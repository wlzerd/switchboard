import { describe, expect, it } from 'vitest';
import { humanDuration, LoginLimiter } from '../src/auth/limiter.ts';

describe('로그인 실패 제한 (max=3, 잠금 60초)', () => {
  it('2번째 실패까지는 남은 횟수를 알려주고 3번째에 잠근다', () => {
    const l = new LoginLimiter(3, 60_000);
    expect(l.fail('ip', 0)).toEqual({ locked: false, remaining: 2, retryInMs: 0 });
    expect(l.fail('ip', 1)).toEqual({ locked: false, remaining: 1, retryInMs: 0 });
    expect(l.fail('ip', 2)).toEqual({ locked: true, remaining: 0, retryInMs: 60_000 });
  });

  it('잠금은 정확히 lockMs 가 지나면 풀리고 횟수도 초기화된다', () => {
    const l = new LoginLimiter(1, 1000);
    l.fail('ip', 0);
    expect(l.check('ip', 999)).toEqual({ locked: true, retryInMs: 1 });
    expect(l.check('ip', 1000)).toEqual({ locked: false });
    expect(l.fail('ip', 1001).locked).toBe(true);
  });

  it('성공하면 실패 기록을 지운다', () => {
    const l = new LoginLimiter(3, 1000);
    l.fail('ip', 0);
    l.fail('ip', 0);
    l.success('ip');
    expect(l.fail('ip', 0).remaining).toBe(2);
  });

  it('주소마다 따로 센다', () => {
    const l = new LoginLimiter(1, 1000);
    l.fail('a', 0);
    expect(l.check('b', 0)).toEqual({ locked: false });
  });
});

describe('humanDuration', () => {
  it.each([
    [1, '1초'],
    [999, '1초'],
    [59_000, '59초'],
    [60_000, '1분'],
    [61_000, '1분 1초'],
    [900_000, '15분'],
  ])('%i ms → %s', (ms, want) => {
    expect(humanDuration(ms)).toBe(want);
  });
});
