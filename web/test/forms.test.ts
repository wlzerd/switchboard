import { describe, expect, it } from 'vitest';
import { agentNameProblem, NAME_MAX, nextFreeName } from '../src/lib/agent';
import { countLimitChanges, countPermissionChanges, hookDraftProblems, limitProblem, patternProblem, regexProblem, windowProblem, type HookDraft } from '../src/lib/guard';
import { parseThemeJson } from '../src/lib/theme';
import type { Meta } from '../src/lib/types';

describe('에이전트 이름', () => {
  const others = [
    { id: 'a1', name: '리서처' },
    { id: 'a2', name: '리서처 2' },
  ];

  it.each([
    ['', '이름을 입력하세요.'],
    ['   ', '이름을 입력하세요.'],
    ['가'.repeat(NAME_MAX), null],
    ['가'.repeat(NAME_MAX + 1), `이름은 ${NAME_MAX}자까지 쓸 수 있습니다. 지금 ${NAME_MAX + 1}자입니다.`],
    // 앞뒤 공백은 잘라서 셉니다: 24자 + 공백은 통과
    [` ${'a'.repeat(NAME_MAX)} `, null],
    ['에코_1-b', null],
    ['에코!', '이름에 쓸 수 없는 문자가 있습니다: ! (글자, 숫자, 공백, -, _ 만 가능)'],
    ['a/b/c', '이름에 쓸 수 없는 문자가 있습니다: / (글자, 숫자, 공백, -, _ 만 가능)'],
    ['리서처', "'리서처'은(는) 이미 쓰고 있는 에이전트 이름입니다."],
    [' 리서처 ', "'리서처'은(는) 이미 쓰고 있는 에이전트 이름입니다."],
  ])('%j → %j', (name, want) => {
    expect(agentNameProblem(name, others)).toBe(want);
  });

  it('자기 자신의 이름은 겹침으로 보지 않는다 (이름 그대로 저장)', () => {
    expect(agentNameProblem('리서처', others, 'a1')).toBeNull();
    expect(agentNameProblem('리서처', others, 'a2')).not.toBeNull();
  });

  it('겹치면 비어 있는 다음 번호를 제안하고, 이미 붙은 번호는 떼고 센다', () => {
    expect(nextFreeName('리서처', others)).toBe('리서처 3');
    expect(nextFreeName('리서처 2', others)).toBe('리서처 3');
    expect(nextFreeName('새 이름', others)).toBe('새 이름');
  });

  it('번호를 붙이면 길이 제한을 넘는 경우 원래 이름을 돌려준다 (무한 반복 없음)', () => {
    const long = 'a'.repeat(NAME_MAX);
    expect(nextFreeName(long, [{ name: long }])).toBe(long);
  });
});

describe('한도 입력', () => {
  const rule = { label: '동시 작업', min: 1, max: 8 };
  it.each([
    ['', '동시 작업 값을 입력하세요.'],
    ['  ', '동시 작업 값을 입력하세요.'],
    ['0', '동시 작업 한도는 1 이상 8 이하여야 합니다.'],
    ['1', null],
    ['8', null],
    ['9', '동시 작업 한도는 1 이상 8 이하여야 합니다.'],
    ['-1', '동시 작업 한도는 1 이상 8 이하여야 합니다.'],
    ['1.5', '동시 작업 한도는 정수여야 합니다. 받은 값: 1.5'],
    ['1e3', '동시 작업 한도는 정수여야 합니다. 받은 값: 1e3'],
    [' 3 ', null],
  ])('%j → %j', (raw, want) => {
    expect(limitProblem(raw, rule)).toBe(want);
  });

  it('큰 한도의 경계 (일일 토큰 1,000 ~ 10,000,000)', () => {
    const tokens = { label: '일일 토큰', min: 1000, max: 10_000_000 };
    expect(limitProblem('999', tokens)).not.toBeNull();
    expect(limitProblem('1000', tokens)).toBeNull();
    expect(limitProblem('10000000', tokens)).toBeNull();
    expect(limitProblem('10000001', tokens)).not.toBeNull();
  });
});

describe('시간대 · 정규식 · 범위 항목', () => {
  it.each([
    ['22:00-08:00', null],
    ['00:00-23:59', null],
    ['23:59-00:00', null],
    ['00:00 - 01:00', null],
    ['09:00-09:00', '시작과 끝이 같으면(09:00-09:00) 시간대가 비어 있습니다.'],
    ['24:00-01:00', "시(hour)는 00~23 이어야 합니다. 받은 값: '24:00-01:00'"],
    ['10:60-11:00', "분(minute)은 00~59 여야 합니다. 받은 값: '10:60-11:00'"],
    ['9:00-10:00', "시간대는 HH:MM-HH:MM 형식이어야 합니다. 받은 값: '9:00-10:00'"],
    ['', "시간대는 HH:MM-HH:MM 형식이어야 합니다. 받은 값: ''"],
  ])('시간대 %j', (v, want) => {
    expect(windowProblem(v)).toBe(want);
  });

  it('정규식: 슬래시 형식 · 플래그 · 깨진 패턴', () => {
    expect(regexProblem('/abc/i')).toBeNull();
    expect(regexProblem('a/b')).toBeNull();
    expect(regexProblem('/a/zz')).toBeNull(); // 알 수 없는 플래그는 슬래시 형식이 아니라 일반 패턴 '/a/zz' 로 봅니다 (서버와 같음)
    expect(regexProblem('([a-z')).toMatch(/^정규식을 해석할 수 없습니다/);
    expect(regexProblem('/(/')).toMatch(/^정규식을 해석할 수 없습니다/);
    expect(regexProblem('/a/gg')).toMatch(/^정규식을 해석할 수 없습니다/);
  });

  it('허용 범위 항목: 빈 값 · 200자 경계 · 50개 경계', () => {
    expect(patternProblem('', [])).toBe('빈 값은 넣을 수 없습니다.');
    expect(patternProblem('x'.repeat(200), [])).toBeNull();
    expect(patternProblem('x'.repeat(201), [])).toBe('항목은 200자까지입니다. 지금 201자입니다.');
    expect(patternProblem('a', Array.from({ length: 49 }, (_, i) => `p${i}`))).toBeNull();
    expect(patternProblem('a', Array.from({ length: 50 }, (_, i) => `p${i}`))).toBe('50개까지 넣을 수 있습니다.');
  });
});

describe('훅 초안 검사', () => {
  const meta: Pick<Meta, 'hookEvents' | 'hookFields' | 'hookActions' | 'conditionOps'> = {
    hookEvents: ['before_tool', 'after_tool', 'before_send', 'on_message', 'before_install'],
    hookFields: {
      before_tool: ['tool', 'category', 'command', 'host', 'url', 'method', 'path', 'text', 'agent', 'now', 'weekday'],
      after_tool: ['tool', 'category', 'command', 'host', 'url', 'method', 'path', 'output', 'agent', 'now', 'weekday'],
      before_send: ['channel', 'target', 'text', 'agent', 'now', 'weekday'],
      on_message: ['channel', 'target', 'user', 'text', 'agent', 'now', 'weekday'],
      before_install: ['kind', 'id', 'agent', 'now', 'weekday'],
    },
    hookActions: { before_tool: ['deny', 'ask', 'log'], after_tool: ['deny', 'modify', 'log'], before_send: ['deny', 'ask', 'modify', 'log'], on_message: ['deny', 'log'], before_install: ['deny', 'ask', 'log'] },
    conditionOps: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'matches', 'not_matches', 'in_window', 'not_in_window'],
  };
  const ok: HookDraft = { name: '결제 API 차단', event: 'before_tool', enabled: true, action: 'deny', conditions: [{ field: 'host', op: 'eq', value: 'api.stripe.com' }], reason: '{host} 차단', modify: null };
  const where = (d: HookDraft): string[] => hookDraftProblems(d, meta).map((p) => p.where);

  it('정상 초안은 문제 없음', () => {
    expect(hookDraftProblems(ok, meta)).toEqual([]);
  });

  it('이름 · 문구 길이 경계 (1~40, 1~200)', () => {
    expect(where({ ...ok, name: '' })).toEqual(['name']);
    expect(where({ ...ok, name: 'x'.repeat(40) })).toEqual([]);
    expect(where({ ...ok, name: 'x'.repeat(41) })).toEqual(['name']);
    expect(where({ ...ok, reason: '   ' })).toEqual(['reason']);
    expect(where({ ...ok, reason: 'x'.repeat(200) })).toEqual([]);
    expect(where({ ...ok, reason: 'x'.repeat(201) })).toEqual(['reason']);
  });

  it('조건 개수 경계 (1~10)', () => {
    const c = { field: 'host', op: 'eq', value: 'a' };
    expect(where({ ...ok, conditions: [] })).toEqual(['conditions']);
    expect(where({ ...ok, conditions: Array.from({ length: 10 }, () => c) })).toEqual([]);
    expect(where({ ...ok, conditions: Array.from({ length: 11 }, () => c) })).toEqual(['conditions']);
  });

  it('이벤트에 없는 동작과 필드를 잡는다', () => {
    expect(where({ ...ok, action: 'modify' })).toEqual(['action']);
    expect(where({ ...ok, event: 'before_send' })).toEqual(['condition:0']);
    // 도구 이벤트에서는 input.<경로> 를 쓸 수 있지만 다른 이벤트에서는 안 됩니다
    expect(where({ ...ok, conditions: [{ field: 'input.body.amount', op: 'eq', value: '5' }] })).toEqual([]);
    expect(where({ ...ok, conditions: [{ field: 'input.', op: 'eq', value: '5' }] })).toEqual(['condition:0']);
    expect(where({ ...ok, event: 'before_send', action: 'deny', conditions: [{ field: 'input.a', op: 'eq', value: '5' }] })).toEqual(['condition:0']);
  });

  it('값 검사: 빈 값은 같음/다름에서만, 시간대 · 정규식 형식, $env 참조는 건너뜀', () => {
    expect(where({ ...ok, conditions: [{ field: 'host', op: 'eq', value: '' }] })).toEqual([]);
    expect(where({ ...ok, conditions: [{ field: 'host', op: 'contains', value: '' }] })).toEqual(['condition:0']);
    expect(where({ ...ok, conditions: [{ field: 'now', op: 'in_window', value: '22:00-22:00' }] })).toEqual(['condition:0']);
    expect(where({ ...ok, conditions: [{ field: 'now', op: 'in_window', value: '$env:QUIET_HOURS' }] })).toEqual([]);
    expect(where({ ...ok, conditions: [{ field: 'text', op: 'matches', value: '([a-z' }] })).toEqual(['condition:0']);
    expect(where({ ...ok, conditions: [{ field: 'text', op: 'matches', value: '' }] })).toEqual(['condition:0']);
    // $env: 뒤 이름 형식이 틀리면 참조가 아니라 일반 값으로 봅니다
    expect(where({ ...ok, conditions: [{ field: 'now', op: 'in_window', value: '$env:quiet' }] })).toEqual(['condition:0']);
  });

  it('수정 동작은 찾을 패턴이 필요하고 정규식이어야 한다', () => {
    const m: HookDraft = { ...ok, event: 'before_send', action: 'modify', conditions: [{ field: 'text', op: 'contains', value: '010' }] };
    expect(where({ ...m, modify: null })).toEqual(['modify']);
    expect(where({ ...m, modify: { find: '', replace: 'x' } })).toEqual(['modify']);
    expect(where({ ...m, modify: { find: '(', replace: 'x' } })).toEqual(['modify']);
    expect(where({ ...m, modify: { find: '\\d+', replace: '' } })).toEqual([]);
  });
});

describe('변경 개수', () => {
  it('권한: 같은 내용이면 0, 키가 한쪽에만 있어도 1', () => {
    const a = { 'fs.read': { mode: 'allow' as const, scope: [], always: [] } };
    expect(countPermissionChanges(a, { 'fs.read': { mode: 'allow', scope: [], always: [] } })).toBe(0);
    expect(countPermissionChanges(a, { 'fs.read': { mode: 'ask', scope: [], always: [] } })).toBe(1);
    expect(countPermissionChanges(a, { ...a, 'fs.write': { mode: 'deny', scope: [], always: [] } })).toBe(1);
  });

  it('한도: 공백만 다른 입력은 변경이 아니다', () => {
    const l = { tokensPerDay: 1000, stepsPerTask: 10, concurrency: 1, messagesPerMinute: 5 };
    expect(countLimitChanges(l, { tokensPerDay: ' 1000 ', stepsPerTask: '10', concurrency: '1', messagesPerMinute: '5' })).toBe(0);
    expect(countLimitChanges(l, { tokensPerDay: '1001', stepsPerTask: '10', concurrency: '2', messagesPerMinute: '5' })).toBe(2);
  });
});

describe('테마 가져오기', () => {
  const tokens = { bg: '#0b0d11', panel: '#0F1217', surface: '#141820', raised: '#1A1F28', line: '#232A35', line2: '#303845', text: '#E8EAEE', text2: '#A6AEBB', text3: '#7D8696', accent: '#C6F35B', onAccent: '#0B0D11', msg: '#6CB6FF', skill: '#FFB547', warn: '#FFB547', danger: '#FF6B6B' };
  const good = { name: '내 테마', tokens, radius: 12, font: 'plex', density: 1, motion: 2 };
  const parse = (o: unknown): ReturnType<typeof parseThemeJson> => parseThemeJson(JSON.stringify(o));

  it('정상 테마는 색을 대문자로 맞춰 돌려준다', () => {
    const t = parse(good);
    expect(typeof t).toBe('object');
    expect((t as { tokens: { bg: string } }).tokens.bg).toBe('#0B0D11');
  });

  it.each([
    [{ ...good, radius: -1 }, '모서리(radius)는 0~20 사이 정수여야 합니다. 받은 값: -1'],
    [{ ...good, radius: 0 }, null],
    [{ ...good, radius: 20 }, null],
    [{ ...good, radius: 21 }, '모서리(radius)는 0~20 사이 정수여야 합니다. 받은 값: 21'],
    [{ ...good, radius: 12.5 }, '모서리(radius)는 0~20 사이 정수여야 합니다. 받은 값: 12.5'],
    [{ ...good, density: 3 }, '밀도(density)는 0, 1, 2 중 하나여야 합니다. 받은 값: 3'],
    [{ ...good, motion: '2' }, '움직임(motion)은 0, 1, 2 중 하나여야 합니다. 받은 값: "2"'],
    [{ ...good, font: 'comic' }, '글꼴(font)은 plex, noto, system 중 하나여야 합니다. 받은 값: "comic"'],
    [{ ...good, tokens: { ...tokens, accent: '#FFF' } }, "색 'accent' 는 #RRGGBB 형식이어야 합니다. 받은 값: \"#FFF\""],
    [{ ...good, tokens: { ...tokens, danger: undefined } }, "색 'danger' 는 #RRGGBB 형식이어야 합니다. 받은 값: undefined"],
    [{ ...good, tokens: null }, '색 토큰(tokens)이 없습니다.'],
    [[good], '테마는 { name, tokens, radius, font, density, motion } 형태의 객체여야 합니다.'],
  ])('%#', (input, want) => {
    const r = parse(input);
    if (want === null) expect(typeof r).toBe('object');
    else expect(r).toBe(want);
  });

  it('이름이 없거나 길면 기본값 · 30자로 맞춘다', () => {
    expect((parse({ ...good, name: '  ' }) as { name: string }).name).toBe('가져온 테마');
    expect((parse({ ...good, name: 'x'.repeat(40) }) as { name: string }).name).toHaveLength(30);
  });

  it('JSON 이 아니면 이유를 알려준다', () => {
    expect(parseThemeJson('{ name: 1 }')).toMatch(/^JSON 형식이 아닙니다/);
    expect(parseThemeJson('')).toMatch(/^JSON 형식이 아닙니다/);
  });
});
