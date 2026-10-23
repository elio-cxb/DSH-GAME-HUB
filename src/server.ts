import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GameStore } from './store.ts';
import { applyMove, chooseLocalMove, createGameState, forcedWakeReason, hasImmediateWinningMove, legalActions, rankLocalMoves, RuleError, tacticalShapesAtLastMove } from './games/gomoku.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WEB_ROOT = resolve(ROOT, 'web');
const DATA_DIR = process.env.DSH_GAME_DATA_DIR || resolve(ROOT, 'data');
const DB_PATH = resolve(DATA_DIR, 'games.sqlite');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8787);
const MAX_BODY = 32 * 1024;
const GAME_USAGE_TOKEN = process.env.DSH_GAME_USAGE_TOKEN || process.env.GAME_WORKER_TOKEN || '';
const GAME_WORKER_TOKEN = process.env.GAME_WORKER_TOKEN || '';
const GAME_BRIDGE_URL = process.env.GAME_BRIDGE_URL || 'http://127.0.0.1:3100/internal/game/turn';
const GAME_BRIDGE_SECRET = process.env.GAME_BRIDGE_SECRET || '';
const BODY_TIMEOUT_MS = 600_000;
const BODY_EXTENSION_MS = 120_000;
const FISH_TIMEOUT_MS = 120_000;
const LEGACY_DECISION_TIMEOUT_MS = Math.max(1000, Math.min(90000, Number(process.env.GAME_KEYTURN_TIMEOUT_MS || process.env.GAME_DECISION_TIMEOUT_MS || 90000)));
const store = new GameStore(DB_PATH);
const sockets = new Set();
const decisionTimers = new Map();
const gameRecordDispatchQueues = new Map();

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY) {
        reject(Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function gameIdFrom(pathname, suffix) {
  const match = pathname.match(new RegExp('^/api/games/([a-f0-9-]{36})/' + suffix + '$'));
  return match?.[1] || null;
}

function bearer(req) {
  const value = req.headers.authorization || '';
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(value);
  return match?.[1] || null;
}

function validUsageWorker(req) {
  const token = req.headers['x-game-worker-token'];
  if (!GAME_USAGE_TOKEN || typeof token !== 'string') return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(GAME_USAGE_TOKEN);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function validGameWorker(req) {
  const token = req.headers['x-game-worker-token'];
  if (!GAME_WORKER_TOKEN || GAME_WORKER_TOKEN.length < 32 || typeof token !== 'string') return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(GAME_WORKER_TOKEN);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function validGameBridge(req) {
  const token = req.headers['x-game-token'];
  if (!GAME_BRIDGE_SECRET || GAME_BRIDGE_SECRET.length < 32 || typeof token !== 'string') return false;
  const provided = Buffer.from(token);
  const expected = Buffer.from(GAME_BRIDGE_SECRET);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function serializeBoard(state) {
  const glyph = (value) => value === 0 ? '.' : value === state.stones.companion ? 'X' : 'O';
  return Array.from({ length: 15 }, (_, row) => state.board.slice(row * 15, row * 15 + 15).map(glyph).join('')).join('\n');
}

function companionMoves(state) { return state.history.filter((move) => move.seatId === 'companion').length; }

function bodyWakeReason(state) {
  const forced = forcedWakeReason(state);
  if (forced) return forced;
  if (state.pendingWakeReason) return state.pendingWakeReason;
  const ownMoves = companionMoves(state);
  if (state.thoughtCard?.wakeAtOwnMove && state.thoughtCard.wakeAtOwnMove > state.lastBodyMoveIndex && ownMoves + 1 >= state.thoughtCard.wakeAtOwnMove) return '思路卡指定的本方手数扳机';
  if (state.thoughtCard?.wakePatterns?.length && state.history.length) {
    const labels = tacticalShapesAtLastMove(state);
    if (state.nextSeat === 'companion' && hasImmediateWinningMove(state, 'companion')) labels.push('制胜机会');
    if (state.thoughtCard.wakePatterns.some((label) => labels.includes(label))) return '思路卡指定的局面扳机';
  }
  if (state.decisionMode === 'dsh-dual') {
    if (!state.thoughtCard) return '开局：请本体先给思路卡并亲自落第一手';
    if (legalActions(state).length === 1) return '终局前一手';
    const interval = state.thoughtCard.ropeHands;
    if (interval === null || !Number.isSafeInteger(interval) || interval < 0) {
      if (ownMoves - state.lastBodyMoveIndex >= 8) return '本体未声明牵引绳，达到 8 次本方落子兜底间隔';
    } else if (ownMoves - state.lastBodyMoveIndex >= interval) {
      return `本方已按牵引绳完成 ${interval} 次落子`;
    }
    if (hasImmediateWinningMove(state, 'companion')) return '胜负手';
  }
  if (state.decisionMode === 'dsh-session') return '本体模式：每个本方回合由主会话决策';
  if (state.decisionMode === 'dsh-subagent') return '下棋鱼模式：每个本方回合由独立棋局会话决策';
  return null;
}

function startCompanionDecision(state, reason = bodyWakeReason(state)) {
  if (state.status !== 'playing' || state.nextSeat !== 'companion') return { state, task: null };
  let controller = 'engine';
  if (state.decisionMode === 'dsh-session') controller = 'body';
  else if (state.decisionMode === 'dsh-subagent') controller = 'fish';
  else if (state.decisionMode === 'dsh-dual') controller = reason ? 'body' : 'fish';
  if (controller === 'engine' || !GAME_BRIDGE_URL || GAME_BRIDGE_SECRET.length < 32) return { state, task: null };
  const taskId = randomUUID();
  const best = rankLocalMoves(state, 'companion', 1)[0];
  const pendingDecision = {
    taskId,
    version: state.version,
    reason: reason || '按当前思路卡继续',
    controller,
    wakeDeliveredAt: new Date().toISOString(),
    budgetMs: controller === 'body' ? BODY_TIMEOUT_MS : FISH_TIMEOUT_MS,
    extended: false,
    engineSuggestion: best ? { row: best.row, col: best.col, score: best.score } : null,
  };
  return { state: { ...state, modelAttempts: state.modelAttempts + 1, pendingWakeReason: null, pendingDecision }, task: { taskId, version: state.version } };
}

function carryForcedWake(state) {
  if (state.status !== 'playing') return state;
  let reason = forcedWakeReason(state);
  const last = state.history.at(-1);
  if (!reason && last?.seatId === 'companion') {
    const shapes = tacticalShapesAtLastMove(state);
    if (state.thoughtCard?.wakePatterns?.some((pattern) => shapes.includes(pattern))) reason = '思路卡指定的局面扳机';
    if (!reason && state.thoughtCard?.wakeAtOwnMove && last.ownMoveIndex >= state.thoughtCard.wakeAtOwnMove) reason = '思路卡指定的本方手数扳机';
    if (!reason && hasImmediateWinningMove(state, 'companion')) reason = '本方胜负手';
  }
  if (reason && state.nextSeat !== 'companion' && !state.pendingWakeReason) return { ...state, pendingWakeReason: reason };
  return state;
}

function advanceGame(state) {
  let next = state;
  for (let guard = 0; guard < 3 && next.status === 'playing'; guard++) {
    if (next.nextSeat === 'human' && next.opponent === 'local') {
      const move = chooseLocalMove(next, 'human');
      if (!move) break;
      next = carryForcedWake(applyMove(next, 'human', { type: 'place', ...move }, 'local', { controller: 'engine' }));
      continue;
    }
    if (next.nextSeat === 'companion') {
      if (next.decisionMode === 'local') {
        const move = chooseLocalMove(next, 'companion');
        if (!move) break;
        next = carryForcedWake(applyMove(next, 'companion', { type: 'place', ...move }, 'local', { controller: 'engine' }));
        continue;
      }
      const scheduled = startCompanionDecision(next);
      if (!scheduled.task) {
        const move = chooseLocalMove(next, 'companion');
        if (!move) break;
        next = applyMove(next, 'companion', { type: 'place', ...move }, 'fallback', { controller: 'engine', thoughtCardVersion: next.thoughtCard?.version ?? null });
        continue;
      }
      return { state: scheduled.state, task: scheduled.task };
    }
    break;
  }
  return { state: next, task: null };
}

function commitWorkerResult(gameId, taskId, version, actionId) {
  const current = store.getGame(gameId);
  if (!current || current.version !== version || current.nextSeat !== 'companion' || current.pendingDecision?.taskId !== taskId) return false;
  const candidate = rankLocalMoves(current, 'companion', 12).find((item) => item.actionId === actionId);
  if (!candidate || !legalActions(current).some((action) => action.row === candidate.row && action.col === candidate.col)) return false;
  const next = carryForcedWake(applyMove({ ...current, pendingDecision: null }, 'companion', { type: 'place', row: candidate.row, col: candidate.col }, 'dsh', { controller: current.pendingDecision.controller, engineSuggestion: current.pendingDecision.engineSuggestion ?? null, thoughtCardVersion: current.thoughtCard?.version ?? null }));
  const response = { accepted: true, version: next.version };
  store.commitTransition(gameId, 'companion', taskId, version, next, response);
  const timer = decisionTimers.get(gameId);
  if (timer) clearTimeout(timer);
  decisionTimers.delete(gameId);
  broadcast(gameId);
  return true;
}

function appendTiming(state, move, controller, outcome, details = {}) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const submitted = new Date().toISOString();
    const wake = details.wakeDeliveredAt || move?.wakeDeliveredAt || state.pendingDecision?.wakeDeliveredAt || state.updatedAt;
    const record = {
      gameId: state.gameId,
      moveNumber: move?.version ?? state.history.length,
      ownMoveIndex: move?.ownMoveIndex ?? companionMoves(state),
      seat: move?.seatId || 'companion',
      controller,
      wakeDeliveredAt: wake,
      moveSubmittedAt: move?.at || submitted,
      durationMs: Math.max(0, Date.parse(move?.at || submitted) - Date.parse(wake)),
      budgetMs: details.budgetMs ?? move?.budgetMs ?? state.pendingDecision?.budgetMs ?? null,
      extended: details.extended ?? move?.extended ?? state.pendingDecision?.extended ?? false,
      extendGrantedMs: details.extendGrantedMs ?? (move?.extended ? BODY_EXTENSION_MS : 0),
      outcome,
      modelCalls: null,
    };
    appendFileSync(resolve(DATA_DIR, `timing-${state.gameId}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
    return record;
  } catch (error) {
    console.error('timing_record_failed', { gameId: state.gameId, code: error instanceof Error ? error.message : 'UNKNOWN' });
    return null;
  }
}

function dispatchGameRecord(state, moves, { recordTiming = true } = {}) {
  if (!Array.isArray(moves)) return Promise.resolve(false);
  if (recordTiming) for (const move of moves) appendTiming(state, move, move.controller || 'engine', 'accepted');
  if (GAME_BRIDGE_SECRET.length < 32) return Promise.resolve(false);
  let target;
  try {
    target = new URL('/internal/game/record', GAME_BRIDGE_URL);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname)) return Promise.resolve(false);
  } catch { return Promise.resolve(false); }
  const safeMoves = moves.map((move) => ({ moveNumber: move.version, seatMoveIndex: move.seatMoveIndex ?? null, ownMoveIndex: move.ownMoveIndex ?? companionMoves(state), seatId: move.seatId, row: move.row, col: move.col, source: move.source, controller: move.controller ?? null, at: move.at, note: move.note ?? null, deviationReport: move.deviationReport ?? null, thoughtCardVersion: move.thoughtCardVersion ?? null, wakeDeliveredAt: move.wakeDeliveredAt ?? null, budgetMs: move.budgetMs ?? null, extended: move.extended ?? false }));
  const batches = safeMoves.length ? Array.from({ length: Math.ceil(safeMoves.length / 8) }, (_, index) => safeMoves.slice(index * 8, (index + 1) * 8)) : [[]];
  const prior = gameRecordDispatchQueues.get(state.gameId) || Promise.resolve(true);
  const next = prior.catch(() => false).then(async () => {
    let result = null;
    for (let index = 0; index < batches.length; index++) {
      const batch = batches[index];
      const finalBatch = index === batches.length - 1;
      const body = JSON.stringify({ gameId: state.gameId, createdAt: state.createdAt, decisionMode: state.decisionMode, opponent: state.opponent, status: finalBatch ? state.status : 'playing', winner: state.winner, draw: state.draw, moveCount: state.history.length, thoughtCard: state.thoughtCard, proposalReports: state.proposalReports.slice(-3), lastController: batch.at(-1)?.controller ?? state.history.at(-1)?.controller ?? null, moves: batch });
      const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-token': GAME_BRIDGE_SECRET }, body, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('BRIDGE_RECORD_REJECTED');
      result = await response.json();
      if (result?.ok !== true) throw new Error('BRIDGE_RECORD_REJECTED');
    }
    return state.status !== 'abandoned' || (result?.archived === true && result?.childSessionArchived === true && result?.notified === true);
  }).catch((error) => {
    console.error('game_record_delivery_failed', { gameId: state.gameId, code: error instanceof Error ? error.message : 'UNKNOWN' });
    return false;
  });
  gameRecordDispatchQueues.set(state.gameId, next);
  void next.finally(() => { if (gameRecordDispatchQueues.get(state.gameId) === next) gameRecordDispatchQueues.delete(state.gameId); });
  return next;
}

function fallbackWorkerDecision(gameId, taskId, version, outcome = 'fallback') {
  const current = store.getGame(gameId);
  if (!current || current.version !== version || current.nextSeat !== 'companion' || current.pendingDecision?.taskId !== taskId) return false;
  const move = chooseLocalMove(current, 'companion');
  if (!move) return false;
  appendTiming(current, null, current.pendingDecision.controller, outcome, { wakeDeliveredAt: current.pendingDecision.wakeDeliveredAt, budgetMs: current.pendingDecision.budgetMs, extended: current.pendingDecision.extended });
  const pending = current.pendingDecision;
  let next = carryForcedWake(applyMove({ ...current, pendingDecision: null }, 'companion', { type: 'place', ...move }, 'fallback', { controller: 'engine', engineSuggestion: pending.engineSuggestion ?? null, thoughtCardVersion: current.thoughtCard?.version ?? null, wakeDeliveredAt: pending.wakeDeliveredAt, budgetMs: pending.budgetMs, extended: pending.extended }));
  const advanced = advanceGame(next);
  next = advanced.state;
  const response = { accepted: true, version: next.version, fallback: true };
  store.commitTransition(gameId, 'companion', taskId, version, next, response);
  const timer = decisionTimers.get(gameId);
  if (timer) clearTimeout(timer);
  decisionTimers.delete(gameId);
  broadcast(gameId);
  dispatchGameRecord(next, next.history.filter((item) => item.version > version));
  if (advanced.task) void dispatchGameTurn(gameId, advanced.task.taskId, advanced.task.version);
  return true;
}

async function handleDecisionTimeout(gameId, taskId, version) {
  const timer = decisionTimers.get(gameId);
  if (timer) clearTimeout(timer);
  decisionTimers.delete(gameId);
  const current = store.getGame(gameId);
  const pending = current?.pendingDecision;
  if (!current || !pending || pending.taskId !== taskId || current.version !== version) return;
  appendTiming(current, null, pending.controller, 'timeout', { wakeDeliveredAt: pending.wakeDeliveredAt, budgetMs: pending.budgetMs, extended: pending.extended });
  if (current.decisionMode === 'dsh-dual' && pending.controller === 'body') {
    const replacement = {
      ...current,
      pendingDecision: { ...pending, taskId: randomUUID(), controller: 'fish', reason: '本体思考超时，按思路卡交由下棋鱼继续', wakeDeliveredAt: new Date().toISOString(), budgetMs: FISH_TIMEOUT_MS, extended: false },
      updatedAt: new Date().toISOString(),
    };
    if (store.saveStateOnly(gameId, version, replacement)) {
      broadcast(gameId);
      void dispatchGameTurn(gameId, replacement.pendingDecision.taskId, version);
    }
    return;
  }
  fallbackWorkerDecision(gameId, taskId, version, 'fallback');
}

async function handleDecisionFailure(gameId, taskId, version) {
  const current = store.getGame(gameId);
  const pending = current?.pendingDecision;
  if (!current || !pending || pending.taskId !== taskId || current.version !== version) return;
  if (current.decisionMode === 'dsh-dual' && pending.controller === 'body') {
    const replacement = { ...current, pendingDecision: { ...pending, taskId: randomUUID(), controller: 'fish', reason: '主会话暂不可用，按思路卡交由下棋鱼继续', wakeDeliveredAt: new Date().toISOString(), budgetMs: FISH_TIMEOUT_MS, extended: false }, updatedAt: new Date().toISOString() };
    if (store.saveStateOnly(gameId, version, replacement)) {
      broadcast(gameId);
      void dispatchGameTurn(gameId, replacement.pendingDecision.taskId, version);
    }
    return;
  }
  fallbackWorkerDecision(gameId, taskId, version, 'fallback');
}

async function dispatchGameTurn(gameId, taskId, version) {
  if (!GAME_BRIDGE_URL || GAME_BRIDGE_SECRET.length < 32) return fallbackWorkerDecision(gameId, taskId, version);
  let bridgeUrl;
  try { bridgeUrl = new URL(GAME_BRIDGE_URL); } catch { return fallbackWorkerDecision(gameId, taskId, version); }
  if (bridgeUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(bridgeUrl.hostname)) return fallbackWorkerDecision(gameId, taskId, version);
  const current = store.getGame(gameId);
  if (!current || current.pendingDecision?.taskId !== taskId || current.version !== version) return;
  try {
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-game-token': GAME_BRIDGE_SECRET },
      body: JSON.stringify({ gameId, gameType: 'gomoku' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('GAME_BRIDGE_UNAVAILABLE');
    const result = await response.json();
    if (result.mode === 'local') return fallbackWorkerDecision(gameId, taskId, version, 'fallback');
    if (result.accepted !== true) throw new Error('GAME_TURN_NOT_ACCEPTED');
    const latest = store.getGame(gameId);
    if (!latest || latest.pendingDecision?.taskId !== taskId || latest.version !== version) return;
    const latestPending = latest.pendingDecision;
    const remaining = Math.max(1, Date.parse(latestPending.wakeDeliveredAt) + latestPending.budgetMs - Date.now());
    const timer = setTimeout(() => void handleDecisionTimeout(gameId, taskId, version), remaining);
    decisionTimers.set(gameId, timer);
  } catch {
    void handleDecisionFailure(gameId, taskId, version);
  }
}
function authGame(req, res, gameId) {
  const token = bearer(req);
  if (!token) { sendJson(res, 401, { error: 'UNAUTHORIZED' }); return null; }
  const seat = store.authenticate(gameId, token);
  if (!seat) { sendJson(res, 401, { error: 'UNAUTHORIZED' }); return null; }
  return seat;
}

function projectObservation(state, seatId) {
  return {
    gameId: state.gameId,
    gameType: 'gomoku_free_v1',
    mode: state.mode,
    decisionMode: state.decisionMode,
    opponent: state.opponent,
    seatId,
    version: state.version,
    status: state.status,
    nextSeat: state.nextSeat,
    winner: state.winner,
    draw: state.draw,
    boardSize: 15,
    board: state.board,
    stones: state.stones,
    decisionPending: Boolean(state.pendingDecision),
    currentController: state.pendingDecision?.controller || (state.nextSeat === 'human' && state.opponent === 'local' ? 'engine' : null),
    thoughtCard: state.thoughtCard,
    history: state.history,
    proposalReports: state.proposalReports,
    fishWakeProposals: state.fishWakeProposals,
    extensionUsed: state.extensionUsed,
    legalActions: legalActions(state),
    myPrivateState: {},
    updatedAt: state.updatedAt,
  };
}

function statusView(state) {
  const lastMove = state.history.at(-1) || null;
  return {
    gameId: state.gameId,
    mode: state.mode,
    decisionMode: state.decisionMode,
    opponent: state.opponent,
    phase: state.status,
    version: state.version,
    turn: state.nextSeat,
    decisionPending: Boolean(state.pendingDecision),
    currentController: state.pendingDecision?.controller || (state.nextSeat === 'human' && state.opponent === 'local' ? 'engine' : null),
    ownMoveCount: companionMoves(state),
    thoughtCard: state.thoughtCard,
    proposalReports: state.proposalReports,
    fishWakeProposals: state.fishWakeProposals,
    extensionUsed: state.extensionUsed,
    modelAttempts: state.modelAttempts || 0,
    winner: state.winner,
    draw: state.draw,
    lastDecision: lastMove ? { seatId: lastMove.seatId, source: lastMove.source, at: lastMove.at } : null,
    updatedAt: state.updatedAt,
  };
}

function broadcast(gameId) {
  const state = store.getGame(gameId);
  if (!state) return;
  const messageBase = { type: 'observation' };
  for (const client of sockets) {
    if (client.readyState === 1 && client.gameId === gameId) {
      client.send(JSON.stringify({ ...messageBase, observation: projectObservation(state, client.seatId) }));
    }
  }
}

function broadcastUsage() {
  for (const client of sockets) {
    if (client.readyState === 1 && client.gameId) {
      client.send(JSON.stringify({ type: 'usage', game: store.usageForGame(client.gameId) }));
    }
  }
}
function playCompanion(state) {
  if (state.mode !== 'local' && state.mode !== 'mock' && state.mode !== 'hybrid') return state;
  const action = chooseLocalMove(state, 'companion');
  if (!action) return state;
  return applyMove(state, 'companion', { type: 'place', ...action }, state.mode === 'mock' ? 'mock' : 'local');
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = resolve(WEB_ROOT, relative);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) return sendJson(res, 404, { error: 'NOT_FOUND' });
  try {
    const data = await readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
    res.end(data);
  } catch { sendJson(res, 404, { error: 'NOT_FOUND' }); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  try {
    if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true, phase: 'one' });
    if (req.method === 'POST' && pathname === '/internal/game-usage') {
      if (!GAME_USAGE_TOKEN && !GAME_BRIDGE_SECRET) return sendJson(res, 503, { error: 'USAGE_INGEST_DISABLED' });
      if (!validUsageWorker(req) && !validGameBridge(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      const validCount = (value) => Number.isSafeInteger(value) && value >= 0;
      const validOptionalCount = (value) => value === undefined || value === null || validCount(value);
      const validOptionalStep = (value) => value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
      if (typeof body.gameId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.gameId)
        || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)
        || typeof body.model !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(body.model)
        || (body.provider !== undefined && !['dsh-main-session', 'dsh-game-worker'].includes(body.provider))
        || !validCount(body.inputTokens) || !validCount(body.outputTokens)
        || !validOptionalCount(body.reasoningTokens) || !validOptionalCount(body.cacheHitTokens)
        || !validOptionalCount(body.cacheMissTokens) || !validOptionalCount(body.cacheWriteTokens)
        || !validOptionalStep(body.turn) || !validOptionalStep(body.step) || !validOptionalStep(body.retry) || !validOptionalStep(body.seq)
        || (body.createdAt !== undefined && body.createdAt !== null && (!Number.isSafeInteger(body.createdAt) || body.createdAt <= 0))
        || (body.cacheBreakdownKnown === true && (!validCount(body.cacheHitTokens) || !validCount(body.cacheMissTokens)
          || !validCount(body.cacheWriteTokens) || body.cacheHitTokens + body.cacheMissTokens + body.cacheWriteTokens !== body.inputTokens))
        || (body.totalTokens !== undefined && !validCount(body.totalTokens))) {
        return sendJson(res, 400, { error: 'INVALID_USAGE_RECORD' });
      }
      if (!store.getGame(body.gameId)) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      const inserted = store.recordModelUsage({
        gameId: body.gameId,
        requestId: body.requestId,
        provider: body.provider || 'dsh-game-worker',
        model: body.model,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        totalTokens: body.totalTokens ?? body.inputTokens + body.outputTokens,
        turn: body.turn ?? null,
        step: body.step ?? null,
        retry: body.retry ?? null,
        seq: body.seq ?? null,
        cacheHitTokens: body.cacheHitTokens ?? null,
        cacheMissTokens: body.cacheMissTokens ?? null,
        cacheWriteTokens: body.cacheWriteTokens ?? null,
        reasoningTokens: body.reasoningTokens ?? null,
        cacheBreakdownKnown: body.cacheBreakdownKnown === true,
        createdAt: Number.isSafeInteger(body.createdAt) ? new Date(body.createdAt).toISOString() : undefined,
      });
      if (inserted) broadcastUsage();
      return sendJson(res, inserted ? 201 : 200, { accepted: true, duplicate: !inserted });
    }
    if (pathname === '/internal/game/view' && req.method === 'POST') {
      if (!validGameBridge(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      if (typeof body.gameId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.gameId)) return sendJson(res, 400, { error: 'INVALID_GAME_ID' });
      const state = store.getGame(body.gameId);
      if (!state) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      if (state.status !== 'playing' || state.nextSeat !== 'companion' || !state.pendingDecision) return sendJson(res, 409, { error: 'NO_PENDING_COMPANION_TURN' });
      const candidates = rankLocalMoves(state, 'companion', 12).map(({ actionId, row, col, score }) => ({ actionId, row, col, score }));
      const lastMoves = state.history.slice(-5).map((move) => ({ seat: move.seatId === 'companion' ? 'you' : state.opponent === 'local' ? 'local engine' : 'opponent', row: move.row, col: move.col, seatMoveIndex: move.seatMoveIndex, ownMoveIndex: move.ownMoveIndex, controller: move.controller, source: move.source, deviationReport: move.deviationReport || null }));
      return sendJson(res, 200, {
        gameId: state.gameId,
        version: state.version,
        decisionId: state.pendingDecision.taskId,
        controller: state.pendingDecision.controller,
        wakeDeliveredAt: state.pendingDecision.wakeDeliveredAt,
        budgetMs: state.pendingDecision.budgetMs,
        extended: state.pendingDecision.extended,
        board: serializeBoard(state),
        yourStone: state.stones.companion === 1 ? 'X (black)' : 'O (white)',
        reason: state.pendingDecision.reason,
        ownMoveCount: companionMoves(state),
        thoughtCard: state.thoughtCard,
        proposalReports: state.proposalReports.slice(-3),
        lastMoves,
        engineSuggestion: state.pendingDecision.engineSuggestion ?? null,
        candidates,
        instruction: 'The engineSuggestion is only a recommendation, and candidates are examples of locally ranked moves. You may choose any empty board intersection by row and col. Use game_play once; do not make another move if it is rejected.'
      });
    }
    if (pathname === '/internal/game/play' && req.method === 'POST') {
      if (!validGameBridge(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      if (typeof body.gameId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.gameId)
        || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)
        || typeof body.decisionId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.decisionId)
        || !['body', 'fish'].includes(body.controller)
        || typeof body.wakeDeliveredAt !== 'string' || !Number.isFinite(Date.parse(body.wakeDeliveredAt))
        || !Number.isSafeInteger(body.expectedVersion)
        || !Number.isInteger(body.row) || !Number.isInteger(body.col)
        || (body.thoughtCard !== undefined && (typeof body.thoughtCard !== 'string' || body.thoughtCard.length > 400))
        || (body.ropeHands !== undefined && (!Number.isSafeInteger(body.ropeHands) || body.ropeHands < 0 || body.ropeHands > 10000))
        || (body.wakeAtOwnMove !== undefined && (!Number.isSafeInteger(body.wakeAtOwnMove) || body.wakeAtOwnMove < 1 || body.wakeAtOwnMove > 10000))
        || (body.wakePatterns !== undefined && (!Array.isArray(body.wakePatterns) || body.wakePatterns.length > 8 || body.wakePatterns.some((item) => typeof item !== 'string' || item.length > 40)))
        || (body.deviationReport !== undefined && (typeof body.deviationReport !== 'string' || body.deviationReport.length > 200))
        || (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 50))
        || (body.wakeupProposal !== undefined && (typeof body.wakeupProposal !== 'string' || body.wakeupProposal.length > 160))) {
        return sendJson(res, 400, { error: 'INVALID_ACTION_REQUEST' });
      }
      const replay = store.getReplay(body.gameId, 'companion', body.requestId);
      if (replay) return sendJson(res, 200, { ...replay, replayed: true });
      const current = store.getGame(body.gameId);
      if (!current) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      if (current.version !== body.expectedVersion || current.nextSeat !== 'companion' || !current.pendingDecision || current.pendingDecision.taskId !== body.decisionId
        || current.pendingDecision.controller !== body.controller || current.pendingDecision.wakeDeliveredAt !== body.wakeDeliveredAt) {
        appendTiming(current, null, body.controller, 'rejected_stale', { wakeDeliveredAt: body.wakeDeliveredAt });
        return sendJson(res, 409, { error: 'STALE_OR_UNAVAILABLE_TURN' });
      }
      const taskId = current.pendingDecision.taskId;
      const row = body.row;
      const col = body.col;
      if (!legalActions(current).some((action) => action.row === row && action.col === col)) return sendJson(res, 422, { error: 'ILLEGAL_ACTION' });
      const pending = current.pendingDecision;
      if (pending.controller === 'body' && (typeof body.thoughtCard !== 'string' || !body.thoughtCard.trim())) return sendJson(res, 400, { error: 'THOUGHT_CARD_REQUIRED' });
      let next = applyMove({ ...current, pendingDecision: null }, 'companion', { type: 'place', row, col }, pending.controller === 'fish' ? 'fish' : 'dsh', {
        controller: pending.controller,
        engineSuggestion: pending.engineSuggestion ?? null,
        thoughtCardVersion: current.thoughtCard?.version ?? null,
        deviationReport: body.deviationReport || null,
        note: body.note || null,
        wakeDeliveredAt: pending.wakeDeliveredAt,
        budgetMs: pending.budgetMs,
        extended: pending.extended,
      });
      let move = next.history.at(-1);
      if (pending.controller === 'fish' && !body.deviationReport) {
        move = { ...move, deviationReport: '未提供偏差回报' };
        next.history[next.history.length - 1] = move;
      }
      if (pending.controller === 'body') {
        const text = String(body.thoughtCard || '').trim().slice(0, 400);
        next = {
          ...next,
          lastBodyMoveIndex: move.ownMoveIndex,
          thoughtCard: text ? {
            text,
            version: (current.thoughtCard?.version || 0) + 1,
            ropeHands: Number.isSafeInteger(body.ropeHands) ? body.ropeHands : null,
            wakeAtOwnMove: Number.isSafeInteger(body.wakeAtOwnMove) ? body.wakeAtOwnMove : null,
            wakePatterns: Array.isArray(body.wakePatterns) ? body.wakePatterns : [],
          } : current.thoughtCard,
        };
      }
      if (pending.controller === 'fish' && typeof body.wakeupProposal === 'string' && body.wakeupProposal.trim()) {
        const proposalCount = current.fishWakeProposals + 1;
        const accepted = proposalCount <= 3;
        const proposal = { ownMoveIndex: move.ownMoveIndex, reason: body.wakeupProposal.trim().slice(0, 160), accepted, at: new Date().toISOString() };
        next = { ...next, fishWakeProposals: proposalCount, proposalReports: [...current.proposalReports, proposal], pendingWakeReason: accepted ? `下棋鱼提议：${proposal.reason}` : current.pendingWakeReason };
      }
      next = carryForcedWake(next);
      const advanced = advanceGame(next);
      next = advanced.state;
      const response = { accepted: true, gameId: body.gameId, version: next.version, moveNumber: move.version, seatMoveIndex: move.seatMoveIndex, ownMoveIndex: move.ownMoveIndex, row, col, source: move.source, controller: pending.controller, note: move.note, deviationReport: move.deviationReport, engineSuggestion: pending.engineSuggestion ?? null, thoughtCard: next.thoughtCard, proposalReports: next.proposalReports.slice(-3), finished: next.status === 'finished', winner: next.winner, draw: next.draw, timing: { controller: pending.controller, wakeDeliveredAt: pending.wakeDeliveredAt, durationMs: Math.max(0, Date.parse(move.at) - Date.parse(pending.wakeDeliveredAt)), budgetMs: pending.budgetMs, extended: pending.extended } };
      const commit = store.commitTransition(body.gameId, 'companion', body.requestId, body.expectedVersion, next, response);
      const timer = decisionTimers.get(body.gameId);
      if (timer) clearTimeout(timer);
      decisionTimers.delete(body.gameId);
      broadcast(body.gameId);
      dispatchGameRecord(next, next.history.filter((item) => item.version > body.expectedVersion));
      if (advanced.task) void dispatchGameTurn(body.gameId, advanced.task.taskId, advanced.task.version);
      return sendJson(res, 200, { ...commit.response, replayed: commit.replayed });
    }
    if (pathname === '/internal/game/status' && req.method === 'POST') {
      if (!validGameBridge(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      const state = typeof body.gameId === 'string' ? store.getGame(body.gameId) : store.latestGame();
      if (!state) return sendJson(res, 200, { active: false, phase: 'none' });
      return sendJson(res, 200, {
        active: state.status === 'playing',
        ...statusView(state),
        moveCount: state.history.length,
        moves: state.history.map((move, index) => ({ number: index + 1, seat: move.seatId, seatMoveIndex: move.seatMoveIndex ?? null, ownMoveIndex: move.ownMoveIndex ?? null, row: move.row, col: move.col, source: move.source, controller: move.controller ?? null, engineSuggestion: move.engineSuggestion ?? null, thoughtCardVersion: move.thoughtCardVersion ?? null, deviationReport: move.deviationReport ?? null })),
      });
    }
    if (req.method === 'POST' && pathname === '/internal/game/extend-time') {
      if (!validGameBridge(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      const current = typeof body.gameId === 'string' ? store.getGame(body.gameId) : null;
      const pending = current?.pendingDecision;
      if (!current || !pending || pending.taskId !== body.decisionId || current.version !== body.expectedVersion || pending.controller !== 'body' || current.extensionUsed) return sendJson(res, 409, { error: 'EXTENSION_UNAVAILABLE' });
      const next = { ...current, extensionUsed: true, pendingDecision: { ...pending, budgetMs: pending.budgetMs + BODY_EXTENSION_MS, extended: true }, updatedAt: new Date().toISOString() };
      if (!store.saveStateOnly(current.gameId, current.version, next)) return sendJson(res, 409, { error: 'STALE_VERSION' });
      const oldTimer = decisionTimers.get(current.gameId);
      if (oldTimer) clearTimeout(oldTimer);
      const remaining = Math.max(1, Date.parse(pending.wakeDeliveredAt) + next.pendingDecision.budgetMs - Date.now());
      decisionTimers.set(current.gameId, setTimeout(() => void handleDecisionTimeout(current.gameId, pending.taskId, current.version), remaining));
      broadcast(current.gameId);
      return sendJson(res, 200, { extended: true, extraMs: BODY_EXTENSION_MS, budgetMs: next.pendingDecision.budgetMs });
    }
    if (req.method === 'POST' && (pathname === '/internal/decision-result' || pathname === '/internal/decision-failure')) {
      if (!validGameWorker(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      if (typeof body.gameId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.gameId) || typeof body.taskId !== 'string' || typeof body.version !== 'number' || !Number.isInteger(body.version)) return sendJson(res, 400, { error: 'INVALID_DECISION_RESULT' });
      if (pathname.endsWith('decision-failure')) return sendJson(res, fallbackWorkerDecision(body.gameId, body.taskId, body.version) ? 200 : 409, { accepted: true, fallback: true });
      if (typeof body.actionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.actionId)) return sendJson(res, 400, { error: 'INVALID_DECISION_RESULT' });
      const usage = body.usage;
      if (usage !== undefined && (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 || (usage.totalTokens !== undefined && (!Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0)))) return sendJson(res, 400, { error: 'INVALID_USAGE_RECORD' });
      const accepted = commitWorkerResult(body.gameId, body.taskId, body.version, body.actionId);
      if (accepted && usage) {
        const inserted = store.recordModelUsage({ gameId: body.gameId, requestId: body.taskId, provider: 'game-decision-worker', model: typeof body.model === 'string' ? body.model.slice(0, 100) : 'unknown', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens });
        if (inserted) broadcastUsage();
      }
      return sendJson(res, accepted ? 200 : 409, { accepted });
    }
    if (req.method === 'POST' && pathname === '/api/rooms') {
      const body = await readBody(req);
      const opponent = body.opponent === 'local' ? 'local' : 'human';
      const requestedMode = ['dsh-session', 'dsh-subagent', 'dsh-dual', 'local'].includes(body.decisionMode) ? body.decisionMode : body.mode === 'hybrid' ? 'dsh-session' : 'local';
      const mode = requestedMode === 'local' ? 'local' : 'hybrid';
      const humanFirst = body.randomizeFirst !== false ? randomInt(0, 2) === 0 : body.humanFirst !== false;
      const gameId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const spectatorToken = randomBytes(32).toString('base64url');
      const initial = createGameState(gameId, mode, humanFirst, { decisionMode: requestedMode, opponent });
      const advanced = advanceGame(initial);
      const state = advanced.state;
      store.createGame(state, token, spectatorToken);
      const payload = { gameId, token, spectatorToken, observation: projectObservation(state, 'human'), status: statusView(state) };
      res.setHeader('location', '/api/games/' + gameId);
      if (advanced.task) void dispatchGameTurn(gameId, advanced.task.taskId, advanced.task.version);
      dispatchGameRecord(state, state.history);
      return sendJson(res, 201, payload);
    }

    const viewId = gameIdFrom(pathname, 'view');
    if (req.method === 'GET' && viewId) {
      const seatId = authGame(req, res, viewId); if (!seatId) return;
      const state = store.getGame(viewId); if (!state) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      return sendJson(res, 200, { observation: projectObservation(state, seatId), status: statusView(state) });
    }

    const statusId = gameIdFrom(pathname, 'status');
    if (req.method === 'GET' && statusId) {
      const seatId = authGame(req, res, statusId); if (!seatId) return;
      const state = store.getGame(statusId); if (!state) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      return sendJson(res, 200, statusView(state));
    }

    const usageId = gameIdFrom(pathname, 'usage');
    if (req.method === 'GET' && usageId) {
      const seatId = authGame(req, res, usageId); if (!seatId) return;
      const state = store.getGame(usageId); if (!state) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      return sendJson(res, 200, store.usageForGame(usageId));
    }
    const eventsId = gameIdFrom(pathname, 'events');
    if (req.method === 'GET' && eventsId) {
      const seatId = authGame(req, res, eventsId); if (!seatId) return;
      const state = store.getGame(eventsId); if (!state) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      return sendJson(res, 200, { events: store.eventsSince(eventsId, Number(url.searchParams.get('since') || 0)), observation: projectObservation(state, seatId) });
    }

    const actionId = gameIdFrom(pathname, 'actions');
    if (req.method === 'POST' && actionId) {
      const seatId = authGame(req, res, actionId); if (!seatId) return;
      if (seatId !== 'human') return sendJson(res, 403, { error: 'HUMAN_SEAT_REQUIRED' });
      const body = await readBody(req);
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId) || !Number.isInteger(body.expectedVersion) || !body.action || body.action.type !== 'place') {
        return sendJson(res, 400, { error: 'INVALID_ACTION_REQUEST' });
      }
      const replay = store.getReplay(actionId, 'human', body.requestId);
      if (replay) return sendJson(res, 200, { ...replay, replayed: true });
      const current = store.getGame(actionId); if (!current) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      if (current.opponent === 'local') return sendJson(res, 403, { error: 'READ_ONLY_GAME' });
      if (current.version !== body.expectedVersion) return sendJson(res, 409, { error: 'STALE_VERSION' });
      const next = applyMove(current, 'human', body.action, 'human', { controller: 'human' });
      const advanced = advanceGame(next);
      const finalState = advanced.state;
      const response = { observation: projectObservation(finalState, 'human'), status: statusView(finalState) };
      const commit = store.commitTransition(actionId, 'human', body.requestId, body.expectedVersion, finalState, response);
      broadcast(actionId);
      dispatchGameRecord(finalState, finalState.history.filter((item) => item.version > body.expectedVersion));
      if (advanced.task) void dispatchGameTurn(actionId, advanced.task.taskId, advanced.task.version);
      return sendJson(res, 200, { ...commit.response, replayed: commit.replayed });
    }

    const closeId = gameIdFrom(pathname, 'close');
    if (req.method === 'POST' && closeId) {
      const seatId = authGame(req, res, closeId); if (!seatId) return;
      if (seatId !== 'human') return sendJson(res, 403, { error: 'HUMAN_SEAT_REQUIRED' });
      const body = await readBody(req);
      if (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId) || !Number.isInteger(body.expectedVersion)) {
        return sendJson(res, 400, { error: 'INVALID_CLOSE_REQUEST' });
      }
      const replay = store.getReplay(closeId, 'human', body.requestId);
      if (replay) return sendJson(res, 200, { ...replay, replayed: true });
      const current = store.getGame(closeId); if (!current) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      if (current.version !== body.expectedVersion) return sendJson(res, 409, { error: 'STALE_VERSION' });
      if (current.status !== 'playing') return sendJson(res, 409, { error: 'GAME_ALREADY_ENDED' });
      const finalState = { ...current, status: 'abandoned' as const, nextSeat: null, pendingDecision: null, pendingWakeReason: null, updatedAt: new Date().toISOString(), version: current.version + 1 };
      const response = { observation: projectObservation(finalState, 'human'), status: statusView(finalState) };
      const commit = store.commitTransition(closeId, 'human', body.requestId, body.expectedVersion, finalState, response);
      const timer = decisionTimers.get(closeId);
      if (timer) clearTimeout(timer);
      decisionTimers.delete(closeId);
      broadcast(closeId);
      const recordDelivered = await dispatchGameRecord(finalState, finalState.history, { recordTiming: false });
      return sendJson(res, 200, { ...commit.response, replayed: commit.replayed, recordDelivered });
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    return sendJson(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const code = error instanceof RuleError ? error.code : error instanceof Error ? error.message : 'INTERNAL_ERROR';
    const status = code === 'STALE_VERSION' ? 409 : code === 'GAME_NOT_FOUND' ? 404 : error instanceof RuleError ? 422 : Number(error?.status) || 500;
    if (status >= 500) console.error('request_failed', { path: pathname, code: 'INTERNAL_ERROR' });
    return sendJson(res, status, { error: status >= 500 ? 'INTERNAL_ERROR' : code });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});
wss.on('connection', (ws) => {
  sockets.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (raw) => {
    if (ws.gameId) return ws.close(1008, 'already authenticated');
    try {
      const hello = JSON.parse(raw.toString());
      if (hello.type !== 'auth' || typeof hello.gameId !== 'string' || typeof hello.token !== 'string') return ws.close(1008, 'auth required');
      const seatId = store.authenticate(hello.gameId, hello.token);
      const state = seatId && store.getGame(hello.gameId);
      if (!seatId || !state) return ws.close(1008, 'unauthorized');
      ws.gameId = hello.gameId;
      ws.seatId = seatId;
      ws.send(JSON.stringify({ type: 'observation', observation: projectObservation(state, seatId) }));
      ws.send(JSON.stringify({ type: 'usage', game: store.usageForGame(hello.gameId) }));
    } catch { ws.close(1008, 'invalid message'); }
  });
  ws.on('close', () => sockets.delete(ws));
});
const heartbeat = setInterval(() => {
  for (const ws of sockets) {
    if (!ws.isAlive) { ws.terminate(); sockets.delete(ws); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
heartbeat.unref();
server.listen(PORT, HOST, () => {
  console.log('dsh-game-hub listening on http://' + HOST + ':' + PORT);
  for (const state of store.pendingGames()) {
    const pending = state.pendingDecision;
    if (!pending) continue;
    const remaining = Math.max(1, Date.parse(pending.wakeDeliveredAt) + pending.budgetMs - Date.now());
    decisionTimers.set(state.gameId, setTimeout(() => void handleDecisionTimeout(state.gameId, pending.taskId, state.version), remaining));
  }
});

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of sockets) ws.close(1001, 'server shutdown');
  server.close(() => { store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);



