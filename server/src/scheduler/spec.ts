/**
 * 예약 실행 규칙.
 *   every 5m | every 2h | every 1d     — 간격 (1분 ~ 30일)
 *   daily 09:00                         — 매일
 *   weekdays 09:00                      — 평일(월~금)
 *   weekly mon 09:00                    — 매주 특정 요일
 * 시각은 서버 시간대(TZ) 기준입니다.
 */

export type ScheduleSpec =
  | { kind: 'every'; ms: number }
  | { kind: 'daily'; minutes: number }
  | { kind: 'weekdays'; minutes: number }
  | { kind: 'weekly'; day: number; minutes: number };

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
const MIN_EVERY = 60_000;
const MAX_EVERY = 30 * 86_400_000;

function parseHHMM(v: string): number | string {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return `시각은 HH:MM 형식이어야 합니다 (예: 09:00). 받은 값: '${v}'`;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23) return `시(hour)는 00~23 이어야 합니다. 받은 값: '${v}'`;
  if (mi > 59) return `분(minute)은 00~59 여야 합니다. 받은 값: '${v}'`;
  return h * 60 + mi;
}

export function parseSpec(text: string): ScheduleSpec | string {
  const parts = text.trim().toLowerCase().split(/\s+/);
  const [kind, a, b] = parts;
  if (kind === 'every' && a !== undefined && parts.length === 2) {
    const m = /^(\d+)(m|h|d)$/.exec(a);
    if (!m) return `간격은 숫자 뒤에 m(분)·h(시간)·d(일)을 붙입니다 (예: every 30m). 받은 값: '${a}'`;
    const n = Number(m[1]);
    const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    const ms = n * unit;
    if (ms < MIN_EVERY) return '간격은 1분 이상이어야 합니다.';
    if (ms > MAX_EVERY) return '간격은 30일 이하여야 합니다.';
    return { kind: 'every', ms };
  }
  if ((kind === 'daily' || kind === 'weekdays') && a !== undefined && parts.length === 2) {
    const minutes = parseHHMM(a);
    return typeof minutes === 'string' ? minutes : { kind, minutes };
  }
  if (kind === 'weekly' && a !== undefined && b !== undefined && parts.length === 3) {
    const day = DAYS.indexOf(a);
    if (day === -1) return `요일은 ${DAYS.join(', ')} 중 하나여야 합니다. 받은 값: '${a}'`;
    const minutes = parseHHMM(b);
    return typeof minutes === 'string' ? minutes : { kind: 'weekly', day, minutes };
  }
  return `예약 형식을 알 수 없습니다: '${text}'. 가능한 형식: every 30m · daily 09:00 · weekdays 09:00 · weekly mon 09:00`;
}

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

export function describeSpec(s: ScheduleSpec): string {
  switch (s.kind) {
    case 'every': {
      if (s.ms % 86_400_000 === 0) return `${s.ms / 86_400_000}일마다`;
      if (s.ms % 3_600_000 === 0) return `${s.ms / 3_600_000}시간마다`;
      return `${Math.round(s.ms / 60_000)}분마다`;
    }
    case 'daily':
      return `매일 ${hhmm(s.minutes)}`;
    case 'weekdays':
      return `평일 ${hhmm(s.minutes)}`;
    case 'weekly':
      return `매주 ${DAY_KO[s.day]} ${hhmm(s.minutes)}`;
  }
}

interface LocalParts {
  y: number;
  mo: number;
  d: number;
  weekday: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    fmtCache.set(timeZone, f);
  }
  return f;
}

function partsOf(utcMs: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number; weekday: number } {
  const p = fmt(timeZone).formatToParts(new Date(utcMs));
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? '0';
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { y: Number(g('year')), mo: Number(g('month')) - 1, d: Number(g('day')), h: Number(g('hour')), mi: Number(g('minute')), s: Number(g('second')), weekday: wd };
}

/** 해당 시각의 (현지 - UTC) 차이 */
export function tzOffsetMs(utcMs: number, timeZone: string): number {
  const p = partsOf(utcMs, timeZone);
  const local = Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s);
  return local - Math.floor(utcMs / 1000) * 1000;
}

/** 현지 벽시계 시각 → UTC. 일광절약시간 경계에서 두 번 보정합니다. */
export function localToUtc(y: number, mo: number, d: number, minutes: number, timeZone: string): number {
  const guess = Date.UTC(y, mo, d, Math.floor(minutes / 60), minutes % 60);
  const off1 = tzOffsetMs(guess, timeZone);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, timeZone);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

function localDay(utcMs: number, timeZone: string): LocalParts {
  const p = partsOf(utcMs, timeZone);
  return { y: p.y, mo: p.mo, d: p.d, weekday: p.weekday };
}

/** after 보다 엄격히 늦은 다음 실행 시각 (ms). */
export function nextRun(spec: ScheduleSpec, after: number, timeZone: string): number {
  if (spec.kind === 'every') return after + spec.ms;
  const today = localDay(after, timeZone);
  for (let i = 0; i < 9; i += 1) {
    const base = new Date(Date.UTC(today.y, today.mo, today.d + i));
    const y = base.getUTCFullYear();
    const mo = base.getUTCMonth();
    const d = base.getUTCDate();
    const weekday = base.getUTCDay();
    if (spec.kind === 'weekdays' && (weekday === 0 || weekday === 6)) continue;
    if (spec.kind === 'weekly' && weekday !== spec.day) continue;
    const at = localToUtc(y, mo, d, spec.minutes, timeZone);
    if (at > after) return at;
  }
  // 이론상 도달하지 않습니다 (9일 안에 반드시 후보가 있음).
  return after + 86_400_000;
}
