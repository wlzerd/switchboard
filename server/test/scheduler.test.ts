import { describe, expect, it } from 'vitest';
import { describeSpec, nextRun, parseSpec, type ScheduleSpec } from '../src/scheduler/spec.ts';

const KST = 'Asia/Seoul';
const kst = (iso: string): number => Date.parse(`${iso}+09:00`);

describe('예약 형식', () => {
  it.each([
    ['every 1m', true],
    ['every 0m', false],
    ['every 30d', true],
    ['every 31d', false],
    ['every 720h', true],
    ['every 721h', false],
    ['daily 00:00', true],
    ['daily 23:59', true],
    ['daily 24:00', false],
    ['daily 9:00', false],
    ['weekdays 09:00', true],
    ['weekly mon 09:00', true],
    ['weekly monday 09:00', false],
    ['weekly mon', false],
    ['hourly', false],
  ])('%s 유효 %s', (text, ok) => {
    expect(typeof parseSpec(text) !== 'string').toBe(ok);
  });

  it('대소문자와 여분 공백은 무시한다', () => {
    expect(parseSpec('  Weekly  MON  07:30 ')).toEqual({ kind: 'weekly', day: 1, minutes: 450 });
  });

  it('설명 문구', () => {
    expect(describeSpec(parseSpec('every 90m') as ScheduleSpec)).toBe('90분마다');
    expect(describeSpec(parseSpec('every 2h') as ScheduleSpec)).toBe('2시간마다');
    expect(describeSpec(parseSpec('weekly fri 18:00') as ScheduleSpec)).toBe('매주 금 18:00');
  });
});

describe('다음 실행 시각 (KST)', () => {
  const daily9 = parseSpec('daily 09:00') as ScheduleSpec;

  it('08:59 이후 → 오늘 09:00, 정확히 09:00 이후 → 내일 09:00 (엄격히 늦은 시각)', () => {
    expect(nextRun(daily9, kst('2026-10-09T08:59:00'), KST)).toBe(kst('2026-10-09T09:00:00'));
    expect(nextRun(daily9, kst('2026-10-09T09:00:00'), KST)).toBe(kst('2026-10-10T09:00:00'));
  });

  it('평일 예약: 금요일 10:00 이후 → 월요일 09:00', () => {
    const wd = parseSpec('weekdays 09:00') as ScheduleSpec;
    expect(nextRun(wd, kst('2026-10-09T10:00:00'), KST)).toBe(kst('2026-10-12T09:00:00'));
  });

  it('주간 예약: 같은 요일이라도 시각이 지났으면 다음 주', () => {
    const fri = parseSpec('weekly fri 09:00') as ScheduleSpec;
    expect(nextRun(fri, kst('2026-10-09T08:00:00'), KST)).toBe(kst('2026-10-09T09:00:00'));
    expect(nextRun(fri, kst('2026-10-09T09:00:01'), KST)).toBe(kst('2026-10-16T09:00:00'));
  });

  it('자정 직전·직후 경계', () => {
    const midnight = parseSpec('daily 00:00') as ScheduleSpec;
    expect(nextRun(midnight, kst('2026-10-09T23:59:59'), KST)).toBe(kst('2026-10-10T00:00:00'));
    expect(nextRun(midnight, kst('2026-10-10T00:00:00'), KST)).toBe(kst('2026-10-11T00:00:00'));
  });

  it('간격 예약은 기준 시각 + 간격', () => {
    expect(nextRun(parseSpec('every 5m') as ScheduleSpec, 1000, KST)).toBe(1000 + 300_000);
  });
});

describe('일광절약시간 (America/New_York)', () => {
  it('서머타임 시작 전후로 현지 09:00 을 유지한다', () => {
    const tz = 'America/New_York';
    const daily = parseSpec('daily 09:00') as ScheduleSpec;
    // 2026-03-07 09:00 EST = 14:00Z, 2026-03-08 09:00 EDT = 13:00Z
    expect(nextRun(daily, Date.parse('2026-03-07T12:00:00Z'), tz)).toBe(Date.parse('2026-03-07T14:00:00Z'));
    expect(nextRun(daily, Date.parse('2026-03-07T15:00:00Z'), tz)).toBe(Date.parse('2026-03-08T13:00:00Z'));
  });
});
