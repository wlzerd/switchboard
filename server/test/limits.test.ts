import { describe, expect, it } from 'vitest';
import { assertDailyBudget, assertStep, dayKey, limitChanges, sameLimits, SlidingWindow, validateLimits } from '../src/limits/limits.ts';
import { LimitError } from '../src/errors.ts';

const ok = { tokensPerDay: 500000, stepsPerTask: 40, concurrency: 2, messagesPerMinute: 20 };

describe('한도 검증 경계', () => {
  const TOKENS_LOW = '일일 토큰 한도는 0(한도 무제한) 또는 1,000 이상이어야 합니다';
  it.each([
    // 일일 토큰: 0 은 무제한, 그 밖에는 1,000 이상, 위쪽 제한 없음 (정확히 다룰 수 있는 정수까지)
    ['tokensPerDay', 0, null],
    ['tokensPerDay', 1, TOKENS_LOW],
    ['tokensPerDay', 999, TOKENS_LOW],
    ['tokensPerDay', -1, TOKENS_LOW],
    ['tokensPerDay', 1000, null],
    ['tokensPerDay', 10_000_001, null],
    ['tokensPerDay', Number.MAX_SAFE_INTEGER, null],
    ['tokensPerDay', Number.MAX_SAFE_INTEGER + 1, '일일 토큰 한도가 너무 큽니다. 9,007,199,254,740,991 이하로 넣으세요. 한도를 없애려면 0 을 넣으세요.'],
    // 나머지는 0 이 무제한이 아니고 위쪽 제한도 그대로
    ['stepsPerTask', 0, '작업당 최대 단계 한도는 1 이상 200 이하여야 합니다. 받은 값: 0'],
    ['stepsPerTask', 1, null],
    ['stepsPerTask', 200, null],
    ['stepsPerTask', 201, '작업당 최대 단계 한도는 1 이상 200 이하여야 합니다. 받은 값: 201'],
    ['concurrency', 0, '동시 작업 한도는 1 이상 8 이하여야 합니다'],
    ['concurrency', 8, null],
    ['concurrency', 9, '동시 작업 한도는 1 이상 8 이하여야 합니다'],
    ['messagesPerMinute', 120, null],
    ['messagesPerMinute', 121, '분당 메시지 한도는 1 이상 120 이하여야 합니다'],
  ])('%s=%d → %s', (field, value, error) => {
    const run = () => validateLimits({ ...ok, [field]: value });
    if (error === null) expect(run()[field as keyof typeof ok]).toBe(value);
    else expect(run).toThrow(error);
  });

  it('거절할 때 어느 칸인지 알려 준다 (화면이 그 칸 아래에 표시)', () => {
    try {
      validateLimits({ ...ok, tokensPerDay: 500 });
      expect.unreachable();
    } catch (err) {
      expect((err as { code: string; detail: unknown }).code).toBe('limit_range');
      expect((err as { detail: unknown }).detail).toEqual({ field: 'tokensPerDay' });
    }
  });

  it('바뀐 한도를 읽기 쉬운 글로 (0 은 무제한)', () => {
    expect(sameLimits(ok, { ...ok })).toBe(true);
    expect(sameLimits(ok, { ...ok, concurrency: 3 })).toBe(false);
    expect(limitChanges(ok, { ...ok, tokensPerDay: 0, concurrency: 3 })).toEqual(['일일 토큰 500,000 → 무제한', '동시 작업 2 → 3']);
    expect(limitChanges({ ...ok, tokensPerDay: 0 }, ok)).toEqual(['일일 토큰 무제한 → 500,000']);
  });

  it('정수가 아니면 받은 값을 보여준다', () => {
    expect(() => validateLimits({ ...ok, concurrency: 1.5 })).toThrow('받은 값: 1.5');
    expect(() => validateLimits({ ...ok, concurrency: '2' })).toThrow('받은 값: "2"');
  });
});

describe('일일 토큰·단계', () => {
  it('한도 1 전까지는 통과, 한도와 같아지면 막고 바꿀 곳을 알려 준다', () => {
    expect(() => assertDailyBudget('아틀라스', 499_999, 500_000, 'Asia/Seoul')).not.toThrow();
    expect(() => assertDailyBudget('아틀라스', 500_000, 500_000, 'Asia/Seoul')).toThrow(LimitError);
    expect(() => assertDailyBudget('아틀라스', 500_000, 500_000, 'Asia/Seoul')).toThrow('에이전트 설정 창의 한도에서 일일 토큰을 올리세요 (0 은 무제한)');
  });

  it('한도 0 은 무제한: 얼마를 썼든 막지 않는다', () => {
    expect(() => assertDailyBudget('아틀라스', 0, 0, 'Asia/Seoul')).not.toThrow();
    expect(() => assertDailyBudget('아틀라스', 50_000_000_000, 0, 'Asia/Seoul')).not.toThrow();
  });

  it('단계는 한도까지 허용, 한도+1에서 멈춘다', () => {
    expect(() => assertStep('아틀라스', 40, 40)).not.toThrow();
    expect(() => assertStep('아틀라스', 41, 40)).toThrow('최대 단계(40)');
  });
});

describe('날짜 키', () => {
  it('서버 시간대 자정을 기준으로 바뀐다 (KST)', () => {
    expect(dayKey(new Date('2026-10-09T14:59:59Z'), 'Asia/Seoul')).toBe('2026-10-09');
    expect(dayKey(new Date('2026-10-09T15:00:00Z'), 'Asia/Seoul')).toBe('2026-10-10');
  });
});

describe('SlidingWindow', () => {
  it('기록이 정확히 창 길이만큼 지나면 빠진다', () => {
    const w = new SlidingWindow();
    expect(w.hit('k', 0, 1, 1000)).toEqual({ allowed: true });
    expect(w.hit('k', 999, 1, 1000)).toMatchObject({ allowed: false, retryInMs: 1 });
    expect(w.hit('k', 1000, 1, 1000)).toEqual({ allowed: true });
  });

  it('키마다 따로 센다', () => {
    const w = new SlidingWindow();
    w.hit('a', 0, 1, 1000);
    expect(w.hit('b', 0, 1, 1000)).toEqual({ allowed: true });
  });
});
