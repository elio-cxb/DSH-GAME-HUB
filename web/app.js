const $ = (selector) => document.querySelector(selector);
const boardElement = $('#board');
let session = null;
let socket = null;
let observation = null;
const sourceNames = { human: '你', local: '托管', mock: '测试模拟', dsh: 'DSH', fallback: '托管（决策未完成）', forced: '系统处理' };
function setConnection(value) { $('#connection').textContent = value; }
function renderUsage(data) {
  const format = (value) => Number(value || 0).toLocaleString('zh-CN');
  $('#project-token-count').textContent = format(data.project?.totalTokens);
  $('#game-token-count').textContent = format(data.game?.totalTokens);
  $('#project-request-count').textContent = format(data.project?.requests);
  $('#game-request-count').textContent = format(data.game?.requests);
}
function render(state) {
  observation = state;
  $('#history-open').disabled = false;
  $('#mode-badge').textContent = state.status === 'finished' ? '已结束' : '对局中';
  $('#mode-badge').className = 'badge';
  $('#version').textContent = String(state.version);
  $('#stone-color').textContent = state.stones?.human === 1 ? '黑棋' : state.stones?.human === 2 ? '白棋' : '—';
  $('#turn').textContent = state.status === 'finished' ? '对局结束' : state.nextSeat === 'human' ? '你的回合' : '对手回合';
  if (state.status === 'finished') {
    $('#headline').textContent = state.draw ? '平局' : state.winner === 'human' ? '你赢了！' : '对手获胜';
    $('#message').textContent = '可以新建一局继续。';
  } else {
    $('#headline').textContent = state.nextSeat === 'human' ? '轮到你落子' : '对手思考中';
    $('#message').textContent = '点击棋盘交叉点落子。';
  }
  const history = $('#history');
  history.replaceChildren();
  state.history.forEach((move, index) => {
    const item = document.createElement('li');
    item.className = 'history-' + move.source;
    const source = move.seatId === 'human' ? '你' : sourceNames[move.source] || move.source;
    const values = [['move-number', String(index + 1)], ['move-source', source], ['move-coordinate', String.fromCharCode(65 + move.col) + (15 - move.row)]];
    for (const [className, text] of values) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      item.append(span);
    }
    history.append(item);
  });
  $('#history-summary').textContent = state.history.length ? `${state.history.length} 手 · ${state.status === 'finished' ? '对局已结束' : '对局进行中'}` : '尚无走子记录';
  const gridLines = boardElement.querySelector(".grid-lines");
  boardElement.replaceChildren();
  if (gridLines) boardElement.append(gridLines);
  const lastMove = state.history.at(-1);
  for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) {
    const value = state.board[row * 15 + col];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cell' + (value ? ' stone-' + value : '') + (lastMove?.row === row && lastMove?.col === col ? ' last' : '');
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-label', `第${row + 1}行第${col + 1}列${value ? value === state.stones.human ? '你的棋子' : '对手棋子' : '空位'}`);
    if (value) button.title = `${state.history.findIndex((move) => move.row === row && move.col === col) + 1}手`;
    button.disabled = value !== 0 || state.nextSeat !== 'human' || state.status !== 'playing';
    button.addEventListener('click', () => move(row, col));
    boardElement.append(button);
  }
}
async function request(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: `Bearer ${session.token}` } : {}), ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
function connect() {
  if (!session) return;
  if (socket) socket.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.addEventListener('open', () => { socket.send(JSON.stringify({ type: 'auth', gameId: session.gameId, token: session.token })); setConnection('已连接'); });
  socket.addEventListener('message', (event) => { try { const data = JSON.parse(event.data); if (data.type === 'observation') render(data.observation); else if (data.type === 'usage') renderUsage(data); } catch {} });
  socket.addEventListener('close', () => setConnection('已断开'));
  socket.addEventListener('error', () => setConnection('连接错误'));
}
async function newGame() {
  try {
    const data = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ mode: 'hybrid', randomizeFirst: true }) });
    session = { gameId: data.gameId, token: data.token };
    localStorage.setItem('dsh-game-session', JSON.stringify(session));
    render(data.observation); connect();
  } catch (error) { $('#message').textContent = error.message; }
}
async function resumeGame() {
  try {
    const saved = JSON.parse(localStorage.getItem('dsh-game-session') || 'null');
    if (!saved?.gameId || !saved?.token) { session = null; setConnection('离线'); return; }
    session = saved;
    const data = await request(`/api/games/${session.gameId}/view`);
    render(data.observation); connect();
  } catch (error) { $('#message').textContent = error.message; setConnection('离线'); }
}
async function move(row, col) {
  if (!session || !observation) return;
  try {
    const data = await request(`/api/games/${session.gameId}/actions`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: observation.version, action: { type: 'place', row, col } }) });
    render(data.observation);
  } catch (error) { $('#message').textContent = error.message; if (error.message === 'STALE_VERSION') await resumeGame(); }
}
$('#new-game').addEventListener('click', newGame);
$('#resume').addEventListener('click', resumeGame);
$('#history-open').addEventListener('click', () => $('#history-dialog').showModal());
$('#history-close').addEventListener('click', () => $('#history-dialog').close());
$('#history-dialog').addEventListener('click', (event) => { if (event.target === $('#history-dialog')) $('#history-dialog').close(); });
resumeGame();


