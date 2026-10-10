import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { App } from '../app.ts';
import { humanDuration, LoginLimiter } from '../auth/limiter.ts';
import { hmac, randomId, safeEqual } from '../crypto/secrets.ts';
import { AppError, AuthError, ValidationError } from '../errors.ts';
import { registerRoutes } from './routes.ts';

const COOKIE = 'sb_session';
const BODY_LIMIT = 16 * 1024 * 1024;

export function readBody(req: FastifyRequest): Record<string, unknown> {
  const b = req.body;
  if (b === null || b === undefined) return {};
  // 첨부 올리기용 application/octet-stream 본문(Buffer)도 JSON 객체가 아닙니다.
  if (typeof b !== 'object' || Array.isArray(b) || Buffer.isBuffer(b)) throw new ValidationError('body_type', '요청 본문은 JSON 객체여야 합니다.');
  return b as Record<string, unknown>;
}

function signSession(secret: string, id: string): string {
  return `${id}.${hmac(secret, id)}`;
}

function verifySession(app: App, raw: string | undefined): { ok: true } | { ok: false; reason: 'none' | 'invalid' | 'expired' } {
  if (!raw) return { ok: false, reason: 'none' };
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'invalid' };
  const id = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sig, hmac(app.config.sessionSecret, id))) return { ok: false, reason: 'invalid' };
  const s = app.store.getSession(id);
  if (!s) return { ok: false, reason: 'invalid' };
  if (s.expiresAt <= Date.now()) {
    app.store.deleteSession(id);
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/** 실시간 연결 확인 간격 */
export const WS_PING_MS = 25_000;
/** 보내지 못하고 쌓인 데이터가 이만큼 넘으면 그 연결을 끊습니다 */
export const WS_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * 연결 확인 한 번: 지난 확인에 답(pong)이 없었으면 끊고, 있었으면 다시 확인을 보냅니다.
 * 노트북 잠자기처럼 조용히 끊긴 연결은 운영체제가 알아채기까지 수십 분이 걸려, 그동안 이벤트가 쌓이기만 합니다.
 */
export function wsKeepalive(state: { alive: boolean }, socket: { readyState: number; OPEN: number; ping(): void; terminate(): void }): 'terminated' | 'pinged' | 'skipped' {
  if (socket.readyState !== socket.OPEN) return 'skipped';
  if (!state.alive) {
    socket.terminate();
    return 'terminated';
  }
  state.alive = false;
  socket.ping();
  return 'pinged';
}

export async function buildServer(app: App): Promise<FastifyInstance> {
  const server = Fastify({ logger: false, trustProxy: app.config.trustProxy, bodyLimit: BODY_LIMIT });
  if (app.config.trustProxy === true) {
    app.log.warn('TRUST_PROXY=true 는 X-Forwarded-For 맨 앞 값(클라이언트가 마음대로 넣을 수 있음)을 접속 주소로 믿어 로그인 잠금을 피할 수 있습니다. 프록시가 같은 컴퓨터면 TRUST_PROXY=loopback, 아니면 프록시 IP 를 넣으세요.');
  }
  await server.register(fastifyCookie);
  await server.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  const secure = app.config.publicUrl?.startsWith('https://') ?? false;
  const limiter = new LoginLimiter(app.config.loginMaxAttempts, app.config.loginLockMinutes * 60_000);
  const allowedOrigins = new Set<string>();
  if (app.config.publicUrl) allowedOrigins.add(new URL(app.config.publicUrl).origin);

  server.addHook('onRequest', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000');

    const url = req.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/')) return;

    // 다른 사이트에서 보낸 변경 요청 차단 (쿠키 SameSite=Strict 에 더해 Origin 확인)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        const host = req.headers.host ?? '';
        const sameHost = (() => {
          try {
            return new URL(origin).host === host;
          } catch {
            return false;
          }
        })();
        if (!sameHost && !allowedOrigins.has(origin)) {
          throw new AuthError('origin_mismatch', `다른 사이트(${origin})에서 온 요청이라 거부했습니다. PUBLIC_URL 이 실제 접속 주소와 같은지 확인하세요.`, 403);
        }
      }
    }
    if (url.startsWith('/api/auth/')) return;
    const v = verifySession(app, req.cookies[COOKIE]);
    if (!v.ok) {
      throw v.reason === 'expired'
        ? new AuthError('session_expired', '세션이 만료되었습니다. 다시 로그인하세요.')
        : new AuthError('login_required', '로그인이 필요합니다.');
    }
  });

  server.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, detail: err.detail ?? null } });
    }
    const e = err as { code?: string; statusCode?: number; name?: string; message?: string };
    if (e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      if (/\/attachments\/?(\?|$)/.test(req.url)) {
        return reply.status(413).send({ error: { code: 'attachment_large', message: `첨부 파일이 한도(${app.config.attachmentMaxMb}MB)를 넘습니다.`, detail: null } });
      }
      return reply.status(413).send({ error: { code: 'body_too_large', message: `요청 본문이 ${BODY_LIMIT / 1024 / 1024}MB 를 넘습니다.`, detail: null } });
    }
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      const upload = req.method === 'POST' && /\/attachments\/?(\?|$)/.test(req.url);
      return reply.status(415).send({ error: { code: 'media_type', message: upload ? '파일 내용을 Content-Type: application/octet-stream 으로 보내세요.' : 'Content-Type 은 application/json 이어야 합니다.', detail: null } });
    }
    if (e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
      return reply.status(400).send({ error: { code: 'body_empty', message: 'Content-Type 이 JSON 인데 본문이 비어 있습니다. JSON 객체를 보내세요.', detail: null } });
    }
    if (e.statusCode === 400 && (e.name === 'SyntaxError' || e.code === 'FST_ERR_CTP_INVALID_JSON_BODY')) {
      return reply.status(400).send({ error: { code: 'body_json', message: `요청 본문이 올바른 JSON 이 아닙니다: ${e.message ?? ''}`, detail: null } });
    }
    const incident = crypto.randomBytes(4).toString('hex');
    app.log.error('처리하지 못한 오류', { incident, method: req.method, url: req.url, error: e.message, stack: (err as Error).stack });
    return reply.status(500).send({ error: { code: 'internal', message: `서버 내부 오류가 났습니다 (사건 번호 ${incident}): ${e.message ?? '알 수 없음'}. 서버 로그에서 이 번호를 찾으세요.`, detail: { incident } } });
  });

  // 첨부 올리기: 파일 내용을 그대로 받습니다 (크기 한도는 그 경로에서 정함).
  server.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  /* 로그인 */
  server.post('/api/auth/login', async (req, reply) => {
    const ip = req.ip;
    const now = Date.now();
    const lock = limiter.check(ip, now);
    if (lock.locked) {
      throw new AuthError('login_locked', `로그인에 여러 번 실패해 잠겼습니다. ${humanDuration(lock.retryInMs)} 뒤 다시 시도하세요.`, 429);
    }
    const body = readBody(req);
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    if (password === '') throw new ValidationError('password_empty', '비밀번호를 입력하세요.');
    if (!safeEqual(password, app.config.adminPassword)) {
      const r = limiter.fail(ip, now);
      if (r.locked) throw new AuthError('login_locked', `비밀번호가 ${app.config.loginMaxAttempts}번 틀려 ${app.config.loginLockMinutes}분 동안 잠갔습니다.`, 429);
      throw new AuthError('password_wrong', `비밀번호가 틀렸습니다. ${r.remaining}번 더 틀리면 ${app.config.loginLockMinutes}분 동안 잠깁니다.`);
    }
    limiter.success(ip);
    app.store.purgeSessions(now);
    const id = randomId('ses', 24);
    const ttl = app.config.sessionTtlHours * 3_600_000;
    app.store.insertSession(id, now + ttl, req.headers['user-agent']?.slice(0, 200) ?? null);
    reply.setCookie(COOKIE, signSession(app.config.sessionSecret, id), { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: Math.floor(ttl / 1000) });
    return { ok: true };
  });

  server.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    if (raw) app.store.deleteSession(raw.slice(0, raw.lastIndexOf('.')));
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  server.get('/api/auth/session', async (req) => {
    const v = verifySession(app, req.cookies[COOKIE]);
    return { authenticated: v.ok, reason: v.ok ? null : v.reason };
  });

  server.get('/healthz', async () => ({ ok: true, uptimeSec: Math.round((Date.now() - app.startedAt) / 1000) }));

  /* 실시간 이벤트 */
  server.get('/api/ws', { websocket: true }, (socket) => {
    const state = { alive: true };
    socket.on('pong', () => {
      state.alive = true;
    });
    const unsubscribe = app.bus.subscribe((event) => {
      if (socket.readyState !== socket.OPEN) return;
      // 받는 쪽이 읽지 않는 연결은 보낼 데이터가 메모리에 쌓이기만 하므로 끊습니다.
      if (socket.bufferedAmount > WS_MAX_BUFFER) {
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify(event));
    });
    const ping = setInterval(() => wsKeepalive(state, socket), WS_PING_MS);
    const cleanup = (): void => {
      clearInterval(ping);
      unsubscribe();
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  registerRoutes(server, app);

  /* 웹 화면 */
  const webDist = path.join(app.config.rootDir, 'web', 'dist');
  const hasWeb = fs.existsSync(path.join(webDist, 'index.html'));
  if (hasWeb) {
    // wildcard: true — 요청마다 파일을 찾으므로 서버를 켠 뒤 다시 빌드한 파일도 바로 나갑니다.
    // 이름에 해시가 붙은 assets 는 오래 캐시하고, index.html 은 매번 새로 확인하게 합니다.
    await server.register(fastifyStatic, {
      root: webDist,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
      cacheControl: false,
      setHeaders: (res, filePath) => {
        res.header('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }
  server.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    const urlPath = req.url.split('?')[0] ?? '';
    if (urlPath.startsWith('/api/')) {
      return reply.status(404).send({ error: { code: 'route_not_found', message: `없는 API 경로입니다: ${req.method} ${urlPath}`, detail: null } });
    }
    // 확장자가 있는 경로(/assets/x.js 등)는 화면 주소가 아니라 파일 요청입니다. index.html 로 대신 답하면
    // 브라우저가 "MIME type text/html" 오류를 내므로 404 로 답합니다 (예: 다시 빌드되어 이름이 바뀐 옛 파일).
    if (req.method === 'GET' && hasWeb && path.extname(urlPath) !== '') {
      return reply.status(404).type('text/plain; charset=utf-8').send(`파일 ${urlPath} 이(가) 없습니다. 화면을 다시 빌드했다면 새로고침하세요.`);
    }
    if (req.method === 'GET' && hasWeb) return reply.header('Cache-Control', 'no-cache').type('text/html').sendFile('index.html');
    if (!hasWeb) {
      return reply
        .status(503)
        .type('text/plain; charset=utf-8')
        .send(`웹 화면이 아직 빌드되지 않았습니다. 저장소 루트에서 npm run build 를 실행한 뒤 서버를 다시 켜거나, 개발 중이면 npm run dev 로 띄운 개발 화면(http://localhost:${process.env['WEB_DEV_PORT'] || '5173'})으로 접속하세요.`);
    }
    return reply.status(404).send({ error: { code: 'not_found', message: `${req.method} ${req.url} 경로가 없습니다.`, detail: null } });
  });

  return server;
}
