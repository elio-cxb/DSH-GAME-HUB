export const BOARD_SIZE = 15;
export type Stone = 0 | 1 | 2;
export type SeatId = 'human' | 'companion';
export type DecisionSource = 'human' | 'local' | 'mock' | 'dsh' | 'fallback' | 'forced';
export type CompanionMode = 'local' | 'mock' | 'hybrid';

export interface Position { row: number; col: number }
export interface MoveRecord extends Position {
  seatId: SeatId;
  stone: 1 | 2;
  source: DecisionSource;
  version: number;
  at: string;
}
export interface GomokuState {
  gameId: string;
  mode: CompanionMode;
  humanFirst: boolean;
  modelAttempts: number;
  pendingDecision: { taskId: string; version: number; reason: string } | null;
  stones: { human: 1 | 2; companion: 1 | 2 };
  board: Stone[];
  version: number;
  status: 'playing' | 'finished';
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

export function createGameState(gameId: string, mode: CompanionMode, humanFirst = true): GomokuState {
  const now = new Date().toISOString();
  return {
    gameId,
    mode,
    humanFirst,
    modelAttempts: 0,
    pendingDecision: null,
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

export function applyMove(state: GomokuState, seatId: SeatId, action: PlaceAction, source: DecisionSource): GomokuState {
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
  const move: MoveRecord = { row, col, seatId, stone, source, version, at: now };
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

export function criticalTurnReason(state: GomokuState, seatId: SeatId): string | null {
  const other: SeatId = seatId === 'human' ? 'companion' : 'human';
  if (hasImmediateWinningMove(state, seatId)) return '自身有一步制胜机会';
  if (hasImmediateWinningMove(state, other)) return '需要应对对手的一步制胜威胁';
  return null;
}

export function chooseLocalMove(state: GomokuState, seatId: SeatId): Position | null {
  return rankLocalMoves(state, seatId, 1)[0] ?? null;
}