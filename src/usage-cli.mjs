import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(process.env.DSH_GAME_DATA_DIR || resolve(root, 'data'), 'games.sqlite');
const gameIndex = process.argv.indexOf('--game');
const gameId = gameIndex >= 0 ? process.argv[gameIndex + 1] : null;
const watch = process.argv.includes('--watch');
if (gameIndex >= 0 && !gameId) {
  console.error('用法: pnpm usage [-- --game <gameId>] [--watch]');
  process.exit(2);
}
const fmt = (value) => Number(value).toLocaleString('en-US');

function readUsage() {
  if (!existsSync(dbPath)) return { rows: [], totals: { requests: 0, input: 0, output: 0, total: 0 }, tableReady: false };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='game_model_usage'").get();
    if (!table) return { rows: [], totals: { requests: 0, input: 0, output: 0, total: 0 }, tableReady: false };
    const rows = gameId
      ? db.prepare('SELECT game_id,COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(total_tokens),0) AS total_tokens,MAX(created_at) AS last_used FROM game_model_usage WHERE game_id=? GROUP BY game_id').all(gameId)
      : db.prepare('SELECT game_id,COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(total_tokens),0) AS total_tokens,MAX(created_at) AS last_used FROM game_model_usage GROUP BY game_id ORDER BY last_used DESC').all();
    const totals = rows.reduce((sum, row) => ({ requests: sum.requests + Number(row.requests), input: sum.input + Number(row.input_tokens), output: sum.output + Number(row.output_tokens), total: sum.total + Number(row.total_tokens) }), { requests: 0, input: 0, output: 0, total: 0 });
    return { rows, totals, tableReady: true };
  } finally {
    db.close();
  }
}
function render() {
  const { rows, totals, tableReady } = readUsage();
  if (watch) process.stdout.write('\x1b[2J\x1b[H');
  console.log(gameId ? `对局 ${gameId} 的 DSH 游戏用量` : '项目累计 DSH 游戏用量');
  console.log(`请求 ${fmt(totals.requests)} 次 | 输入 ${fmt(totals.input)} | 输出 ${fmt(totals.output)} | 合计 ${fmt(totals.total)} tokens`);
  for (const row of rows) console.log(`${row.game_id} | ${fmt(row.requests)} 次 | ${fmt(row.total_tokens)} tokens | ${row.last_used || '无时间记录'}`);
  if (!totals.requests) console.log(tableReady ? '尚无游戏模型请求的用量记录。' : '账本尚未初始化或尚无数据目录。');
  console.log('统计范围：游戏 Worker 实际上报的模型 usage；不读聊天账本，不估算缺失用量。');
  if (watch) console.log('每 2 秒刷新一次；Ctrl+C 退出。');
}
render();
if (watch) setInterval(render, 2000);
