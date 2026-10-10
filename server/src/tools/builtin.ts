import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reportLabel } from '../agents/autonomy.ts';
import type { Config } from '../config/env.ts';
import type { AgentRow, ReportTarget, Store } from '../db/store.ts';
import { ValidationError } from '../errors.ts';
import { displayPath, isInsidePath, resolveToolPath } from '../permissions/folders.ts';
import { hostEntryMatches, isExactEntry } from '../permissions/policy.ts';
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

/** 예약 고치기: 적은 항목만 바꿉니다. reply 는 실제 대상으로 푼 값 (null 이면 웹 화면에만). */
export interface ScheduleChange {
  spec?: string;
  prompt?: string;
  enabled?: boolean;
  reply?: ToolEnv['reply'];
}

export interface ScheduleApi {
  create(agent: AgentRow, spec: string, prompt: string, reply: ToolEnv['reply']): string;
  /** id 를 주면 그 예약 하나를 할 일 전체와 함께 보여 줍니다. */
  list(agent: AgentRow, id?: string): string;
  update(agent: AgentRow, id: string, change: ScheduleChange): string;
  cancel(agent: AgentRow, id: string): string;
}

/** 에이전트가 고른 보고 · 결과 받을 곳(report_to)을 푼 값 */
export interface ResolvedReport {
  /** null 이면 채널로 보내지 않고 웹 화면에만 */
  to: ReportTarget | null;
  /** 그곳으로 보낼 때마다 승인이 필요하면 그 이유 */
  ask: string | null;
}

export interface DelegateInput {
  to: string;
  task: string;
  reason: string;
}

export interface HeartbeatToolInput {
  enabled: boolean;
  everyMinutes?: number;
  checklist?: string;
  /** 'HH:MM-HH:MM' · 빈 문자열이면 하루 종일 */
  activeHours?: string;
  /** 고른 보고 받을 곳. 없으면 정해 둔 곳을 쓰고, 정해 둔 곳도 없으면 지금 대화한 채널 */
  report?: ResolvedReport;
}

export interface ProjectApi {
  /** 등록하거나(없으면) 고칩니다(있으면). abs 는 실제 경로로 푼 값. 결과 문구를 돌려줍니다. */
  track(env: ToolEnv, abs: string, input: { name?: string; note?: string; watch?: boolean }): string;
  untrack(env: ToolEnv, abs: string): string;
}

export interface ToolServices {
  config: Config;
  store: Store;
  registry: ModuleRegistry;
  deliver: (agent: AgentRow, env: ToolEnv, moduleId: string, target: string, text: string) => Promise<string>;
  createSkill: (agent: AgentRow, env: ToolEnv, input: SkillInput) => Promise<string>;
  createModule: (agent: AgentRow, env: ToolEnv, files: SourceFile[]) => Promise<string>;
  schedules: ScheduleApi;
  delegate: (agent: AgentRow, env: ToolEnv, input: DelegateInput) => Promise<string>;
  heartbeat: (agent: AgentRow, env: ToolEnv, input: HeartbeatToolInput) => string;
  /** report_to 글을 실제 보낼 곳으로 풉니다. 고를 수 없는 곳이면 이유와 함께 예외를 던집니다. */
  resolveReport: (agent: AgentRow, env: ToolEnv, raw: string) => ResolvedReport;
  projects: ProjectApi;
}

const realpathNative = (p: string): string => fs.realpathSync.native(p);

/**
 * 도구 입력 경로 → 실제 절대 경로 (심볼릭 링크 · 대소문자를 운영체제가 푼 값).
 * 상대 경로는 작업 폴더 기준, 절대 경로와 '~/…' 는 허용 폴더를 가리킬 때 씁니다. 들어가도 되는 곳인지는 기본 금지 조항이 판단합니다.
 */
export function toolPath(env: ToolEnv, p: string): string {
  return resolveToolPath(p, env.workspace, os.homedir(), realpathNative);
}

/** 결과 문구 · 권한 대상: 작업 폴더 안은 상대 경로, 밖(허용 폴더)은 '~/…' 또는 절대 경로 */
const rel = (env: ToolEnv, abs: string): string => (isInsidePath(env.workspace, abs) ? path.relative(env.workspace, abs) || '.' : displayPath(abs, os.homedir()));

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/** 보고 · 결과 받을 곳 (heartbeat_set · schedule_create · schedule_update 공통). 채널 id(32자) + ':' + 대상(200자) */
const reportToSchema = (description: string): Record<string, unknown> => ({ type: 'string', minLength: 1, maxLength: 240, description });

/** report_to 를 적었으면 푼 값을, 안 적었으면 null. 고를 수 없는 곳이면 승인을 묻기 전에 이유를 알립니다. */
function reportOf(s: ToolServices, input: Record<string, unknown>, env: ToolEnv): ResolvedReport | null {
  return typeof input['report_to'] === 'string' ? s.resolveReport(env.agent, env, input['report_to']) : null;
}

const reportName = (s: ToolServices, r: ResolvedReport): string => reportLabel(r.to, (id) => s.store.findModule(id)?.manifest.name);

/** 보낼 때마다 승인이 필요한 곳을 골랐으면 결과 끝에 알립니다. */
function withAskNote(text: string, r: ResolvedReport | null): string {
  return r?.ask ? `${text}\n주의: 그곳으로 보낼 때마다 사용자의 승인이 필요합니다 (${r.ask})` : text;
}

/* ───────── 파일 ───────── */

const fsRead = (s: ToolServices): BuiltinTool => ({
  name: 'fs_read',
  title: '파일 읽기',
  description: '작업 폴더나 허용 폴더 안의 텍스트 파일을 읽습니다. offset(1부터 시작하는 줄 번호)과 limit(줄 수)로 일부만 읽을 수 있습니다.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 500, description: '작업 폴더 기준 상대 경로, 또는 허용 폴더 안의 절대 경로' },
      offset: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 5000 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = toolPath(env, str(input, 'path'));
    return { permission: 'fs.read', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    const abs = toolPath(env, str(input, 'path'));
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
  description: '작업 폴더나 읽기·쓰기 허용 폴더 안의 파일에 내용을 씁니다. append 가 true 면 뒤에 덧붙입니다. 필요한 폴더는 만듭니다.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 500, description: '작업 폴더 기준 상대 경로, 또는 읽기·쓰기 허용 폴더 안의 절대 경로' },
      content: { type: 'string', maxLength: 1_000_000 },
      append: { type: 'boolean' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = toolPath(env, str(input, 'path'));
    return { permission: 'fs.write', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    const abs = toolPath(env, str(input, 'path'));
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
  description: '작업 폴더나 허용 폴더 안의 파일과 폴더 목록을 봅니다. depth 로 하위 폴더를 몇 단계까지 볼지 정합니다 (1~3).',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', maxLength: 500, description: '작업 폴더 기준 상대 경로, 또는 허용 폴더 안의 절대 경로. 비우면 작업 폴더' },
      depth: { type: 'integer', minimum: 1, maximum: 3 },
    },
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = toolPath(env, str(input, 'path') || '.');
    return { permission: 'fs.read', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    const root = toolPath(env, str(input, 'path') || '.');
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

/** 셸이 끝난 뒤 출력 파이프가 닫히기를 기다리는 시간 (백그라운드 프로세스가 붙잡고 있으면 그 뒤에 끊음) */
export const PIPE_GRACE_MS = 1000;

const shellExec = (s: ToolServices): BuiltinTool => ({
  name: 'shell_exec',
  title: '셸 명령',
  description:
    '셸 명령을 실행하고 종료 코드와 출력을 돌려줍니다. 기본 실행 폴더는 작업 폴더이고, cwd 로 읽기·쓰기 허용 폴더에서 실행할 수 있습니다. ' +
    '셸의 ~ 와 $HOME 은 작업 폴더를 뜻하므로 허용 폴더는 절대 경로로 쓰세요. 서버의 비밀 환경 변수는 전달되지 않습니다.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', minLength: 1, maxLength: 4000 },
      timeout_ms: { type: 'integer', minimum: 1000 },
      cwd: { type: 'string', maxLength: 500, description: '실행할 폴더. 비우면 작업 폴더. 작업 폴더 기준 상대 경로나 읽기·쓰기 허용 폴더 안의 절대 경로' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const command = str(input, 'command');
    const parsed = parseCommand(command);
    const manager = parsed.segments.map(packageManagerOf).find((m) => m !== null) ?? null;
    const cwdIn = str(input, 'cwd').trim();
    // 실행 폴더도 경로 검사(작업 폴더 · 읽기·쓰기 허용 폴더)를 받도록 paths 에 넣습니다.
    const where = cwdIn ? { cwd: toolPath(env, cwdIn), paths: [toolPath(env, cwdIn)] } : {};
    const summary = `${command.slice(0, 120)}${cwdIn ? ` (${rel(env, toolPath(env, cwdIn))})` : ''}`;
    if (manager) return { permission: 'pkg.install', target: manager, command, summary, ...where };
    return { permission: 'shell.exec', target: command, command, summary, ...where };
  },
  run(input, env) {
    const command = str(input, 'command');
    const cwdIn = str(input, 'cwd').trim();
    const cwd = cwdIn ? toolPath(env, cwdIn) : env.workspace;
    if (cwdIn && !(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) {
      return Promise.reject(new ValidationError('shell_cwd', `실행 폴더 '${rel(env, cwd)}'이(가) 없거나 폴더가 아닙니다.`));
    }
    const limit = Math.min(typeof input['timeout_ms'] === 'number' ? input['timeout_ms'] : s.config.shellTimeoutMs, s.config.shellTimeoutMs);
    const max = s.config.shellOutputMaxBytes;
    const tmp = path.join(env.workspace, '.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    return new Promise<string>((resolve, reject) => {
      let child;
      try {
        child = spawn('/bin/sh', ['-c', command], {
          cwd,
          // HOME 을 작업 폴더로 둡니다. 기본 금지 조항(작업 폴더 탈출)도 ~ 와 $HOME 을 작업 폴더로 보고 검사합니다.
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
        const room = max - size;
        // 마지막 조각이 한도를 넘어도 잘렸다고 알립니다.
        if (chunk.length > room) cut = true;
        if (room <= 0) return;
        const piece = chunk.subarray(0, room).toString('utf8');
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
      let settled = false;
      let grace: NodeJS.Timeout | null = null;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, limit);
      const onAbort = (): void => killGroup();
      env.signal.addEventListener('abort', onAbort, { once: true });
      const finish = (code: number | null, signal: NodeJS.Signals | null, held: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        env.signal.removeEventListener('abort', onAbort);
        const head = timedOut
          ? `${Math.round(limit / 1000)}초 제한을 넘어 강제로 멈췄습니다.`
          : env.signal.aborted
            ? '작업이 취소되어 명령을 멈췄습니다.'
            : `종료 코드 ${code ?? `(신호 ${signal})`}`;
        const heldNote = held ? ` · 백그라운드 프로세스가 출력을 붙잡고 있어 ${PIPE_GRACE_MS / 1000}초 뒤 끊었습니다 (계속 띄워 두려면 출력을 파일로 보내세요: 명령 > app.log 2>&1 &)` : '';
        resolve(`${head}${heldNote}${cut ? ` · 출력이 ${max}바이트를 넘어 잘림` : ''}\n--- stdout ---\n${out.trimEnd()}\n--- stderr ---\n${err.trimEnd()}`);
      };
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (grace) clearTimeout(grace);
        env.signal.removeEventListener('abort', onAbort);
        reject(new ValidationError('shell_error', e.message.includes('ENOENT') ? '/bin/sh 를 찾지 못했습니다. 이 서버는 Linux·macOS 에서 셸 명령을 지원합니다.' : `명령 실행 오류: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        // 셸은 끝났는데 새 세션으로 빠져나간 백그라운드 프로세스(setsid 등)가 출력 파이프를 쥐고 있으면 'close' 가 오지 않습니다.
        // 프로세스 그룹을 죽여도 닿지 않으므로, 잠깐 기다린 뒤 파이프를 끊고 결과를 돌려줍니다 (작업이 영원히 멈추지 않게).
        grace = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(code, signal, true);
        }, PIPE_GRACE_MS);
      });
      child.on('close', (code, signal) => finish(code, signal, false));
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
    // 내부망 주소는 와일드카드가 아닌 항목(그대로 항목 포함)으로 직접 적은 호스트만 허용합니다.
    const explicit = (host: string): boolean => [...(rule?.scope ?? []), ...(rule?.always ?? [])].some((p) => (isExactEntry(p) || !p.includes('*')) && hostEntryMatches(p, host));
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
          return [...rule.scope, ...rule.always].some((p) => hostEntryMatches(p, host));
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
    const linked = s.store.listAgentModules(env.agent.id).map((l) => s.store.findModule(l.moduleId)).filter((m) => m && m.manifest.channel && m.manifest.channel.send !== false);
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

/* ───────── 위임 ───────── */

const delegateTask = (s: ToolServices): BuiltinTool => ({
  name: 'delegate_task',
  title: '다른 에이전트에게 맡기기',
  description:
    '다른 에이전트에게 일을 맡깁니다. 그 에이전트의 역할에 맞는 일이거나, 권한이 없어 직접 할 수 없는 일을 넘길 때 씁니다. ' +
    'to 는 시스템 프롬프트의 위임 목록에 있는 에이전트 이름, task 는 그 에이전트가 이 대화를 몰라도 이해할 수 있게 필요한 정보(링크 · 번호 · 재현 방법 등)를 모두 담아 씁니다. ' +
    '결과는 끝나는 대로 이 대화로 돌아옵니다. 서로 다른 일이 여러 건이면 건마다 따로 맡기고, 같은 일은 결과가 오기 전에 다시 맡기지 마세요.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', minLength: 1, maxLength: 24, description: '맡을 에이전트 이름' },
      task: { type: 'string', minLength: 1, maxLength: 8000, description: '맡길 일 (완결된 설명)' },
      reason: { type: 'string', maxLength: 500, description: '맡기는 이유 (예: 셸 명령 권한이 없음)' },
    },
    required: ['to', 'task'],
    additionalProperties: false,
  },
  describe(input): Described {
    return { permission: null, target: str(input, 'to'), text: str(input, 'task'), summary: `${str(input, 'to')} · ${str(input, 'task').replace(/\s+/g, ' ').slice(0, 60)}` };
  },
  run(input, env) {
    return s.delegate(env.agent, env, { to: str(input, 'to'), task: str(input, 'task'), reason: str(input, 'reason') });
  },
});

/* ───────── 하트비트 ───────── */

const heartbeatSet = (s: ToolServices): BuiltinTool => ({
  name: 'heartbeat_set',
  title: '하트비트 설정',
  description:
    '무엇을 확인하고 어떤 경우에 알릴지(점검 · 알릴 조건)와, 정해진 간격으로 스스로 점검하는 하트비트를 정합니다. 사용자가 "변화가 생기면 알려줘", "중요한 메일이 오면 알려줘"처럼 지켜봐 달라고 할 때 씁니다. ' +
    '메일처럼 연결된 모듈이 새 소식을 직접 보내 주는 일은 enabled=false 로 조건만 적고, 스스로 주기적으로 확인해야 하는 일(웹 페이지 · 서버 상태 등)은 enabled=true 와 every_minutes 로 켭니다. ' +
    '알릴 것이 없으면 조용히 있고, 알릴 것이 있을 때만 보고합니다. 보고 받을 곳은 report_to 로 고르고, 안 고르면 정해 둔 곳(없으면 지금 대화한 곳)으로 보고합니다.',
  input_schema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', description: 'true 면 every_minutes 마다 스스로 점검합니다. 모듈 자동 알림(새 메일 등)만으로 충분하면 false' },
      every_minutes: { type: 'integer', minimum: 1, maximum: 1440, description: '확인 간격(분)' },
      checklist: { type: 'string', maxLength: 4000, description: '확인할 것과 알릴 조건 (예: 결제 · 계약 · 장애 관련 메일이 오면 알린다). 하트비트와 모듈 자동 알림 모두 이 조건으로 판단합니다' },
      active_hours: { type: 'string', maxLength: 20, description: "확인할 시간대 'HH:MM-HH:MM' (서버 시간대). 빈 문자열이면 하루 종일" },
      report_to: reportToSchema("보고 받을 곳: 'here' 지금 대화한 곳 · 'web' 채널로 보내지 않고 웹 화면에만 · '<channel id>:<대상>' 연결된 채널의 대상 (예: discord:#alerts, telegram:123456789). 하트비트와 모듈 자동 알림의 보고가 모두 이리로 갑니다"),
    },
    required: ['enabled'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const every = typeof input['every_minutes'] === 'number' ? `${input['every_minutes']}분마다` : '간격 유지';
    const report = reportOf(s, input, env);
    const summary = `${input['enabled'] === true ? `켜기 · ${every}` : '끄기'}${report ? ` · 보고 → ${reportName(s, report)}` : ''}`;
    return { permission: 'heartbeat.manage', target: 'heartbeat', text: str(input, 'checklist'), summary };
  },
  async run(input, env) {
    const report = reportOf(s, input, env);
    const out = s.heartbeat(env.agent, env, {
      enabled: input['enabled'] === true,
      ...(typeof input['every_minutes'] === 'number' ? { everyMinutes: input['every_minutes'] } : {}),
      ...(typeof input['checklist'] === 'string' ? { checklist: input['checklist'] } : {}),
      ...(typeof input['active_hours'] === 'string' ? { activeHours: input['active_hours'] } : {}),
      ...(report ? { report } : {}),
    });
    return withAskNote(out, report);
  },
});

/* ───────── 관리 중인 프로젝트 ───────── */

const projectTrack = (s: ToolServices): BuiltinTool => ({
  name: 'project_track',
  title: '프로젝트 등록',
  description:
    '관리할 프로젝트(폴더 · 저장소)를 등록하거나, 이미 등록한 프로젝트의 이름 · 메모 · 하트비트 점검 여부를 고칩니다. ' +
    '사용자가 맡긴 프로젝트를 새로 만들거나 가져왔을 때(git clone 등), 또는 계속 관리하기로 한 폴더가 생겼을 때 씁니다. ' +
    'note 에는 무엇을 하는 곳이고 무엇을 관리하는지 적습니다. 사용자는 프로젝트 화면에서 어디서 무엇을 하는지 봅니다.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 500, description: '작업 폴더 기준 상대 경로, 또는 허용 폴더 안의 절대 경로 (폴더)' },
      name: { type: 'string', maxLength: 60, description: '보여 줄 이름 (비우면 폴더 이름)' },
      note: { type: 'string', maxLength: 300, description: '무엇을 하는 프로젝트인지 · 무엇을 관리하는지' },
      watch: { type: 'boolean', description: 'true 면 하트비트 점검 때 이 프로젝트도 확인합니다' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = toolPath(env, str(input, 'path'));
    return { permission: 'fs.read', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    const abs = toolPath(env, str(input, 'path'));
    return s.projects.track(env, abs, {
      ...(typeof input['name'] === 'string' ? { name: input['name'] } : {}),
      ...(typeof input['note'] === 'string' ? { note: input['note'] } : {}),
      ...(typeof input['watch'] === 'boolean' ? { watch: input['watch'] } : {}),
    });
  },
});

const projectUntrack = (s: ToolServices): BuiltinTool => ({
  name: 'project_untrack',
  title: '프로젝트 빼기',
  description: '더 관리하지 않는 프로젝트를 목록에서 뺍니다. 폴더와 파일은 지우지 않습니다.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1, maxLength: 500, description: '등록할 때 쓴 경로' } },
    required: ['path'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const abs = toolPath(env, str(input, 'path'));
    return { permission: 'fs.read', target: rel(env, abs), paths: [abs], summary: rel(env, abs) };
  },
  async run(input, env) {
    return s.projects.untrack(env, toolPath(env, str(input, 'path')));
  },
});

/* ───────── 예약 ───────── */

const SPEC_FORMS = 'every 30m · daily 09:00 · weekdays 09:00 · weekly mon 09:00 (서버 시간대)';

const scheduleCreate = (s: ToolServices): BuiltinTool => ({
  name: 'schedule_create',
  title: '예약 만들기',
  description: `정해진 시각에 스스로 작업을 시작하도록 예약합니다. spec 형식: ${SPEC_FORMS}. 결과는 report_to 로 고른 곳, 안 고르면 지금 대화한 곳으로 보냅니다.`,
  input_schema: {
    type: 'object',
    properties: {
      spec: { type: 'string', minLength: 1, maxLength: 40 },
      prompt: { type: 'string', minLength: 1, maxLength: 2000 },
      report_to: reportToSchema("결과 받을 곳: 'here' 지금 대화한 곳(기본) · 'web' 웹 화면에만 · '<channel id>:<대상>' (예: discord:#daily)"),
    },
    required: ['spec', 'prompt'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const report = reportOf(s, input, env);
    return { permission: 'schedule.create', target: str(input, 'spec'), summary: `${str(input, 'spec')} · ${str(input, 'prompt').slice(0, 40)}${report ? ` · 결과 → ${reportName(s, report)}` : ''}` };
  },
  async run(input, env) {
    const report = reportOf(s, input, env);
    return withAskNote(s.schedules.create(env.agent, str(input, 'spec'), str(input, 'prompt'), report ? report.to : env.reply), report);
  },
});

const scheduleList = (s: ToolServices): BuiltinTool => ({
  name: 'schedule_list',
  title: '예약 목록',
  description: '자신의 예약 실행 목록을 봅니다. id 를 넣으면 그 예약의 할 일(prompt) 전체를 보여 줍니다.',
  input_schema: { type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 64 } }, additionalProperties: false },
  describe(input): Described {
    return { permission: null, target: null, summary: str(input, 'id') ? `예약 ${str(input, 'id')}` : '예약 목록' };
  },
  async run(input, env) {
    return s.schedules.list(env.agent, str(input, 'id') || undefined);
  },
});

const scheduleUpdate = (s: ToolServices): BuiltinTool => ({
  name: 'schedule_update',
  title: '예약 고치기',
  description:
    '자신의 예약 하나를 고칩니다. 적은 항목만 바뀌고 나머지는 그대로입니다. 지우고 다시 만들지 말고 이 도구로 고치세요. ' +
    '잠시 멈출 때는 enabled=false 로 끄고(지우지 않음), 다시 켤 때는 enabled=true 입니다. 규칙(spec)을 바꾸거나 다시 켜면 지금부터 다음 실행 시각을 셉니다. ' +
    'prompt 는 통째로 바뀌므로 일부만 고칠 때는 schedule_list 에 id 를 넣어 전체를 보고 고친 전문을 넣으세요.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1, maxLength: 64, description: 'schedule_list 에 나오는 예약 id' },
      spec: { type: 'string', minLength: 1, maxLength: 40, description: `새 규칙: ${SPEC_FORMS}` },
      prompt: { type: 'string', minLength: 1, maxLength: 2000, description: '새로 할 일 (전체를 바꿉니다)' },
      enabled: { type: 'boolean', description: 'false 면 지우지 않고 끄고, true 면 다시 켭니다' },
      report_to: reportToSchema("결과 받을 곳: 'here' 지금 대화한 곳 · 'web' 웹 화면에만 · '<channel id>:<대상>' (예: discord:#daily)"),
    },
    required: ['id'],
    additionalProperties: false,
  },
  describe(input, env): Described {
    const report = reportOf(s, input, env);
    const changes = [
      ...(typeof input['spec'] === 'string' ? [`규칙 ${input['spec']}`] : []),
      ...(typeof input['prompt'] === 'string' ? ['할 일'] : []),
      ...(typeof input['enabled'] === 'boolean' ? [input['enabled'] ? '켜기' : '끄기'] : []),
      ...(report ? [`결과 → ${reportName(s, report)}`] : []),
    ];
    if (changes.length === 0) throw new ValidationError('schedule_no_change', '바꿀 항목(spec · prompt · enabled · report_to)을 하나 이상 적으세요.');
    return { permission: 'schedule.create', target: str(input, 'id'), text: str(input, 'prompt'), summary: `예약 ${str(input, 'id')} · ${changes.join(' · ')}` };
  },
  async run(input, env) {
    const report = reportOf(s, input, env);
    const out = s.schedules.update(env.agent, str(input, 'id'), {
      ...(typeof input['spec'] === 'string' ? { spec: input['spec'] } : {}),
      ...(typeof input['prompt'] === 'string' ? { prompt: input['prompt'] } : {}),
      ...(typeof input['enabled'] === 'boolean' ? { enabled: input['enabled'] } : {}),
      ...(report ? { reply: report.to } : {}),
    });
    return withAskNote(out, report);
  },
});

const scheduleCancel = (s: ToolServices): BuiltinTool => ({
  name: 'schedule_cancel',
  title: '예약 취소',
  description: '자신의 예약 하나를 아주 지웁니다. 잠시 멈추거나 고칠 때는 지우지 말고 schedule_update 를 쓰세요. id 는 schedule_list 에서 확인합니다.',
  input_schema: { type: 'object', properties: { id: { type: 'string', minLength: 1 } }, required: ['id'], additionalProperties: false },
  describe(input): Described {
    return { permission: 'schedule.create', target: str(input, 'id'), summary: `예약 ${str(input, 'id')} 취소` };
  },
  async run(input, env) {
    return s.schedules.cancel(env.agent, str(input, 'id'));
  },
});

export function builtinTools(s: ToolServices): BuiltinTool[] {
  return [fsRead(s), fsWrite(), fsList(), shellExec(s), httpRequest(s), sendMessage(s), skillCreate(s), moduleCreate(s), scheduleCreate(s), scheduleList(s), scheduleUpdate(s), scheduleCancel(s), delegateTask(s), heartbeatSet(s), projectTrack(s), projectUntrack(s)];
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
  schedule_update: ['schedule.create'],
  schedule_cancel: ['schedule.create'],
  schedule_list: [],
  send_message: [],
  // 위임은 권한 항목이 아니라 에이전트의 위임 설정(보내기 허용)으로 켜고 끕니다.
  delegate_task: [],
  heartbeat_set: ['heartbeat.manage'],
  // 프로젝트 등록은 그 폴더를 읽을 수 있어야 합니다 (작업 폴더 · 허용 폴더 밖은 기본 금지 조항이 막음).
  project_track: ['fs.read'],
  project_untrack: ['fs.read'],
};
