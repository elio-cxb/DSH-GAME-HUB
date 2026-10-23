import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const HOST = process.env.GAME_WORKER_HOST || '127.0.0.1';
const PORT = Number(process.env.GAME_WORKER_PORT || 8788);
const GAME_HUB_URL = (process.env.GAME_HUB_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WORKER_TOKEN = process.env.GAME_WORKER_TOKEN || '';
const MODEL_API_URL = process.env.GAME_MODEL_API_URL || '';
const MODEL_API_KEY = process.env.GAME_MODEL_API_KEY || '';
const MODEL_NAME = process.env.GAME_MODEL_NAME || '';
const PERSONA = (process.env.GAME_PERSONA || '你是小鲸鱼，正在和用户下五子棋。自然、简短地替自己选择一步。').slice(0, 240);
const TIMEOUT_MS = Math.max(1000, Math.min(60000, Number(process.env.GAME_DECISION_TIMEOUT_MS || 20000)));
const MAX_BODY = 16 * 1024;

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
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
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error('INVALID_JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function authorized(req) {
  const token = req.headers['x-game-worker-token'];
  if (!WORKER_TOKEN || WORKER_TOKEN.length < 32 || typeof token !== 'string') return false;
  const received = Buffer.from(token);
  const expected = Buffer.from(WORKER_TOKEN);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
function validTask(task) {
  return task && typeof task.taskId === 'string' && /^[a-f0-9-]{36}$/.test(task.taskId)
    && typeof task.gameId === 'string' && /^[a-f0-9-]{36}$/.test(task.gameId)
    && Number.isSafeInteger(task.version) && task.version >= 0
    && typeof task.reason === 'string' && task.reason.length <= 120
    && typeof task.board === 'string' && task.board.split('\n').length === 15 && task.board.split('\n').every((line) => /^[.XO]{15}$/.test(line))
    && Array.isArray(task.candidates) && task.candidates.length > 0 && task.candidates.length <= 12
    && task.candidates.every((action) => action && typeof action.actionId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(action.actionId) && Number.isInteger(action.row) && action.row >= 0 && action.row < 15 && Number.isInteger(action.col) && action.col >= 0 && action.col < 15);
}
function extractJson(text) {
  if (typeof text !== 'string' || text.length > 2000) throw new Error('INVALID_MODEL_OUTPUT');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.actionId !== 'string') throw new Error('INVALID_MODEL_OUTPUT');
  return parsed.actionId;
}
async function postResult(path, body) {
  const response = await fetch(GAME_HUB_URL + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-game-worker-token': WORKER_TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('GAME_SERVER_REJECTED_RESULT');
  return response.json();
}
async function failTask(task) {
  try { await postResult('/internal/decision-failure', { gameId: task.gameId, taskId: task.taskId, version: task.version }); }
  catch { /* Game server also has a bounded timeout and local fallback. */ }
}
async function decide(task) {
  if (!MODEL_API_URL || !MODEL_API_KEY || !MODEL_NAME) throw new Error('MODEL_PROVIDER_NOT_CONFIGURED');
  const endpoint = new URL(MODEL_API_URL);
  if (endpoint.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname)) throw new Error('MODEL_ENDPOINT_MUST_USE_HTTPS');
  const prompt = {
    game: 'gomoku_free_v1',
    reason: task.reason,
    yourStone: task.companionStone === 1 ? 'X (black)' : 'O (white)',
    board: task.board,
    coordinates: 'row and col are zero-based; row 0 is the top edge.',
    candidates: task.candidates,
    instruction: 'Choose one candidate actionId. Do not invent a move. Return JSON only: {"actionId":"..."}.',
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + MODEL_API_KEY },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: [{ role: 'system', content: PERSONA + ' 只根据给出的本人可见棋盘和候选点选择落子。只能输出 JSON 对象 {"actionId":"候选编号"}，不能输出其他文字。' }, { role: 'user', content: JSON.stringify(prompt) }],
      temperature: 0.1,
      max_tokens: 96,
      stream: false,
      response_format: { type: 'json_object' },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('MODEL_PROVIDER_ERROR');
  const payload = await response.json();
  const actionId = extractJson(payload?.choices?.[0]?.message?.content);
  if (!task.candidates.some((candidate) => candidate.actionId === actionId)) throw new Error('MODEL_SELECTED_ILLEGAL_ACTION');
  const rawUsage = payload?.usage;
  const usage = rawUsage && Number.isSafeInteger(rawUsage.prompt_tokens) && rawUsage.prompt_tokens >= 0
    && Number.isSafeInteger(rawUsage.completion_tokens) && rawUsage.completion_tokens >= 0
    ? { inputTokens: rawUsage.prompt_tokens, outputTokens: rawUsage.completion_tokens, ...(Number.isSafeInteger(rawUsage.total_tokens) && rawUsage.total_tokens >= 0 ? { totalTokens: rawUsage.total_tokens } : {}) }
    : undefined;
  return { actionId, usage };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true, modelConfigured: Boolean(MODEL_API_URL && MODEL_API_KEY && MODEL_NAME) });
  if (req.method !== 'POST' || url.pathname !== '/decision') return send(res, 404, { error: 'NOT_FOUND' });
  if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED' });
  let task;
  try { task = await readBody(req); }
  catch (error) { return send(res, error.status || 400, { error: error.message }); }
  if (!validTask(task)) return send(res, 400, { error: 'INVALID_DECISION_TASK' });
  try {
    const result = await decide(task);
    const accepted = await postResult('/internal/decision-result', { gameId: task.gameId, taskId: task.taskId, version: task.version, actionId: result.actionId, model: MODEL_NAME, ...(result.usage ? { usage: result.usage } : {}) });
    return send(res, accepted.accepted ? 200 : 409, accepted);
  } catch (error) {
    await failTask(task);
    const code = error instanceof Error ? error.message : 'DECISION_FAILED';
    console.error('game_decision_failed', { code });
    return send(res, 502, { error: 'DECISION_FAILED' });
  }
});
server.listen(PORT, HOST, () => console.log(`game decision worker listening on http://${HOST}:${PORT}`));
