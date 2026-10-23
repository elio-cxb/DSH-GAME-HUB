import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { GameStore } from './store.ts';
import { applyMove, chooseLocalMove, createGameState, criticalTurnReason, legalActions, rankLocalMoves, RuleError } from './games/gomoku.ts';

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
const configuredCallLimit = Number(process.env.GAME_LLM_CALLS_MAX || 8);
const GAME_LLM_CALLS_MAX = Number.isFinite(configuredCallLimit) ? Math.max(0, Math.min(8, Math.floor(configuredCallLimit))) : 8;
const GAME_DECISION_TIMEOUT_MS = Math.max(1000, Math.min(90000, Number(process.env.GAME_KEYTURN_TIMEOUT_MS || process.env.GAME_DECISION_TIMEOUT_MS || 90000)));
const store = new GameStore(DB_PATH);
const sockets = new Set();
const decisionTimers = new Map();

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

function companionTask(state) {
  const reason = criticalTurnReason(state, 'companion');
  if (!reason || state.mode !== 'hybrid' || !GAME_BRIDGE_URL || GAME_BRIDGE_SECRET.length < 32 || (state.modelAttempts || 0) >= GAME_LLM_CALLS_MAX) return null;
  const candidates = rankLocalMoves(state, 'companion', 12).map(({ row, col, actionId }) => ({ actionId, row, col }));
  const taskId = randomUUID();
  return {
    taskId,
    reason,
    candidates,
    state: { ...state, modelAttempts: (state.modelAttempts || 0) + 1, pendingDecision: { taskId, version: state.version, reason } },
  };
}

function commitWorkerResult(gameId, taskId, version, actionId) {
  const current = store.getGame(gameId);
  if (!current || current.version !== version || current.nextSeat !== 'companion' || current.pendingDecision?.taskId !== taskId) return false;
  const candidate = rankLocalMoves(current, 'companion', 12).find((item) => item.actionId === actionId);
  if (!candidate || !legalActions(current).some((action) => action.row === candidate.row && action.col === candidate.col)) return false;
  const next = applyMove({ ...current, pendingDecision: null }, 'companion', { type: 'place', row: candidate.row, col: candidate.col }, 'dsh');
  const response = { accepted: true, version: next.version };
  store.commitTransition(gameId, 'companion', taskId, version, next, response);
  const timer = decisionTimers.get(gameId);
  if (timer) clearTimeout(timer);
  decisionTimers.delete(gameId);
  broadcast(gameId);
  return true;
}

function fallbackWorkerDecision(gameId, taskId, version) {
  const current = store.getGame(gameId);
  if (!current || current.version !== version || current.nextSeat !== 'companion' || current.pendingDecision?.taskId !== taskId) return false;
  const move = chooseLocalMove(current, 'companion');
  if (!move) return false;
  const next = applyMove({ ...current, pendingDecision: null }, 'companion', { type: 'place', ...move }, 'fallback');
  const response = { accepted: true, version: next.version, fallback: true };
  store.commitTransition(gameId, 'companion', taskId, version, next, response);
  const timer = decisionTimers.get(gameId);
  if (timer) clearTimeout(timer);
  decisionTimers.delete(gameId);
  broadcast(gameId);
  return true;
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
    if (result.mode === 'local') return fallbackWorkerDecision(gameId, taskId, version);
    if (result.accepted !== true) throw new Error('GAME_TURN_NOT_ACCEPTED');
    const latest = store.getGame(gameId);
    if (!latest || latest.pendingDecision?.taskId !== taskId || latest.version !== version) return;
    const timer = setTimeout(() => fallbackWorkerDecision(gameId, taskId, version), GAME_DECISION_TIMEOUT_MS);
    decisionTimers.set(gameId, timer);
  } catch {
    fallbackWorkerDecision(gameId, taskId, version);
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
    history: state.history,
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
    phase: state.status,
    version: state.version,
    turn: state.nextSeat,
    decisionPending: Boolean(state.pendingDecision),
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
  const project = store.usageForProject();
  for (const client of sockets) {
    if (client.readyState === 1 && client.gameId) {
      client.send(JSON.stringify({ type: 'usage', project, game: store.usageForGame(client.gameId) }));
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
      if (typeof body.gameId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.gameId)
        || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)
        || typeof body.model !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(body.model)
        || (body.provider !== undefined && !['dsh-main-session', 'dsh-game-worker'].includes(body.provider))
        || !validCount(body.inputTokens) || !validCount(body.outputTokens)
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
      const candidates = rankLocalMoves(state, 'companion', 12).map(({ actionId, row, col }) => ({ actionId, row, col }));
      const lastMoves = state.history.slice(-2).map((move) => ({ seat: move.seatId === 'companion' ? 'you' : 'opponent', row: move.row, col: move.col }));
      return sendJson(res, 200, {
        gameId: state.gameId,
        version: state.version,
        board: serializeBoard(state),
        yourStone: state.stones.companion === 1 ? 'X (black)' : 'O (white)',
        reason: state.pendingDecision.reason,
        lastMoves,
        candidates,
        instruction: 'Choose only one listed actionId. Use game_play once; do not make another move if it is rejected.'
      });
    }
    if (pathname === '/internal/game/play' && req.method === 'POST') {
      if (!validGameBridge(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      if (typeof body.gameId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.gameId)
        || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId)
        || !Number.isSafeInteger(body.expectedVersion) || typeof body.actionId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(body.actionId)) {
        return sendJson(res, 400, { error: 'INVALID_ACTION_REQUEST' });
      }
      const replay = store.getReplay(body.gameId, 'companion', body.requestId);
      if (replay) return sendJson(res, 200, { ...replay, replayed: true });
      const current = store.getGame(body.gameId);
      if (!current) return sendJson(res, 404, { error: 'GAME_NOT_FOUND' });
      if (current.version !== body.expectedVersion || current.nextSeat !== 'companion' || !current.pendingDecision) return sendJson(res, 409, { error: 'STALE_OR_UNAVAILABLE_TURN' });
      const taskId = current.pendingDecision.taskId;
      const candidate = rankLocalMoves(current, 'companion', 12).find((item) => item.actionId === body.actionId);
      if (!candidate || !legalActions(current).some((action) => action.row === candidate.row && action.col === candidate.col)) return sendJson(res, 422, { error: 'ILLEGAL_ACTION' });
      const next = applyMove({ ...current, pendingDecision: null }, 'companion', { type: 'place', row: candidate.row, col: candidate.col }, 'dsh');
      const response = { accepted: true, gameId: body.gameId, version: next.version, moveNumber: next.history.length, row: candidate.row, col: candidate.col, finished: next.status === 'finished', winner: next.winner, draw: next.draw };
      const commit = store.commitTransition(body.gameId, 'companion', body.requestId, body.expectedVersion, next, response);
      const timer = decisionTimers.get(body.gameId);
      if (timer) clearTimeout(timer);
      decisionTimers.delete(body.gameId);
      broadcast(body.gameId);
      return sendJson(res, 200, { ...commit.response, replayed: commit.replayed });
    }
    if (pathname === '/internal/game/status' && req.method === 'POST') {
      if (!validGameBridge(req)) return sendJson(res, 401, { error: 'UNAUTHORIZED' });
      const body = await readBody(req);
      const state = typeof body.gameId === 'string' ? store.getGame(body.gameId) : store.activeGames()[0] || null;
      if (!state) return sendJson(res, 200, { active: false, phase: 'none' });
      return sendJson(res, 200, { active: state.status === 'playing', ...statusView(state) });
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
      const mode = body.mode === 'mock' ? 'mock' : body.mode === 'hybrid' ? 'hybrid' : 'local';
      const humanFirst = body.randomizeFirst === true ? randomInt(0, 2) === 0 : body.humanFirst !== false;
      const gameId = randomUUID();
      const token = randomBytes(32).toString('base64url');
      let state = createGameState(gameId, mode, humanFirst);
      if (!humanFirst) state = playCompanion(state);
      store.createGame(state, token);
      const payload = { gameId, token, observation: projectObservation(state, 'human'), status: statusView(state) };
      res.setHeader('location', '/api/games/' + gameId);
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
      if (current.version !== body.expectedVersion) return sendJson(res, 409, { error: 'STALE_VERSION' });
      let next = applyMove(current, 'human', body.action, 'human');
      const task = next.nextSeat === 'companion' ? companionTask(next) : null;
      if (task) next = task.state;
      else next = playCompanion(next);
      const response = { observation: projectObservation(next, 'human'), status: statusView(next) };
      const commit = store.commitTransition(actionId, 'human', body.requestId, body.expectedVersion, next, response);
      broadcast(actionId);
      if (task) void dispatchGameTurn(actionId, task.taskId, next.version);
      return sendJson(res, 200, { ...commit.response, replayed: commit.replayed });
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
      ws.send(JSON.stringify({ type: 'usage', project: store.usageForProject(), game: store.usageForGame(hello.gameId) }));
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
    const taskId = state.pendingDecision?.taskId;
    if (taskId) fallbackWorkerDecision(state.gameId, taskId, state.version);
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



