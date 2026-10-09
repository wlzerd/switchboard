import { ValidationError } from '../errors.ts';
import { linearProblem, regexRunner } from './safe-regex.ts';
import { HOOK_EVENTS, type HookAction, type HookCtx, type HookEvent } from './types.ts';

export type ConditionOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'matches'
  | 'not_matches'
  | 'in_window'
  | 'not_in_window';

export interface Condition {
  field: string;
  op: ConditionOp;
  value: string;
}

export interface RuleHook {
  id: string;
  name: string;
  event: HookEvent;
  enabled: boolean;
  action: HookAction;
  conditions: Condition[];
  reason: string;
  /** action 이 modify 일 때: 정규식 find 를 replace 로 바꿉니다 ($1 같은 그룹 참조 가능). */
  modify: { find: string; replace: string } | null;
}

export const CONDITION_OPS: readonly ConditionOp[] = ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'matches', 'not_matches', 'in_window', 'not_in_window'];

const COMMON_FIELDS = ['agent', 'now', 'weekday'];
export const FIELDS_BY_EVENT: Record<HookEvent, string[]> = {
  before_tool: ['tool', 'category', 'command', 'host', 'url', 'method', 'path', 'text', ...COMMON_FIELDS],
  after_tool: ['tool', 'category', 'command', 'host', 'url', 'method', 'path', 'output', ...COMMON_FIELDS],
  before_send: ['channel', 'target', 'text', ...COMMON_FIELDS],
  on_message: ['channel', 'target', 'user', 'text', ...COMMON_FIELDS],
  before_install: ['kind', 'id', ...COMMON_FIELDS],
};

export const ACTIONS_BY_EVENT: Record<HookEvent, HookAction[]> = {
  before_tool: ['deny', 'ask', 'log'],
  after_tool: ['deny', 'modify', 'log'],
  before_send: ['deny', 'ask', 'modify', 'log'],
  on_message: ['deny', 'log'],
  before_install: ['deny', 'ask', 'log'],
};

const ACTION_LABEL: Record<HookAction, string> = { deny: '차단', ask: '확인', modify: '수정', log: '기록' };

/** 'HH:MM-HH:MM' → 분 단위 [시작, 끝). 잘못되면 이유 문자열. */
export function parseWindow(value: string): { start: number; end: number } | string {
  const m = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return `시간대는 HH:MM-HH:MM 형식이어야 합니다. 받은 값: '${value}'`;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (h1 > 23 || h2 > 23) return `시(hour)는 00~23 이어야 합니다. 받은 값: '${value}'`;
  if (m1 > 59 || m2 > 59) return `분(minute)은 00~59 여야 합니다. 받은 값: '${value}'`;
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  if (start === end) return `시작과 끝이 같으면(${value}) 시간대가 비어 있습니다.`;
  return { start, end };
}

/** 시작 포함, 끝 미포함. 시작이 끝보다 늦으면 자정을 넘는 구간입니다 (22:00-08:00). */
export function inWindow(minutes: number, w: { start: number; end: number }): boolean {
  if (w.start < w.end) return minutes >= w.start && minutes < w.end;
  return minutes >= w.start || minutes < w.end;
}

/** '/pattern/flags' 또는 그냥 'pattern' 을 정규식으로. */
export function parseRegex(value: string): RegExp | string {
  const slashForm = /^\/(.*)\/([dgimsuvy]*)$/s.exec(value);
  try {
    return slashForm ? new RegExp(slashForm[1] as string, slashForm[2]) : new RegExp(value);
  } catch (err) {
    return `정규식을 해석할 수 없습니다: ${(err as Error).message}`;
  }
}

const ENV_REF = /^\$env:([A-Z_][A-Z0-9_]*)$/;

export function envRefName(value: string): string | null {
  const m = ENV_REF.exec(value.trim());
  return m ? (m[1] as string) : null;
}

export interface RuleRuntime {
  env: (name: string) => string | undefined;
  timeZone: string;
}

export function clockOf(now: Date, timeZone: string): { minutes: number; hhmm: string; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const h = Number(get('hour'));
  const m = Number(get('minute'));
  return { minutes: h * 60 + m, hhmm: `${get('hour')}:${get('minute')}`, weekday: get('weekday').toLowerCase() };
}

/** 이벤트 컨텍스트에서 필드 값을 꺼냅니다. input.a.b 처럼 점 경로도 반복문으로 따라갑니다. */
export function resolveField(ctx: HookCtx, field: string, timeZone: string): string | null {
  if (field === 'agent') return ctx.agentName;
  if (field === 'now') return clockOf(ctx.now, timeZone).hhmm;
  if (field === 'weekday') return clockOf(ctx.now, timeZone).weekday;
  switch (ctx.event) {
    case 'before_tool':
    case 'after_tool': {
      if (field.startsWith('input.')) {
        let node: unknown = ctx.input;
        for (const part of field.slice(6).split('.')) {
          if (node === null || typeof node !== 'object') return null;
          node = (node as Record<string, unknown>)[part];
        }
        if (node === undefined || node === null) return null;
        return typeof node === 'string' ? node : JSON.stringify(node);
      }
      const map: Record<string, string | null> = {
        tool: ctx.tool,
        category: ctx.category,
        command: ctx.command,
        host: ctx.host,
        url: ctx.url,
        method: ctx.method,
        path: ctx.paths[0] ?? null,
        text: ctx.text,
        output: ctx.output ?? null,
      };
      return field in map ? (map[field] ?? null) : null;
    }
    case 'before_send':
      return field === 'channel' ? ctx.channel : field === 'target' ? ctx.target : field === 'text' ? ctx.text : null;
    case 'on_message':
      return field === 'channel' ? ctx.channel : field === 'target' ? ctx.target : field === 'user' ? ctx.user : field === 'text' ? ctx.text : null;
    case 'before_install':
      return field === 'kind' ? ctx.kind : field === 'id' ? ctx.id : null;
  }
}

export interface ConditionResult {
  matched: boolean;
  /** 조건을 평가하지 못한 이유 (환경 변수 없음 등) */
  skipped?: string;
}

const MAX_TEXT = 100_000;

/** 조건 비교에 쓰는 필드 값: 너무 긴 본문은 앞 100,000자만 봅니다. 규칙 훅과 코드 훅(h.field)이 같은 값을 씁니다. */
export function fieldText(ctx: HookCtx, field: string, timeZone: string): string | null {
  const actual = resolveField(ctx, field, timeZone);
  if (actual === null) return null;
  return actual.length > MAX_TEXT ? actual.slice(0, MAX_TEXT) : actual;
}

export function evalCondition(c: Condition, ctx: HookCtx, rt: RuleRuntime): ConditionResult {
  let value = c.value;
  const envName = envRefName(value);
  if (envName) {
    const v = rt.env(envName);
    if (v === undefined || v.trim() === '') return { matched: false, skipped: `조건이 참조하는 환경 변수 ${envName} 이(가) 비어 있어 건너뛰었습니다.` };
    value = v.trim();
  }
  if (c.op === 'in_window' || c.op === 'not_in_window') {
    const w = parseWindow(value);
    if (typeof w === 'string') return { matched: false, skipped: w };
    const inside = inWindow(clockOf(ctx.now, rt.timeZone).minutes, w);
    return { matched: c.op === 'in_window' ? inside : !inside };
  }
  const actual = fieldText(ctx, c.field, rt.timeZone);
  const text = actual ?? '';
  switch (c.op) {
    case 'eq':
      return { matched: actual !== null && text === value };
    case 'neq':
      return { matched: actual === null || text !== value };
    case 'contains':
      return { matched: actual !== null && text.includes(value) };
    case 'not_contains':
      return { matched: actual === null || !text.includes(value) };
    case 'starts_with':
      return { matched: actual !== null && text.startsWith(value) };
    case 'matches':
    case 'not_matches': {
      const re = parseRegex(value);
      if (typeof re === 'string') return { matched: false, skipped: re };
      if (actual === null) return { matched: c.op === 'not_matches' };
      // 사용자가 쓴 정규식은 시간 제한을 두고 별도 스레드에서 돌립니다 (서버가 멈추지 않게).
      const r = regexRunner.test(re.source, re.flags, text);
      if (!r.ok) {
        // 시간 안에 판단하지 못하면 조건이 맞는 것으로 봅니다: 차단 · 확인 훅을 느린 입력으로 피해 가지 못하게.
        if (r.timedOut) return { matched: true, skipped: `${r.error}. 조건이 맞는 것으로 보고 처리했습니다.` };
        return { matched: false, skipped: r.error };
      }
      return { matched: c.op === 'matches' ? r.value : !r.value };
    }
  }
}

/** 이유 문구의 {필드} 를 실제 값으로 바꿉니다. 모르는 필드는 그대로 둡니다. */
export function renderReason(template: string, ctx: HookCtx, timeZone: string): string {
  return template.replace(/\{([a-z_.]+)\}/g, (whole, field: string) => resolveField(ctx, field, timeZone) ?? whole);
}

/** API로 들어온 규칙 훅 검증. 무엇이 왜 잘못됐는지 항목별로 알려줍니다. */
export function validateRuleHook(input: unknown, envHas: (name: string) => boolean): Omit<RuleHook, 'id'> {
  if (input === null || typeof input !== 'object') throw new ValidationError('hook_type', '훅 설정은 객체여야 합니다.');
  const h = input as Record<string, unknown>;
  const name = typeof h['name'] === 'string' ? h['name'].trim() : '';
  if (name.length < 1 || name.length > 40) throw new ValidationError('hook_name', `훅 이름은 1~40자여야 합니다. 받은 값: ${name.length}자`);
  const event = h['event'];
  if (!HOOK_EVENTS.includes(event as HookEvent)) throw new ValidationError('hook_event', `이벤트는 ${HOOK_EVENTS.join(', ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(event)}`);
  const ev = event as HookEvent;
  const action = h['action'] as HookAction;
  if (!ACTIONS_BY_EVENT[ev].includes(action)) {
    throw new ValidationError('hook_action', `${ev} 이벤트에서 쓸 수 있는 동작은 ${ACTIONS_BY_EVENT[ev].map((a) => `${a}(${ACTION_LABEL[a]})`).join(', ')} 입니다. 받은 값: ${JSON.stringify(action)}`);
  }
  const rawConds = h['conditions'];
  if (!Array.isArray(rawConds) || rawConds.length === 0) throw new ValidationError('hook_conditions_empty', '조건이 하나 이상 필요합니다. 조건이 없으면 모든 호출에 적용되어 위험합니다.');
  if (rawConds.length > 10) throw new ValidationError('hook_conditions_many', `조건은 10개까지 넣을 수 있습니다. 지금 ${rawConds.length}개입니다.`);
  const conditions: Condition[] = rawConds.map((c, i) => validateCondition(c, i, ev, envHas));
  const reason = typeof h['reason'] === 'string' ? h['reason'].trim() : '';
  if (reason.length < 1 || reason.length > 200) throw new ValidationError('hook_reason', `문구는 1~200자여야 합니다. 받은 값: ${reason.length}자`);
  let modify: RuleHook['modify'] = null;
  if (action === 'modify') {
    const m = h['modify'] as { find?: unknown; replace?: unknown } | undefined;
    if (!m || typeof m.find !== 'string' || m.find === '' || typeof m.replace !== 'string') {
      throw new ValidationError('hook_modify', '수정 동작에는 찾을 정규식(find)과 바꿀 문자열(replace)이 필요합니다.');
    }
    const re = parseRegex(m.find);
    if (typeof re === 'string') throw new ValidationError('hook_modify_regex', `수정할 패턴(find): ${re}`);
    const slow = linearProblem(re.source, re.flags);
    if (slow) throw new ValidationError('hook_modify_regex_slow', `수정할 패턴(find): ${slow}`);
    modify = { find: m.find, replace: m.replace };
  }
  return { name, event: ev, enabled: h['enabled'] !== false, action, conditions, reason, modify };
}

function validateCondition(raw: unknown, index: number, event: HookEvent, envHas: (name: string) => boolean): Condition {
  const n = index + 1;
  if (raw === null || typeof raw !== 'object') throw new ValidationError('hook_condition_type', `${n}번째 조건이 객체가 아닙니다.`);
  const c = raw as Record<string, unknown>;
  const op = c['op'] as ConditionOp;
  if (!CONDITION_OPS.includes(op)) throw new ValidationError('hook_condition_op', `${n}번째 조건의 연산자 '${String(op)}'를 알 수 없습니다. 가능한 값: ${CONDITION_OPS.join(', ')}`);
  const value = typeof c['value'] === 'string' ? c['value'] : '';
  const field = typeof c['field'] === 'string' ? c['field'] : '';
  if (op !== 'in_window' && op !== 'not_in_window') {
    const allowed = FIELDS_BY_EVENT[event];
    const ok = allowed.includes(field) || ((event === 'before_tool' || event === 'after_tool') && /^input\.[A-Za-z0-9_.]+$/.test(field));
    if (!ok) throw new ValidationError('hook_condition_field', `${n}번째 조건의 필드 '${field}'는 ${event} 이벤트에 없습니다. 가능한 필드: ${allowed.join(', ')}${event.endsWith('tool') ? ', input.<경로>' : ''}`);
  }
  const envName = envRefName(value);
  if (envName && !envHas(envName)) {
    throw new ValidationError('hook_condition_env', `${n}번째 조건이 참조하는 값 ${envName} 이(가) 없습니다. 설정 화면의 훅 값에서 먼저 넣으세요.`);
  }
  if (!envName) {
    if (op === 'in_window' || op === 'not_in_window') {
      const w = parseWindow(value);
      if (typeof w === 'string') throw new ValidationError('hook_condition_window', `${n}번째 조건: ${w}`);
    }
    if (op === 'matches' || op === 'not_matches') {
      const re = parseRegex(value);
      if (typeof re === 'string') throw new ValidationError('hook_condition_regex', `${n}번째 조건: ${re}`);
      const slow = linearProblem(re.source, re.flags);
      if (slow) throw new ValidationError('hook_condition_regex_slow', `${n}번째 조건: ${slow}`);
    }
    if (value === '' && op !== 'eq' && op !== 'neq') throw new ValidationError('hook_condition_value', `${n}번째 조건의 값이 비어 있습니다.`);
  }
  return { field: op === 'in_window' || op === 'not_in_window' ? 'now' : field, op, value };
}

/**
 * 규칙 훅을 같은 뜻의 코드 훅으로 보여줍니다. DATA_DIR/hooks/<id>.mjs 로 저장하면 그대로 동작합니다
 * (when·reason·modify 의 두 번째 인자 h 는 엔진의 hookHelpers).
 */
export function renderHookCode(h: Pick<RuleHook, 'id' | 'name' | 'event' | 'action' | 'conditions' | 'reason' | 'modify'> & { enabled?: boolean }): string {
  const q = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`;
  const val = (v: string): string => {
    const e = envRefName(v);
    return e ? `h.env(${q(e)})` : q(v);
  };
  const expr = (c: Condition): string => {
    const f = `h.field(${q(c.field)})`;
    switch (c.op) {
      case 'eq': return `${f} === ${val(c.value)}`;
      case 'neq': return `${f} !== ${val(c.value)}`;
      case 'contains': return `${f}?.includes(${val(c.value)}) === true`;
      case 'not_contains': return `${f}?.includes(${val(c.value)}) !== true`;
      case 'starts_with': return `${f}?.startsWith(${val(c.value)}) === true`;
      case 'matches': return `h.matches(${q(c.field)}, ${regexCode(c.value, '', q, true)})`;
      case 'not_matches': return `!h.matches(${q(c.field)}, ${regexCode(c.value, '', q, true)})`;
      case 'in_window': return `h.inWindow(${val(c.value)})`;
      case 'not_in_window': return `!h.inWindow(${val(c.value)})`;
    }
  };
  const lines = [
    `// DATA_DIR/hooks/${h.id}.mjs`,
    'export default {',
    `  name: ${q(h.name)},`,
    `  on: ${q(h.event)},`,
    `  action: ${q(h.action)},`,
    ...(h.enabled === false ? ['  enabled: false,'] : []),
    `  when: (ctx, h) =>\n    ${h.conditions.map(expr).join(' &&\n    ')},`,
  ];
  // 수정 패턴은 규칙 훅에서도 $env: 참조를 풀지 않으므로 그대로 정규식으로 씁니다.
  if (h.modify) lines.push(`  modify: (text) => text.replace(${regexCode(h.modify.find, 'g', q, false)}, ${q(h.modify.replace)}),`);
  lines.push(`  reason: ${q(h.reason)},`, '};');
  return lines.join('\n');
}

/** 슬래시 앞에 역슬래시가 없으면 이스케이프합니다 (이미 이스케이프된 \/ 는 그대로). */
function escapeSlashes(body: string): string {
  let out = '';
  let escaped = false;
  for (const ch of body) {
    if (escaped) {
      out += ch;
      escaped = false;
    } else if (ch === '\\') {
      out += ch;
      escaped = true;
    } else {
      out += ch === '/' ? '\\/' : ch;
    }
  }
  return out;
}

/** 규칙 값을 같은 뜻의 정규식 코드로. 줄바꿈처럼 리터럴에 못 쓰는 문자가 있으면 new RegExp(...) 로 씁니다. */
function regexCode(v: string, extraFlags: string, q: (s: string) => string, allowEnv: boolean): string {
  const e = allowEnv ? envRefName(v) : null;
  // 환경 변수 값은 '/패턴/플래그' 형식일 수 있으므로 h.matches 가 규칙 훅과 같은 방식으로 해석합니다.
  if (e) return `h.env(${q(e)})`;
  const slash = /^\/(.*)\/([dgimsuvy]*)$/s.exec(v);
  const body = slash ? (slash[1] as string) : v;
  const flags = Array.from(new Set(((slash ? (slash[2] as string) : '') + extraFlags).split(''))).join('');
  if (/[\n\r\u2028\u2029]/.test(body) || body === '') return `new RegExp(${q(body)}, ${q(flags)})`;
  return `/${escapeSlashes(body)}/${flags}`;
}
