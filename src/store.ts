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
      'CREATE TABLE IF NOT EXISTS game_model_usage (game_id TEXT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE, request_id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, total_tokens INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (game_id, request_id));',
      'PRAGMA user_version = 2;'
    ].join(''));
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  createGame(state: GomokuState, humanToken: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO games(game_id,version,status,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run(state.gameId, state.version, state.status, JSON.stringify(state), state.createdAt, state.updatedAt);
      this.db.prepare('INSERT INTO seats(game_id,seat_id,player_kind,token_hash) VALUES(?,?,?,?)')
        .run(state.gameId, 'human', 'HUMAN', GameStore.hashToken(humanToken));
      this.db.prepare('INSERT INTO seats(game_id,seat_id,player_kind,token_hash) VALUES(?,?,?,?)')
        .run(state.gameId, 'companion', 'COMPANION', GameStore.hashToken('internal:' + state.gameId));
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
  getGame(gameId: string): GomokuState | null {
    const row = this.db.prepare('SELECT state_json FROM games WHERE game_id=?').get(gameId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as GomokuState : null;
  }

  authenticate(gameId: string, token: string): SeatId | null {
    if (!token || token.length > 512) return null;
    const row = this.db.prepare('SELECT seat_id FROM seats WHERE game_id=? AND token_hash=?')
      .get(gameId, GameStore.hashToken(token)) as { seat_id: SeatId } | undefined;
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
      .run(gameId, move.version, 'move', JSON.stringify({ seatId: move.seatId, row: move.row, col: move.col, stone: move.stone, source: move.source }), move.at);
  }

  recordModelUsage(record: { gameId: string; requestId: string; provider: string; model: string; inputTokens: number; outputTokens: number; totalTokens: number }): boolean {
    const result = this.db.prepare('INSERT OR IGNORE INTO game_model_usage(game_id,request_id,provider,model,input_tokens,output_tokens,total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(record.gameId, record.requestId, record.provider, record.model, record.inputTokens, record.outputTokens, record.totalTokens, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  usageForGame(gameId: string): { requests: number; inputTokens: number; outputTokens: number; totalTokens: number; models: Array<{ provider: string; model: string; requests: number; inputTokens: number; outputTokens: number; totalTokens: number }> } {
    const rows = this.db.prepare('SELECT provider,model,COUNT(*) AS requests,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(total_tokens) AS total_tokens FROM game_model_usage WHERE game_id=? GROUP BY provider,model ORDER BY model')
      .all(gameId) as Array<{ provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; total_tokens: number }>;
    return rows.reduce((sum, row) => ({
      requests: sum.requests + Number(row.requests),
      inputTokens: sum.inputTokens + Number(row.input_tokens),
      outputTokens: sum.outputTokens + Number(row.output_tokens),
      totalTokens: sum.totalTokens + Number(row.total_tokens),
      models: [...sum.models, { provider: row.provider, model: row.model, requests: Number(row.requests), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens) }],
    }), { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, models: [] });
  }
  usageForProject(): { requests: number; inputTokens: number; outputTokens: number; totalTokens: number } {
    const row = this.db.prepare('SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(total_tokens),0) AS total_tokens FROM game_model_usage')
      .get() as { requests: number; input_tokens: number; output_tokens: number; total_tokens: number };
    return { requests: Number(row.requests), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), totalTokens: Number(row.total_tokens) };
  }
  close(): void {
    this.db.close();
  }
}



