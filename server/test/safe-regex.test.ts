import { afterAll, describe, expect, it } from 'vitest';
import guardsJson from '../../config/guards.json' with { type: 'json' };
import { GuardState } from '../src/guards/guards.ts';
import { HookEngine, hookHelpers } from '../src/hooks/engine.ts';
import { evalCondition, validateRuleHook, type RuleHook } from '../src/hooks/rules.ts';
import { linearProblem, regexRunner, RegexRunner } from '../src/hooks/safe-regex.ts';
import type { SendCtx } from '../src/hooks/types.ts';

// 사용자가 쓴 정규식은 입력에 따라 되추적이 폭발해 서버(이벤트 루프) 전체를 멈출 수 있습니다.
// 예전에는 /^(\w+\s?)*$/ 가 27자에 286ms, 한 글자마다 두 배로 늘었습니다.
const BOMB = '^(\\w+\\s?)*$';
const bombInput = (n: number): string => `${'a'.repeat(n)}!`;
const TZ = 'Asia/Seoul';
const rt = { env: () => undefined, timeZone: TZ };

const send = (text: string): SendCtx => ({ event: 'before_send', agentId: 'a1', agentName: '에코', taskId: null, now: new Date(), channel: 'discord', target: '#help', text, perMinute: 1000 });
const msg = (text: string) => ({ event: 'on_message' as const, agentId: 'a1', agentName: '에코', taskId: null, now: new Date(), channel: 'discord', target: '#help', user: '누군가', text });

afterAll(() => regexRunner.close());

describe('시간 제한 실행기', () => {
  const runner = new RegexRunner(200, 5000);
  afterAll(() => runner.close());

  it('선형 엔진으로 돌 수 있는 폭발형은 V8 이 바꿔 돌려 바로 끝납니다', () => {
    const t = performance.now();
    const r = runner.test(BOMB, '', bombInput(60));
    expect(r).toEqual({ ok: true, value: false });
    expect(performance.now() - t).toBeLessThan(150);
  });

  it('선형 엔진이 못 도는(대소문자 무시) 폭발형은 제한 시간에 끊기고, 서버는 기다린 만큼만 멈춥니다', () => {
    const t = performance.now();
    const r = runner.test(BOMB, 'i', bombInput(40));
    const ms = performance.now() - t;
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.timedOut).toBe(true);
    expect(r.ok === false ? r.error : '').toContain('200ms 안에 끝나지 않았습니다');
    expect(ms).toBeGreaterThanOrEqual(190);
    expect(ms).toBeLessThan(1500);
  });

  it('시간 초과 직후의 다음 폭발형도 스레드 시작 여유(5초)가 아니라 제한 시간(0.2초)에 끊깁니다', () => {
    runner.test(BOMB, 'i', bombInput(40));
    const t = performance.now();
    const r = runner.test(BOMB, 'i', bombInput(40));
    expect(r.ok === false && r.timedOut).toBe(true);
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it('시간 초과로 스레드를 내린 뒤에도 다음 검사는 정상입니다 (새 스레드)', () => {
    expect(runner.test('b', '', 'abc')).toEqual({ ok: true, value: true });
    expect(runner.replace('\\d{4}', 'g', '카드 1234 5678', '****')).toEqual({ ok: true, value: '카드 **** ****' });
  });

  it('잘못된 정규식은 시간 초과가 아니라 실행 오류로 알립니다', () => {
    const r = runner.test('(', '', 'x');
    expect(r.ok === false && r.timedOut).toBe(false);
    expect(r.ok === false ? r.error : '').toContain('정규식을 실행하지 못했습니다');
  });

  it('g 플래그가 있어도 매번 처음부터 봅니다 (lastIndex 가 남지 않음)', () => {
    expect(runner.test('a', 'g', 'a')).toEqual({ ok: true, value: true });
    expect(runner.test('a', 'g', 'a')).toEqual({ ok: true, value: true });
  });
});

describe('저장할 때 거부하는 정규식 (입력 길이에 비례해 끝나게 검사할 수 없음)', () => {
  it.each([
    ['(\\w+)\\s+\\1', '', '역참조'],
    ['(?<n>a)\\k<n>', '', '역참조'],
    ['foo(?=bar)', 'i', '앞 보기'],
    ['(?!x)y', '', '앞 보기'],
  ])('%s (%s) → %s', (source, flags, word) => {
    expect(linearProblem(source, flags)).toContain(word);
  });

  it.each([
    ['^(\\w+\\s?)*$', 'iu'],
    ['(?<=a)b', ''],
    ['[가-힣]+', 'u'],
    ['\\bword\\b', 'gm'],
    ['a{2,5}', 's'],
  ])('%s (%s) 는 받습니다 (플래그 i · u 는 구조와 상관없음)', (source, flags) => {
    expect(linearProblem(source, flags)).toBeNull();
  });

  it('규칙 훅 저장: 조건 · 수정 패턴 모두 같은 규칙으로 막고 몇 번째 조건인지 알려 줍니다', () => {
    const base = { name: '반복 단어', event: 'before_send', action: 'deny', reason: '막음' };
    expect(() => validateRuleHook({ ...base, conditions: [{ field: 'text', op: 'contains', value: 'x' }, { field: 'text', op: 'matches', value: '(\\w+)\\s+\\1' }] }, () => true)).toThrow(/2번째 조건: 역참조/);
    expect(() => validateRuleHook({ ...base, action: 'modify', conditions: [{ field: 'text', op: 'contains', value: 'x' }], modify: { find: 'a(?=b)', replace: '' } }, () => true)).toThrow(/수정할 패턴\(find\): 앞 보기/);
    expect(validateRuleHook({ ...base, conditions: [{ field: 'text', op: 'matches', value: '/^(\\w+\\s?)*$/i' }] }, () => true).conditions).toHaveLength(1);
  });
});

describe('훅이 정규식 시간 초과를 만나면', () => {
  const rule = (over: Partial<RuleHook>): RuleHook => ({ id: 'h1', name: '폭발형', event: 'on_message', enabled: true, action: 'deny', conditions: [{ field: 'text', op: 'matches', value: `/${BOMB}/i` }], reason: '막음', modify: null, ...over });
  const engine = (rules: RuleHook[]) =>
    new HookEngine({
      guardEnv: { lists: guardsJson, knownSecrets: () => [], selfHosts: [], protectedPaths: [], floodPerMinute: 1000, loopRepeat: 50 },
      guardState: new GuardState(),
      rules: () => rules,
      fileHooks: () => [],
      runtime: rt,
    });

  it('조건이 맞는 것으로 봅니다: 차단 훅을 느린 입력으로 피해 갈 수 없습니다', () => {
    const out = engine([rule({})]).run(msg(bombInput(40)));
    expect(out.decision).toBe('deny');
  });

  it('not_matches 도 맞는 것으로 봅니다 (판단하지 못하면 막는 쪽)', () => {
    const r = evalCondition({ field: 'text', op: 'not_matches', value: `/${BOMB}/i` }, msg(bombInput(40)), rt);
    expect(r.matched).toBe(true);
    expect(r.skipped).toContain('조건이 맞는 것으로 보고 처리했습니다');
  });

  it('보통 입력에서는 정규식 결과 그대로입니다', () => {
    expect(engine([rule({})]).run(msg('hello world')).decision).toBe('deny');
    expect(engine([rule({})]).run(msg('hello!')).decision).toBe('allow');
  });

  it('수정 훅의 패턴이 끝나지 않으면 가리려던 내용이 그대로 나가지 않게 막습니다', () => {
    const modify = rule({ event: 'before_send', action: 'modify', conditions: [{ field: 'text', op: 'contains', value: 'a' }], modify: { find: `/${BOMB}/i`, replace: '[가림]' } });
    const out = engine([modify]).run(send(bombInput(40)));
    expect(out.decision).toBe('deny');
    expect(out.reasons[0]).toContain('수정 패턴이 시간 안에 끝나지 않아 막았습니다');
  });

  it('코드 훅의 h.matches 도 시간 제한을 받고, 끝나지 않으면 오류로 그 훅을 건너뜁니다', () => {
    const h = hookHelpers(msg(bombInput(40)), rt);
    expect(() => h.matches('text', new RegExp(BOMB, 'i'))).toThrow(/끝나지 않았습니다/);
    expect(h.matches('text', /^a+!$/)).toBe(true);
  });
});
