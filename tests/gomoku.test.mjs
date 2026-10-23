import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameState, applyMove, chooseLocalMove, criticalTurnReason, rankLocalMoves, hasFive, legalActions, RuleError } from '../src/games/gomoku.ts';

function playSequence(state, seat, points, source = 'human') {
  for (const [row, col] of points) state = applyMove(state, seat, { type: 'place', row, col }, source);
  return state;
}

test('freestyle gomoku detects horizontal, vertical, and diagonal five', () => {
  for (const points of [
    [[7, 3], [7, 4], [7, 5], [7, 6], [7, 7]],
    [[3, 7], [4, 7], [5, 7], [6, 7], [7, 7]],
    [[3, 3], [4, 4], [5, 5], [6, 6], [7, 7]],
    [[3, 7], [4, 6], [5, 5], [6, 4], [7, 3]],
  ]) {
    const board = Array(225).fill(0);
    for (const [row, col] of points) board[row * 15 + col] = 1;
    assert.equal(hasFive(board, ...points.at(-1), 1), true);
  }
});

test('rules reject wrong seat, occupied cells, and out-of-bounds moves', () => {
  const state = createGameState('test-game', 'local');
  assert.throws(() => applyMove(state, 'companion', { type: 'place', row: 7, col: 7 }, 'local'), (e) => e instanceof RuleError && e.code === 'NOT_YOUR_TURN');
  assert.throws(() => applyMove(state, 'human', { type: 'place', row: 15, col: 7 }, 'human'), (e) => e.code === 'OUT_OF_BOUNDS');
  const moved = applyMove(state, 'human', { type: 'place', row: 7, col: 7 }, 'human');
  assert.throws(() => applyMove(moved, 'companion', { type: 'place', row: 7, col: 7 }, 'local'), (e) => e.code === 'OCCUPIED');
});

test('winner ends game and legal action list becomes empty', () => {
  let state = createGameState('win-game', 'local');
  const human = [[7, 2], [7, 3], [7, 4], [7, 5], [7, 6]];
  const other = [[0, 0], [1, 0], [2, 0], [3, 0]];
  for (let i = 0; i < 4; i++) {
    state = applyMove(state, 'human', { type: 'place', row: human[i][0], col: human[i][1] }, 'human');
    state = applyMove(state, 'companion', { type: 'place', row: other[i][0], col: other[i][1] }, 'local');
  }
  state = applyMove(state, 'human', { type: 'place', row: human[4][0], col: human[4][1] }, 'human');
  assert.equal(state.winner, 'human');
  assert.equal(state.status, 'finished');
  assert.equal(legalActions(state).length, 0);
  assert.throws(() => applyMove(state, 'companion', { type: 'place', row: 8, col: 8 }, 'local'), (e) => e.code === 'GAME_FINISHED');
});

test('local Bot always chooses a legal move for 100 AI-vs-AI games', () => {
  for (let game = 0; game < 100; game++) {
    let state = createGameState('bot-' + game, 'local', game % 2 === 0);
    let steps = 0;
    while (state.status === 'playing' && steps < 225) {
      const seat = state.nextSeat;
      const move = chooseLocalMove(state, seat);
      assert.ok(move, 'bot has a move while board is live');
      assert.equal(state.board[move.row * 15 + move.col], 0);
      state = applyMove(state, seat, { type: 'place', ...move }, seat === 'human' ? 'human' : 'local');
      steps++;
    }
    assert.equal(state.status, 'finished', 'game finishes in at most 225 turns');
    assert.ok(steps <= 225);
  }
});
test('hybrid scorer escalates immediate wins and must-block threats with legal candidate ids', () => {
  const base = createGameState('critical-game', 'hybrid', true);
  const board = Array(225).fill(0);
  for (let col = 4; col <= 7; col++) board[7 * 15 + col] = base.stones.companion;
  const winning = { ...base, board, nextSeat: 'companion' };
  assert.equal(criticalTurnReason(winning, 'companion'), '自身有一步制胜机会');
  const ranked = rankLocalMoves(winning, 'companion', 12);
  assert.ok(ranked.some((move) => move.actionId === 'move_7_3' || move.actionId === 'move_7_8'));

  const threatBoard = Array(225).fill(0);
  for (let col = 4; col <= 7; col++) threatBoard[7 * 15 + col] = base.stones.human;
  const blocking = { ...base, board: threatBoard, nextSeat: 'companion' };
  assert.equal(criticalTurnReason(blocking, 'companion'), '需要应对对手的一步制胜威胁');
});
