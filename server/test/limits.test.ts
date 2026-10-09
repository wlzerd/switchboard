import { describe, expect, it } from 'vitest';
import { assertDailyBudget, assertStep, dayKey, SlidingWindow, validateLimits } from '../src/limits/limits.ts';
import { LimitError } from '../src/errors.ts';

const ok = { tokensPerDay: 500000, stepsPerTask: 40, concurrency: 2, messagesPerMinute: 20 };

describe('한도 검증 경계', () => {
  it.each([
    ['tokensPerDay', 999, false],
    ['tokensPerDay', 1000, true],
    ['tokensPerDay', 10_000_000, true],
    ['tokensPerDay', 10_000_001, false],
    ['stepsPerTask', 0, false],
    ['stepsPerTask', 1, true],
    ['stepsPerTask', 200, true],
    ['stepsPerTask', 201, false],
    ['concurrency', 8, true],
    ['concurrency', 9, false],
    ['messagesPerMinute', 120, true],
    ['messagesPerMinute', 121, false],
  ])('%s=%i 통과 %s', (field, value, pass) => {
    const run = () => validateLimits({ ...ok, [field]: value });
    if (pass) expect(run).not.toThrow();
    else expect(run).toThrow('이하여야 합니다');
  });

  it('정수가 아니면 받은 값을 보여준다', () => {
    expect(() => validateLimits({ ...ok, concurrency: 1.5 })).toThrow('받은 값: 1.5');
    expect(() => validateLimits({ ...ok, concurrency: '2' })).toThrow('받은 값: "2"');
  });
});

describe('일일 토큰·단계', () => {
  it('한도 1 전까지는 통과, 한도와 같아지면 막는다', () => {
    expect(() => assertDailyBudget('아틀라스', 499_999, 500_000, 'Asia/Seoul')).not.toThrow();
    expect(() => assertDailyBudget('아틀라스', 500_000, 500_000, 'Asia/Seoul')).toThrow(LimitError);
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
