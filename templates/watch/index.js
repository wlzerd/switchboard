// 주기 실행 템플릿. WATCH_URL 을 주기적으로 받아 내용이 바뀌면 에이전트에게 알립니다.
// 설치한 뒤 module.json 의 permissions.net 을 실제 도메인으로 좁히세요 ("*" 는 모든 도메인).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let timer = null;

export default {
  async activate(ctx) {
    const url = ctx.env.WATCH_URL;
    if (!/^https?:\/\//.test(url ?? '')) throw new Error(`WATCH_URL 은 http(s) 주소여야 합니다. 현재 값: ${url}`);
    const minutes = Number(ctx.env.WATCH_INTERVAL_MINUTES ?? 60);
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error(`WATCH_INTERVAL_MINUTES 는 1 이상이어야 합니다. 현재 값: ${ctx.env.WATCH_INTERVAL_MINUTES}`);
    const stateFile = path.join(ctx.dataDir, 'last-hash.txt');

    const check = async () => {
      try {
        const res = await ctx.fetch(url);
        const text = await res.text();
        const hash = crypto.createHash('sha256').update(text).digest('hex');
        const prev = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;
        fs.writeFileSync(stateFile, hash);
        if (prev !== null && prev !== hash) {
          ctx.emit({ target: 'watch', targetLabel: '주기 실행', userId: 'watch', userName: '주기 실행', text: `${url} 내용이 바뀌었습니다. 무엇이 바뀌었는지 확인해 요약해 주세요.`, direct: true });
        }
      } catch (err) {
        ctx.log.error(`${url} 확인 실패: ${err.message}`);
      }
    };
    await check();
    timer = setInterval(check, minutes * 60_000);
    ctx.log.info(`${minutes}분마다 ${url} 을(를) 확인합니다`);
  },

  async deactivate() {
    if (timer) clearInterval(timer);
  },

  async send(target, text, ctx) {
    ctx.log.info(`[${target}] ${text.slice(0, 200)}`);
    return '로그에 남겼습니다';
  },

  tools: {},
};
