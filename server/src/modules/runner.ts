/**
 * 모듈 프로세스 진입점. 서버가 fork 로 띄우며, 모듈 하나를 불러와 IPC 로 도구 호출·메시지 전송을 처리합니다.
 * 이 프로세스에는 모듈이 module.json 에 선언한 환경 변수만 전달됩니다 (Anthropic 키 등 서버 비밀값 없음).
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchHost } from '../permissions/match.ts';
import type { ChildMessage, InboundMessage, InitMessage, ParentMessage, SerializedError } from './protocol.ts';

function send(msg: ChildMessage): void {
  if (process.send) process.send(msg);
}

function serialize(err: unknown): SerializedError {
  if (err instanceof Error) {
    const e = err as Error & { code?: string; permission?: string; resource?: string };
    const message =
      e.code === 'ERR_ACCESS_DENIED'
        ? `모듈 권한 밖의 접근이 막혔습니다 (${e.permission ?? '권한'}${e.resource ? `: ${e.resource}` : ''}). 모듈은 자기 폴더와 데이터 폴더(ctx.dataDir)만 쓸 수 있습니다.`
        : e.message;
    return { name: e.name, message, stack: e.stack?.split('\n').slice(0, 6).join('\n') };
  }
  return { name: 'Error', message: String(err) };
}

type ToolFn = (input: unknown, ctx: ModuleContext) => unknown;

interface ModuleDefinition {
  activate?: (ctx: ModuleContext) => unknown;
  deactivate?: (ctx: ModuleContext) => unknown;
  tools?: Record<string, ToolFn>;
  send?: (target: string, text: string, ctx: ModuleContext) => unknown;
  computer?: { run: (action: string, input: unknown, ctx: ModuleContext) => unknown };
}

interface ModuleContext {
  id: string;
  env: Record<string, string>;
  dataDir: string;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
  emit: (message: InboundMessage) => void;
  fetch: typeof fetch;
  meta: { agentId: string | null; agentName: string | null; taskId: string | null } | null;
}

let def: ModuleDefinition | null = null;
let ctx: ModuleContext | null = null;
let tools: Record<string, ToolFn> = {};

function toOutput(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function installFetchGuard(id: string, allow: string[]): typeof fetch {
  const real = globalThis.fetch.bind(globalThis);
  const guarded: typeof fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    let host: string;
    try {
      host = new URL(raw).hostname;
    } catch {
      throw new Error(`모듈 '${id}': 잘못된 URL '${raw}' 입니다.`);
    }
    if (!allow.some((p) => matchHost(p, host))) {
      throw new Error(`모듈 '${id}'은(는) ${host} 에 접속할 권한이 없습니다. module.json 의 permissions.net 에 도메인을 추가하고 다시 승인받으세요. 허용 목록: ${allow.join(', ') || '(없음)'}`);
    }
    return real(input, init);
  };
  globalThis.fetch = guarded;
  return guarded;
}

async function init(msg: InitMessage): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  const guardedFetch = installFetchGuard(msg.id, msg.netAllow);
  ctx = {
    id: msg.id,
    env,
    dataDir: msg.dataDir,
    log: {
      info: (m) => send({ t: 'log', level: 'info', msg: String(m) }),
      warn: (m) => send({ t: 'log', level: 'warn', msg: String(m) }),
      error: (m) => send({ t: 'log', level: 'error', msg: String(m) }),
    },
    emit: (message) => send({ t: 'inbound', message }),
    fetch: guardedFetch,
    meta: null,
  };

  const file = path.join(msg.dir, msg.entry);
  const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
  const exported = loaded.default;

  if (msg.kind === 'skill') {
    if (typeof exported !== 'function') {
      throw new Error(`스킬 '${msg.id}'의 ${msg.entry} 는 export default async function run(input, ctx) 형태여야 합니다. 지금은 ${typeof exported} 를 내보냅니다.`);
    }
    const first = msg.tools[0];
    if (!first) throw new Error(`스킬 '${msg.id}'의 module.json 에 도구가 없습니다.`);
    tools = { [first.name]: exported as ToolFn };
    def = {};
  } else {
    if (exported === null || typeof exported !== 'object') {
      throw new Error(`모듈 '${msg.id}'의 ${msg.entry} 는 export default { activate, tools, send } 형태의 객체를 내보내야 합니다. 지금은 ${typeof exported} 입니다.`);
    }
    def = exported as ModuleDefinition;
    const exportedTools = def.tools ?? {};
    const missing = msg.tools.filter((t) => typeof exportedTools[t.handler] !== 'function');
    if (missing.length > 0) {
      throw new Error(`모듈 '${msg.id}'이(가) module.json 에 선언한 도구의 함수 ${missing.map((t) => (t.handler === t.name ? t.name : `${t.handler}(${t.name})`)).join(', ')} 를 tools 에서 내보내지 않습니다.`);
    }
    tools = {};
    for (const t of msg.tools) tools[t.name] = exportedTools[t.handler] as ToolFn;
    if (def.activate) await def.activate(ctx);
  }
  send({ t: 'ready', tools: Object.keys(tools), canSend: typeof def?.send === 'function' });
}

async function handle(msg: ParentMessage): Promise<void> {
  switch (msg.t) {
    case 'init':
      try {
        await init(msg);
      } catch (err) {
        send({ t: 'fatal', error: serialize(err) });
        setTimeout(() => process.exit(1), 50);
      }
      return;
    case 'call': {
      const fn = tools[msg.tool];
      if (!ctx || typeof fn !== 'function') {
        send({ t: 'result', id: msg.id, ok: false, error: { name: 'ToolNotFound', message: `이 모듈에는 '${msg.tool}' 도구가 없습니다.` } });
        return;
      }
      try {
        const out = await fn(msg.input, { ...ctx, meta: msg.meta });
        send({ t: 'result', id: msg.id, ok: true, output: toOutput(out) });
      } catch (err) {
        send({ t: 'result', id: msg.id, ok: false, error: serialize(err) });
      }
      return;
    }
    case 'send': {
      if (!ctx || !def?.send) {
        send({ t: 'result', id: msg.id, ok: false, error: { name: 'NotAChannel', message: '이 모듈은 메시지를 보낼 수 없습니다 (send 가 없음).' } });
        return;
      }
      try {
        const out = await def.send(msg.target, msg.text, ctx);
        send({ t: 'result', id: msg.id, ok: true, output: toOutput(out) });
      } catch (err) {
        send({ t: 'result', id: msg.id, ok: false, error: serialize(err) });
      }
      return;
    }
    case 'computer': {
      if (!ctx || typeof def?.computer?.run !== 'function') {
        send({ t: 'result', id: msg.id, ok: false, error: { name: 'NotAComputer', message: '이 모듈은 화면 제어를 하지 않습니다 (export default 에 computer.run 이 없음).' } });
        return;
      }
      try {
        const out = (await def.computer.run(msg.action, msg.input, ctx)) as { text?: unknown; image?: unknown } | null | undefined;
        const image = out?.image as { data?: unknown; mediaType?: unknown } | null | undefined;
        const valid = image && typeof image.data === 'string' && (image.mediaType === 'image/png' || image.mediaType === 'image/jpeg');
        if (image && !valid) throw new Error('화면 제어 결과의 image 는 { data: base64 문자열, mediaType: "image/png" | "image/jpeg" } 이어야 합니다.');
        send({ t: 'result', id: msg.id, ok: true, output: typeof out?.text === 'string' ? out.text : '', image: valid ? { data: image.data as string, mediaType: image.mediaType as 'image/png' | 'image/jpeg' } : null });
      } catch (err) {
        send({ t: 'result', id: msg.id, ok: false, error: serialize(err) });
      }
      return;
    }
    case 'stop':
      try {
        if (def?.deactivate && ctx) await def.deactivate(ctx);
      } finally {
        process.exit(0);
      }
  }
}

process.on('message', (m) => {
  void handle(m as ParentMessage);
});
process.on('disconnect', () => process.exit(0));
process.on('uncaughtException', (err) => {
  send({ t: 'fatal', error: serialize(err) });
  setTimeout(() => process.exit(1), 50);
});
process.on('unhandledRejection', (err) => {
  send({ t: 'fatal', error: serialize(err) });
  setTimeout(() => process.exit(1), 50);
});
