import { describe, expect, it } from 'vitest';
import {
  CHECKLIST_MAX,
  HEARTBEAT_MAX_MINUTES,
  RESULT_MAX,
  delegationProblem,
  delegationRequestText,
  delegationResultText,
  heartbeatDue,
  isSilentReport,
  parseReportTarget,
  validateDelegation,
  validateHeartbeat,
} from '../src/agents/autonomy.ts';
import type { DelegationSettings, HeartbeatSettings } from '../src/db/store.ts';

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code';
  }
};

describe('isSilentReport', () => {
  it.each([
    ['', true],
    ['  \n ', true],
    ['NO_REPORT', true],
    ['no_report', true],
    ['**NO_REPORT**', true],
    ['> NO_REPORT', true],
    ['"NO_REPORT"', true],
    ['NO_REPORT.', true],
    ['NO_REPORT — 변화 없음', true],
  ])('조용히 끝남: %j', (text, silent) => {
    expect(isSilentReport(text)).toBe(silent);
  });

  it.each([
    ['NO_REPORTS', false],
    ['NO_REPORT_X', false],
    ['NO_REPORT1', false],
    ['변화 없음. NO_REPORT', false],
    ['디스크 95%입니다', false],
  ])('보고로 봄: %j', (text, silent) => {
    expect(isSilentReport(text)).toBe(silent);
  });
});

describe('validateHeartbeat', () => {
  const ok = { enabled: true, everyMinutes: 30, activeHours: null, checklist: '확인' };

  it('간격 경계: 최솟값 ~ 하루', () => {
    expect(validateHeartbeat({ ...ok, everyMinutes: 5 }, 5).everyMinutes).toBe(5);
    expect(validateHeartbeat({ ...ok, everyMinutes: HEARTBEAT_MAX_MINUTES }, 5).everyMinutes).toBe(1440);
    for (const bad of [4, 1441, 30.5, '30', null]) expect(codeOf(() => validateHeartbeat({ ...ok, everyMinutes: bad }, 5))).toBe('heartbeat_interval');
  });

  it('활동 시간은 공백을 정리해 저장하고, 시작=끝 · 한 자리 시 · 24시는 거절합니다', () => {
    expect(validateHeartbeat({ ...ok, activeHours: ' 22:00 - 06:30 ' }, 5).activeHours).toBe('22:00-06:30');
    expect(validateHeartbeat({ ...ok, activeHours: '' }, 5).activeHours).toBeNull();
    for (const bad of ['09:00-09:00', '9:00-18:00', '24:00-06:00', '09:60-10:00', 930]) expect(codeOf(() => validateHeartbeat({ ...ok, activeHours: bad }, 5))).toBe('heartbeat_hours');
  });

  it('점검 목록: 켤 때만 필요하고(공백만은 빈 것), 앞뒤 공백을 빼고 4,000자까지', () => {
    expect(codeOf(() => validateHeartbeat({ ...ok, checklist: '   ' }, 5))).toBe('heartbeat_checklist');
    expect(validateHeartbeat({ ...ok, enabled: false, checklist: '' }, 5).checklist).toBe('');
    expect(validateHeartbeat({ ...ok, checklist: ` ${'x'.repeat(CHECKLIST_MAX)} ` }, 5).checklist).toHaveLength(CHECKLIST_MAX);
    expect(codeOf(() => validateHeartbeat({ ...ok, checklist: 'x'.repeat(CHECKLIST_MAX + 1) }, 5))).toBe('heartbeat_checklist_long');
  });

  it('모양이 틀리면 항목을 짚어 거절합니다', () => {
    expect(codeOf(() => validateHeartbeat(null, 5))).toBe('heartbeat_type');
    expect(codeOf(() => validateHeartbeat([], 5))).toBe('heartbeat_type');
    expect(codeOf(() => validateHeartbeat({ ...ok, enabled: 'true' }, 5))).toBe('heartbeat_enabled');
  });
});

describe('heartbeatDue', () => {
  const hb: HeartbeatSettings = { enabled: true, everyMinutes: 30, activeHours: null, checklist: 'x' };
  const now = Date.UTC(2026, 9, 9, 12, 0);
  const idle = { paused: false, busy: false };

  it('꺼짐 · 일시정지 · 다른 작업 중이면 돌리지 않습니다', () => {
    expect(heartbeatDue(null, null, now, 'UTC', idle)).toBe(false);
    expect(heartbeatDue({ ...hb, enabled: false }, null, now, 'UTC', idle)).toBe(false);
    expect(heartbeatDue(hb, null, now, 'UTC', { paused: true, busy: false })).toBe(false);
    expect(heartbeatDue(hb, null, now, 'UTC', { paused: false, busy: true })).toBe(false);
  });

  it('간격 경계: 정확히 30분이 지나면 돌고, 1ms 모자라면 기다립니다', () => {
    expect(heartbeatDue(hb, now - 30 * 60_000, now, 'UTC', idle)).toBe(true);
    expect(heartbeatDue(hb, now - 30 * 60_000 + 1, now, 'UTC', idle)).toBe(false);
  });

  it('처음이거나 마지막 실행이 미래로 기록되어 있으면(시계가 뒤로 감) 바로 돕니다', () => {
    expect(heartbeatDue(hb, null, now, 'UTC', idle)).toBe(true);
    expect(heartbeatDue(hb, now + 60_000, now, 'UTC', idle)).toBe(true);
  });

  it('활동 시간: 시작은 포함, 끝은 제외, 자정을 넘는 구간도 됩니다', () => {
    const at = (h: number, m: number) => Date.UTC(2026, 9, 9, h, m);
    const day = { ...hb, activeHours: '09:00-18:00' };
    expect(heartbeatDue(day, null, at(9, 0), 'UTC', idle)).toBe(true);
    expect(heartbeatDue(day, null, at(8, 59), 'UTC', idle)).toBe(false);
    expect(heartbeatDue(day, null, at(18, 0), 'UTC', idle)).toBe(false);
    const night = { ...hb, activeHours: '22:00-06:00' };
    expect(heartbeatDue(night, null, at(23, 0), 'UTC', idle)).toBe(true);
    expect(heartbeatDue(night, null, at(5, 59), 'UTC', idle)).toBe(true);
    expect(heartbeatDue(night, null, at(6, 0), 'UTC', idle)).toBe(false);
  });

  it('활동 시간은 서버 시간대로 봅니다 (UTC 01:00 = 서울 10:00)', () => {
    const day = { ...hb, activeHours: '09:00-18:00' };
    expect(heartbeatDue(day, null, Date.UTC(2026, 9, 9, 1, 0), 'Asia/Seoul', idle)).toBe(true);
    expect(heartbeatDue(day, null, Date.UTC(2026, 9, 9, 1, 0), 'UTC', idle)).toBe(false);
  });

  it('저장된 활동 시간이 깨져 있으면 돌리지 않습니다', () => {
    expect(heartbeatDue({ ...hb, activeHours: 'garbage' }, null, now, 'UTC', idle)).toBe(false);
  });
});

describe('parseReportTarget', () => {
  it('null 은 화면에만, 앞뒤 공백은 지웁니다', () => {
    expect(parseReportTarget(null)).toBeNull();
    expect(parseReportTarget({ moduleId: ' discord ', target: ' #ops ' })).toEqual({ moduleId: 'discord', target: '#ops' });
  });

  it('대상 길이 경계와 빠진 값', () => {
    expect(parseReportTarget({ moduleId: 'd', target: 'x'.repeat(200) })?.target).toHaveLength(200);
    expect(codeOf(() => parseReportTarget({ moduleId: 'd', target: 'x'.repeat(201) }))).toBe('report_target_long');
    expect(codeOf(() => parseReportTarget({ moduleId: 'd', target: '  ' }))).toBe('report_target');
    expect(codeOf(() => parseReportTarget({ target: '#ops' }))).toBe('report_module');
    expect(codeOf(() => parseReportTarget([]))).toBe('report_type');
  });
});

describe('validateDelegation', () => {
  const ag = (id: string, d: Partial<DelegationSettings> = {}) => ({ id, name: id.toUpperCase(), delegation: { accept: true, send: true, supervisorId: null, ...d } });

  it('없으면 기본값(모두 미허용), 불리언이 아니면 거절', () => {
    expect(validateDelegation(undefined, null, [])).toEqual({ accept: false, send: false, supervisorId: null });
    expect(codeOf(() => validateDelegation({ accept: 'yes' }, null, []))).toBe('delegation_accept');
    expect(codeOf(() => validateDelegation({ send: 1 }, null, []))).toBe('delegation_send');
    expect(codeOf(() => validateDelegation('x', null, []))).toBe('delegation_type');
  });

  it('협조 에이전트를 정하려면 보내기가 허용이어야 합니다', () => {
    const list = [ag('boss')];
    expect(codeOf(() => validateDelegation({ send: false, supervisorId: 'boss' }, null, list))).toBe('delegation_supervisor_send');
    expect(validateDelegation({ send: true, supervisorId: 'boss' }, null, list).supervisorId).toBe('boss');
  });

  it('자기 자신 · 없는 에이전트 · 받기를 끈 에이전트는 협조 에이전트가 될 수 없습니다', () => {
    const list = [ag('me'), ag('off', { accept: false })];
    expect(codeOf(() => validateDelegation({ send: true, supervisorId: 'me' }, 'me', list))).toBe('delegation_supervisor_self');
    expect(codeOf(() => validateDelegation({ send: true, supervisorId: 'ghost' }, 'me', list))).toBe('delegation_supervisor_missing');
    expect(codeOf(() => validateDelegation({ send: true, supervisorId: 'off' }, 'me', list))).toBe('delegation_supervisor_accept');
  });

  it('위아래 관계가 아니므로 서로를 협조 에이전트로 두어도 됩니다 (되돌려 맡기기는 위임할 때 막음)', () => {
    const list = [ag('a', { supervisorId: 'b' }), ag('b', { supervisorId: 'c' }), ag('c')];
    expect(validateDelegation({ accept: true, send: true, supervisorId: 'a' }, 'c', list).supervisorId).toBe('a');
    expect(validateDelegation({ accept: true, send: true, supervisorId: 'a' }, 'b', [ag('a', { supervisorId: 'b' }), ag('b')]).supervisorId).toBe('a');
  });

  it('누군가의 협조 에이전트는 받기를 끌 수 없고, 새 에이전트에는 이 검사가 없습니다', () => {
    const list = [ag('boss'), ag('w1', { supervisorId: 'boss' }), ag('w2', { supervisorId: 'boss' })];
    try {
      validateDelegation({ accept: false, send: true }, 'boss', list);
      expect.unreachable();
    } catch (err) {
      expect((err as { code: string }).code).toBe('delegation_has_dependents');
      expect((err as Error).message).toContain("'W1', 'W2'");
    }
    expect(validateDelegation({ accept: false }, 'w1', list).accept).toBe(false);
    expect(validateDelegation({ accept: false }, null, list).accept).toBe(false);
  });
});

describe('delegationProblem', () => {
  const ag = (id: string, d: Partial<DelegationSettings> = {}) => ({ id, name: id, delegation: { accept: true, send: true, supervisorId: null, ...d } });
  const from = ag('a');
  const to = ag('b');

  it('보내기 꺼짐 · 없는 대상 · 자기 자신 · 받기 꺼짐', () => {
    expect(delegationProblem({ from: ag('a', { send: false }), to, toName: 'b', chain: [], maxDepth: 3 })).toContain('보내기가 꺼져');
    expect(delegationProblem({ from, to: null, toName: '유령', chain: [], maxDepth: 3 })).toContain("'유령'이라는 에이전트가 없습니다");
    expect(delegationProblem({ from, to: from, toName: 'a', chain: [], maxDepth: 3 })).toContain('자기 자신');
    expect(delegationProblem({ from, to: ag('b', { accept: false }), toName: 'b', chain: [], maxDepth: 3 })).toContain('받기가 꺼져');
  });

  it('맡겨 온 쪽으로 되돌려 맡기면 순환으로 거절합니다', () => {
    expect(delegationProblem({ from, to, toName: 'b', chain: ['b'], maxDepth: 5 })).toContain('순환');
  });

  it('깊이 경계: 지금까지 2단계면 3단계 한도에서 한 번 더 됨, 3단계면 안 됨', () => {
    expect(delegationProblem({ from, to, toName: 'b', chain: ['x', 'y'], maxDepth: 3 })).toBeNull();
    expect(delegationProblem({ from, to, toName: 'b', chain: ['x', 'y', 'z'], maxDepth: 3 })).toContain('3단계까지');
  });
});

describe('위임 글', () => {
  it('이유가 비면 이유 줄이 없습니다', () => {
    expect(delegationRequestText('A', '일', '  ')).not.toContain('이유:');
    expect(delegationRequestText('A', '일', '권한 없음')).toContain('이유: 권한 없음');
  });

  it(`결과는 ${RESULT_MAX.toLocaleString()}자까지 그대로, 넘으면 앞부분만 보냈다고 적습니다`, () => {
    expect(delegationResultText('B', 'done', 'x'.repeat(RESULT_MAX), null)).not.toContain('앞부분');
    expect(delegationResultText('B', 'done', 'x'.repeat(RESULT_MAX + 1), null)).toContain(`전체 ${(RESULT_MAX + 1).toLocaleString()}자 중 앞부분`);
  });

  it('빈 답 · 이유 없는 실패도 비워 두지 않습니다', () => {
    expect(delegationResultText('B', 'done', '  ', null)).toContain('(답이 비어 있습니다)');
    expect(delegationResultText('B', 'failed', '', null)).toContain('[위임 결과 · B · 실패]\n이유를 알 수 없습니다');
    expect(delegationResultText('B', 'cancelled', '', '사용자가 취소')).toContain('취소됨');
  });
});
