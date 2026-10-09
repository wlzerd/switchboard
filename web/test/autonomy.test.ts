import { describe, expect, it } from 'vitest';
import {
  delegationChips,
  delegationProblem,
  dependentsOf,
  heartbeatFormOf,
  heartbeatFormProblem,
  heartbeatPayload,
  intervalChoices,
  intervalLabel,
  receivesNotices,
  sameHeartbeat,
  supervisorChoices,
  type HeartbeatForm,
} from '../src/lib/autonomy';
import { ARC_BOW_MAX, ARC_BOW_MIN, arcBow, layoutGraph, orderAgents } from '../src/lib/graph';
import type { DelegationSettings, Overview } from '../src/lib/types';

const ag = (id: string, d: Partial<DelegationSettings> = {}) => ({ id, name: id.toUpperCase(), delegation: { accept: true, send: true, supervisorId: null, ...d } });

describe('상위 에이전트 후보', () => {
  it('새 에이전트는 받기를 허용한 모든 에이전트를 고를 수 있습니다', () => {
    const list = [ag('a'), ag('b', { accept: false }), ag('c')];
    expect(supervisorChoices(list, null).map((a) => a.id)).toEqual(['a', 'c']);
  });

  it('자기 자신과, 고르면 순환하는 에이전트(바로 아래 · 몇 단계 아래)는 뺍니다', () => {
    // a ← b ← c (c 의 상위는 b, b 의 상위는 a)
    const list = [ag('a'), ag('b', { supervisorId: 'a' }), ag('c', { supervisorId: 'b' }), ag('d')];
    expect(supervisorChoices(list, 'a').map((x) => x.id)).toEqual(['d']);
    expect(supervisorChoices(list, 'b').map((x) => x.id)).toEqual(['a', 'd']);
    expect(supervisorChoices(list, 'c').map((x) => x.id)).toEqual(['a', 'b', 'd']);
  });

  it('저장된 데이터에 이미 순환이 있어도 멈춥니다', () => {
    const list = [ag('x', { supervisorId: 'y' }), ag('y', { supervisorId: 'x' }), ag('me')];
    expect(supervisorChoices(list, 'me').map((a) => a.id)).toEqual(['x', 'y']);
  });

  it('긴 사슬도 재귀 없이 끝까지 따라갑니다', () => {
    const n = 20_000;
    const list = Array.from({ length: n }, (_, i) => ag(`n${i}`, { supervisorId: i === 0 ? null : `n${i - 1}` }));
    // 맨 위(n0)의 상위로 맨 아래(n19999)를 고르면 순환입니다.
    expect(supervisorChoices(list, 'n0').some((a) => a.id === `n${n - 1}`)).toBe(false);
  });
});

describe('위임 설정 검사', () => {
  const list = [ag('boss'), ag('w1', { supervisorId: 'boss' }), ag('w2', { supervisorId: 'boss' }), ag('lone', { accept: false })];

  it('누군가의 상위인데 받기를 끄면 그 에이전트들을 짚어 거절합니다', () => {
    expect(dependentsOf(list, 'boss').map((a) => a.id)).toEqual(['w1', 'w2']);
    expect(delegationProblem({ accept: false, send: true, supervisorId: null }, list, 'boss')).toBe("'W1', 'W2'의 상위 에이전트라서 위임 받기를 끌 수 없습니다.");
    expect(delegationProblem({ accept: true, send: true, supervisorId: null }, list, 'boss')).toBeNull();
  });

  it('새 에이전트(selfId=null)는 아래에 둔 에이전트가 없으니 받기를 꺼도 됩니다', () => {
    expect(delegationProblem({ accept: false, send: false, supervisorId: null }, list, null)).toBeNull();
  });

  it('상위를 정하려면 보내기가 허용이어야 합니다', () => {
    expect(delegationProblem({ accept: false, send: false, supervisorId: 'boss' }, list, null)).toContain('위임 요청 보내기를 허용');
    expect(delegationProblem({ accept: false, send: true, supervisorId: 'boss' }, list, null)).toBeNull();
  });

  it('받기를 끈 에이전트 · 없는 에이전트 · 순환을 각각 다른 문구로', () => {
    expect(delegationProblem({ accept: true, send: true, supervisorId: 'lone' }, list, null)).toContain("'LONE'은(는) 위임 받기가 꺼져");
    expect(delegationProblem({ accept: true, send: true, supervisorId: 'ghost' }, list, null)).toContain('없습니다');
    expect(delegationProblem({ accept: true, send: true, supervisorId: 'w1' }, list, 'boss')).toContain('순환');
  });

  it('칩: 상위가 지워졌으면 삭제됨', () => {
    expect(delegationChips({ accept: true, send: false, supervisorId: null }, list)).toEqual(['받기 허용', '보내기 미허용']);
    expect(delegationChips({ accept: false, send: true, supervisorId: 'gone' }, list)).toEqual(['받기 미허용', '보내기 허용', '상위 삭제됨']);
  });
});

describe('하트비트 간격', () => {
  const limits = { minMinutes: 5, maxMinutes: 1440, checklistMax: 4000 };

  it('최솟값은 늘 들어가고, 지금 값이 목록에 없으면 끼워 넣습니다', () => {
    expect(intervalChoices({ ...limits, minMinutes: 7 }, 30)[0]).toBe(7);
    expect(intervalChoices(limits, 45)).toContain(45);
    expect(intervalChoices(limits, 45)).toEqual([...intervalChoices(limits, 45)].sort((a, b) => a - b));
  });

  it('범위 밖 · 정수가 아닌 지금 값은 넣지 않습니다', () => {
    expect(intervalChoices(limits, 2)).not.toContain(2);
    expect(intervalChoices(limits, 2000)).not.toContain(2000);
    expect(intervalChoices(limits, 30.5)).not.toContain(30.5);
  });

  it('최솟값이 하루면 하루만', () => {
    expect(intervalChoices({ ...limits, minMinutes: 1440 }, 30)).toEqual([1440]);
  });

  it('이름: 분 · 시간 · 하루 · 여러 날', () => {
    expect(intervalLabel(5)).toBe('5분');
    expect(intervalLabel(60)).toBe('1시간');
    expect(intervalLabel(90)).toBe('1시간 30분');
    expect(intervalLabel(1439)).toBe('23시간 59분');
    expect(intervalLabel(1440)).toBe('하루');
    expect(intervalLabel(2880)).toBe('2일');
  });
});

describe('하트비트 설정 검사', () => {
  const limits = { minMinutes: 5, maxMinutes: 1440, checklistMax: 100 };
  const modules = [
    { id: 'discord', name: 'Discord', canSend: true },
    { id: 'email', name: '이메일', canSend: false },
  ];
  const base: HeartbeatForm = { enabled: true, everyMinutes: 30, allDay: true, start: '09:00', end: '18:00', checklist: '새 메일 확인', reportModule: '', reportTarget: '' };

  it('간격 경계: 최솟값 ~ 최댓값만', () => {
    expect(heartbeatFormProblem({ ...base, everyMinutes: 5 }, limits, modules)).toBeNull();
    expect(heartbeatFormProblem({ ...base, everyMinutes: 1440 }, limits, modules)).toBeNull();
    expect(heartbeatFormProblem({ ...base, everyMinutes: 4 }, limits, modules)).toContain('5분 이상');
    expect(heartbeatFormProblem({ ...base, everyMinutes: 1441 }, limits, modules)).toContain('하루 이하');
    expect(heartbeatFormProblem({ ...base, everyMinutes: 30.5 }, limits, modules)).not.toBeNull();
  });

  it('시간 지정: 시작과 끝이 같으면 안 되고, 하루 종일이면 시간 값을 보지 않습니다', () => {
    expect(heartbeatFormProblem({ ...base, allDay: false, start: '09:00', end: '09:00' }, limits, modules)).toContain('같습니다');
    expect(heartbeatFormProblem({ ...base, allDay: false, start: '22:00', end: '08:00' }, limits, modules)).toBeNull();
    expect(heartbeatFormProblem({ ...base, allDay: false, start: '24:00', end: '08:00' }, limits, modules)).toContain('00:00~23:59');
    expect(heartbeatFormProblem({ ...base, allDay: false, start: '', end: '08:00' }, limits, modules)).toContain('00:00~23:59');
    expect(heartbeatFormProblem({ ...base, allDay: true, start: '', end: '' }, limits, modules)).toBeNull();
  });

  it('점검 목록: 켜려면 필요하고(공백만은 빈 것), 길이는 앞뒤 공백을 빼고 셉니다', () => {
    expect(heartbeatFormProblem({ ...base, checklist: '   ' }, limits, modules)).toContain('알릴 조건을 적으세요');
    expect(heartbeatFormProblem({ ...base, enabled: false, checklist: '' }, limits, modules)).toBeNull();
    expect(heartbeatFormProblem({ ...base, checklist: `  ${'x'.repeat(100)}  ` }, limits, modules)).toBeNull();
    expect(heartbeatFormProblem({ ...base, checklist: 'x'.repeat(101) }, limits, modules)).toContain('100자까지');
  });

  it('보고 채널: 받기 전용 모듈은 고를 수 없고, 대상은 1~200자', () => {
    expect(heartbeatFormProblem({ ...base, reportModule: 'email', reportTarget: 'x' }, limits, modules)).toContain('보낼 수 없는');
    expect(heartbeatFormProblem({ ...base, reportModule: 'gone', reportTarget: 'x' }, limits, modules)).toContain('없습니다');
    expect(heartbeatFormProblem({ ...base, reportModule: 'discord', reportTarget: '  ' }, limits, modules)).toContain('대상');
    expect(heartbeatFormProblem({ ...base, reportModule: 'discord', reportTarget: 'x'.repeat(200) }, limits, modules)).toBeNull();
    expect(heartbeatFormProblem({ ...base, reportModule: 'discord', reportTarget: 'x'.repeat(201) }, limits, modules)).toContain('200자까지');
  });

  it('보내는 값: 하루 종일이면 activeHours=null, 채널을 안 고르면 report=null, 앞뒤 공백 정리', () => {
    expect(heartbeatPayload({ ...base, checklist: ' a ', reportTarget: ' #ops ', reportModule: 'discord' })).toEqual({
      heartbeat: { enabled: true, everyMinutes: 30, activeHours: null, checklist: 'a' },
      report: { moduleId: 'discord', target: '#ops' },
    });
    expect(heartbeatPayload({ ...base, allDay: false, start: '22:00', end: '06:00' }).heartbeat.activeHours).toBe('22:00-06:00');
    expect(heartbeatPayload({ ...base, reportTarget: '#ops' }).report).toBeNull();
  });

  it('하루 종일일 때 숨은 시간 값만 다르면 바뀐 것이 아닙니다', () => {
    expect(sameHeartbeat({ ...base, start: '01:00' }, base)).toBe(true);
    expect(sameHeartbeat({ ...base, allDay: false }, base)).toBe(false);
  });

  it('저장된 값에서 화면 값 만들기 (최솟값이 30분보다 크면 기본 간격도 올림)', () => {
    expect(heartbeatFormOf({ heartbeat: null, report: null }, { ...limits, minMinutes: 60 }).everyMinutes).toBe(60);
    const f = heartbeatFormOf({ heartbeat: { enabled: true, everyMinutes: 45, activeHours: '22:00-06:00', checklist: 'c', lastAt: null }, report: { moduleId: 'discord', target: '#ops' } }, limits);
    expect(f).toMatchObject({ allDay: false, start: '22:00', end: '06:00', everyMinutes: 45, reportModule: 'discord', reportTarget: '#ops' });
  });
});

describe('에이전트 줄 순서', () => {
  it('상위 바로 아래에 하위들이 원래 순서대로 옵니다', () => {
    const list = [ag('w1', { supervisorId: 'boss' }), ag('solo'), ag('boss'), ag('w2', { supervisorId: 'boss' }), ag('sub', { supervisorId: 'w1' })];
    expect(orderAgents(list).map((a) => a.id)).toEqual(['solo', 'boss', 'w1', 'sub', 'w2']);
  });

  it('자기 자신 · 없는 에이전트를 상위로 가리키면 맨 위 줄로, 순환은 원래 순서대로 뒤에', () => {
    const list = [ag('x', { supervisorId: 'y' }), ag('self', { supervisorId: 'self' }), ag('y', { supervisorId: 'x' }), ag('orphan', { supervisorId: 'ghost' })];
    expect(orderAgents(list).map((a) => a.id)).toEqual(['self', 'orphan', 'x', 'y']);
  });

  it('깊은 사슬도 재귀 없이 순서대로', () => {
    const n = 20_000;
    const list = Array.from({ length: n }, (_, i) => ag(`n${n - 1 - i}`, { supervisorId: n - 1 - i === 0 ? null : `n${n - 2 - i}` }));
    const out = orderAgents(list);
    expect(out).toHaveLength(n);
    expect(out[0]?.id).toBe('n0');
    expect(out[n - 1]?.id).toBe(`n${n - 1}`);
  });
});

describe('위임 선', () => {
  const overview = (edges: Overview['edges']): Overview =>
    ({
      server: { startedAt: 0, now: 0, tz: 'UTC', tokensToday: 0, approvalsPending: 0, envKey: false },
      agents: [ag('a', { supervisorId: 'b' }), ag('b'), ag('c')],
      modules: [],
      skills: [],
      builtinNodes: [],
      edges,
    }) as unknown as Overview;

  it('지금 위임이 오가는 사이에는 상위 관계 점선 대신 움직이는 선 하나만 (방향과 관계없이)', () => {
    expect(layoutGraph(overview([{ from: 'a', to: 'b', kind: 'delegate' }])).edges.map((e) => e.kind)).toEqual(['delegate']);
    expect(layoutGraph(overview([{ from: 'a', to: 'b', kind: 'delegate' }, { from: 'a', to: 'b', kind: 'delegating' }])).edges.map((e) => e.kind)).toEqual(['delegating']);
    // 상위(b)가 하위(a)에게 맡긴 경우: 방향이 반대여도 같은 사이로 봅니다.
    expect(layoutGraph(overview([{ from: 'a', to: 'b', kind: 'delegate' }, { from: 'b', to: 'a', kind: 'delegating' }])).edges.map((e) => `${e.source}>${e.target}:${e.kind}`)).toEqual(['b>a:delegating']);
    // 다른 사이의 위임은 상위 관계 선을 지우지 않습니다.
    expect(layoutGraph(overview([{ from: 'a', to: 'b', kind: 'delegate' }, { from: 'c', to: 'b', kind: 'delegating' }])).edges).toHaveLength(2);
  });

  it('곡선은 가까우면 36px, 멀수록 커지다 120px 에서 멈춥니다 (위아래 대칭)', () => {
    expect(arcBow(0)).toBe(ARC_BOW_MIN);
    expect(arcBow(100)).toBeCloseTo(58);
    expect(arcBow(-100)).toBe(arcBow(100));
    expect(arcBow(10_000)).toBe(ARC_BOW_MAX);
  });
});

describe('모듈 자동 알림을 받는지 (알릴 조건 칸을 하트비트가 꺼져도 보일지)', () => {
  const modules = [
    { id: 'email', channel: true, canSend: false },
    { id: 'discord', channel: true, canSend: true },
    { id: 'notion', channel: false, canSend: false },
  ];
  const link = (moduleId: string, trigger: 'direct' | 'all' | 'none' = 'direct') => ({ moduleId, targets: [], trigger });

  it.each([
    ['받기 전용 채널을 알림 받기로 연결', [link('email')], true],
    ['받기 전용 채널을 모든 메시지로 연결', [link('email', 'all')], true],
    ['받기 전용 채널을 도구만으로 연결', [link('email', 'none')], false],
    ['보내기도 하는 채널만', [link('discord', 'all')], false],
    ['채널이 아닌 도구 모듈만', [link('notion')], false],
    ['지워진 모듈', [link('gone')], false],
    ['연결 없음', [], false],
  ])('%s → %s', (_label, links, expected) => {
    expect(receivesNotices({ links }, modules)).toBe(expected);
  });
});
