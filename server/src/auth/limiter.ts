/**
 * 로그인 실패 제한. 같은 주소(IP)에서 시간 창(windowMs) 안에 max 번 틀리면 lockMs 동안 잠급니다.
 * 잠금이 풀리거나 창이 지나면 실패 횟수도 처음부터 셉니다 (몇 달 전 오타가 계속 쌓이지 않게).
 * 어디서든 접속하는 서버라 주소가 끝없이 늘 수 있으므로, 기록 수에 상한을 두고 지난 기록부터 지웁니다.
 */
interface Entry {
  failures: number;
  firstAt: number;
  lockedUntil: number;
}

export class LoginLimiter {
  private readonly max: number;
  private readonly lockMs: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly state = new Map<string, Entry>();

  constructor(max: number, lockMs: number, windowMs = lockMs, maxEntries = 10_000) {
    this.max = max;
    this.lockMs = lockMs;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
  }

  /** 지금 기록 수 (시험 · 확인용) */
  get size(): number {
    return this.state.size;
  }

  private stale(e: Entry, now: number): boolean {
    return e.lockedUntil !== 0 ? e.lockedUntil <= now : now - e.firstAt >= this.windowMs;
  }

  check(key: string, now: number): { locked: true; retryInMs: number } | { locked: false } {
    const s = this.state.get(key);
    if (!s) return { locked: false };
    if (s.lockedUntil > now) return { locked: true, retryInMs: s.lockedUntil - now };
    if (this.stale(s, now)) this.state.delete(key);
    return { locked: false };
  }

  /** 실패를 기록합니다. 이번 실패로 잠기면 locked=true. remaining 은 잠기기까지 남은 시도 횟수. */
  fail(key: string, now: number): { locked: boolean; remaining: number; retryInMs: number } {
    let s = this.state.get(key);
    if (s && this.stale(s, now)) {
      this.state.delete(key);
      s = undefined;
    }
    if (!s) {
      this.makeRoom(now);
      s = { failures: 0, firstAt: now, lockedUntil: 0 };
    }
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

  /**
   * 기록이 가득 차면: 지난 기록 → 잠기지 않은 기록 중 먼저 들어온 것 → (모두 잠김) 먼저 들어온 기록 순으로 지웁니다.
   * 잠긴 기록을 먼저 지우면 주소를 바꿔 가며 두드려 잠금을 풀 수 있으므로 가장 나중에 지웁니다.
   */
  private makeRoom(now: number): void {
    if (this.state.size < this.maxEntries) return;
    for (const [k, e] of this.state) if (this.stale(e, now)) this.state.delete(k);
    for (const [k, e] of this.state) {
      if (this.state.size < this.maxEntries) return;
      if (e.lockedUntil === 0) this.state.delete(k);
    }
    while (this.state.size >= this.maxEntries) {
      const oldest = this.state.keys().next();
      if (oldest.done) break;
      this.state.delete(oldest.value);
    }
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
