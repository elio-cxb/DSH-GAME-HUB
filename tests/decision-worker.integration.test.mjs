import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return JSON.parse(text || '{}');
}
async function waitReady(url, child) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('worker exited before ready');
    try { if ((await fetch(url + '/healthz')).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('worker did not become ready');
}

test('thin Worker sends one compact model request and posts only a validated candidate plus actual usage', async (t) => {
  const workerToken = 'worker-integration-secret-'.padEnd(40, 'x');
  let modelCalls = 0;
  let modelRequest;
  let callback;
  const modelServer = createServer(async (req, res) => {
    modelCalls++;
    modelRequest = await readJson(req);
    assert.equal(req.headers.authorization, 'Bearer test-model-key');
    const actionId = modelRequest.messages[1].content.match(/move_7_8/) ? 'move_7_8' : 'move_7_8';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actionId }) } }], usage: { prompt_tokens: 43, completion_tokens: 6, total_tokens: 49 } }));
  });
  const modelPort = await listen(modelServer);
  const hubServer = createServer(async (req, res) => {
    if (req.headers['x-game-worker-token'] !== workerToken) { res.writeHead(401); return res.end(); }
    callback = { path: req.url, body: await readJson(req) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
  });
  const hubPort = await listen(hubServer);
  t.after(async () => {
    await Promise.all([new Promise((resolve) => modelServer.close(resolve)), new Promise((resolve) => hubServer.close(resolve))]);
  });
  const workerPort = await freePort();
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--experimental-strip-types', 'src/decision-worker.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, GAME_WORKER_HOST: '127.0.0.1', GAME_WORKER_PORT: String(workerPort), GAME_HUB_URL: `http://127.0.0.1:${hubPort}`, GAME_WORKER_TOKEN: workerToken, GAME_MODEL_API_URL: `http://127.0.0.1:${modelPort}/chat/completions`, GAME_MODEL_API_KEY: 'test-model-key', GAME_MODEL_NAME: 'test-model' },
    stdio: 'ignore',
  });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); } });
  const workerUrl = `http://127.0.0.1:${workerPort}`;
  await waitReady(workerUrl, child);
  const gameId = '11111111-1111-4111-8111-111111111111';
  const task = { taskId: '22222222-2222-4222-8222-222222222222', gameId, version: 9, reason: '需要应对一步制胜威胁', companionStone: 1, board: Array(15).fill('.'.repeat(15)).join('\n'), candidates: [{ actionId: 'move_7_8', row: 7, col: 8 }, { actionId: 'move_8_8', row: 8, col: 8 }] };
  const denied = await fetch(workerUrl + '/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(task) });
  assert.equal(denied.status, 401);
  const response = await fetch(workerUrl + '/decision', { method: 'POST', headers: { 'content-type': 'application/json', 'x-game-worker-token': workerToken }, body: JSON.stringify(task) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(modelCalls, 1);
  assert.equal(modelRequest.model, 'test-model');
  assert.equal('tools' in modelRequest, false);
  assert.equal(modelRequest.messages.length, 2);
  assert.equal(callback.path, '/internal/decision-result');
  assert.equal(callback.body.actionId, 'move_7_8');
  assert.deepEqual(callback.body.usage, { inputTokens: 43, outputTokens: 6, totalTokens: 49 });
});
