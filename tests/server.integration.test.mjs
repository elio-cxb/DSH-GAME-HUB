import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import WebSocket from 'ws';

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitReady(url, child) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('server exited before ready');
    try { const response = await fetch(url + '/healthz'); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('server did not become ready');
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 4000))]);
}
function startServer(port, dataDir, workerToken) {
  return spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DSH_GAME_DATA_DIR: dataDir, DSH_GAME_USAGE_TOKEN: workerToken },
    stdio: 'ignore',
  });
}

test('HTTP auth, idempotency, game-only token usage, WebSocket auth, and restart recovery', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-game-hub-'));
  const port = await reservePort();
  const workerToken = 'integration-only-game-worker-token';
  const base = 'http://127.0.0.1:' + port;
  const auth = (token) => ({ authorization: 'Bearer ' + token });
  let child = startServer(port, dataDir, workerToken);
  t.after(async () => { await stop(child); await rm(dataDir, { recursive: true, force: true }); });
  await waitReady(base, child);
  let sawHumanBlack = false;
  let sawHumanWhite = false;
  for (let index = 0; index < 32; index++) {
    const randomRoomResponse = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'hybrid', randomizeFirst: true }) });
    assert.equal(randomRoomResponse.status, 201);
    const randomRoom = await randomRoomResponse.json();
    const view = randomRoom.observation;
    if (view.stones.human === 1) {
      sawHumanBlack = true;
      assert.equal(view.nextSeat, 'human');
      assert.equal(view.history.length, 0);
    } else {
      sawHumanWhite = true;
      assert.equal(view.nextSeat, 'human');
      assert.equal(view.history.length, 1);
      assert.equal(view.history[0].seatId, 'companion');
    }
  }
  assert.equal(sawHumanBlack, true, 'randomized rooms include human as black/first');
  assert.equal(sawHumanWhite, true, 'randomized rooms include human as white/second');

  const createdResponse = await fetch(base + '/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'mock' }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.token, /^[A-Za-z0-9_-]{40,}$/);
  const { gameId, token } = created;
  const spectatorToken = created.spectatorToken;
  assert.match(spectatorToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal((await fetch(base + `/api/games/${gameId}/status`)).status, 401);
  assert.equal((await fetch(base + `/api/games/${gameId}/status?token=${token}`)).status, 401, 'token in URL is not accepted');
  assert.equal((await fetch(base + `/api/games/${gameId}/status`, { headers: auth('x'.repeat(48)) })).status, 401);
  assert.equal((await fetch(base + `/api/games/${gameId}/status`, { headers: auth(token) })).status, 200);
  assert.equal((await fetch(base + `/api/games/${gameId}/status`, { headers: auth(spectatorToken) })).status, 200, 'read-only spectator token can inspect status');

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  t.after(() => ws.readyState === WebSocket.CLOSED ? undefined : ws.close());
  const wsObservation = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket auth timed out')), 3000);
    ws.once('open', () => ws.send(JSON.stringify({ type: 'auth', gameId, token })));
    ws.once('message', (message) => { clearTimeout(timer); resolve(JSON.parse(message.toString())); });
    ws.once('error', reject);
  });
  const wsData = await wsObservation;
  assert.equal(wsData.type, 'observation');
  assert.equal(wsData.observation.seatId, 'human');

  const firstView = await (await fetch(base + `/api/games/${gameId}/view`, { headers: auth(token) })).json();
  const empty = firstView.observation.legalActions[0];
  const action = { requestId: 'request_move_0001', expectedVersion: firstView.observation.version, action: { type: 'place', row: empty.row, col: empty.col } };
  const submit = () => fetch(base + `/api/games/${gameId}/actions`, { method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify(action) });
  const first = await submit();
  assert.equal(first.status, 200);
  const firstResult = await first.json();
  assert.ok(firstResult.observation.history.length >= 2, 'human move and companion response persisted atomically');
  assert.equal(firstResult.observation.history.at(-1).source, 'local');
  const spectatorWrite = await fetch(base + `/api/games/${gameId}/actions`, { method: 'POST', headers: { ...auth(spectatorToken), 'content-type': 'application/json' }, body: JSON.stringify(action) });
  assert.equal(spectatorWrite.status, 403, 'spectator token cannot submit moves');
  const replay = await submit();
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);

  const usageBody = { gameId, requestId: 'dsh-usage-0001', model: 'deepseek-flash', inputTokens: 120, outputTokens: 30, totalTokens: 150 };
  const ingest = (headers) => fetch(base + '/internal/game-usage', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(usageBody) });
  assert.equal((await ingest({})).status, 401, 'usage ingestion requires the game worker secret');
  assert.equal((await ingest({ 'x-game-worker-token': workerToken })).status, 201);
  const duplicateUsage = await ingest({ 'x-game-worker-token': workerToken });
  assert.equal(duplicateUsage.status, 200);
  assert.equal((await duplicateUsage.json()).duplicate, true);
  assert.equal((await fetch(base + `/api/games/${gameId}/usage`, { headers: auth(token) })).status, 200);
  const usageSummary = await (await fetch(base + `/api/games/${gameId}/usage`, { headers: auth(token) })).json();
  assert.deepEqual({ requests: usageSummary.requests, inputTokens: usageSummary.inputTokens, outputTokens: usageSummary.outputTokens, totalTokens: usageSummary.totalTokens }, { requests: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150 });

  const badMove = await fetch(base + `/api/games/${gameId}/actions`, { method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'request_bad_move', expectedVersion: firstResult.observation.version, action: { type: 'place', row: empty.row, col: empty.col } }) });
  assert.equal(badMove.status, 422);

  await stop(child);
  child = startServer(port, dataDir, workerToken);
  await waitReady(base, child);
  const restored = await fetch(base + `/api/games/${gameId}/view`, { headers: auth(token) });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).observation.version, firstResult.observation.version);
  const restoredUsage = await (await fetch(base + `/api/games/${gameId}/usage`, { headers: auth(token) })).json();
  assert.equal(restoredUsage.totalTokens, 150);
});
