import { LimitError, ValidationError } from '../errors.ts';

export interface AgentLimits {
  tokensPerDay: number;
  stepsPerTask: number;
  concurrency: number;
  messagesPerMinute: number;
}

export interface LimitRule {
  label: string;
  unit: string;
  min: number;
  /** null 이면 위쪽 제한 없음 */
  max: number | null;
  /** 0 을 넣으면 한도를 두지 않는 항목이면 그 뜻 */
  zero?: string;
}

export const LIMIT_RULES: Record<keyof AgentLimits, LimitRule> = {
  tokensPerDay: { label: '일일 토큰', unit: '토큰', min: 1000, max: null, zero: '한도 무제한' },
  stepsPerTask: { label: '작업당 최대 단계', unit: '단계', min: 1, max: 200 },
  concurrency: { label: '동시 작업', unit: '개', min: 1, max: 8 },
  messagesPerMinute: { label: '분당 메시지', unit: '건', min: 1, max: 120 },
};

const fmt = (n: number): string => n.toLocaleString('ko-KR');

const rangeText = (rule: LimitRule, v: number): string =>
  rule.zero
    ? `${rule.label} 한도는 0(${rule.zero}) 또는 ${fmt(rule.min)} 이상이어야 합니다. 받은 값: ${fmt(v)}`
    : rule.max === null
      ? `${rule.label} 한도는 ${fmt(rule.min)} 이상이어야 합니다. 받은 값: ${fmt(v)}`
      : `${rule.label} 한도는 ${fmt(rule.min)} 이상 ${fmt(rule.max)} 이하여야 합니다. 받은 값: ${fmt(v)}`;

export function validateLimits(input: unknown): AgentLimits {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('limits_type', '한도 설정은 객체여야 합니다.');
  }
  const src = input as Record<string, unknown>;
  const out = {} as AgentLimits;
  for (const key of Object.keys(LIMIT_RULES) as (keyof AgentLimits)[]) {
    const rule = LIMIT_RULES[key];
    const v = src[key];
    if (typeof v !== 'number' || !Number.isInteger(v)) {
      throw new ValidationError('limit_not_integer', `${rule.label} 한도는 정수여야 합니다. 받은 값: ${JSON.stringify(v)}`, { field: key });
    }
    if (v === 0 && rule.zero) {
      out[key] = 0;
      continue;
    }
    if (v < rule.min || (rule.max !== null && v > rule.max)) throw new ValidationError('limit_range', rangeText(rule, v), { field: key });
    // 위쪽 제한이 없는 항목도 정확히 저장 · 비교할 수 있는 정수까지만 받습니다.
    if (!Number.isSafeInteger(v)) {
      throw new ValidationError('limit_range', `${rule.label} 한도가 너무 큽니다. ${fmt(Number.MAX_SAFE_INTEGER)} 이하로 넣으세요.${rule.zero ? ` 한도를 없애려면 0 을 넣으세요.` : ''}`, { field: key });
    }
    out[key] = v;
  }
  return out;
}

/** 두 한도 설정이 같은지 */
export function sameLimits(a: AgentLimits, b: AgentLimits): boolean {
  return (Object.keys(LIMIT_RULES) as (keyof AgentLimits)[]).every((k) => a[k] === b[k]);
}

/** 바뀐 한도를 사람이 읽는 글로: '일일 토큰 500,000 → 무제한' */
export function limitChanges(before: AgentLimits, after: AgentLimits): string[] {
  const shown = (rule: LimitRule, v: number): string => (v === 0 && rule.zero ? '무제한' : fmt(v));
  return (Object.keys(LIMIT_RULES) as (keyof AgentLimits)[])
    .filter((k) => before[k] !== after[k])
    .map((k) => `${LIMIT_RULES[k].label} ${shown(LIMIT_RULES[k], before[k])} → ${shown(LIMIT_RULES[k], after[k])}`);
}

/** 일일 토큰 한도. 0 이면 한도가 없습니다. used 가 limit 에 도달하면(같아도) 새 요청을 막습니다. */
export function assertDailyBudget(agentName: string, used: number, limit: number, timeZone: string): void {
  if (limit === 0) return;
  if (used >= limit) {
    throw new LimitError(
      'limit_tokens_daily',
      `에이전트 '${agentName}'가 오늘 쓴 토큰(${fmt(used)})이 일일 한도(${fmt(limit)})에 도달해 새 요청을 멈췄습니다. ${timeZone} 기준 자정 이후 다시 시작하거나, 에이전트 설정 창의 한도에서 일일 토큰을 올리세요 (0 은 무제한).`,
      { used, limit },
    );
  }
}

/** 작업당 최대 단계. step 은 1부터 셉니다. step 이 limit 을 넘으면 멈춥니다. */
export function assertStep(agentName: string, step: number, limit: number): void {
  if (step > limit) {
    throw new LimitError('limit_steps', `에이전트 '${agentName}'의 작업이 최대 단계(${limit})에 도달해 멈췄습니다. 작업을 나누거나 에이전트 설정 창의 한도에서 올리세요.`, { step, limit });
  }
}

/** 시간대 기준 날짜 키 (YYYY-MM-DD). */
export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/**
 * 고정 길이 시간 창 안의 횟수를 셉니다 (분당 발송 제한 등).
 * 창 길이(windowMs) 이상 지난 기록은 버립니다. 경계: 정확히 windowMs 전의 기록은 이미 지난 것으로 봅니다.
 */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  /** 허용되면 기록을 남기고 true. 막히면 다시 가능해지기까지 남은 시간을 돌려줍니다. */
  hit(key: string, now: number, limit: number, windowMs: number): { allowed: true } | { allowed: false; retryInMs: number; count: number } {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) {
      const oldest = list[0] as number;
      this.hits.set(key, list);
      return { allowed: false, retryInMs: Math.max(0, oldest + windowMs - now), count: list.length };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true };
  }

  count(key: string, now: number, windowMs: number): number {
    return (this.hits.get(key) ?? []).filter((t) => now - t < windowMs).length;
  }
}
