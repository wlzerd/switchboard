import type { Meta, Mode, PermissionRule, RuleHook } from './types';

/**
 * 권한 · 훅 화면의 입력 검사. 서버 검증(server/src/limits, server/src/hooks/rules.ts)과 같은 규칙으로
 * 저장 전에 바로 알려 줍니다. 최종 판단은 언제나 서버가 합니다.
 */

export const MODE_LABEL: Record<Mode, string> = { allow: '허용', ask: '확인', deny: '차단' };
export const ACTION_LABEL: Record<RuleHook['action'], string> = { deny: '차단', ask: '확인', modify: '수정', log: '기록' };
export const EVENT_LABEL: Record<string, string> = {
  before_tool: '도구 실행 전',
  after_tool: '도구 실행 후',
  before_send: '메시지 보내기 전',
  on_message: '메시지 받을 때',
  before_install: '모듈 설치 전',
};
export const OP_LABEL: Record<string, string> = {
  eq: '같음',
  neq: '다름',
  contains: '포함',
  not_contains: '포함 안 함',
  starts_with: '로 시작',
  matches: '정규식 일치',
  not_matches: '정규식 불일치',
  in_window: '시간대 안',
  not_in_window: '시간대 밖',
};

export const HOOK_NAME_MAX = 40;
export const HOOK_REASON_MAX = 200;
export const HOOK_CONDITIONS_MAX = 10;
export const SCOPE_ITEMS_MAX = 50;
export const PATTERN_MAX = 200;

/** 'HH:MM-HH:MM' 시간대 검사 (자정을 넘는 22:00-08:00 도 가능, 시작 = 끝은 빈 구간이라 불가) */
export function windowProblem(value: string): string | null {
  const m = /^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return `시간대는 HH:MM-HH:MM 형식이어야 합니다. 받은 값: '${value}'`;
  const [h1, m1, h2, m2] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (h1 > 23 || h2 > 23) return `시(hour)는 00~23 이어야 합니다. 받은 값: '${value}'`;
  if (m1 > 59 || m2 > 59) return `분(minute)은 00~59 여야 합니다. 받은 값: '${value}'`;
  if (h1 * 60 + m1 === h2 * 60 + m2) return `시작과 끝이 같으면(${value}) 시간대가 비어 있습니다.`;
  return null;
}

/** '/pattern/flags' 또는 'pattern' 정규식 검사 */
export function regexProblem(value: string): string | null {
  const slash = /^\/(.*)\/([dgimsuvy]*)$/s.exec(value);
  const source = slash ? (slash[1] as string) : value;
  try {
    if (slash) new RegExp(source, slash[2]);
    else new RegExp(value);
  } catch (err) {
    return `정규식을 해석할 수 없습니다: ${(err as Error).message}`;
  }
  return slowConstruct(source);
}

/**
 * 서버가 거부하는 구조(입력 길이에 비례해 끝나게 검사할 수 없음): 역참조 · 앞 보기.
 * 글자 그대로 쓴 \\1 이나 [(?=] 처럼 문자 집합 안의 글자는 건너뜁니다. 문구는 서버와 같습니다.
 */
export function slowConstruct(source: string): string | null {
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (c === '\\') {
      const next = source[i + 1] ?? '';
      if (!inClass && (/[1-9]/.test(next) || (next === 'k' && source[i + 2] === '<'))) {
        return '역참조(\\1 · \\k<이름>)가 있는 정규식은 쓸 수 없습니다. 입력이 길면 검사가 끝나지 않을 수 있습니다.';
      }
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === '(' && source[i + 1] === '?' && (source[i + 2] === '=' || source[i + 2] === '!')) {
      return '앞 보기((?=…) · (?!…))가 있는 정규식은 쓸 수 없습니다. 입력이 길면 검사가 끝나지 않을 수 있습니다.';
    }
  }
  return null;
}

const ENV_REF = /^\$env:([A-Z_][A-Z0-9_]*)$/;

export interface HookDraft {
  name: string;
  event: string;
  enabled: boolean;
  action: RuleHook['action'];
  conditions: { field: string; op: string; value: string }[];
  reason: string;
  modify: { find: string; replace: string } | null;
}

export type HookProblem = { where: 'name' | 'event' | 'action' | 'conditions' | 'reason' | 'modify' | `condition:${number}`; text: string };

/** 훅 초안의 문제를 모두 모아 돌려줍니다 (위치별로 표시). */
export function hookDraftProblems(d: HookDraft, meta: Pick<Meta, 'hookEvents' | 'hookFields' | 'hookActions' | 'conditionOps'>): HookProblem[] {
  const out: HookProblem[] = [];
  const name = d.name.trim();
  if (name.length < 1 || name.length > HOOK_NAME_MAX) out.push({ where: 'name', text: `훅 이름은 1~${HOOK_NAME_MAX}자여야 합니다. 지금 ${name.length}자입니다.` });
  if (!meta.hookEvents.includes(d.event)) {
    out.push({ where: 'event', text: `이벤트 '${d.event}'를 알 수 없습니다.` });
    return out;
  }
  const actions = meta.hookActions[d.event] ?? [];
  if (!actions.includes(d.action)) out.push({ where: 'action', text: `${EVENT_LABEL[d.event] ?? d.event}에서는 ${actions.map((a) => ACTION_LABEL[a]).join(' · ')}만 쓸 수 있습니다.` });
  if (d.conditions.length === 0) out.push({ where: 'conditions', text: '조건이 하나 이상 필요합니다. 조건이 없으면 모든 호출에 적용되어 위험합니다.' });
  if (d.conditions.length > HOOK_CONDITIONS_MAX) out.push({ where: 'conditions', text: `조건은 ${HOOK_CONDITIONS_MAX}개까지 넣을 수 있습니다. 지금 ${d.conditions.length}개입니다.` });
  const fields = meta.hookFields[d.event] ?? [];
  d.conditions.forEach((c, i) => {
    const where = `condition:${i}` as const;
    const n = i + 1;
    if (!meta.conditionOps.includes(c.op)) {
      out.push({ where, text: `${n}번째 조건의 연산자 '${c.op}'를 알 수 없습니다.` });
      return;
    }
    const timeOp = c.op === 'in_window' || c.op === 'not_in_window';
    if (!timeOp) {
      const toolEvent = d.event === 'before_tool' || d.event === 'after_tool';
      if (!fields.includes(c.field) && !(toolEvent && /^input\.[A-Za-z0-9_.]+$/.test(c.field))) {
        out.push({ where, text: `${n}번째 조건의 필드 '${c.field}'는 이 이벤트에 없습니다.` });
        return;
      }
    }
    if (ENV_REF.test(c.value.trim())) return;
    if (timeOp) {
      const w = windowProblem(c.value);
      if (w) out.push({ where, text: `${n}번째 조건: ${w}` });
      return;
    }
    if (c.op === 'matches' || c.op === 'not_matches') {
      const r = regexProblem(c.value);
      if (r) out.push({ where, text: `${n}번째 조건: ${r}` });
    }
    if (c.value === '' && c.op !== 'eq' && c.op !== 'neq') out.push({ where, text: `${n}번째 조건의 값이 비어 있습니다.` });
  });
  const reason = d.reason.trim();
  if (reason.length < 1 || reason.length > HOOK_REASON_MAX) out.push({ where: 'reason', text: `문구는 1~${HOOK_REASON_MAX}자여야 합니다. 지금 ${reason.length}자입니다.` });
  // 이 이벤트에서 쓸 수 없는 동작이면 위에서 이미 알렸으므로 수정 패턴은 따로 따지지 않습니다.
  if (d.action === 'modify' && actions.includes('modify')) {
    if (!d.modify || d.modify.find === '') out.push({ where: 'modify', text: '수정 동작에는 찾을 정규식(find)이 필요합니다.' });
    else {
      const r = regexProblem(d.modify.find);
      if (r) out.push({ where: 'modify', text: `수정할 패턴(find): ${r}` });
    }
  }
  return out;
}

/** 범위(scope) 항목 하나 검사 */
export function patternProblem(item: string, current: readonly string[]): string | null {
  if (item.trim() === '') return '빈 값은 넣을 수 없습니다.';
  if (item.length > PATTERN_MAX) return `항목은 ${PATTERN_MAX}자까지입니다. 지금 ${item.length}자입니다.`;
  if (current.length >= SCOPE_ITEMS_MAX) return `${SCOPE_ITEMS_MAX}개까지 넣을 수 있습니다.`;
  return null;
}

/** 두 권한 설정에서 달라진 항목 수 */
export function countPermissionChanges(a: Record<string, PermissionRule>, b: Record<string, PermissionRule>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let n = 0;
  for (const k of keys) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) n += 1;
  return n;
}
