const $ = (selector) => document.querySelector(selector);
const boardElement = $('#board');
let session = null;
let socket = null;
let observation = null;
let liveObservation = null;
let frames = [];
let paused = false;
let currentFrameIndex = 0;
let replayDelayMs = 5000;
let closingGame = false;
const sourceNames = { human: '皮皮', local: '本地引擎', mock: '测试模拟', dsh: '本体', fish: '下棋鱼', fallback: '引擎兜底', forced: '系统处理' };

function setConnection(value) { $('#connection').textContent = value; }
function formatCoord(point) { return String.fromCharCode(65 + point.col) + (15 - point.row); }
function renderUsage(data) {
  const format = (value) => Number(value || 0).toLocaleString('zh-CN');
  $('#game-token-count').textContent = format(data.game?.totalTokens);
  $('#game-request-count').textContent = format(data.game?.requests);
  $('#game-cache-hit').textContent = format(data.game?.cacheHitTokens);
  $('#game-cache-miss').textContent = format(data.game?.cacheMissTokens);
  const cacheKnownInput = Number(data.game?.cacheHitTokens || 0) + Number(data.game?.cacheMissTokens || 0) + Number(data.game?.cacheWriteTokens || 0);
  $('#game-cache-ratio').textContent = cacheKnownInput > 0
    ? (Number(data.game?.cacheHitTokens || 0) / cacheKnownInput * 100).toFixed(1) + '%'
    : '暂无数据';
  $('#game-cache-known').textContent = format(data.game?.cacheBreakdownRequests);
  $('#game-cache-total').textContent = format(data.game?.requests);
  $('#usage-cache-note').textContent = data.game?.cacheBreakdownRequests
    ? `缓存分桶已覆盖 ${format(data.game.cacheBreakdownRequests)} / ${format(data.game.requests)} 条请求；旧记录或 Worker 请求可能没有缓存明细。`
    : '目前没有带缓存分桶的请求记录。';
  const tbody = $('#usage-request-rows');
  tbody.replaceChildren();
  for (const request of [...(data.game?.requestDetails || [])].reverse()) {
    const row = document.createElement('tr');
    const cells = [
      request.createdAt ? new Date(request.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—',
      request.turn == null ? (request.provider === 'game-decision-worker' ? 'Worker' : '—') : `T${request.turn} · S${request.step ?? '—'} · R${request.retry ?? 0}`,
      request.cacheBreakdownKnown ? format(request.cacheHitTokens) : '—',
      request.cacheBreakdownKnown ? format(request.cacheMissTokens) : '—',
      request.cacheBreakdownKnown ? format(request.cacheWriteTokens) : '—',
      format(Number(request.outputTokens || 0) + Number(request.reasoningTokens || 0))
    ];
    for (const value of cells) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    tbody.append(row);
  }
}

function acceptObservation(state) {
  if (!state) return;
  if (liveObservation?.gameId !== state.gameId) $('#thought-card-panel').open = false;
  liveObservation = state;
  const existing = frames.findIndex((frame) => frame.state.version === state.version);
  const frame = { state, receivedAt: performance.now() };
  if (existing >= 0) frames[existing] = frame;
  else frames.push(frame);
  frames.sort((a, b) => a.state.version - b.state.version);
  if (frames.length > 300) { frames.shift(); currentFrameIndex = Math.max(0, currentFrameIndex - 1); }
  if (!paused) currentFrameIndex = latestAvailableIndex();
  renderPlayback();
}

function latestAvailableIndex() {
  if (!session?.spectator) return frames.length - 1;
  const cutoff = performance.now() - replayDelayMs;
  let index = frames.findIndex((frame) => frame.receivedAt > cutoff);
  return index < 0 ? frames.length - 1 : Math.max(0, index - 1);
}

function renderPlayback() {
  if (!frames.length) return;
  $('#replay-controls').hidden = !session?.spectator;
  if (!paused) currentFrameIndex = latestAvailableIndex();
  currentFrameIndex = Math.max(0, Math.min(frames.length - 1, currentFrameIndex));
  render(frames[currentFrameIndex].state);
  $('#replay-position').textContent = `${frames[currentFrameIndex].state.history.length} / ${liveObservation?.history.length || 0} 手`;
  $('#replay-pause').textContent = paused ? '继续' : '暂停';
  $('#replay-back').disabled = currentFrameIndex <= 0;
  $('#replay-forward').disabled = currentFrameIndex >= latestAvailableIndex();
}

function render(state) {
  observation = state;
  const live = liveObservation || state;
  $('#history-open').disabled = false;
  $('#copy-watch-link').disabled = !session?.spectatorToken;
  $('#mode-badge').textContent = state.status === 'playing' ? '对局中' : state.status === 'abandoned' ? '已中止' : '已结束';
  $('#mode-badge').className = 'badge';
  const closeButton = $('#close-game');
  closeButton.hidden = Boolean(session?.spectator) || state.status !== 'playing';
  closeButton.disabled = closingGame;
  closeButton.textContent = closingGame ? '正在结束…' : '结束本局';
  $('#version').textContent = String(state.version);
  const humanLabel = session?.spectator ? (state.opponent === 'local' ? '本地引擎' : '皮皮') : '你';
  const humanStone = state.stones?.human;
  $('#stone-label').textContent = session?.spectator ? '对弈席位' : '你的棋子';
  $('#stone-color').textContent = humanStone === 1 ? `${humanLabel}执黑` : humanStone === 2 ? `${humanLabel}执白` : '—';
  if (state.status === 'finished') {
    $('#headline').textContent = state.draw ? '平局' : state.winner === 'companion' ? '小鲸鱼获胜' : state.opponent === 'local' ? '本地引擎获胜' : '皮皮获胜';
    $('#message').textContent = '可以新建一局继续。';
  } else if (state.status === 'abandoned') {
    $('#headline').textContent = '本局已中止';
    $('#message').textContent = '本局记录已归档，可以新建一局继续。';
  } else {
    $('#headline').textContent = state.nextSeat === 'human'
      ? (session?.spectator ? `${humanLabel}回合` : '轮到你')
      : '小鲸鱼回合';
    $('#message').textContent = '棋局按当前决策模式进行。';
  }
  const thoughtCard = $('#thought-card-panel');
  thoughtCard.hidden = !state.thoughtCard?.text;
  $('#thought-card-text').textContent = state.thoughtCard?.text || '';
  $('#turn').textContent = state.status !== 'playing' ? '对局结束' : state.nextSeat === 'human' ? humanLabel : '小鲸鱼';
  const history = $('#history');
  history.replaceChildren();
  state.history.forEach((move, index) => {
    const item = document.createElement('li');
    item.className = 'history-' + move.source;
    const actor = move.seatId === 'companion'
      ? move.controller === 'fish' ? '下棋鱼' : move.controller === 'engine' ? '引擎兜底' : '本体'
      : state.opponent === 'local' ? '本地引擎' : '皮皮';
    const values = [['move-number', String(index + 1)], ['move-source', actor], ['move-coordinate', formatCoord(move)]];
    if (move.seatId === 'companion') {
      const ownMoveIndex = move.ownMoveIndex ?? state.history.slice(0, index + 1).filter((entry) => entry.seatId === 'companion').length;
      values.push(['move-suggestion', `小鲸鱼第 ${ownMoveIndex} 手${move.thoughtCardVersion ? ` · 思路卡 v${move.thoughtCardVersion}` : ''}`]);
    }
    if (move.engineSuggestion) values.push(['move-suggestion', `引擎建议 ${formatCoord(move.engineSuggestion)} · 实际 ${formatCoord(move)}`]);
    if (move.deviationReport) values.push(['move-suggestion', `偏差回报：${move.deviationReport}`]);
    if (['body', 'fish'].includes(move.controller) && move.wakeDeliveredAt && move.at) {
      const durationMs = Date.parse(move.at) - Date.parse(move.wakeDeliveredAt);
      if (Number.isFinite(durationMs) && durationMs >= 0) values.push(['move-suggestion', `思考 ${formatDuration(durationMs)}`]);
    }
    for (const [className, text] of values) { const span = document.createElement('span'); span.className = className; span.textContent = text; item.append(span); }
    history.append(item);
  });
  const humanMoves = state.history.filter((move) => move.seatId === 'human').length;
  const companionMoves = state.history.filter((move) => move.seatId === 'companion').length;
  const humanSeatName = state.opponent === 'local' ? '本地引擎' : '皮皮';
  $('#history-summary').textContent = state.history.length ? `${state.history.length} 手 · ${humanSeatName} ${humanMoves} 手 · 小鲸鱼 ${companionMoves} 手 · ${state.status === 'playing' ? '对局进行中' : state.status === 'abandoned' ? '本局已中止' : '对局已结束'}` : '尚无走子记录';
  renderHistoryStats(state);
  const gridLines = boardElement.querySelector('.grid-lines');
  boardElement.replaceChildren();
  if (gridLines) boardElement.append(gridLines);
  const lastMove = state.history.at(-1);
  const canPlay = !session?.spectator && session?.opponent !== 'local' && state.version === live.version && state.nextSeat === 'human' && state.status === 'playing';
  for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) {
    const value = state.board[row * 15 + col];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cell' + (value ? ' stone-' + value : '') + (lastMove?.row === row && lastMove?.col === col ? ' last' : '');
    button.setAttribute('role', 'gridcell');
    button.setAttribute('aria-label', `第${row + 1}行第${col + 1}列${value ? '已有棋子' : '空位'}`);
    if (value) button.title = `${state.history.findIndex((move) => move.row === row && move.col === col) + 1}手`;
    button.disabled = value !== 0 || !canPlay;
    button.addEventListener('click', () => move(row, col));
    boardElement.append(button);
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
}

function percentile90(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)];
}

function renderHistoryStats(state) {
  const history = state.history || [];
  const count = (controller) => history.filter((move) => move.seatId === 'companion' && move.controller === controller).length;
  const durations = (controller) => history
    .filter((move) => move.seatId === 'companion' && move.controller === controller && move.wakeDeliveredAt && move.at)
    .map((move) => Date.parse(move.at) - Date.parse(move.wakeDeliveredAt))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const humanCount = history.filter((move) => move.seatId === 'human').length;
  const companionCount = history.filter((move) => move.seatId === 'companion').length;
  const bodyDurations = durations('body');
  const fishDurations = durations('fish');
  const allModelDurations = [...bodyDurations, ...fishDurations];
  const proposals = state.proposalReports || [];
  const acceptedProposals = proposals.filter((proposal) => proposal.accepted).length;
  const proposalCount = Math.max(proposals.length, Number(state.fishWakeProposals) || 0);
  const durationSummary = (controller, values) => {
    const moves = count(controller);
    if (!values.length) return moves ? `${moves} 手 · 用时记录缺失` : `${moves} 手`;
    const total = values.reduce((sum, value) => sum + value, 0);
    const p90 = percentile90(values);
    return `${moves} 手 · 累计 ${formatDuration(total)} · P90 ${formatDuration(p90)}（${values.length} 手有计时）`;
  };
  const rows = [
    ['总手数', `${history.length} 手`],
    [state.opponent === 'local' ? '本地引擎' : '皮皮', `${humanCount} 手`],
    ['小鲸鱼', `${companionCount} 手`],
    ['本体', durationSummary('body', bodyDurations)],
    ['下棋鱼', durationSummary('fish', fishDurations)],
    ['模型思考 P90', percentile90(allModelDurations) == null ? '暂无' : `${formatDuration(percentile90(allModelDurations))}（${allModelDurations.length} 手有计时）`],
    ['引擎兜底', `${count('engine')} 手`],
    ['本体 120 秒加时', state.extensionUsed || history.some((move) => move.extended) ? '已使用' : '未使用'],
    ['下棋鱼主动唤醒', `${proposalCount} 次提议 · 已采纳 ${acceptedProposals}/3 次`],
  ];
  const list = $('#history-stats-list');
  list.replaceChildren();
  for (const [label, value] of rows) {
    const wrapper = document.createElement('div');
    const term = document.createElement('dt'); term.textContent = label;
    const detail = document.createElement('dd'); detail.textContent = value;
    wrapper.append(term, detail); list.append(wrapper);
  }
}

async function request(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: `Bearer ${session.token}` } : {}), ...options.headers } });
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
  socket.addEventListener('message', (event) => { try { const data = JSON.parse(event.data); if (data.type === 'observation') acceptObservation(data.observation); else if (data.type === 'usage') renderUsage(data); } catch {} });
  socket.addEventListener('close', () => setConnection('已断开'));
  socket.addEventListener('error', () => setConnection('连接错误'));
}

async function newGame() {
  try {
    const opponent = $('#opponent-select').value;
    const decisionMode = $('#decision-mode-select').value;
    const data = await request('/api/rooms', { method: 'POST', body: JSON.stringify({ opponent, decisionMode, randomizeFirst: true }) });
    session = { gameId: data.gameId, token: data.token, spectatorToken: data.spectatorToken, opponent, decisionMode };
    localStorage.setItem('dsh-game-session', JSON.stringify(session));
    frames = []; paused = false;
    acceptObservation(data.observation);
    connect();
  } catch (error) { $('#message').textContent = error.message; }
}

function observerFromHash() {
  const match = /^#watch=([a-f0-9-]{36})&token=([A-Za-z0-9_-]{32,})$/i.exec(location.hash);
  return match ? { gameId: match[1], token: match[2], spectator: true } : null;
}

async function resumeGame() {
  try {
    const watcher = observerFromHash();
    const params = new URLSearchParams(location.search);
    const invitedGameId = params.get('gameId');
    const invitedToken = params.get('token');
    let saved = watcher || JSON.parse(localStorage.getItem('dsh-game-session') || 'null');
    if (!watcher && /^[a-f0-9-]{36}$/i.test(invitedGameId || '') && /^[A-Za-z0-9_-]{32,}$/.test(invitedToken || '')) {
      saved = { gameId: invitedGameId, token: invitedToken, opponent: 'local', decisionMode: 'dsh-dual' };
      localStorage.setItem('dsh-game-session', JSON.stringify(saved));
      history.replaceState({}, '', location.pathname);
    }
    if (!saved?.gameId || !saved?.token) { session = null; setConnection('离线'); return; }
    session = saved;
    const data = await request(`/api/games/${session.gameId}/view`);
    frames = []; paused = false;
    acceptObservation(data.observation); connect();
  } catch (error) { $('#message').textContent = error.message; setConnection('离线'); }
}

async function move(row, col) {
  if (!session || !observation || session.spectator || session.opponent === 'local' || observation.version !== liveObservation?.version) return;
  try {
    const data = await request(`/api/games/${session.gameId}/actions`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: liveObservation.version, action: { type: 'place', row, col } }) });
    acceptObservation(data.observation);
  } catch (error) { $('#message').textContent = error.message; if (error.message === 'STALE_VERSION') await resumeGame(); }
}

async function closeGame() {
  if (!session || session.spectator || !liveObservation || liveObservation.status !== 'playing' || closingGame) return;
  closingGame = true;
  render(liveObservation);
  try {
    const data = await request(`/api/games/${session.gameId}/close`, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), expectedVersion: liveObservation.version }) });
    acceptObservation(data.observation);
    $('#message').textContent = data.recordDelivered
      ? '本局已结束，已通知小鲸鱼并归档棋局与棋局会话。'
      : '本局已结束；桥接暂未确认通知和归档，请检查桥接是否运行。';
  } catch (error) {
    $('#message').textContent = error.message;
    if (error.message === 'STALE_VERSION') await resumeGame();
  } finally {
    closingGame = false;
    if (liveObservation) render(liveObservation);
  }
}

$('#new-game').addEventListener('click', newGame);
$('#resume').addEventListener('click', resumeGame);
$('#history-open').addEventListener('click', () => $('#history-dialog').showModal());
$('#close-game').addEventListener('click', closeGame);
$('#history-close').addEventListener('click', () => $('#history-dialog').close());
$('#history-dialog').addEventListener('click', (event) => { if (event.target === $('#history-dialog')) $('#history-dialog').close(); });
$('#delay-range').addEventListener('input', (event) => { replayDelayMs = Number(event.target.value) * 1000; $('#delay-value').textContent = `${event.target.value} 秒`; renderPlayback(); });
$('#replay-pause').addEventListener('click', () => { paused = !paused; if (!paused) currentFrameIndex = latestAvailableIndex(); renderPlayback(); });
$('#replay-back').addEventListener('click', () => { paused = true; currentFrameIndex = Math.max(0, currentFrameIndex - 1); renderPlayback(); });
$('#replay-forward').addEventListener('click', () => { paused = true; currentFrameIndex = Math.min(latestAvailableIndex(), currentFrameIndex + 1); renderPlayback(); });
$('#copy-watch-link').addEventListener('click', async () => {
  if (!session?.spectatorToken) return;
  const link = `${location.origin}/#watch=${session.gameId}&token=${session.spectatorToken}`;
  try { await navigator.clipboard.writeText(link); $('#message').textContent = '只读观战链接已复制。'; }
  catch { $('#message').textContent = link; }
});
setInterval(renderPlayback, 200);
resumeGame();
