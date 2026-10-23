import fs from 'node:fs';
import path from 'node:path';

function readLocalEnv() {
  let text = '';
  try { text = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8').replace(/^\uFEFF/, ''); } catch {}
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(GAME_BRIDGE_SECRET|GAME_BRIDGE_URL)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

const localEnv = readLocalEnv();
const secret = process.env.GAME_BRIDGE_SECRET || localEnv.GAME_BRIDGE_SECRET || '';
const entry = process.env.GAME_BRIDGE_URL || localEnv.GAME_BRIDGE_URL || 'http://127.0.0.1:3100/internal/game/turn';

if (secret.length < 32) {
  console.error('缺少有效的 GAME_BRIDGE_SECRET。请先在本目录 .env 中配置桥接密钥。');
  process.exitCode = 1;
} else {
  let target;
  try { target = new URL('/internal/game/invite-test', entry); }
  catch { console.error('GAME_BRIDGE_URL 格式无效。'); process.exitCode = 1; }
  if (target && (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname))) {
    console.error('游戏桥接地址必须是本机 HTTP 回环地址。');
    process.exitCode = 1;
  } else if (target) {
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-game-token': secret },
        body: '{}',
        signal: AbortSignal.timeout(15000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) throw new Error(result.error || `桥接返回 HTTP ${response.status}`);
      console.log(`邀请测试已排入小鲸鱼主会话（${result.inviteId}）。此入口不占每日自动邀请次数，也没有入口冷却。`);
    } catch (error) {
      console.error(`邀请测试未能提交：${error?.message ?? error}`);
      process.exitCode = 1;
    }
  }
}
