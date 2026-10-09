import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import guardsJson from '../../config/guards.json' with { type: 'json' };
import { GuardState } from '../src/guards/guards.ts';
import { HookEngine, type FileHook } from '../src/hooks/engine.ts';
import { loadFileHooks } from '../src/hooks/files.ts';
import { evalCondition, inWindow, parseWindow, renderHookCode, validateRuleHook, type RuleHook } from '../src/hooks/rules.ts';
import type { HookCtx, SendCtx, ToolCtx } from '../src/hooks/types.ts';
import type { Logger } from '../src/log.ts';

const TZ = 'Asia/Seoul';
// 2026-10-09 23:10 KST = 14:10 UTC
const at = (hhmmKst: string): Date => {
  const [h, m] = hhmmKst.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(2026, 9, 9, h - 9, m));
};

const send = (text: string, now = at('23:10'), target = '#help'): SendCtx => ({
  event: 'before_send',
  agentId: 'a1',
  agentName: '에코',
  taskId: null,
  now,
  channel: 'discord',
  target,
  text,
  perMinute: 100,
});

describe('시간대', () => {
  it.each([
    ['22:00-08:00', true],
    ['00:00-23:59', true],
    ['24:00-01:00', false],
    ['10:60-11:00', false],
    ['09:00-09:00', false],
    ['9:00-10:00', false],
  ])('%s 유효 %s', (v, ok) => {
    expect(typeof parseWindow(v) !== 'string').toBe(ok);
  });

  it('자정을 넘는 구간: 시작 포함, 끝 미포함', () => {
    const w = parseWindow('22:00-08:00') as { start: number; end: number };
    expect(inWindow(22 * 60, w)).toBe(true);
    expect(inWindow(7 * 60 + 59, w)).toBe(true);
    expect(inWindow(8 * 60, w)).toBe(false);
    expect(inWindow(21 * 60 + 59, w)).toBe(false);
  });

  it('하루 안의 구간', () => {
    const w = parseWindow('09:00-18:00') as { start: number; end: number };
    expect(inWindow(9 * 60, w)).toBe(true);
    expect(inWindow(17 * 60 + 59, w)).toBe(true);
    expect(inWindow(18 * 60, w)).toBe(false);
  });
});

describe('조건 평가', () => {
  const rt = { env: (n: string) => (n === 'QUIET_HOURS' ? '22:00-08:00' : undefined), timeZone: TZ };

  it('환경 변수 참조가 비어 있으면 건너뛰고 이유를 남긴다', () => {
    const r = evalCondition({ field: 'now', op: 'in_window', value: '$env:MISSING' }, send('x'), rt);
    expect(r.matched).toBe(false);
    expect(r.skipped).toContain('MISSING');
  });

  it('서버 시간대 기준으로 시각을 판단한다 (UTC 아님)', () => {
    expect(evalCondition({ field: 'now', op: 'in_window', value: '$env:QUIET_HOURS' }, send('x', at('23:10')), rt).matched).toBe(true);
    expect(evalCondition({ field: 'now', op: 'in_window', value: '$env:QUIET_HOURS' }, send('x', at('14:00')), rt).matched).toBe(false);
  });

  it('필드가 없을 때 neq 는 참, eq 는 거짓', () => {
    const ctx = send('x');
    expect(evalCondition({ field: 'channel', op: 'neq', value: 'telegram' }, ctx, rt).matched).toBe(true);
    expect(evalCondition({ field: 'channel', op: 'eq', value: 'discord' }, ctx, rt).matched).toBe(true);
  });
});

describe('규칙 훅 검증', () => {
  const ok = { name: '야간 발송 보류', event: 'before_send', action: 'ask', conditions: [{ field: 'now', op: 'in_window', value: '22:00-08:00' }], reason: '업무 시간 외 발송은 승인이 필요합니다' };
  const has = () => true;

  it('정상 입력', () => {
    expect(validateRuleHook(ok, has).event).toBe('before_send');
  });

  it('조건이 없으면 거부 (모든 호출에 걸리는 것을 막음)', () => {
    expect(() => validateRuleHook({ ...ok, conditions: [] }, has)).toThrow('조건이 하나 이상 필요');
  });

  it('조건 10개는 통과, 11개는 거부', () => {
    const c = { field: 'text', op: 'contains', value: 'x' };
    expect(() => validateRuleHook({ ...ok, conditions: Array(10).fill(c) }, has)).not.toThrow();
    expect(() => validateRuleHook({ ...ok, conditions: Array(11).fill(c) }, has)).toThrow('10개까지');
  });

  it('이름 40자 통과, 41자 거부 / 문구 200자 통과, 201자 거부', () => {
    expect(() => validateRuleHook({ ...ok, name: 'a'.repeat(40) }, has)).not.toThrow();
    expect(() => validateRuleHook({ ...ok, name: 'a'.repeat(41) }, has)).toThrow('41자');
    expect(() => validateRuleHook({ ...ok, reason: 'a'.repeat(200) }, has)).not.toThrow();
    expect(() => validateRuleHook({ ...ok, reason: 'a'.repeat(201) }, has)).toThrow('201자');
  });

  it('이벤트에서 쓸 수 없는 동작·필드를 정확히 알려준다', () => {
    expect(() => validateRuleHook({ ...ok, event: 'before_tool', action: 'modify' }, has)).toThrow('before_tool 이벤트에서 쓸 수 있는 동작');
    expect(() => validateRuleHook({ ...ok, conditions: [{ field: 'host', op: 'eq', value: 'a' }] }, has)).toThrow("필드 'host'는 before_send 이벤트에 없습니다");
  });

  it('.env 에 없는 변수를 참조하면 저장 단계에서 막는다', () => {
    expect(() => validateRuleHook({ ...ok, conditions: [{ field: 'now', op: 'in_window', value: '$env:NOPE' }] }, () => false)).toThrow('NOPE');
  });

  it('잘못된 정규식은 저장 단계에서 막는다', () => {
    expect(() => validateRuleHook({ ...ok, conditions: [{ field: 'text', op: 'matches', value: '([a-z' }] }, has)).toThrow('정규식');
  });
});

describe('훅 엔진', () => {
  const quiet: RuleHook = { id: 'quiet', name: '야간 발송 보류', event: 'before_send', enabled: true, action: 'ask', conditions: [{ field: 'now', op: 'in_window', value: '22:00-08:00' }, { field: 'target', op: 'neq', value: '#ops' }], reason: '업무 시간 외 발송은 승인이 필요합니다 ({target})', modify: null };
  const mask: RuleHook = { id: 'mask', name: '개인정보 가리기', event: 'before_send', enabled: true, action: 'modify', conditions: [{ field: 'text', op: 'matches', value: '01[016789]-?\\d{3,4}-?\\d{4}' }], reason: '전화번호를 가렸습니다', modify: { find: '(01[016789])-?(\\d{3,4})-?(\\d{4})', replace: '$1-****-$3' } };

  const engine = (rules: RuleHook[]) =>
    new HookEngine({
      guardEnv: { lists: guardsJson, knownSecrets: () => [], selfHosts: [], protectedPaths: [], floodPerMinute: 100, loopRepeat: 5 },
      guardState: new GuardState(),
      rules: () => rules,
      fileHooks: () => [],
      runtime: { env: () => undefined, timeZone: TZ },
    });

  it('기본 금지 조항이 사용자 훅보다 먼저 막는다', () => {
    const out = engine([quiet]).run(send(`sk-ant-api03-${'k'.repeat(30)}`));
    expect(out.decision).toBe('deny');
    expect(out.by).toEqual(['guard:secret-leak']);
  });

  it('조건이 모두 맞을 때만 확인을 요청하고, 문구의 {필드}를 채운다', () => {
    expect(engine([quiet]).run(send('안녕', at('23:10'), '#help'))).toMatchObject({ decision: 'ask', reasons: ['업무 시간 외 발송은 승인이 필요합니다 (#help)'] });
    expect(engine([quiet]).run(send('안녕', at('23:10'), '#ops')).decision).toBe('allow');
    expect(engine([quiet]).run(send('안녕', at('14:00'), '#help')).decision).toBe('allow');
  });

  it('수정 훅은 본문을 바꾸고 바뀐 본문을 돌려준다', () => {
    const out = engine([mask]).run(send('010-1234-5678 또는 01098765432 로 연락', at('14:00')));
    expect(out.decision).toBe('allow');
    expect(out.text).toBe('010-****-5678 또는 010-****-5432 로 연락');
  });

  it('꺼진 훅은 평가하지 않는다', () => {
    expect(engine([{ ...quiet, enabled: false }]).run(send('x', at('23:10'))).decision).toBe('allow');
  });

});

describe('코드 보기 = 같은 동작의 코드 훅', () => {
  const env: Record<string, string> = { QUIET_HOURS: '22:00-08:00', BAD_WORDS: '/욕설|비속어/i', EMPTY_VAR: '   ' };
  const silent = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent } as unknown as Logger;
  const engine = (rules: RuleHook[], files: FileHook[]) =>
    new HookEngine({
      guardEnv: { lists: guardsJson, knownSecrets: () => [], selfHosts: [], protectedPaths: [], floodPerMinute: 100, loopRepeat: 50 },
      guardState: new GuardState(),
      rules: () => rules,
      fileHooks: () => files,
      runtime: { env: (n) => env[n], timeZone: TZ },
    });
  const tool = (over: Partial<ToolCtx>): ToolCtx => ({
    event: 'before_tool',
    agentId: 'a1',
    agentName: '에코',
    taskId: null,
    now: at('23:10'),
    tool: 'http_request',
    category: 'net.fetch',
    input: { url: 'https://api.example.com/v1/items', body: { amount: 5 } },
    workspace: '/w',
    command: null,
    paths: [],
    url: 'https://api.example.com/v1/items',
    host: 'api.example.com',
    method: 'GET',
    text: null,
    ...over,
  });
  const base = { name: '시험', enabled: true, modify: null } as const;
  const rules: RuleHook[] = [
    { ...base, id: 'r-eq', event: 'before_tool', action: 'deny', conditions: [{ field: 'host', op: 'eq', value: 'api.example.com' }], reason: '{host} 로 보내는 요청 차단' },
    { ...base, id: 'r-neq-env-window', event: 'before_send', action: 'ask', conditions: [{ field: 'target', op: 'neq', value: '#ops' }, { field: 'now', op: 'in_window', value: '$env:QUIET_HOURS' }], reason: '야간 발송 ({target})' },
    { ...base, id: 'r-quote', event: 'before_send', action: 'deny', conditions: [{ field: 'text', op: 'contains', value: "it's 'quoted'" }], reason: "따옴표 ' 포함" },
    { ...base, id: 'r-not-contains', event: 'before_send', action: 'log', conditions: [{ field: 'text', op: 'not_contains', value: '안녕' }], reason: '인사 없음' },
    { ...base, id: 'r-starts', event: 'before_tool', action: 'ask', conditions: [{ field: 'command', op: 'starts_with', value: 'git push' }], reason: '푸시 확인' },
    { ...base, id: 'r-slash-form', event: 'before_tool', action: 'deny', conditions: [{ field: 'url', op: 'matches', value: '/^https:\\/\\/API\\.example\\.com\\//i' }], reason: '대소문자 무시 정규식' },
    { ...base, id: 'r-plain-slash', event: 'before_tool', action: 'deny', conditions: [{ field: 'url', op: 'matches', value: 'example.com/v1' }], reason: '슬래시 포함 패턴' },
    { ...base, id: 'r-env-regex', event: 'before_send', action: 'deny', conditions: [{ field: 'text', op: 'not_matches', value: '$env:BAD_WORDS' }, { field: 'target', op: 'eq', value: '#help' }], reason: '욕설 없음' },
    { ...base, id: 'r-not-window', event: 'before_tool', action: 'ask', conditions: [{ field: 'now', op: 'not_in_window', value: '09:00-18:00' }], reason: '업무 시간 밖' },
    { ...base, id: 'r-input-path', event: 'before_tool', action: 'deny', conditions: [{ field: 'input.body.amount', op: 'eq', value: '5' }], reason: '금액 {input.body.amount}' },
    { ...base, id: 'r-env-empty', event: 'before_tool', action: 'deny', conditions: [{ field: 'host', op: 'eq', value: '$env:EMPTY_VAR' }], reason: '빈 환경 변수' },
    { ...base, id: 'r-backslash', event: 'before_tool', action: 'deny', conditions: [{ field: 'path', op: 'contains', value: 'C:\\Users' }], reason: '윈도 경로' },
    { ...base, id: 'r-null-field', event: 'before_tool', action: 'deny', conditions: [{ field: 'command', op: 'not_matches', value: '^ls' }], reason: '명령 없음도 통과' },
    {
      ...base,
      id: 'r-modify',
      event: 'before_send',
      action: 'modify',
      conditions: [{ field: 'text', op: 'contains', value: '010' }],
      reason: '전화번호를 가렸습니다',
      modify: { find: '(01[016789])-?(\\d{3,4})-?(\\d{4})', replace: '$1-****-$3' },
    },
  ];
  const ctxs: HookCtx[] = [
    tool({}),
    tool({ now: at('10:00'), host: 'other.example.org', url: 'https://other.example.org/x', input: {} }),
    tool({ tool: 'shell_exec', category: 'shell.exec', command: 'git push origin main', host: null, url: null, input: { command: 'git push origin main' } }),
    tool({ tool: 'shell_exec', category: 'shell.exec', command: 'ls -al', host: null, url: null, now: at('17:59') }),
    tool({ tool: 'fs_read', category: 'fs.read', paths: ['C:\\Users\\me\\a.txt'], host: null, url: null, now: at('18:00') }),
    tool({ url: 'https://API.EXAMPLE.COM/v2', host: 'API.EXAMPLE.COM', input: { body: { amount: 50 } } }),
    send('안녕하세요', at('23:10'), '#help'),
    send('비속어 섞인 문장', at('23:10'), '#help'),
    send("it's 'quoted' text", at('07:59'), '#ops'),
    send('010-1234-5678 로 연락', at('08:00'), '#help'),
    send('', at('21:59'), '#help'),
  ];

  it('모든 연산자에서 규칙 훅과 코드로 옮긴 훅의 결정 · 문구 · 수정 결과가 같다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hook-code-'));
    try {
      for (const r of rules) fs.writeFileSync(path.join(dir, `${r.id}.mjs`), renderHookCode(r));
      const { hooks, errors } = await loadFileHooks(dir, silent);
      expect(errors).toEqual([]);
      expect(hooks).toHaveLength(rules.length);
      let matchedAny = 0;
      for (const r of rules) {
        const fh = hooks.find((h) => h.id === r.id) as FileHook;
        for (const ctx of ctxs) {
          const a = engine([r], []).run(ctx);
          const b = engine([], [fh]).run(ctx);
          expect({ id: r.id, at: ctx.now.toISOString(), decision: b.decision, reasons: b.reasons, text: b.text }).toEqual({ id: r.id, at: ctx.now.toISOString(), decision: a.decision, reasons: a.reasons, text: a.text });
          if (a.decision !== 'allow' || a.text !== undefined || a.logs.length > 0) matchedAny += 1;
        }
      }
      // 모든 비교가 '아무 일도 없음'끼리 같은 것이 아님을 확인 (시험 자체가 비어 있지 않도록)
      expect(matchedAny).toBeGreaterThan(rules.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('꺼진 규칙은 코드에서도 enabled: false 로 나온다', () => {
    expect(renderHookCode({ ...rules[0]!, enabled: false })).toContain('enabled: false');
    expect(renderHookCode(rules[0]!)).not.toContain('enabled');
  });
});
