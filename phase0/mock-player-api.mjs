import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const internal = {
  gameId: 'mock-game-001',
  gameType: 'blood_battle_v1',
  ruleSetVersion: 'mock-1',
  version: 7,
  phase: 'discard',
  currentSeat: 'companion',
  publicState: { turnNumber: 12, players: [{ seatId: 'human', remainingCount: 8 }, { seatId: 'companion', remainingCount: 9 }] },
  privateBySeat: {
    human: ['wan-1', 'wan-2'],
    companion: ['bamboo-3', 'dot-7'],
  },
  legalBySeat: {
    human: [{ actionId: 'h-discard-1', type: 'discard' }],
    companion: [{ actionId: 'c-discard-3', type: 'discard', tile: 'bamboo-3' }],
  },
  hidden: { opponentHand: ['SECRET_OPPONENT_CARD'], wall: ['SECRET_WALL_CARD'], rngSeed: 'SECRET_RNG_SEED' },
};

const progressToken = 'mock-progress-token';
const seatTokens = new Map([
  ['mock-human-token', 'human'],
  ['mock-companion-token', 'companion'],
]);

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function createMockServer() {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
    if (url.pathname === '/health') return send(res, 200, { ok: true });

    if (url.pathname === '/api/games/' + internal.gameId + '/status') {
      if (req.headers.authorization !== 'Bearer ' + progressToken) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, {
        gameId: internal.gameId,
        state: 'active',
        phase: internal.phase,
        turnNumber: internal.publicState.turnNumber,
        activePlayer: '小鲸鱼',
        decisionSource: 'local',
        lastAction: '托管完成了最近一步',
      });
    }

    if (url.pathname === '/api/games/' + internal.gameId + '/observation') {
      if (url.searchParams.has('seatId')) return send(res, 400, { error: 'seat_is_bound_to_token' });
      const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const seatId = seatTokens.get(token);
      if (!seatId) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, {
        gameId: internal.gameId,
        gameType: internal.gameType,
        ruleSetVersion: internal.ruleSetVersion,
        version: internal.version,
        phase: internal.phase,
        self: { seatId, role: 'player' },
        publicState: internal.publicState,
        myPrivateState: { hand: internal.privateBySeat[seatId] },
        legalActions: internal.legalBySeat[seatId],
      });
    }

    return send(res, 404, { error: 'not_found' });
  });
}

async function selfTest() {
  const server = createMockServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const base = 'http://127.0.0.1:' + address.port;
  try {
    const observationResponse = await fetch(base + '/api/games/' + internal.gameId + '/observation', {
      headers: { authorization: 'Bearer mock-companion-token' },
    });
    assert.equal(observationResponse.status, 200);
    const observation = await observationResponse.json();
    assert.equal(observation.self.seatId, 'companion');
    assert.deepEqual(observation.myPrivateState.hand, ['bamboo-3', 'dot-7']);
    const observationText = JSON.stringify(observation);
    for (const secret of Object.values(internal.hidden).flat()) assert.equal(observationText.includes(secret), false);
    assert.equal(observationText.includes('human hand'), false);

    const seatOverride = await fetch(base + '/api/games/' + internal.gameId + '/observation?seatId=human', {
      headers: { authorization: 'Bearer mock-companion-token' },
    });
    assert.equal(seatOverride.status, 400);

    const unauthenticated = await fetch(base + '/api/games/' + internal.gameId + '/observation');
    assert.equal(unauthenticated.status, 401);

    const progress = await fetch(base + '/api/games/' + internal.gameId + '/status', {
      headers: { authorization: 'Bearer ' + progressToken },
    });
    assert.equal(progress.status, 200);
    const progressBody = await progress.json();
    assert.equal(progressBody.decisionSource, 'local');
    const progressText = JSON.stringify(progressBody);
    for (const secret of Object.values(internal.hidden).flat()) assert.equal(progressText.includes(secret), false);
    assert.equal('myPrivateState' in progressBody, false);

    const deniedProgress = await fetch(base + '/api/games/' + internal.gameId + '/status');
    assert.equal(deniedProgress.status, 401);

    console.log('PASS: seat token fixes the observation; secrets and other-seat state stay out of the response.');
    console.log('PASS: progress query is separately authenticated and returns status/source only.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.argv.includes('--self-test')) {
  await selfTest();
} else {
  console.log('Run with --self-test to exercise the Phase 0 mock. This file does not connect to DSH or any model API.');
}
