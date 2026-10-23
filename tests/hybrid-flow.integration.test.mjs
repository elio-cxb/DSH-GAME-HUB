import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createServer } from 'node:http';
import { GameStore } from '../src/store.ts';
import { createGameState } from '../src/games/gomoku.ts';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}
async function waitReady(url, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before ready');
    try { if ((await fetch(url + '/healthz')).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('server did not become ready');
}

test('hybrid Gomoku sends a short bridge callback, accepts a legal DSH move, and records tagged usage', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-gomoku-hybrid-'));
  const port = await reservePort();
  const gameId = '33333333-3333-4333-8333-333333333333';
  const seatToken = 'human-seat-token-for-hybrid-integration-test';
  const bridgeSecret = 'hybrid-bridge-test-secret-'.padEnd(40, 'z');
  const base = `http://127.0.0.1:${port}`;
  const store = new GameStore(join(dataDir, 'games.sqlite'));
  const seed = createGameState(gameId, 'hybrid', true);
  const board = Array(225).fill(0);
  for (let col = 4; col <= 7; col++) board[7 * 15 + col] = seed.stones.companion;
  store.createGame({ ...seed, board }, seatToken);
  store.close();

  const bridge = createServer(async (req, res) => {
    const body = await readJson(req);
    assert.equal(req.headers['x-game-token'], bridgeSecret);
    assert.equal(req.url, '/internal/game/turn');
    assert.deepEqual(Object.keys(body).sort(), ['gameId', 'gameType']);
    assert.equal(body.gameId, gameId);
    assert.equal(body.gameType, 'gomoku');
    const view = await fetch(base + '/internal/game/view', { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-token': bridgeSecret }, body: JSON.stringify({ gameId }) }).then((r) => r.json());
    const winning = view.candidates.find((candidate) => candidate.row === 7 && (candidate.col === 3 || candidate.col === 8));
    assert.ok(winning, 'bridge gets server-selected legal candidates');
    const playBody = { gameId, requestId: 'dsh_move_request_0001', expectedVersion: view.version, actionId: winning.actionId };
    const played = await fetch(base + '/internal/game/play', { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-token': bridgeSecret }, body: JSON.stringify(playBody) });
    assert.equal(played.status, 200);
    const replay = await fetch(base + '/internal/game/play', { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-token': bridgeSecret }, body: JSON.stringify(playBody) }).then((r) => r.json());
    assert.equal(replay.replayed, true, 'retry with same request id is idempotent');
    const usage = await fetch(base + '/internal/game-usage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-token': bridgeSecret }, body: JSON.stringify({ gameId, requestId: 'dsh_usage_request_0001', model: 'mock-route-a', provider: 'dsh-main-session', inputTokens: 20, outputTokens: 4, totalTokens: 24 }) });
    assert.equal(usage.status, 201);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, mode: 'dsh-session' }));
  });
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(0, '127.0.0.1', resolve); });
  const bridgePort = bridge.address().port;
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DSH_GAME_DATA_DIR: dataDir, GAME_BRIDGE_URL: `http://127.0.0.1:${bridgePort}/internal/game/turn`, GAME_BRIDGE_SECRET: bridgeSecret, GAME_DECISION_TIMEOUT_MS: '5000' },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]); }
    await new Promise((resolve) => bridge.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  await waitReady(base, child);
  const action = { requestId: 'human_critical_move_0001', expectedVersion: 0, action: { type: 'place', row: 0, col: 0 } };
  const moved = await fetch(base + `/api/games/${gameId}/actions`, { method: 'POST', headers: { authorization: `Bearer ${seatToken}`, 'content-type': 'application/json' }, body: JSON.stringify(action) });
  assert.equal(moved.status, 200);
  const pending = await moved.json();
  assert.equal(pending.observation.decisionPending, true);
  let finished;
  for (let attempt = 0; attempt < 40; attempt++) {
    finished = await (await fetch(base + `/api/games/${gameId}/view`, { headers: { authorization: `Bearer ${seatToken}` } })).json();
    if (finished.observation.history.some((move) => move.source === 'dsh')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const dshMove = finished.observation.history.find((move) => move.source === 'dsh');
  assert.ok(dshMove, 'DSH move is persisted');
  assert.equal(dshMove.row, 7);
  assert.ok([3, 8].includes(dshMove.col));
  const usage = await (await fetch(base + `/api/games/${gameId}/usage`, { headers: { authorization: `Bearer ${seatToken}` } })).json();
  assert.equal(usage.totalTokens, 24);
  assert.equal(usage.requests, 1);
});
