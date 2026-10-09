import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.ts';
import type { AgentRow, Store } from '../db/store.ts';
import { ValidationError } from '../errors.ts';
import { matchHost } from '../permissions/match.ts';
import { packageManagerOf, parseCommand } from '../permissions/shell.ts';
import type { ModuleRegistry } from '../modules/registry.ts';
import type { SourceFile } from '../modules/static-check.ts';
import { safeFetch, NetError } from './net.ts';
import type { BuiltinTool, Described, ToolEnv } from './types.ts';

export interface SkillInput {
  name: string;
  title: string;
  description: string;
  input_schema: Record<string, unknown>;
  code: string;
  net: string[];
  tests: { input: Record<string, unknown>; expectIncludes?: string }[];
}

export interface ScheduleApi {
  create(agent: AgentRow, spec: string, prompt: string, reply: ToolEnv['reply']): string;
  list(agent: AgentRow): string;
  cancel(agent: AgentRow, id: string): string;
}

export interface ToolServices {
  config: Config;
  store: Store;
  registry: ModuleRegistry;
  deliver: (agent: AgentRow, env: ToolEnv, moduleId: string, target: string, text: string) => Promise<string>;
  createSkill: (agent: AgentRow, env: ToolEnv, input: SkillInput) => Promise<string>;
  createModule: (agent: AgentRow, env: ToolEnv, files: SourceFile[]) => Promise<string>;
  schedules: ScheduleApi;
}

/** 작업 폴더 기준 경로를 실제 경로(심볼릭 링크를 푼 값)로. 없는 경로는 존재하는 조상까지만 풉니다. */
export function resolveInWorkspace(workspace: string, p: string): string {
  const abs = path.resolve(workspace, p);
  let cur = abs;
  const rest: string[] = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
  let real = cur;
  try {
    real = fs.realpathSync(cur);
  } catch {
    // 권한 문제 등으로 못 풀면 그대로 둡니다 (가드가 경로를 다시 확인).
  }
  return path.join(real, ...rest);
}

const rel = (env: ToolEnv, abs: string): string => path.relative(env.workspace, abs) || '.';

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/* ───────── 파일 ───────── */

const fsRead = (s: ToolServices): BuiltinTool => ({
  name: 'fs_read',
  title: '파일 읽기',
  description: '작업 폴더 안의 텍스트 파일을 읽습니다. offset(1부터 시작하는 줄 번호)과 limit(줄 수)로 일부만 읽을 수 있습니다.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 500, description: '작업 폴더 기준 경로' },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 5000 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = resolveInWorkspace(env.workspace, str(input, 'path'));
    return { permission: 'fs.read', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    const abs = resolveInWorkspace(env.workspace, str(input, 'path'));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new ValidationError('fs_not_found', `파일 '${rel(env, abs)}'이(가) 없습니다.`);
    }
    if (stat.isDirectory()) throw new ValidationError('fs_is_dir', `'${rel(env, abs)}'은(는) 폴더입니다. fs_list 로 목록을 보세요.`);
    const max = s.config.httpToolMaxBytes;
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, max));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    if (buf.subarray(0, 8192).includes(0)) return `(바이너리 파일 · ${stat.size}바이트) 텍스트로 읽을 수 없습니다.`;
    const lines = buf.toString('utf8').split('\n');
    const offset = typeof input['offset'] === 'number' ? input['offset'] : 1;
    const limit = typeof input['limit'] === 'number' ? input['limit'] : lines.length;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const more = stat.size > max ? ` · 앞 ${max}바이트만 읽음` : '';
    return `${rel(env, abs)} (${lines.length}줄 중 ${offset}–${offset - 1 + slice.length}줄${more})\n${slice.join('\n')}`;
  },
});

const fsWrite = (): BuiltinTool => ({
  name: 'fs_write',
  title: '파일 쓰기',
  description: '작업 폴더 안의 파일에 내용을 씁니다. append 가 true 면 뒤에 덧붙입니다. 필요한 폴더는 만듭니다.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 500 },
      content: { type: 'string', maxLength: 1_000_000 },
      append: { type: 'boolean' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = resolveInWorkspace(env.workspace, str(input, 'path'));
    return { permission: 'fs.write', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    const abs = resolveInWorkspace(env.workspace, str(input, 'path'));
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new ValidationError('fs_is_dir', `'${rel(env, abs)}'은(는) 폴더라 쓸 수 없습니다.`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const content = str(input, 'content');
    if (input['append'] === true) fs.appendFileSync(abs, content);
    else fs.writeFileSync(abs, content);
    return `'${rel(env, abs)}'에 ${Buffer.byteLength(content)}바이트를 ${input['append'] === true ? '덧붙였' : '썼'}습니다.`;
  },
});

const fsList = (): BuiltinTool => ({
  name: 'fs_list',
  title: '파일 목록',
  description: '작업 폴더 안의 파일과 폴더 목록을 봅니다. depth 로 하위 폴더를 몇 단계까지 볼지 정합니다 (1~3).',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', maxLength: 500 }, depth: { type: 'integer', minimum: 1, maximum: 3 } },
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = resolveInWorkspace(env.workspace, str(input, 'path') || '.');
    return { permission: 'fs.read', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    const root = resolveInWorkspace(env.workspace, str(input, 'path') || '.');
    if (!fs.existsSync(root)) throw new ValidationError('fs_not_found', `폴더 '${rel(env, root)}'이(가) 없습니다.`);
    const depth = typeof input['depth'] === 'number' ? input['depth'] : 1;
    const out: string[] = [];
    const queue: { dir: string; level: number }[] = [{ dir: root, level: 1 }];
    while (queue.length > 0 && out.length < 300) {
      const { dir, level } = queue.shift() as { dir: string; level: number };
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name);
        const name = path.relative(root, full);
        if (e.isDirectory()) {
          out.push(`${name}/`);
          if (level < depth) queue.push({ dir: full, level: level + 1 });
        } else out.push(`${name} (${fs.statSync(full).size}B)`);
        if (out.length >= 300) break;
      }
    }
    if (out.length === 0) return `'${rel(env, root)}' 폴더가 비어 있습니다.`;
    return `${rel(env, root)}/\n${out.join('\n')}${out.length >= 300 ? '\n…(300개까지만 보여줍니다)' : ''}`;
  },
});

/* ───────── 셸 ───────── */

const shellExec = (s: ToolServices): BuiltinTool => ({
  name: 'shell_exec',
  title: '셸 명령',
  description: '작업 폴더에서 셸 명령을 실행하고 종료 코드와 출력을 돌려줍니다. 서버의 비밀 환경 변수는 전달되지 않습니다.',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', minLength: 1, maxLength: 4000 }, timeout_ms: { type: 'integer', minimum: 1000 } },
    required: ['command'],
    additionalProperties: false,
  },
  describe(input): Described {
    const command = str(input, 'command');
    const parsed = parseCommand(command);
    const manager = parsed.segments.map(packageManagerOf).find((m) => m !== null) ?? null;
    if (manager) return { permission: 'pkg.install', target: manager, command, summary: command.slice(0, 120) };
    return { permission: 'shell.exec', target: command, command, summary: command.slice(0, 120) };
  },
  run(input, env) {
    const command = str(input, 'command');
    const limit = Math.min(typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : s.config.shellTimeoutMs, s.config.shellTimeoutMs);
    const max = s.config.shellOutputMaxBytes;
    const tmp = path.join(env.workspace, '.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    return new Promise<string>((resolve, reject) => {
      let child;
      try {
        child = spawn('/bin/sh', ['-c', command], {
          cwd: env.workspace,
          env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: env.workspace, TMPDIR: tmp, LANG: process.env['LANG'] ?? 'C.UTF-8', TZ: process.env['TZ'] ?? '' },
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        reject(new ValidationError('shell_spawn', `셸을 띄우지 못했습니다: ${(err as Error).message}`));
        return;
      }
      let out = '';
      let err = '';
      let size = 0;
      let cut = false;
      const take = (chunk: Buffer, into: 'out' | 'err'): void => {
        if (size >= max) {
          cut = true;
          return;
        }
        const piece = chunk.subarray(0, max - size).toString('utf8');
        size += chunk.length;
        if (into === 'out') out += piece;
        else err += piece;
      };
      child.stdout?.on('data', (c: Buffer) => take(c, 'out'));
      child.stderr?.on('data', (c: Buffer) => take(c, 'err'));
      const killGroup = (): void => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, limit);
      const onAbort = (): void => killGroup();
      env.signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        env.signal.removeEventListener('abort', onAbort);
        reject(new ValidationError('shell_error', e.message.includes('ENOENT') ? '/bin/sh 를 찾지 못했습니다. 이 서버는 Linux·macOS 에서 셸 명령을 지원합니다.' : `명령 실행 오류: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        env.signal.removeEventListener('abort', onAbort);
        const head = timedOut
          ? `${Math.round(limit / 1000)}초 제한을 넘어 강제로 멈췄습니다.`
          : env.signal.aborted
            ? '작업이 취소되어 명령을 멈췄습니다.'
            : `종료 코드 ${code ?? `(신호 ${signal})`}`;
        resolve(`${head}${cut ? ` · 출력이 ${max}바이트를 넘어 잘림` : ''}\n--- stdout ---\n${out.trimEnd()}\n--- stderr ---\n${err.trimEnd()}`);
      });
    });
  },
});

/* ───────── HTTP ───────── */

const httpRequest = (s: ToolServices): BuiltinTool => ({
  name: 'http_request',
  title: 'HTTP 요청',
  description: '외부 HTTP(S) API 를 호출합니다. 내부망 주소는 막혀 있습니다. 응답 본문은 크기 한도까지만 돌려줍니다.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4000 },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
      headers: { type: 'object' },
      body: { type: 'string', maxLength: 1_000_000 },
    },
    required: ['url'],
    additionalProperties: false,
  },
  describe(input): Described {
    const raw = str(input, 'url');
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new ValidationError('http_url', `URL 형식이 아닙니다: '${raw.slice(0, 80)}'`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ValidationError('http_protocol', `http(s) 주소만 요청할 수 있습니다. 받은 주소: ${u.protocol}`);
    const method = (str(input, 'method') || 'GET').toUpperCase();
    const headers = input['headers'] && typeof input['headers'] === 'object' ? JSON.stringify(input['headers']) : '';
    return { permission: 'net.fetch', target: u.hostname, url: u.href, host: u.hostname, method, text: `${headers}\n${str(input, 'body')}`, summary: `${method} ${u.host}${u.pathname}` };
  },
  async run(input, env) {
    const rule = env.agent.permissions['net.fetch'];
    const explicit = (host: string): boolean => [...(rule?.scope ?? []), ...(rule?.always ?? [])].some((p) => !p.includes('*') && matchHost(p, host));
    const headers: Record<string, string> = {};
    const rawHeaders = input['headers'];
    if (rawHeaders && typeof rawHeaders === 'object') {
      for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
        if (typeof v !== 'string') throw new ValidationError('http_header', `헤더 '${k}'의 값은 문자열이어야 합니다.`);
        headers[k] = v;
      }
    }
    try {
      const r = await safeFetch(str(input, 'url'), {
        method: (str(input, 'method') || 'GET').toUpperCase(),
        headers,
        body: typeof input['body'] === 'string' ? input['body'] : undefined,
        timeoutMs: s.config.httpToolTimeoutMs,
        maxBytes: s.config.httpToolMaxBytes,
        signal: env.signal,
        hostAllowed: (host) => {
          if (!rule || rule.mode === 'deny') return false;
          if (rule.mode === 'allow' && rule.scope.length === 0) return true;
          return [...rule.scope, ...rule.always].some((p) => matchHost(p, host));
        },
        privateAllowed: explicit,
      });
      const head = `HTTP ${r.status} ${r.statusText} · ${r.contentType || '형식 없음'}${r.url !== str(input, 'url') ? ` · 최종 주소 ${r.url}` : ''}`;
      if (r.binaryBytes !== null) return `${head}\n(바이너리 응답 ${r.binaryBytes}바이트 — 텍스트가 아니라 본문을 싣지 않았습니다)`;
      return `${head}${r.truncated ? ` · ${s.config.httpToolMaxBytes}바이트까지만` : ''}\n${r.body}`;
    } catch (err) {
      if (err instanceof NetError) throw new ValidationError(`http_${err.code}`, err.message);
      throw err;
    }
  },
});

/* ───────── 메시지 ───────── */

const sendMessage = (s: ToolServices): BuiltinTool => ({
  name: 'send_message',
  title: '메시지 보내기',
  description: '연결된 채널 모듈(Discord, Telegram 등)로 메시지를 보냅니다. channel 은 모듈 id, target 은 채널 이름(#ops)이나 대화 id 입니다.',
  input_schema: {
    type: 'object',
    properties: { channel: { type: 'string', minLength: 1 }, target: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 4000 } },
    required: ['channel', 'target', 'text'],
    additionalProperties: false,
  },
  describe(input): Described {
    // 전송 권한·발송 훅은 deliver() 가 함께 처리합니다 (답장 경로와 같은 검사).
    return { permission: null, target: str(input, 'target'), text: str(input, 'text'), summary: `${str(input, 'channel')} ${str(input, 'target')}` };
  },
  async run(input, env) {
    const channel = str(input, 'channel');
    const linked = s.store.listAgentModules(env.agent.id).map((l) => s.store.findModule(l.moduleId)).filter((m) => m && m.manifest.channel);
    if (!linked.some((m) => m?.id === channel)) {
      const names = linked.map((m) => m?.id).join(', ') || '(없음)';
      throw new ValidationError('send_channel', `'${channel}'은(는) 이 에이전트에 연결된 채널 모듈이 아닙니다. 연결된 채널: ${names}`);
    }
    return s.deliver(env.agent, env, channel, str(input, 'target'), str(input, 'text'));
  },
});

/* ───────── 스킬·모듈 만들기 ───────── */

const skillCreate = (s: ToolServices): BuiltinTool => ({
  name: 'skill_create',
  title: '스킬 만들기',
  description:
    '새 스킬(도구)을 만들어 자신에게 연결합니다. code 는 `export default async function run(input, ctx) { … return 결과 }` 형태의 ES 모듈이어야 합니다. ' +
    '외부 접속은 ctx.fetch 로만 하고 net 에 도메인을 선언하세요. 비밀값은 코드에 쓰지 말고 ctx.env 로 받습니다. tests 에 넣은 입력으로 바로 시험한 뒤 연결됩니다.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 64, description: '영문 소문자·숫자·밑줄 (예: fx_rate)' },
      title: { type: 'string', minLength: 1, maxLength: 40, description: '화면에 보일 이름 (예: 환율_조회)' },
      description: { type: 'string', minLength: 1, maxLength: 1024 },
      input_schema: { type: 'object' },
      code: { type: 'string', minLength: 1, maxLength: 65_536 },
      net: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 200 }, maxItems: 20 },
      tests: {
        type: 'array',
        maxItems: 5,
        items: { type: 'object', properties: { input: { type: 'object' }, expectIncludes: { type: 'string' } }, required: ['input'] },
      },
    },
    required: ['name', 'title', 'description', 'input_schema', 'code'],
    additionalProperties: false,
  },
  describe(input): Described {
    return { permission: 'skill.create', target: str(input, 'name'), text: str(input, 'code'), summary: `${str(input, 'title')} (${str(input, 'name')})` };
  },
  run(input, env) {
    return s.createSkill(env.agent, env, {
      name: str(input, 'name'),
      title: str(input, 'title'),
      description: str(input, 'description'),
      input_schema: input['input_schema'] as Record<string, unknown>,
      code: str(input, 'code'),
      net: Array.isArray(input['net']) ? (input['net'] as string[]) : [],
      tests: Array.isArray(input['tests']) ? (input['tests'] as SkillInput['tests']) : [],
    });
  },
});

const moduleCreate = (s: ToolServices): BuiltinTool => ({
  name: 'module_create',
  title: '모듈 만들기',
  description:
    '새 모듈을 만들어 설치 승인을 요청합니다. files 에 module.json 과 진입점(index.js)을 넣으세요. 형식은 시스템 프롬프트의 모듈 제작 가이드를 따릅니다. ' +
    '사용자가 승인하면 설치되고 자신에게 연결됩니다.',
  input_schema: {
    type: 'object',
    properties: {
      files: {
        type: 'array',
        minItems: 2,
        maxItems: 20,
        items: { type: 'object', properties: { path: { type: 'string', minLength: 1, maxLength: 200 }, content: { type: 'string', maxLength: 262_144 } }, required: ['path', 'content'], additionalProperties: false },
      },
    },
    required: ['files'],
    additionalProperties: false,
  },
  describe(input): Described {
    const files = (input['files'] as { path: string; content: string }[]) ?? [];
    const manifest = files.find((f) => f.path === 'module.json');
    let id = '(id 없음)';
    try {
      id = String((JSON.parse(manifest?.content ?? '{}') as { id?: unknown }).id ?? id);
    } catch {
      // module.json 오류는 run 에서 정확히 알려줍니다.
    }
    return { permission: 'module.create', target: id, text: files.map((f) => f.content).join('\n'), summary: `${id} · 파일 ${files.length}개` };
  },
  run(input, env) {
    return s.createModule(env.agent, env, input['files'] as SourceFile[]);
  },
});

/* ───────── 예약 ───────── */

const scheduleCreate = (s: ToolServices): BuiltinTool => ({
  name: 'schedule_create',
  title: '예약 만들기',
  description: '정해진 시각에 스스로 작업을 시작하도록 예약합니다. spec 형식: every 30m · daily 09:00 · weekdays 09:00 · weekly mon 09:00 (서버 시간대). 결과는 지금 대화한 채널로 보냅니다.',
  input_schema: {
    type: 'object',
    properties: { spec: { type: 'string', minLength: 1, maxLength: 40 }, prompt: { type: 'string', minLength: 1, maxLength: 2000 } },
    required: ['spec', 'prompt'],
    additionalProperties: false,
  },
  describe(input): Described {
    return { permission: 'schedule.create', target: str(input, 'spec'), summary: `${str(input, 'spec')} · ${str(input, 'prompt').slice(0, 40)}` };
  },
  async run(input, env) {
    return s.schedules.create(env.agent, str(input, 'spec'), str(input, 'prompt'), env.reply);
  },
});

const scheduleList = (s: ToolServices): BuiltinTool => ({
  name: 'schedule_list',
  title: '예약 목록',
  description: '자신의 예약 실행 목록을 봅니다.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  describe(): Described {
    return { permission: null, target: null, summary: '예약 목록' };
  },
  async run(_input, env) {
    return s.schedules.list(env.agent);
  },
});

const scheduleCancel = (s: ToolServices): BuiltinTool => ({
  name: 'schedule_cancel',
  title: '예약 취소',
  description: '자신의 예약 하나를 지웁니다. id 는 schedule_list 에서 확인합니다.',
  input_schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  describe(input): Described {
    return { permission: 'schedule.create', target: str(input, 'id'), summary: `예약 ${str(input, 'id')} 취소` };
  },
  async run(input, env) {
    return s.schedules.cancel(env.agent, str(input, 'id'));
  },
});

export function builtinTools(s: ToolServices): BuiltinTool[] {
  return [fsRead(s), fsWrite(), fsList(), shellExec(s), httpRequest(s), sendMessage(s), skillCreate(s), moduleCreate(s), scheduleCreate(s), scheduleList(s), scheduleCancel(s)];
}

/** 이 도구들을 쓰려면 어떤 권한이 하나라도 허용/확인이어야 하는지 (모두 차단이면 목록에서 뺍니다). */
export const TOOL_PERMISSION: Record<string, string[]> = {
  fs_read: ['fs.read'],
  fs_list: ['fs.read'],
  fs_write: ['fs.write'],
  shell_exec: ['shell.exec', 'pkg.install'],
  http_request: ['net.fetch'],
  skill_create: ['skill.create'],
  module_create: ['module.create'],
  schedule_create: ['schedule.create'],
  schedule_cancel: ['schedule.create'],
  schedule_list: [],
  send_message: [],
};
