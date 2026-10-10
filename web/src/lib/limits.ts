/** 에이전트 한도 입력 (에이전트 설정 창): 일일 토큰 · 작업당 단계 · 동시 작업 · 분당 메시지 */
import { compactTokens } from './format';
import type { AgentLimits, LimitRule } from './types';

export type LimitDraft = Record<keyof AgentLimits, string>;

export function limitDraft(l: AgentLimits): LimitDraft {
  return { tokensPerDay: String(l.tokensPerDay), stepsPerTask: String(l.stepsPerTask), concurrency: String(l.concurrency), messagesPerMinute: String(l.messagesPerMinute) };
}

/** 입력값을 서버에 보낼 숫자로 (검사를 통과한 값만 넘깁니다) */
export function limitNumbers(draft: LimitDraft, keys: readonly (keyof AgentLimits)[]): AgentLimits {
  return Object.fromEntries(keys.map((k) => [k, Number(draft[k].trim())])) as unknown as AgentLimits;
}

/** 칸 이름. 0 이 '한도 없음'인 항목은 그 뜻을 붙입니다: 일일 토큰(0:한도 무제한) */
export function limitLabel(rule: LimitRule): string {
  return rule.zero ? `${rule.label}(0:${rule.zero})` : rule.label;
}

const rangeText = (rule: LimitRule): string =>
  rule.max === null ? `${rule.label} 한도는 ${rule.min.toLocaleString()} 이상이어야 합니다.` : `${rule.label} 한도는 ${rule.min.toLocaleString()} 이상 ${rule.max.toLocaleString()} 이하여야 합니다.`;

/** 한도 입력 문자열 검사 */
export function limitProblem(raw: string, rule: LimitRule): string | null {
  const t = raw.trim();
  if (t === '') return `${rule.label} 값을 입력하세요.`;
  if (!/^-?\d+$/.test(t)) return `${rule.label} 한도는 정수여야 합니다. 받은 값: ${t}`;
  const n = Number(t);
  if (n === 0 && rule.zero) return null;
  if (n < rule.min) return rule.zero ? `${rule.min.toLocaleString()} 미만으로는 설정할 수 없습니다.` : rangeText(rule);
  if (rule.max !== null && n > rule.max) return rangeText(rule);
  if (!Number.isSafeInteger(n)) return `너무 큰 값입니다.${rule.zero ? ' 한도를 없애려면 0을 넣으세요.' : ''}`;
  return null;
}

export function countLimitChanges(a: AgentLimits, b: LimitDraft): number {
  let n = 0;
  for (const k of Object.keys(a) as (keyof AgentLimits)[]) if (String(a[k]) !== b[k].trim()) n += 1;
  return n;
}

/** 일일 토큰 한도 표시 (0 은 무제한) */
export function tokenLimitText(n: number): string {
  return n === 0 ? '무제한' : compactTokens(n);
}
