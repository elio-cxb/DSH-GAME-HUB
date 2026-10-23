import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GomokuState, MoveRecord, SeatId } from './games/gomoku.ts';

export interface CommitResult { replayed: boolean; response: unknown }

export class GameStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS games (game_id TEXT PRIMARY KEY, version INTEGER NOT NULL, status TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS seats (game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE, seat_id TEXT NOT NULL, player_kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, PRIMARY KEY (game_id, seat_id));',
      'CREATE TABLE IF NOT EXISTS game_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE, version INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (game_id, version));',
      'CREATE TABLE IF NOT EXISTS idempotency (game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE, seat_id TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (game_id, seat_id, request_id));',
      'CREATE TABLE IF NOT EXISTS game_model_usage (game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE, request_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, created_at TEXT NOT NULL, turn INTEGER, step INTEGER, retry INTEGER, seq INTEGER, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, cache_breakdown_known INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (game_id, request_id));',
      'PRAGMA user_version = 3;'
    ].join(''));
    const usageColumns = new Set((this.db.prepare('PRAGMA table_info(game_model_usage)').all() as Array<{ name: string }>).map((column) => column.name));
    const migrations: Array<[string, string]> = [
      ['turn', 'INTEGER'], ['step', 'INTEGER'], ['retry', 'INTEGER'], ['seq', 'INTEGER'],
      ['cache_hit_tokens', 'INTEGER'], ['cache_miss_tokens', 'INTEGER'], ['cache_write_tokens', 'INTEGER'],
      ['reasoning_tokens', 'INTEGER'], ['cache_breakdown_known', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of migrations) {
      if (!usageColumns.has(name)) this.db.exec(`ALTER TABLE game_model_usage ADD COLUMN ${name} ${definition}`);
    }
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  createGame(state: GomokuState, humanToken: string, spectatorToken: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO games(game_id,version,status,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(state.gameId, state.version, state.status, JSON.stringify(state), state.createdAt, state.updatedAt);
      this.db.prepare('INSERT INTO seats(game_id,seat_id,player_kind,token_hash) VALUES(?,?,?,?)')
        .run(state.gameId, 'human', 'HUMAN', GameStore.hashToken(humanToken));
      this.db.prepare('INSERT INTO seats(game_id,seat_id,player_kind,token_hash) VALUES(?,?,?,?)')
        .run(state.gameId, 'companion', 'COMPANION', GameStore.hashToken('internal:' + state.gameId));
      this.db.prepare('INSERT INTO seats(game_id,seat_id,player_kind,token_hash) VALUES(?,?,?,?)')
        .run(state.gameId, 'spectator', 'SPECTATOR', GameStore.hashToken(spectatorToken));
      this.db.prepare('INSERT INTO game_events(game_id,version,event_type,payload_json,created_at) VALUES(?,?,?,?,?)')
        .run(state.gameId, 0, 'game_created', JSON.stringify({ gameType: 'gomoku_free_v1', mode: state.mode }), state.createdAt);
      for (const move of state.history) this.insertMoveEvent(state.gameId, move);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  pendingGames(): GomokuState[] {
    const rows = this.db.prepare("SELECT state_json FROM games WHERE status='playing'").all() as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json) as GomokuState).filter((state) => Boolean(state.pendingDecision));
  }
  activeGames(): GomokuState[] {
    const rows = this.db.prepare("SELECT state_json FROM games WHERE status='playing' ORDER BY updated_at DESC").all() as Array<{ state_json: string }>;
    return rows.map((row) => JSON.parse(row.state_json) as GomokuState);
  }
  latestGame(): GomokuState | null {
    const row = this.db.prepare('SELECT state_json FROM games ORDER BY updated_at DESC LIMIT 1').get() as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as GomokuState : null;
  }
  getGame(gameId: string): GomokuState | null {
    const row = this.db.prepare('SELECT state_json FROM games WHERE game_id=?').get(gameId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as GomokuState : null;
  }

  saveStateOnly(gameId: string, expectedVersion: number, state: GomokuState): boolean {
    const result = this.db.prepare('UPDATE games SET state_json=?,updated_at=? WHERE game_id=? AND version=?')
      .run(JSON.stringify(state), state.updatedAt, gameId, expectedVersion);
    return Number(result.changes) === 1;
  }

  authenticate(gameId: string, token: string): SeatId | 'spectator' | null {
    if (!token || token.length > 512) return null;
    const row = this.db.prepare('SELECT seat_id FROM seats WHERE game_id=? AND token_hash=?')
      .get(gameId, GameStore.hashToken(token)) as { seat_id: SeatId | 'spectator' } | undefined;
    return row?.seat_id ?? null;
  }

  getReplay(gameId: string, seatId: SeatId, requestId: string): unknown | null {
    const row = this.db.prepare('SELECT response_json FROM idempotency WHERE game_id=? AND seat_id=? AND request_id=?')
      .get(gameId, seatId, requestId) as { response_json: string } | undefined;
    return row ? JSON.parse(row.response_json) : null;
  }

  commitTransition(gameId: string, seatId: SeatId, requestId: string, expectedVersion: number, nextState: GomokuState, response: unknown): CommitResult {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const replay = this.db.prepare('SELECT response_json FROM idempotency WHERE game_id=? AND seat_id=? AND request_id=?')
        .get(gameId, seatId, requestId) as { response_json: string } | undefined;
      if (replay) {
        this.db.exec('COMMIT');
        return { replayed: true, response: JSON.parse(replay.response_json) };
      }
      const row = this.db.prepare('SELECT version FROM games WHERE game_id=?').get(gameId) as { version: number } | undefined;
      if (!row) throw new Error('GAME_NOT_FOUND');
      if (row.version !== expectedVersion) throw new Error('STALE_VERSION');
      const update = this.db.prepare('UPDATE games SET version=?,status=?,state_json=?,updated_at=? WHERE game_id=? AND version=?')
        .run(nextState.version, nextState.status, JSON.stringify(nextState), nextState.updatedAt, gameId, expectedVersion);
      if (Number(update.changes) !== 1) throw new Error('STALE_VERSION');
      for (const move of nextState.history.filter((item) => item.version > expectedVersion)) this.insertMoveEvent(gameId, move);
      this.db.prepare('INSERT INTO idempotency(game_id,seat_id,request_id,version,response_json,created_at) VALUES(?,?,?,?,?,?)')
        .run(gameId, seatId, requestId, nextState.version, JSON.stringify(response), new Date().toISOString());
      this.db.exec('COMMIT');
      return { replayed: false, response };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  eventsSince(gameId: string, since: number, limit = 100): Array<{ seq: number; version: number; type: string; payload: unknown; createdAt: string }> {
    const rows = this.db.prepare('SELECT seq,version,event_type,payload_json,created_at FROM game_events WHERE game_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(gameId, Math.max(0, since), Math.min(200, Math.max(1, limit))) as Array<{ seq: number; version: number; event_type: string; payload_json: string; created_at: string }>;
    return rows.map((row) => ({ seq: row.seq, version: row.version, type: row.event_type, payload: JSON.parse(row.payload_json), createdAt: row.created_at }));
  }

  private insertMoveEvent(gameId: string, move: MoveRecord): void {
    this.db.prepare('INSERT INTO game_events(game_id,version,event_type,payload_json,created_at) VALUES(?,?,?,?,?)')
      .run(gameId, move.version, 'move', JSON.stringify({ seatId: move.seatId, seatMoveIndex: move.seatMoveIndex ?? null, ownMoveIndex: move.ownMoveIndex ?? null, row: move.row, col: move.col, stone: move.stone, source: move.source, controller: move.controller ?? null, engineSuggestion: move.engineSuggestion ?? null, thoughtCardVersion: move.thoughtCardVersion ?? null, deviationReport: move.deviationReport ?? null, note: move.note ?? null, wakeDeliveredAt: move.wakeDeliveredAt ?? null, budgetMs: move.budgetMs ?? null, extended: move.extended ?? false }), move.at);
  }

  recordModelUsage(record: {
    gameId: string; requestId: string; provider: string; model: string;
    inputTokens: number; outputTokens: number; totalTokens: number; createdAt?: string;
    turn?: number | null; step?: number | null; retry?: number | null; seq?: number | null;
    cacheHitTokens?: number | null; cacheMissTokens?: number | null; cacheWriteTokens?: number | null;
    reasoningTokens?: number | null; cacheBreakdownKnown?: boolean;
  }): boolean {
    const result = this.db.prepare(`INSERT INTO game_model_usage(
      game_id,request_id,provider,model,input_tokens,output_tokens,total_tokens,created_at,
      turn,step,retry,seq,cache_hit_tokens,cache_miss_tokens,cache_write_tokens,reasoning_tokens,cache_breakdown_known
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_id,request_id) DO UPDATE SET
      provider=excluded.provider, model=excluded.model, input_tokens=excluded.input_tokens,
      output_tokens=excluded.output_tokens, total_tokens=excluded.total_tokens, created_at=excluded.created_at,
      turn=excluded.turn, step=excluded.step, retry=excluded.retry, seq=excluded.seq,
      cache_hit_tokens=excluded.cache_hit_tokens, cache_miss_tokens=excluded.cache_miss_tokens,
      cache_write_tokens=excluded.cache_write_tokens, reasoning_tokens=excluded.reasoning_tokens,
      cache_breakdown_known=excluded.cache_breakdown_known
    WHERE excluded.seq IS NOT NULL AND (game_model_usage.seq IS NULL OR excluded.seq > game_model_usage.seq)`)
      .run(record.gameId, record.requestId, record.provider, record.model, record.inputTokens, record.outputTokens, record.totalTokens,
        record.createdAt || new Date().toISOString(), record.turn ?? null, record.step ?? null, record.retry ?? null, record.seq ?? null,
        record.cacheHitTokens ?? null, record.cacheMissTokens ?? null, record.cacheWriteTokens ?? null,
        record.reasoningTokens ?? null, record.cacheBreakdownKnown ? 1 : 0);
    return Number(result.changes) === 1;
  }

  usageForGame(gameId: string): Record<string, unknown> {
    const rows = this.db.prepare(`SELECT provider,model,COUNT(*) AS requests,
      SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(total_tokens) AS total_tokens,
      SUM(CASE WHEN cache_breakdown_known=1 THEN cache_hit_tokens ELSE 0 END) AS cache_hit_tokens,
      SUM(CASE WHEN cache_breakdown_known=1 THEN cache_miss_tokens ELSE 0 END) AS cache_miss_tokens,
      SUM(CASE WHEN cache_breakdown_known=1 THEN cache_write_tokens ELSE 0 END) AS cache_write_tokens,
      SUM(CASE WHEN cache_breakdown_known=1 THEN 1 ELSE 0 END) AS cache_breakdown_requests
      FROM game_model_usage WHERE game_id=? GROUP BY provider,model ORDER BY model`)
      .all(gameId) as Array<{ provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; total_tokens: number;
        cache_hit_tokens: number | null; cache_miss_tokens: number | null; cache_write_tokens: number | null; cache_breakdown_requests: number }>;
    const totals = rows.reduce((sum, row) => ({
      requests: sum.requests + Number(row.requests),
      inputTokens: sum.inputTokens + Number(row.input_tokens),
      outputTokens: sum.outputTokens + Number(row.output_tokens),
      totalTokens: sum.totalTokens + Number(row.total_tokens),
      cacheHitTokens: sum.cacheHitTokens + Number(row.cache_hit_tokens || 0),
      cacheMissTokens: sum.cacheMissTokens + Number(row.cache_miss_tokens || 0),
      cacheWriteTokens: sum.cacheWriteTokens + Number(row.cache_write_tokens || 0),
      cacheBreakdownRequests: sum.cacheBreakdownRequests + Number(row.cache_breakdown_requests || 0),
      models: [...sum.models, {
        provider: row.provider, model: row.model, requests: Number(row.requests),
        inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens),
        cacheHitTokens: Number(row.cache_hit_tokens || 0), cacheMissTokens: Number(row.cache_miss_tokens || 0),
        cacheWriteTokens: Number(row.cache_write_tokens || 0), cacheBreakdownRequests: Number(row.cache_breakdown_requests || 0),
      }],
    }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, cacheWriteTokens: 0, cacheBreakdownRequests: 0, models: [] as Array<Record<string, unknown>> });
    const requests = this.db.prepare(`SELECT request_id AS requestId,provider,model,input_tokens AS inputTokens,
      output_tokens AS outputTokens,total_tokens AS totalTokens,created_at AS createdAt,
      turn,step,retry,cache_hit_tokens AS cacheHitTokens,cache_miss_tokens AS cacheMissTokens,
      cache_write_tokens AS cacheWriteTokens,reasoning_tokens AS reasoningTokens,
      cache_breakdown_known AS cacheBreakdownKnown
      FROM game_model_usage WHERE game_id=? ORDER BY created_at DESC LIMIT 100`).all(gameId)
      .map((row) => ({ ...row, cacheBreakdownKnown: Boolean(row.cacheBreakdownKnown) }));
    return { ...totals, requestDetails: requests };
  }
  usageForProject(): { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; cacheHitTokens: number; cacheMissTokens: number; cacheWriteTokens: number; cacheBreakdownRequests: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,
      COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(total_tokens),0) AS total_tokens,
      COALESCE(SUM(CASE WHEN cache_breakdown_known=1 THEN cache_hit_tokens ELSE 0 END),0) AS cache_hit_tokens,
      COALESCE(SUM(CASE WHEN cache_breakdown_known=1 THEN cache_miss_tokens ELSE 0 END),0) AS cache_miss_tokens,
      COALESCE(SUM(CASE WHEN cache_breakdown_known=1 THEN cache_write_tokens ELSE 0 END),0) AS cache_write_tokens,
      COALESCE(SUM(CASE WHEN cache_breakdown_known=1 THEN 1 ELSE 0 END),0) AS cache_breakdown_requests FROM game_model_usage`)
      .get() as { requests: number; input_tokens: number; output_tokens: number; total_tokens: number;
        cache_hit_tokens: number; cache_miss_tokens: number; cache_write_tokens: number; cache_breakdown_requests: number };
    return { requests: Number(row.requests), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens),
      cacheHitTokens: Number(row.cache_hit_tokens || 0), cacheMissTokens: Number(row.cache_miss_tokens || 0), cacheWriteTokens: Number(row.cache_write_tokens || 0), cacheBreakdownRequests: Number(row.cache_breakdown_requests || 0) };
  }
  close(): void {
    this.db.close();
  }
}



