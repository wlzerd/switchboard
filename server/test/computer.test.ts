import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ACTIONS,
  DEFAULT_MAX_EDGE,
  MAX_PIXELS,
  TYPE_MAX,
  failsafeHit,
  fitInto,
  fitSize,
  fromScreen,
  geometry,
  macKey,
  macRequest,
  modifierName,
  normalizeKey,
  parseCombo,
  parseDisplayGeometry,
  parseModifiers,
  parseMouseLocation,
  parseSettings,
  parseSipsSize,
  toScreen,
  validateAction,
  xdotoolArgs,
} from '../../modules/computer/lib.js';
import { makeComputer } from '../../modules/computer/index.js';
import { COMPUTER_ACTIONS, ScreenLocks, saveScreenshot, screenSummary, screenTimeoutMs, typedText } from '../src/agents/screen.ts';
import { findCardNumber } from '../src/guards/secrets.ts';

const geo = geometry(1440, 900, DEFAULT_MAX_EDGE);
const errOf = (fn: () => unknown): string => {
  try {
    fn();
    return '';
  } catch (err) {
    return (err as Error).message;
  }
};

describe('스크린샷 크기', () => {
  it('긴 변 한도와 전체 픽셀 한도 중 더 작은 쪽에 맞추고, 작은 화면은 키우지 않습니다', () => {
    expect(fitSize(1024, 768, 1568)).toEqual({ w: 1024, h: 768 });
    // 1440×900 = 1.296MP → 1.15MP 한도로 줄어듦
    const s = fitSize(1440, 900, 1568);
    expect(s.w * s.h).toBeLessThanOrEqual(MAX_PIXELS);
    expect(s.w / s.h).toBeCloseTo(1440 / 900, 2);
    // 긴 변 한도가 먼저 걸리는 가로로 긴 화면
    expect(fitSize(4000, 400, 1568).w).toBe(1568);
  });

  it('한도 경계: 정확히 한도면 그대로, 1px 넘으면 줄입니다', () => {
    expect(fitSize(1000, 1150, 1568, 1_150_000)).toEqual({ w: 1000, h: 1150 });
    expect(fitSize(1001, 1150, 1568, 1_150_000).w).toBeLessThan(1001);
    expect(fitSize(1568, 100, 1568)).toEqual({ w: 1568, h: 100 });
    expect(fitSize(1569, 100, 1568).w).toBe(1568);
  });

  it('크기를 모르면 거절', () => {
    expect(errOf(() => fitSize(0, 900, 1568))).toContain('화면 크기를 알 수 없습니다');
    expect(errOf(() => fitSize(Number.NaN, 900, 1568))).toContain('화면 크기를 알 수 없습니다');
  });

  it('확대 이미지는 평소 스크린샷 크기 안에, 작으면 원래 해상도 그대로', () => {
    expect(fitInto(400, 200, 1356, 847)).toEqual({ w: 400, h: 200 });
    expect(fitInto(2880, 1800, 1356, 847)).toEqual({ w: 1355, h: 847 });
  });

  it('COMPUTER_MAX_EDGE 경계: 640~2000', () => {
    expect(parseSettings({}).maxEdge).toBe(DEFAULT_MAX_EDGE);
    expect(parseSettings({ COMPUTER_MAX_EDGE: '640' }).maxEdge).toBe(640);
    expect(parseSettings({ COMPUTER_MAX_EDGE: '2000' }).maxEdge).toBe(2000);
    expect(errOf(() => parseSettings({ COMPUTER_MAX_EDGE: '639' }))).toContain('640~2000');
    expect(errOf(() => parseSettings({ COMPUTER_MAX_EDGE: '2001' }))).toContain('640~2000');
    expect(errOf(() => parseSettings({ COMPUTER_MAX_EDGE: '1.5k' }))).toContain('정수가 아닙니다');
  });
});

describe('좌표 바꾸기', () => {
  it('스크린샷 → 화면 → 스크린샷이 1px 안에서 돌아옵니다', () => {
    for (const [x, y] of [[0, 0], [100, 50], [geo.shot.w - 1, geo.shot.h - 1]] as const) {
      const [sx, sy] = toScreen(x, y, geo) as [number, number];
      const [bx, by] = fromScreen(sx, sy, geo) as [number, number];
      expect(Math.abs(bx - x)).toBeLessThanOrEqual(1);
      expect(Math.abs(by - y)).toBeLessThanOrEqual(1);
    }
  });

  it('스크린샷 오른쪽 아래 끝도 화면 안(최대 w-1, h-1)으로 갑니다', () => {
    const [x, y] = toScreen(geo.shot.w - 1, geo.shot.h - 1, geo);
    expect(x).toBeLessThanOrEqual(geo.screen.w - 1);
    expect(y).toBeLessThanOrEqual(geo.screen.h - 1);
  });

  it('비상 정지 모서리 경계: (2,2)까지 정지, (3,0) · (0,3)은 아님', () => {
    expect(failsafeHit(0, 0)).toBe(true);
    expect(failsafeHit(2, 2)).toBe(true);
    expect(failsafeHit(2.5, 0)).toBe(false);
    expect(failsafeHit(3, 0)).toBe(false);
    expect(failsafeHit(0, 3)).toBe(false);
  });
});

describe('동작 검사', () => {
  it('17가지 동작 이름이 서버와 모듈에서 같습니다', () => {
    expect([...COMPUTER_ACTIONS].sort()).toEqual([...ACTIONS].sort());
    expect(ACTIONS).toHaveLength(17);
  });

  it('좌표 경계: 스크린샷 안(0 ~ w-1)만, 밖이면 크기를 알려 줍니다', () => {
    expect(validateAction('left_click', { coordinate: [0, 0] }, geo)).toMatchObject({ kind: 'click', at: [0, 0] });
    expect(validateAction('mouse_move', { coordinate: [geo.shot.w - 1, geo.shot.h - 1] }, geo).kind).toBe('move');
    expect(errOf(() => validateAction('mouse_move', { coordinate: [geo.shot.w, 0] }, geo))).toContain(`0~${geo.shot.w - 1}`);
    expect(errOf(() => validateAction('mouse_move', { coordinate: [-1, 0] }, geo))).toContain('범위');
    expect(errOf(() => validateAction('mouse_move', { coordinate: [1] }, geo))).toContain('[x, y]');
    expect(errOf(() => validateAction('mouse_move', { coordinate: ['1', 2] }, geo))).toContain('숫자');
  });

  it('클릭은 좌표가 없으면 지금 위치, 횟수와 버튼은 동작 이름대로', () => {
    expect(validateAction('left_click', {}, geo)).toEqual({ kind: 'click', button: 'left', count: 1, at: null, mods: [] });
    expect(validateAction('double_click', {}, geo)).toMatchObject({ button: 'left', count: 2 });
    expect(validateAction('triple_click', {}, geo)).toMatchObject({ count: 3 });
    expect(validateAction('right_click', {}, geo)).toMatchObject({ button: 'right', count: 1 });
    expect(validateAction('middle_click', {}, geo)).toMatchObject({ button: 'middle' });
    expect(validateAction('left_click', { text: 'cmd+shift' }, geo).mods).toEqual(['super', 'shift']);
    expect(errOf(() => validateAction('left_click', { text: 'ctrl+a' }, geo))).toContain('shift · ctrl · alt · super 뿐');
  });

  it('확대 영역은 왼쪽 위 → 오른쪽 아래, 스크린샷 안 (끝 좌표는 너비와 같아도 됨)', () => {
    expect(validateAction('zoom', { region: [0, 0, geo.shot.w, geo.shot.h] }, geo).kind).toBe('zoom');
    expect(errOf(() => validateAction('zoom', { region: [10, 10, 10, 20] }, geo))).toContain('왼쪽 위 → 오른쪽 아래');
    expect(errOf(() => validateAction('zoom', { region: [0, 0, geo.shot.w + 1, 10] }, geo))).toContain('안의');
    expect(errOf(() => validateAction('zoom', { region: [0, 0, 10] }, geo))).toContain('[x0, y0, x1, y1]');
  });

  it('스크롤: 방향 넷, 양 1~100 (기본 3)', () => {
    expect(validateAction('scroll', { scroll_direction: 'down' }, geo)).toMatchObject({ dir: 'down', amount: 3, at: null });
    expect(validateAction('scroll', { scroll_direction: 'up', scroll_amount: 100 }, geo).amount).toBe(100);
    expect(errOf(() => validateAction('scroll', { scroll_direction: 'up', scroll_amount: 0 }, geo))).toContain('1~100');
    expect(errOf(() => validateAction('scroll', { scroll_direction: 'up', scroll_amount: 101 }, geo))).toContain('1~100');
    expect(errOf(() => validateAction('scroll', { scroll_direction: 'sideways' }, geo))).toContain('up · down · left · right');
  });

  it('글자 입력 경계: 빈 글자는 거절, 최대 길이까지', () => {
    expect(validateAction('type', { text: '안녕하세요' }, geo)).toEqual({ kind: 'type', text: '안녕하세요' });
    expect(validateAction('type', { text: 'x'.repeat(TYPE_MAX) }, geo).kind).toBe('type');
    expect(errOf(() => validateAction('type', { text: 'x'.repeat(TYPE_MAX + 1) }, geo))).toContain('까지 입력');
    expect(errOf(() => validateAction('type', { text: '' }, geo))).toContain('비어');
  });

  it('키 · 반복 · 누르고 있기 · 기다리기 경계', () => {
    expect(validateAction('key', { text: 'Return' }, geo)).toMatchObject({ key: 'Return', repeat: 1 });
    expect(validateAction('key', { text: 'Page_Down', repeat: 100 }, geo).repeat).toBe(100);
    expect(errOf(() => validateAction('key', { text: 'a', repeat: 101 }, geo))).toContain('1~100');
    expect(errOf(() => validateAction('key', { text: 'a', repeat: 1.5 }, geo))).toContain('정수');
    expect(validateAction('hold_key', { text: 'shift', duration: 300 }, geo)).toMatchObject({ mods: ['shift'], key: null, duration: 300 });
    expect(errOf(() => validateAction('hold_key', { text: 'shift', duration: 300.5 }, geo))).toContain('300초 이하');
    expect(errOf(() => validateAction('wait', { duration: 0 }, geo))).toContain('0초보다 크고');
    expect(validateAction('wait', { duration: 0.1 }, geo).kind).toBe('wait');
  });

  it('모르는 동작은 쓸 수 있는 동작을 알려 주며 거절', () => {
    expect(errOf(() => validateAction('teleport', {}, geo))).toContain('쓸 수 있는 동작');
  });
});

describe('키 조합', () => {
  it('조합 키 이름은 여러 표기를 받습니다 (_L/_R, cmd, option)', () => {
    expect(modifierName('Control_L')).toBe('ctrl');
    expect(modifierName('Shift_R')).toBe('shift');
    expect(modifierName('cmd')).toBe('super');
    expect(modifierName('option')).toBe('alt');
    expect(modifierName('a')).toBeNull();
  });

  it("'+' 키 자체와 대소문자 · 별칭", () => {
    expect(parseCombo('ctrl++')).toMatchObject({ mods: ['ctrl'], key: 'plus' });
    expect(parseCombo('+')).toMatchObject({ mods: [], key: 'plus' });
    expect(parseCombo('CTRL+S')).toMatchObject({ mods: ['ctrl'], key: 's' });
    expect(parseCombo('alt+Tab')).toMatchObject({ mods: ['alt'], key: 'Tab' });
    expect(parseCombo('enter').key).toBe('Return');
    expect(parseCombo('f12').key).toBe('F12');
    expect(parseCombo('ctrl+shift+ctrl')).toMatchObject({ mods: ['ctrl', 'shift'], key: null });
  });

  it('잘못된 조합은 무엇이 틀렸는지 알려 줍니다', () => {
    expect(errOf(() => parseCombo('a+b'))).toContain('일반 키가 둘 이상');
    expect(errOf(() => parseCombo('ctrl+'))).toContain('빈 칸');
    expect(errOf(() => parseCombo(''))).toContain('비어');
    expect(errOf(() => parseCombo('ctrl+!?'))).toContain("알 수 없는 키 이름 '!?'");
    // X11 키 이름(keysym)은 그대로 넘깁니다.
    expect(parseCombo('XF86AudioMute')).toMatchObject({ key: 'XF86AudioMute', known: false });
  });

  it('normalizeKey: 한 글자는 소문자, F1~F24, 모르는 이름은 known=false', () => {
    expect(normalizeKey('A')).toEqual({ key: 'a', known: true });
    expect(normalizeKey('f24')).toEqual({ key: 'F24', known: true });
    expect(normalizeKey('f25')).toEqual({ key: 'f25', known: false });
    expect(normalizeKey('Prior')).toEqual({ key: 'Page_Up', known: true });
  });

  it('parseModifiers: 비우면 없음', () => {
    expect(parseModifiers(undefined)).toEqual([]);
    expect(parseModifiers('')).toEqual([]);
  });
});

describe('macOS 요청', () => {
  it('키는 자판 배열과 무관한 키 코드로, + 는 shift 를 함께', () => {
    expect(macKey('a')).toEqual({ code: 0, shift: false });
    expect(macKey('Return')).toEqual({ code: 36, shift: false });
    expect(macKey('plus')).toEqual({ code: 24, shift: true });
    expect(macKey('XF86AudioMute')).toBeNull();
    expect(macRequest({ kind: 'key', mods: ['ctrl'], key: 'plus', known: true, repeat: 2 })).toEqual({ op: 'key', mods: ['ctrl', 'shift'], code: 24, repeat: 2 });
    expect(errOf(() => macRequest({ kind: 'key', mods: [], key: 'XF86AudioMute', known: false, repeat: 1 }))).toContain('macOS 에서 쓸 수 없는 키');
  });

  it('스크롤 방향 부호: 위 · 왼쪽은 +, 아래 · 오른쪽은 -', () => {
    expect(macRequest({ kind: 'scroll', dir: 'up', amount: 2, at: null, mods: [] })).toMatchObject({ dy: 3, dx: 0, amount: 2 });
    expect(macRequest({ kind: 'scroll', dir: 'down', amount: 2, at: null, mods: [] })).toMatchObject({ dy: -3, dx: 0 });
    expect(macRequest({ kind: 'scroll', dir: 'right', amount: 1, at: [5, 6], mods: [] })).toMatchObject({ dx: -3, dy: 0, x: 5, y: 6 });
  });

  it('sips 크기 출력 읽기', () => {
    expect(parseSipsSize('/tmp/a.png\n  pixelWidth: 2880\n  pixelHeight: 1800\n')).toEqual({ w: 2880, h: 1800 });
    expect(errOf(() => parseSipsSize('Error 13'))).toContain('이미지 크기를 읽지 못했습니다');
  });
});

describe('X11(xdotool) 요청', () => {
  it('클릭은 이동 → 조합 키 누름 → 클릭 → 뗌 순서로 한 번에', () => {
    expect(xdotoolArgs({ kind: 'click', button: 'right', count: 1, at: [10, 20], mods: ['ctrl', 'shift'] })).toEqual([
      'mousemove', '--sync', '10', '20', 'keydown', 'ctrl', 'keydown', 'shift', 'click', '--repeat', '1', '--delay', '80', '3', 'keyup', 'shift', 'keyup', 'ctrl',
    ]);
  });

  it('스크롤 버튼 4·5·6·7, 키 조합과 글자 입력은 -- 뒤에 (글자가 - 로 시작해도 옵션으로 읽히지 않게)', () => {
    expect(xdotoolArgs({ kind: 'scroll', dir: 'left', amount: 3, at: null, mods: [] })).toEqual(['click', '--repeat', '3', '--delay', '30', '6']);
    expect(xdotoolArgs({ kind: 'key', mods: ['ctrl'], key: 's', known: true, repeat: 1 })).toEqual(['key', '--repeat', '1', '--delay', '30', '--', 'ctrl+s']);
    expect(xdotoolArgs({ kind: 'type', text: '--help 안녕' })).toEqual(['type', '--delay', '12', '--', '--help 안녕']);
    expect(xdotoolArgs({ kind: 'hold', mods: ['shift'], key: null, known: true, duration: 2 })).toEqual(['keydown', 'shift', 'sleep', '2', 'keyup', 'shift']);
  });

  it('위치 · 화면 크기 출력 읽기', () => {
    expect(parseMouseLocation('X=123\nY=456\nSCREEN=0\nWINDOW=1')).toEqual([123, 456]);
    expect(parseDisplayGeometry('1920 1080\n')).toEqual({ w: 1920, h: 1080 });
    expect(errOf(() => parseDisplayGeometry('Error: Can\'t open display'))).toContain('화면 크기를 읽지 못했습니다');
  });
});

describe('모듈 흐름 (가짜 운영체제)', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-computer-'));
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const make = (over: Record<string, unknown> = {}) => {
    const calls: { op: string; arg?: unknown }[] = [];
    let screen = { w: 1440, h: 900 };
    let cursorAt: [number, number] = [500, 500];
    const backend = {
      check: async () => {},
      screenSize: async () => screen,
      cursor: async () => cursorAt,
      screenshot: async (_c: unknown, g: { shot: { w: number; h: number } }) => {
        calls.push({ op: 'screenshot', arg: g.shot });
        return { data: 'AA==', mediaType: 'image/jpeg' };
      },
      zoom: async (_c: unknown, _g: unknown, rect: unknown) => {
        calls.push({ op: 'zoom', arg: rect });
        return { data: 'AA==', mediaType: 'image/jpeg' };
      },
      act: async (_c: unknown, req: { kind: string }) => {
        if (failsafeHit(cursorAt[0], cursorAt[1])) {
          const e = new Error('stop');
          e.name = 'ComputerStopped';
          throw e;
        }
        calls.push({ op: req.kind, arg: req });
      },
      ...over,
    };
    const mod = makeComputer(() => backend);
    const ctx = { env: {}, dataDir, log: { info: () => {}, warn: () => {}, error: () => {} } };
    return { mod, ctx, calls, setScreen: (w: number, h: number) => (screen = { w, h }), setCursor: (x: number, y: number) => (cursorAt = [x, y]) };
  };

  it('스크린샷을 볼 때마다 화면 크기를 다시 재서 그 기준으로 좌표를 바꿉니다', async () => {
    const t = make();
    await t.mod.activate(t.ctx);
    await t.mod.computer.run('screenshot', {});
    t.setScreen(2880, 1800);
    await t.mod.computer.run('screenshot', {});
    const shots = t.calls.filter((c) => c.op === 'screenshot').map((c) => c.arg as { w: number; h: number });
    expect(shots[1]!.w).toBeGreaterThanOrEqual(shots[0]!.w);
    await t.mod.computer.run('left_click', { coordinate: [shots[1]!.w - 1, shots[1]!.h - 1] });
    const click = t.calls.find((c) => c.op === 'click')!.arg as { at: [number, number] };
    expect(click.at[0]).toBeGreaterThan(2700);
  });

  it('cursor_position 은 스크린샷 좌표로, 결과 글자는 X=…,Y=…', async () => {
    const t = make();
    await t.mod.activate(t.ctx);
    t.setCursor(1439, 899);
    const r = await t.mod.computer.run('cursor_position', {});
    expect(r.text).toMatch(/^X=\d+,Y=\d+$/);
  });

  it('입력이 틀리면 운영체제에 아무것도 보내지 않습니다', async () => {
    const t = make();
    await t.mod.activate(t.ctx);
    await expect(t.mod.computer.run('left_click', { coordinate: [99_999, 0] })).rejects.toThrow('범위');
    await expect(t.mod.computer.run('fly', {})).rejects.toThrow('알 수 없는 화면 동작');
    expect(t.calls).toEqual([]);
  });

  it('마우스가 왼쪽 위 모서리에 있으면 입력 동작을 멈춥니다 (화면 보기는 계속 됨)', async () => {
    const t = make();
    await t.mod.activate(t.ctx);
    t.setCursor(0, 0);
    await expect(t.mod.computer.run('key', { text: 'Return' })).rejects.toMatchObject({ name: 'ComputerStopped' });
    await expect(t.mod.computer.run('screenshot', {})).resolves.toMatchObject({ image: { mediaType: 'image/jpeg' } });
  });

  it('운영체제 검사가 실패하면 시작하지 않습니다 (이유 그대로)', async () => {
    const t = make({ check: async () => Promise.reject(new Error('macOS 손쉬운 사용 권한이 없어')) });
    await expect(t.mod.activate(t.ctx)).rejects.toThrow('손쉬운 사용');
  });
});

describe('서버 쪽 화면 규칙', () => {
  it('요약 · 입력 글자 · 제한 시간', () => {
    expect(screenSummary('left_click', { coordinate: [10, 20], text: 'cmd' })).toBe('클릭 (10, 20) + cmd');
    expect(screenSummary('left_click', {})).toBe('클릭 (지금 위치)');
    expect(screenSummary('type', { text: 'x'.repeat(50) })).toBe(`입력 "${'x'.repeat(40)}…"`);
    expect(screenSummary('scroll', { scroll_direction: 'down' })).toBe('스크롤 아래 3');
    expect(typedText('type', { text: '비밀' })).toBe('비밀');
    expect(typedText('left_click', { text: 'cmd' })).toBeNull();
    expect(screenTimeoutMs('wait', { duration: 300 })).toBe(330_000);
    expect(screenTimeoutMs('wait', { duration: 9999 })).toBe(330_000);
    expect(screenTimeoutMs('screenshot', {})).toBe(30_000);
  });

  it('카드 번호(Luhn)는 13~19자리만, 공백 · 하이픈 구분도 찾습니다', () => {
    expect(findCardNumber('4111 1111 1111 1111')).toBe('4111…1111');
    expect(findCardNumber('카드 5555-5555-5555-4444 로 결제')).toBe('5555…4444');
    expect(findCardNumber('4111 1111 1111 1112')).toBeNull();
    // 길이 경계: Luhn 을 통과하는 12자리는 카드로 보지 않고, 13자리부터 봅니다.
    expect(findCardNumber('411111111117')).toBeNull();
    expect(findCardNumber('4111111111119')).toBe('4111…1119');
    expect(findCardNumber('전화 010-1234-5678')).toBeNull();
  });

  it('화면 잠금: 같은 작업은 다시 잡아도 되고, 다른 작업은 거절, 작업이 끝나면 풀림', () => {
    const locks = new ScreenLocks();
    expect(locks.acquire('computer', { taskId: 't1', agentId: 'a', agentName: '가' })).toEqual({ ok: true });
    expect(locks.acquire('computer', { taskId: 't1', agentId: 'a', agentName: '가' })).toEqual({ ok: true });
    const busy = locks.acquire('computer', { taskId: 't2', agentId: 'b', agentName: '나' });
    expect(busy).toMatchObject({ ok: false, holder: { agentName: '가' } });
    expect(locks.releaseTask('t2')).toEqual([]);
    expect(locks.releaseTask('t1')).toEqual(['computer']);
    expect(locks.acquire('computer', { taskId: 't2', agentId: 'b', agentName: '나' })).toEqual({ ok: true });
  });

  it('스크린샷 보관: 오래된 것부터 지워 정한 개수만 남깁니다', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-screens-'));
    try {
      const names: string[] = [];
      for (let i = 0; i < 5; i += 1) names.push(saveScreenshot(root, 'agt_1', 'tsk_1', { data: 'AA==', mediaType: 'image/jpeg' }, 1_760_000_000_000 + i, 3));
      expect(fs.readdirSync(path.join(root, 'agt_1')).sort()).toEqual(names.slice(2).map((n) => n.split('/')[1]).sort());
      // 같은 시각에 두 번 저장해도 덮어쓰지 않습니다.
      const a = saveScreenshot(root, 'agt_1', 'tsk_1', { data: 'AA==', mediaType: 'image/jpeg' }, 1, 10);
      const b = saveScreenshot(root, 'agt_1', 'tsk_1', { data: 'AA==', mediaType: 'image/jpeg' }, 1, 10);
      expect(a).not.toBe(b);
      expect(() => saveScreenshot(root, '../x', 't', { data: 'AA==', mediaType: 'image/jpeg' })).toThrow('에이전트 id');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
