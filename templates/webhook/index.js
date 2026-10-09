// 웹훅 수신 템플릿. POST /hook 으로 { "text": "...", "target": "이름" } 을 받으면 에이전트에게 넘깁니다.
// 헤더 X-Webhook-Secret 이 WEBHOOK_SECRET 과 같아야 합니다. 에이전트의 답장은 dataDir/outbox.jsonl 에 쌓입니다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

let server = null;

function same(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export default {
  async activate(ctx) {
    const port = Number(ctx.env.WEBHOOK_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`WEBHOOK_PORT 는 1~65535 사이 정수여야 합니다. 현재 값: ${ctx.env.WEBHOOK_PORT}`);
    server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/hook') {
        res.writeHead(404).end('POST /hook 만 받습니다.');
        return;
      }
      if (!same(req.headers['x-webhook-secret'] ?? '', ctx.env.WEBHOOK_SECRET)) {
        res.writeHead(401).end('X-Webhook-Secret 이 맞지 않습니다.');
        return;
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          res.writeHead(400).end('본문이 JSON 이 아닙니다.');
          return;
        }
        if (typeof data.text !== 'string' || data.text.trim() === '') {
          res.writeHead(400).end('text 가 비어 있습니다.');
          return;
        }
        const target = typeof data.target === 'string' && data.target ? data.target : 'webhook';
        ctx.emit({ target, targetLabel: target, userId: 'webhook', userName: '웹훅', text: data.text, direct: true });
        res.writeHead(202).end('받았습니다');
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', (err) => reject(new Error(err.code === 'EADDRINUSE' ? `포트 ${port} 를 이미 쓰고 있습니다. WEBHOOK_PORT 를 바꾸세요.` : `웹훅 서버를 열지 못했습니다: ${err.message}`)));
      server.listen(port, resolve);
    });
    ctx.log.info(`웹훅을 포트 ${port} 의 POST /hook 에서 받습니다`);
  },

  async deactivate() {
    if (server) await new Promise((r) => server.close(r));
  },

  async send(target, text, ctx) {
    fs.appendFileSync(path.join(ctx.dataDir, 'outbox.jsonl'), JSON.stringify({ at: new Date().toISOString(), target, text }) + '\n');
    return 'outbox.jsonl 에 기록했습니다';
  },

  tools: {},
};
