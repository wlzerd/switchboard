/** 화면 표시용 형식 */

/** 소수 자릿수로 반올림한 뒤 뒤쪽 0 만 지웁니다 (10 → '10', 1.20 → '1.2'). */
function trimmed(v: number, digits: number): string {
  return String(Number(v.toFixed(digits)));
}

export function compactTokens(n: number): string {
  const millions = (): string => `${trimmed(n / 1_000_000, n >= 9_995_000 ? 0 : 2)}M`;
  if (n >= 1_000_000) return millions();
  if (n >= 1000) {
    const k = trimmed(n / 1000, n >= 99_950 ? 0 : 1);
    // 999,500 이상은 반올림하면 1000K 가 되므로 M 으로 씁니다.
    return Number(k) >= 1000 ? millions() : `${k}K`;
  }
  return String(n);
}

export function uptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (v: number): string => String(v).padStart(2, '0');
  return `${d > 0 ? `${d}일 ` : ''}${p(h)}:${p(m)}:${p(sec)}`;
}

export function clock(ts: number, tz?: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ts));
}

export function relTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}

export function tokensLabel(n: number | null): string {
  if (n === null) return '-';
  return compactTokens(n);
}

export function percent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)));
}

/** 이름의 첫 글자 (아바타) */
export function initial(name: string): string {
  return Array.from(name.trim())[0] ?? '?';
}
