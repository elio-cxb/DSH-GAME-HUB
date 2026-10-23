export const BOARD_SIZE = 15;
export type Stone = 0 | 1 | 2;
export type SeatId = 'human' | 'companion';
export type DecisionSource = 'human' | 'local' | 'mock' | 'dsh' | 'fish' | 'fallback' | 'forced';
export type CompanionMode = 'local' | 'mock' | 'hybrid';
export type DecisionMode = 'dsh-session' | 'dsh-subagent' | 'dsh-dual' | 'local';
export type GameOpponent = 'human' | 'local';
export type DecisionController = 'body' | 'fish' | 'engine';

export interface Position { row: number; col: number }
export interface MoveRecord extends Position {
  seatId: SeatId;
  stone: 1 | 2;
  source: DecisionSource;
  controller?: DecisionController | 'human';
  seatMoveIndex?: number;
  ownMoveIndex?: number;
  engineSuggestion?: { row: number; col: number; score: number } | null;
  thoughtCardVersion?: number | null;
  deviationReport?: string | null;
  note?: string | null;
  wakeDeliveredAt?: string;
  budgetMs?: number | null;
  extended?: boolean;
  version: number;
  at: string;
}
export interface GomokuState {
  gameId: string;
  mode: CompanionMode;
  decisionMode: DecisionMode;
  opponent: GameOpponent;
  humanFirst: boolean;
  modelAttempts: number;
  lastDshWakeAtCompanionMove: number | null;
  pendingDecision: { taskId: string; version: number; reason: string; controller: DecisionController; wakeDeliveredAt: string; budgetMs: number; extended: boolean; engineSuggestion?: { row: number; col: number; score: number } | null } | null;
  thoughtCard: { text: string; version: number; ropeHands: number | null; wakeAtOwnMove: number | null; wakePatterns: string[] } | null;
  lastBodyMoveIndex: number;
  fishWakeProposals: number;
  proposalReports: Array<{ ownMoveIndex: number; reason: string; accepted: boolean; at: string }>;
  pendingWakeReason: string | null;
  extensionUsed: boolean;
  stones: { human: 1 | 2; companion: 1 | 2 };
  board: Stone[];
  version: number;
  status: 'playing' | 'finished' | 'abandoned';
  nextSeat: SeatId | null;
  winner: SeatId | null;
  draw: boolean;
  history: MoveRecord[];
  createdAt: string;
  updatedAt: string;
}
export interface PlaceAction extends Position { type: 'place' }

export class RuleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RuleError';
  }
}

export function createGameState(gameId: string, mode: CompanionMode, humanFirst = true, options: { decisionMode?: DecisionMode; opponent?: GameOpponent } = {}): GomokuState {
  const now = new Date().toISOString();
  return {
    gameId,
    mode,
    decisionMode: options.decisionMode || (mode === 'hybrid' ? 'dsh-session' : 'local'),
    opponent: options.opponent || 'human',
    humanFirst,
    modelAttempts: 0,
    lastDshWakeAtCompanionMove: null,
    pendingDecision: null,
    thoughtCard: null,
    lastBodyMoveIndex: 0,
    fishWakeProposals: 0,
    proposalReports: [],
    pendingWakeReason: null,
    extensionUsed: false,
    stones: humanFirst ? { human: 1, companion: 2 } : { human: 2, companion: 1 },
    board: Array.from({ length: BOARD_SIZE * BOARD_SIZE }, () => 0 as Stone),
    version: 0,
    status: 'playing',
    nextSeat: humanFirst ? 'human' : 'companion',
    winner: null,
    draw: false,
    history: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function indexOf(row: number, col: number): number {
  return row * BOARD_SIZE + col;
}

export function legalActions(state: GomokuState): PlaceAction[] {
  if (state.status !== 'playing') return [];
  const result: PlaceAction[] = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (state.board[indexOf(row, col)] === 0) result.push({ type: 'place', row, col });
    }
  }
  return result;
}

function countRay(board: Stone[], row: number, col: number, dr: number, dc: number, stone: Stone): number {
  let count = 0;
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[indexOf(r, c)] === stone) {
    count++;
    r += dr;
    c += dc;
  }
  return count;
}

export function hasFive(board: Stone[], row: number, col: number, stone: Stone): boolean {
  const axes: Position[] = [{ row: 1, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 1 }, { row: 1, col: -1 }];
  return axes.some(({ row: dr, col: dc }) =>
    1 + countRay(board, row, col, dr, dc, stone) + countRay(board, row, col, -dr, -dc, stone) >= 5
  );
}

export function applyMove(state: GomokuState, seatId: SeatId, action: PlaceAction, source: DecisionSource, metadata: Partial<Pick<MoveRecord, 'controller' | 'seatMoveIndex' | 'engineSuggestion' | 'thoughtCardVersion' | 'deviationReport' | 'note' | 'wakeDeliveredAt' | 'budgetMs' | 'extended'>> = {}): GomokuState {
  if (state.status !== 'playing') throw new RuleError('GAME_FINISHED', 'The game has already finished.');
  if (state.nextSeat !== seatId) throw new RuleError('NOT_YOUR_TURN', 'This seat cannot move now.');
  const { row, col } = action;
  if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
    throw new RuleError('OUT_OF_BOUNDS', 'Choose an intersection inside the 15 by 15 board.');
  }
  const index = indexOf(row, col);
  if (state.board[index] !== 0) throw new RuleError('OCCUPIED', 'That intersection is occupied.');

  const board = state.board.slice();
  const stone = state.stones[seatId];
  board[index] = stone;
  const version = state.version + 1;
  const won = hasFive(board, row, col, stone);
  const full = !won && board.every((cell) => cell !== 0);
  const nextSeat = won || full ? null : seatId === 'human' ? 'companion' : 'human';
  const now = new Date().toISOString();
  const seatMoveIndex = state.history.filter((item) => item.seatId === seatId).length + 1;
  const ownMoveIndex = state.history.filter((item) => item.seatId === 'companion').length + (seatId === 'companion' ? 1 : 0);
  const move: MoveRecord = { row, col, seatId, stone, source, seatMoveIndex, ownMoveIndex, engineSuggestion: metadata.engineSuggestion ?? null, controller: metadata.controller ?? (seatId === 'human' ? 'human' : source === 'local' || source === 'fallback' ? 'engine' : 'body'), thoughtCardVersion: metadata.thoughtCardVersion ?? null, deviationReport: metadata.deviationReport ?? null, note: metadata.note ?? null, wakeDeliveredAt: metadata.wakeDeliveredAt || state.updatedAt, budgetMs: metadata.budgetMs ?? null, extended: metadata.extended ?? false, version, at: now };
  return {
    ...state,
    board,
    version,
    status: won || full ? 'finished' : 'playing',
    nextSeat,
    winner: won ? seatId : null,
    draw: full,
    history: [...state.history, move],
    updatedAt: now,
  };
}

function directionPotential(board: Stone[], row: number, col: number, dr: number, dc: number, stone: Stone): number {
  const run = 1 + countRay(board, row, col, dr, dc, stone) + countRay(board, row, col, -dr, -dc, stone);
  let open = 0;
  for (const sign of [-1, 1]) {
    const ray = countRay(board, row, col, sign * dr, sign * dc, stone);
    const r = row + sign * dr * (1 + ray);
    const c = col + sign * dc * (1 + ray);
    if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[indexOf(r, c)] === 0) open++;
  }
  if (run >= 5) return 1_000_000;
  if (run === 4) return open === 2 ? 180_000 : open === 1 ? 90_000 : 0;
  if (run === 3) return open === 2 ? 18_000 : open === 1 ? 2_500 : 0;
  if (run === 2) return open === 2 ? 1_800 : open === 1 ? 300 : 0;
  return open === 2 ? 60 : open === 1 ? 10 : 0;
}

function placementPotential(board: Stone[], row: number, col: number, stone: Stone): number {
  const axes: Position[] = [{ row: 1, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 1 }, { row: 1, col: -1 }];
  return axes.reduce((sum, axis) => sum + directionPotential(board, row, col, axis.row, axis.col, stone), 0);
}

function candidateCells(board: Stone[]): Position[] {
  const occupied: Position[] = [];
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col < BOARD_SIZE; col++) {
      if (board[indexOf(row, col)] !== 0) occupied.push({ row, col });
    }
  }
  if (occupied.length === 0) return [{ row: 7, col: 7 }];
  const candidates = new Map<number, Position>();
  for (const point of occupied) {
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const row = point.row + dr;
        const col = point.col + dc;
        if (row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE && board[indexOf(row, col)] === 0) {
          candidates.set(indexOf(row, col), { row, col });
        }
      }
    }
  }
  return [...candidates.values()];
}

export function rankLocalMoves(state: GomokuState, seatId: SeatId, limit = 12): Array<PlaceAction & { actionId: string; score: number }> {
  if (state.status !== 'playing' || state.nextSeat !== seatId) return [];
  const own = state.stones[seatId];
  const opponent = state.stones[seatId === 'human' ? 'companion' : 'human'];
  return candidateCells(state.board).map((candidate) => {
    const index = indexOf(candidate.row, candidate.col);
    const board = state.board.slice();
    board[index] = own;
    const offense = placementPotential(board, candidate.row, candidate.col, own);
    board[index] = opponent;
    const defense = placementPotential(board, candidate.row, candidate.col, opponent);
    const score = offense + defense * 1.08 - Math.abs(candidate.row - 7) - Math.abs(candidate.col - 7);
    return { ...candidate, actionId: `move_${candidate.row}_${candidate.col}`, score };
  }).sort((a, b) => b.score - a.score || a.row - b.row || a.col - b.col).slice(0, Math.max(1, limit));
}

export function hasImmediateWinningMove(state: GomokuState, seatId: SeatId): boolean {
  const stone = state.stones[seatId];
  return candidateCells(state.board).some(({ row, col }) => {
    const board = state.board.slice();
    board[indexOf(row, col)] = stone;
    return hasFive(board, row, col, stone);
  });
}

const AXES: Position[] = [{ row: 1, col: 0 }, { row: 0, col: 1 }, { row: 1, col: 1 }, { row: 1, col: -1 }];

function shapeOnAxis(board: Stone[], row: number, col: number, stone: Stone, axis: Position): { run: number; open: number } {
  const run = 1 + countRay(board, row, col, axis.row, axis.col, stone) + countRay(board, row, col, -axis.row, -axis.col, stone);
  let open = 0;
  for (const sign of [-1, 1]) {
    const ray = countRay(board, row, col, sign * axis.row, sign * axis.col, stone);
    const r = row + sign * axis.row * (1 + ray);
    const c = col + sign * axis.col * (1 + ray);
    if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && board[indexOf(r, c)] === 0) open++;
  }
  return { run, open };
}

/** Uses the same contiguous-run/open-end definition as directionPotential: open 4 =活四, one-ended 4 =冲四. */
export function tacticalShapesAtLastMove(state: GomokuState): string[] {
  const last = state.history.at(-1);
  if (!last) return [];
  const shapes = AXES.map((axis) => shapeOnAxis(state.board, last.row, last.col, last.stone, axis));
  const fours = shapes.filter((shape) => shape.run === 4 && shape.open > 0).length;
  const openFours = shapes.filter((shape) => shape.run === 4 && shape.open === 2).length;
  const openThrees = shapes.filter((shape) => shape.run === 3 && shape.open === 2).length;
  const labels: string[] = [];
  if (shapes.some((shape) => shape.run === 3 && shape.open === 2)) labels.push('活三');
  if (shapes.some((shape) => shape.run === 3 && shape.open === 1)) labels.push('眠三');
  if (shapes.some((shape) => shape.run === 4 && shape.open === 2)) labels.push('活四');
  if (shapes.some((shape) => shape.run === 4 && shape.open === 1)) labels.push('冲四');
  if (openFours > 0) labels.push('双活四');
  if (fours >= 2) labels.push('双四');
  if (fours > 0 && openThrees > 0) labels.push('四三');
  if (openThrees >= 2) labels.push('双三');
  const winningPoints = (stone: Stone) => {
    let count = 0;
    for (let row = 0; row < BOARD_SIZE; row++) for (let col = 0; col < BOARD_SIZE; col++) {
      const at = indexOf(row, col);
      if (state.board[at] !== 0) continue;
      const board = state.board.slice();
      board[at] = stone;
      if (hasFive(board, row, col, stone) && ++count >= 2) return count;
    }
    return count;
  };
  if (winningPoints(last.stone) >= 2) labels.push('双点必杀');
  return [...new Set(labels)];
}

export function forcedWakeReason(state: GomokuState): string | null {
  const labels = tacticalShapesAtLastMove(state);
  if (labels.includes('活四')) return '形成活四';
  if (labels.includes('双四')) return '形成双四';
  if (labels.includes('四三')) return '形成四三';
  if (labels.includes('双三')) return '形成双三';
  if (labels.includes('双点必杀')) return '出现双点必杀';
  if (state.nextSeat === 'companion' && hasImmediateWinningMove(state, 'companion')) return '本方胜负手';
  return null;
}

export function criticalTurnReason(state: GomokuState, seatId: SeatId): string | null {
  const other: SeatId = seatId === 'human' ? 'companion' : 'human';
  if (hasImmediateWinningMove(state, seatId)) return '自身有一步制胜机会';
  if (hasImmediateWinningMove(state, other)) return '需要应对对手的一步制胜威胁';
  return null;
}

/** Call the model only when the position has multiple similarly strong tactical routes.
 * Immediate wins and forced blocks are deterministic and stay with the local bot.
 */
export function decisionOpportunityReason(state: GomokuState, seatId: SeatId): string | null {
  const other: SeatId = seatId === 'human' ? 'companion' : 'human';
  if (hasImmediateWinningMove(state, seatId) || hasImmediateWinningMove(state, other)) return null;
  const [best, runnerUp] = rankLocalMoves(state, seatId, 2);
  if (!best || !runnerUp || best.score < 150_000 || runnerUp.score < 150_000) return null;
  if (runnerUp.score / best.score < 0.9) return null;
  return '存在多条强战术路线，适合由你选择进攻方向';
}

export function chooseLocalMove(state: GomokuState, seatId: SeatId): Position | null {
  return rankLocalMoves(state, seatId, 1)[0] ?? null;
}
