/**
 * 로그인 실패 제한. 같은 주소(IP)에서 max 번 틀리면 lockMs 동안 잠급니다.
 * 잠금이 풀리면 실패 횟수도 처음부터 셉니다.
 */
export class LoginLimiter {
  private readonly max: number;
  private readonly lockMs: number;
  private readonly state = new Map<string, { failures: number; lockedUntil: number }>();

  constructor(max: number, lockMs: number) {
    this.max = max;
    this.lockMs = lockMs;
  }

  check(key: string, now: number): { locked: true; retryInMs: number } | { locked: false } {
    const s = this.state.get(key);
    if (!s) return { locked: false };
    if (s.lockedUntil > now) return { locked: true, retryInMs: s.lockedUntil - now };
    if (s.lockedUntil !== 0) this.state.delete(key);
    return { locked: false };
  }

  /** 실패를 기록합니다. 이번 실패로 잠기면 locked=true. remaining 은 잠기기까지 남은 시도 횟수. */
  fail(key: string, now: number): { locked: boolean; remaining: number; retryInMs: number } {
    const s = this.state.get(key) ?? { failures: 0, lockedUntil: 0 };
    s.failures += 1;
    if (s.failures >= this.max) {
      s.lockedUntil = now + this.lockMs;
      this.state.set(key, s);
      return { locked: true, remaining: 0, retryInMs: this.lockMs };
    }
    this.state.set(key, s);
    return { locked: false, remaining: this.max - s.failures, retryInMs: 0 };
  }

  success(key: string): void {
    this.state.delete(key);
  }
}

/** 남은 시간을 '14분 3초' 처럼 */
export function humanDuration(ms: number): string {
  const total = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}초`;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}
