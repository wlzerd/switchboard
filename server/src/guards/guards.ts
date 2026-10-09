import path from 'node:path';
import type { HookCtx, HookEvent, InstallCtx, SendCtx, ToolCtx } from '../hooks/types.ts';
import { SlidingWindow } from '../limits/limits.ts';
import { commandArgs, commandName, parseCommand, type ParsedCommand, type Segment } from '../permissions/shell.ts';
import { findSecret } from './secrets.ts';

export interface GuardLists {
  financeHosts: string[];
  secretFileNames: string[];
  secretFileExtensions: string[];
  secretDirectories: string[];
  shellInterpreters: string[];
}

export interface GuardEnv {
  lists: GuardLists;
  /** 서버가 가진 비밀값 원문 (.env 키·토큰, 저장된 API 키) */
  knownSecrets: () => string[];
  /** 서버 자신의 API 로 들어오는 호스트 (localhost 등) */
  selfHosts: string[];
  /** 에이전트가 건드리면 안 되는 서버 설정 경로 (훅·권한 설정 등) */
  protectedPaths: string[];
  floodPerMinute: number;
  loopRepeat: number;
}

export interface GuardDef {
  id: string;
  name: string;
  events: HookEvent[];
  /** UI에 보여줄 조건 요약 */
  conditions: string[];
  /** 문구 틀 (UI 표시용) */
  reasonTemplate: string;
}

export interface GuardHit {
  guard: string;
  name: string;
  reason: string;
}

/** 경로가 root 안(같은 경로 포함)인지. '..foo' 같은 이름은 상위 경로로 보지 않습니다. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + path.sep);
}

/** 셸 인자가 경로처럼 보이면 작업 폴더 기준 절대 경로로, 아니면 null. ~ 와 $HOME 은 홈 밖이므로 특수 표식을 돌려줍니다. */
export function shellArgPath(arg: string, workspace: string): string | null {
  let v = arg;
  const eq = v.indexOf('=');
  if (v.startsWith('-') && eq !== -1) v = v.slice(eq + 1);
  if (v === '' || v.startsWith('-')) return null;
  if (v === '~' || v.startsWith('~/') || v.startsWith('$HOME') || v.startsWith('${HOME}')) return '\u0000HOME';
  const looksLikePath = v.startsWith('/') || v === '..' || v.startsWith('../') || v.includes('/../') || v.endsWith('/..') || v.startsWith('./');
  if (!looksLikePath && !v.includes('/')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return null; // URL
  return path.resolve(workspace, v);
}

const SAFE_DEVICES = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/stdin', '/dev/zero', '/dev/random', '/dev/urandom']);

function isSecretPath(p: string, lists: GuardLists): boolean {
  const base = path.basename(p);
  const lower = base.toLowerCase();
  if (lower === '.env.example' || lower === '.env.sample' || lower.endsWith('.pub')) return false;
  if (lists.secretFileNames.includes(lower) || lower.startsWith('.env.')) return true;
  if (lists.secretFileNames.some((n) => n.startsWith('id_') && lower.startsWith(n))) return true;
  if (lists.secretFileExtensions.some((ext) => lower.endsWith(ext))) return true;
  const parts = p.split(/[\\/]+/);
  return parts.some((part) => lists.secretDirectories.includes(part));
}

function segmentPaths(seg: Segment, workspace: string): { arg: string; abs: string }[] {
  const out: { arg: string; abs: string }[] = [];
  const name = commandName(seg.words);
  const args = commandArgs(seg.words);
  for (const a of args) {
    const abs = shellArgPath(a, workspace);
    if (abs !== null) out.push({ arg: a, abs });
  }
  for (const r of seg.redirects) {
    const abs = shellArgPath(r.target.startsWith('/') || r.target.includes('/') ? r.target : `./${r.target}`, workspace);
    if (abs !== null) out.push({ arg: r.target, abs });
  }
  if (name === 'cd' && args.length === 0) out.push({ arg: 'cd', abs: '\u0000HOME' });
  return out;
}

/**
 * 비밀 파일 검사용: 경로 표시가 없는 맨 파일 이름(.env 등)까지 포함해 모든 인자를 작업 폴더 기준 경로로 풉니다.
 * `--file=.env` 처럼 옵션 값에 붙은 경우도 확인합니다.
 */
function segmentFileCandidates(seg: Segment, workspace: string): { arg: string; abs: string }[] {
  const out: { arg: string; abs: string }[] = [];
  const values = [...commandArgs(seg.words), ...seg.redirects.map((r) => r.target)];
  for (const a of values) {
    const eq = a.indexOf('=');
    const v = a.startsWith('-') ? (eq === -1 ? '' : a.slice(eq + 1)) : a;
    if (v === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) continue;
    const special = shellArgPath(v, workspace);
    if (special === '\u0000HOME') {
      out.push({ arg: a, abs: path.join('/home', v.replace(/^(~|\$\{?HOME\}?)/, '')) });
      continue;
    }
    out.push({ arg: a, abs: special ?? path.resolve(workspace, v) });
  }
  return out;
}

function hasRecursiveForce(args: readonly string[]): boolean {
  let r = false;
  let f = false;
  for (const a of args) {
    if (a === '--recursive') r = true;
    else if (a === '--force') f = true;
    else if (/^-[A-Za-z]+$/.test(a)) {
      if (/[rR]/.test(a)) r = true;
      if (a.includes('f')) f = true;
    }
  }
  return r && f;
}

const ROOT_TARGETS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '${HOME}', '$HOME/', '/.', '/..', '.', '..', '*', './*', '../*']);

/** 위험 명령 판정. 걸리면 사람이 읽을 이유를, 아니면 null. */
export function dangerousCommandReason(parsed: ParsedCommand, raw: string, interpreters: readonly string[]): string | null {
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;?\s*:/.test(raw)) return '포크 폭탄 형태의 명령';
  const segs = parsed.segments;
  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i] as Segment;
    const name = commandName(seg.words);
    const args = commandArgs(seg.words);
    if (name === null) continue;
    if (name === 'rm' && hasRecursiveForce(args)) {
      if (args.includes('--no-preserve-root')) return '루트 보호를 끄는 강제 삭제 (rm --no-preserve-root)';
      const target = args.find((a) => !a.startsWith('-') && ROOT_TARGETS.has(a));
      if (target !== undefined) return `전체 삭제로 이어질 수 있는 강제 삭제 (rm -rf ${target})`;
    }
    if (name === 'mkfs' || name.startsWith('mkfs.')) return `디스크 포맷 명령 (${name})`;
    if (name === 'dd' && args.some((a) => a.startsWith('of=/dev/'))) return '장치에 직접 쓰는 dd 명령';
    if (['shutdown', 'reboot', 'halt', 'poweroff'].includes(name)) return `서버 전원 명령 (${name})`;
    if (name === 'init' && (args[0] === '0' || args[0] === '6')) return `서버 전원 명령 (init ${args[0]})`;
    if (name === 'systemctl' && ['poweroff', 'reboot', 'halt', 'kexec'].includes(args[0] ?? '')) return `서버 전원 명령 (systemctl ${args[0]})`;
    if ((name === 'chmod' || name === 'chown') && args.some((a) => /^-[A-Za-z]*R/.test(a) || a === '--recursive') && args.some((a) => a === '/' || a === '/*')) {
      return `루트 전체의 권한을 바꾸는 명령 (${name} -R /)`;
    }
    if (seg.redirects.some((r) => /^\/dev\/(sd|hd|nvme|disk|mmcblk|xvd)/.test(r.target))) return '디스크 장치에 직접 쓰는 리다이렉트';
    if ((name === 'curl' || name === 'wget') && i + 1 < segs.length) {
      const next = segs[i + 1] as Segment;
      const nextName = commandName(next.words);
      if (next.before === '|' && nextName !== null && interpreters.includes(nextName)) {
        return `내려받은 스크립트를 바로 실행하는 명령 (${name} … | ${nextName})`;
      }
    }
  }
  return null;
}

const PRIVILEGE_COMMANDS = new Set(['sudo', 'su', 'doas', 'pkexec', 'runas']);

function privilegeReason(parsed: ParsedCommand): string | null {
  for (const seg of parsed.segments) {
    const name = commandName(seg.words);
    if (name !== null && PRIVILEGE_COMMANDS.has(name)) return name;
  }
  return null;
}

function hostAndPath(url: string | null): { host: string; path: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase().replace(/^\[|\]$/g, ''), path: u.pathname };
  } catch {
    return null;
  }
}

export const GUARD_DEFS: readonly GuardDef[] = [
  { id: 'secret-leak', name: '비밀값 유출 차단', events: ['before_send', 'before_tool'], conditions: ['sk-ant-…', 'ghp_…', 'xoxb-…', '봇 토큰 형식', '서버에 등록된 비밀값'], reasonTemplate: '{kind} 형식의 문자열이 있어 내보내지 않았습니다 ({line}번째 줄)' },
  { id: 'secret-files', name: '비밀 파일 접근 차단', events: ['before_tool'], conditions: ['.env', '*.pem', '*.key', '~/.ssh/**', 'id_rsa'], reasonTemplate: '{path} 는 비밀 파일이라 읽거나 쓸 수 없습니다' },
  { id: 'danger-cmd', name: '위험 명령 차단', events: ['before_tool'], conditions: ['rm -rf /', 'mkfs', 'dd of=/dev/*', 'shutdown', 'curl … | sh'], reasonTemplate: '위험 명령으로 분류되어 실행하지 않았습니다: {이유}' },
  { id: 'privilege', name: '권한 상승 차단', events: ['before_tool'], conditions: ['sudo', 'su', 'doas', 'pkexec'], reasonTemplate: '권한 상승 명령({command})은 실행할 수 없습니다' },
  { id: 'escape', name: '작업 폴더 탈출 차단', events: ['before_tool'], conditions: ['작업 폴더 밖 경로', '../', '~', '심볼릭 링크'], reasonTemplate: '{path} 는 작업 폴더 밖입니다' },
  { id: 'self-modify', name: '자기 권한 · 훅 변경 차단', events: ['before_tool'], conditions: ['서버 자신의 /api 호출', '권한·훅 설정 파일'], reasonTemplate: '에이전트는 자신의 권한과 훅을 바꿀 수 없습니다' },
  { id: 'hardcoded', name: '하드코딩된 비밀값 차단', events: ['before_install'], conditions: ['모듈 · 스킬 코드 안의 키 · 토큰'], reasonTemplate: '{file}:{line} 에 비밀값이 직접 들어 있습니다. ctx.env 참조로 바꿔야 설치됩니다' },
  { id: 'finance', name: '금융 거래 차단', events: ['before_tool'], conditions: ['결제 · 송금 · 주문 API의 쓰기 요청'], reasonTemplate: '금융 거래 API({host})로 보내는 {method} 요청은 실행할 수 없습니다' },
  { id: 'flood', name: '대량 발송 제한', events: ['before_send'], conditions: ['분당 발송 한도 초과'], reasonTemplate: '분당 발송 한도({limit}건)를 넘어 보내지 않았습니다' },
  { id: 'loop', name: '무한 반복 차단', events: ['before_tool'], conditions: ['같은 도구 · 같은 입력 연속 호출'], reasonTemplate: '같은 호출이 {n}회 연속 반복되어 막았습니다' },
];

function hit(id: string, reason: string): GuardHit {
  const def = GUARD_DEFS.find((g) => g.id === id) as GuardDef;
  return { guard: id, name: def.name, reason };
}

/** 객체를 키 순서와 무관하게 같은 문자열로 (반복 호출 비교용). 깊이가 깊어도 스택을 쓰는 반복으로 처리합니다. */
export function stableStringify(value: unknown): string {
  const out: string[] = [];
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string' && v.startsWith('\u0001')) {
      out.push(v.slice(1));
      continue;
    }
    if (v === null || typeof v !== 'object') {
      out.push(JSON.stringify(v) ?? 'null');
      continue;
    }
    if (seen.has(v)) {
      out.push('"[순환]"');
      continue;
    }
    seen.add(v);
    if (Array.isArray(v)) {
      stack.push('\u0001]');
      for (let i = v.length - 1; i >= 0; i -= 1) {
        stack.push(v[i]);
        if (i > 0) stack.push('\u0001,');
      }
      stack.push('\u0001[');
    } else {
      const keys = Object.keys(v).sort();
      stack.push('\u0001}');
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const k = keys[i] as string;
        stack.push((v as Record<string, unknown>)[k]);
        stack.push(`\u0001${JSON.stringify(k)}:`);
        if (i > 0) stack.push('\u0001,');
      }
      stack.push('\u0001{');
    }
  }
  return out.join('');
}

/** 상태가 필요한 가드(대량 발송, 무한 반복)의 기록. 서버가 켜져 있는 동안 메모리에 둡니다. */
export class GuardState {
  readonly flood = new SlidingWindow();
  private readonly lastCall = new Map<string, { sig: string; count: number }>();

  /** 같은 호출 연속 횟수를 올리고 현재 횟수를 돌려줍니다. */
  bumpCall(taskId: string, sig: string): number {
    const prev = this.lastCall.get(taskId);
    const count = prev && prev.sig === sig ? prev.count + 1 : 1;
    this.lastCall.set(taskId, { sig, count });
    return count;
  }

  endTask(taskId: string): void {
    this.lastCall.delete(taskId);
  }
}

/**
 * 기본 금지 조항을 순서대로 검사해 처음 걸린 것을 돌려줍니다. 금지 조항은 끌 수 없습니다.
 * 상태를 바꾸는 검사(대량 발송, 무한 반복)는 다른 검사를 모두 통과한 뒤 마지막에 셉니다.
 */
export function runGuards(ctx: HookCtx, env: GuardEnv, state: GuardState): GuardHit | null {
  switch (ctx.event) {
    case 'before_tool':
      return toolGuards(ctx, env, state);
    case 'before_send':
      return sendGuards(ctx, env, state);
    case 'before_install':
      return installGuards(ctx, env);
    default:
      return null;
  }
}

function toolGuards(ctx: ToolCtx, env: GuardEnv, state: GuardState): GuardHit | null {
  const known = env.knownSecrets();
  const lists = env.lists;

  // 1) 비밀값 유출: 밖으로 나가는 내용 + 명령 + URL
  for (const text of [ctx.text, ctx.command, ctx.url]) {
    if (!text) continue;
    const s = findSecret(text, known);
    if (s) return hit('secret-leak', `${s.kind} 형식의 문자열이 있어 실행하지 않았습니다 (${s.line}번째 줄). 비밀값은 env 로만 다뤄야 합니다.`);
  }

  // 2) 비밀 파일
  for (const p of ctx.paths) {
    if (isSecretPath(p, lists)) return hit('secret-files', `${displayPath(p, ctx.workspace)} 는 비밀 파일이라 읽거나 쓸 수 없습니다.`);
  }

  let parsed: ParsedCommand | null = null;
  if (ctx.command) {
    parsed = parseCommand(ctx.command);
    for (const seg of parsed.segments) {
      for (const { arg, abs } of segmentFileCandidates(seg, ctx.workspace)) {
        if (isSecretPath(abs, lists)) return hit('secret-files', `${arg} 는 비밀 파일이라 명령에서 쓸 수 없습니다.`);
      }
    }
    // 3) 위험 명령
    const danger = dangerousCommandReason(parsed, ctx.command, lists.shellInterpreters);
    if (danger) return hit('danger-cmd', `위험 명령으로 분류되어 실행하지 않았습니다: ${danger}`);
    // 4) 권한 상승
    const priv = privilegeReason(parsed);
    if (priv) return hit('privilege', `권한 상승 명령(${priv})은 실행할 수 없습니다.`);
  }

  // 5) 작업 폴더 탈출
  for (const p of ctx.paths) {
    if (!isInside(ctx.workspace, p)) return hit('escape', `${p} 는 작업 폴더 밖입니다. 작업 폴더 안의 경로만 쓸 수 있습니다.`);
  }
  if (parsed) {
    for (const seg of parsed.segments) {
      for (const { arg, abs } of segmentPaths(seg, ctx.workspace)) {
        if (abs === '\u0000HOME') return hit('escape', `${arg} 는 홈 폴더를 가리킵니다. 작업 폴더 안의 경로만 쓸 수 있습니다.`);
        if (SAFE_DEVICES.has(abs)) continue;
        if (!isInside(ctx.workspace, abs)) return hit('escape', `${arg} 는 작업 폴더 밖 경로(${abs})입니다.`);
      }
    }
  }

  // 6) 자기 권한·훅 변경
  const hp = hostAndPath(ctx.url);
  if (hp && env.selfHosts.includes(hp.host) && hp.path.startsWith('/api')) {
    return hit('self-modify', `서버 자신의 API(${hp.host}${hp.path})는 에이전트가 호출할 수 없습니다. 에이전트는 자신의 권한과 훅을 바꿀 수 없습니다.`);
  }
  for (const p of ctx.paths) {
    if (env.protectedPaths.some((pp) => isInside(pp, p))) return hit('self-modify', `${p} 는 서버의 권한·훅 설정이라 에이전트가 바꿀 수 없습니다.`);
  }

  // 8) 금융 거래
  if (hp && ctx.method && ctx.method.toUpperCase() !== 'GET' && ctx.method.toUpperCase() !== 'HEAD') {
    if (lists.financeHosts.includes(hp.host)) {
      return hit('finance', `금융 거래 API(${hp.host}${hp.path})로 보내는 ${ctx.method.toUpperCase()} 요청은 에이전트가 실행할 수 없습니다.`);
    }
  }

  // 10) 무한 반복 — 마지막에 셉니다 (다른 이유로 막힌 호출은 세지 않음)
  if (ctx.taskId) {
    const count = state.bumpCall(ctx.taskId, `${ctx.tool}:${stableStringify(ctx.input)}`);
    if (count > env.loopRepeat) {
      return hit('loop', `같은 호출(${ctx.tool})이 ${count}회 연속 반복되어 막았습니다. 같은 입력은 ${env.loopRepeat}회까지 연속으로 쓸 수 있습니다. 다른 방법을 쓰거나 작업을 멈추세요.`);
    }
  }
  return null;
}

function sendGuards(ctx: SendCtx, env: GuardEnv, state: GuardState): GuardHit | null {
  const s = findSecret(ctx.text, env.knownSecrets());
  if (s) return hit('secret-leak', `${s.kind} 형식의 문자열이 있어 보내지 않았습니다 (${s.line}번째 줄).`);
  const limit = Math.min(ctx.perMinute, env.floodPerMinute);
  const key = ctx.agentId ?? 'system';
  const r = state.flood.hit(key, ctx.now.getTime(), limit, 60_000);
  if (!r.allowed) {
    const sec = Math.max(1, Math.ceil(r.retryInMs / 1000));
    return hit('flood', `분당 발송 한도(${limit}건)를 넘어 보내지 않았습니다. ${sec}초 뒤 다시 보낼 수 있습니다.`);
  }
  return null;
}

function installGuards(ctx: InstallCtx, env: GuardEnv): GuardHit | null {
  const known = env.knownSecrets();
  for (const f of ctx.files) {
    const s = findSecret(f.content, known);
    if (s) return hit('hardcoded', `${f.path}:${s.line} 에 ${s.kind}이(가) 직접 들어 있습니다. 코드에는 ctx.env.이름 으로 참조하고 값은 .env 에 넣어야 설치됩니다.`);
  }
  return null;
}

function displayPath(p: string, workspace: string): string {
  return isInside(workspace, p) ? path.relative(workspace, p) || '.' : p;
}
