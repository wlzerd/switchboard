// 화면 제어 모듈의 순수 함수들. 운영체제 명령 없이 시험할 수 있도록 index.js · mac.js · linux.js 에서 떼어 놓았습니다.
// 모든 함수는 재귀 없이 동작합니다.

/** Claude 컴퓨터 사용 도구 묶음(computer_toolset_20260801)의 동작 17가지 */
export const ACTIONS = [
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'cursor_position',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
];

/** 마우스 · 키보드를 실제로 움직이는 동작 (실행 전에 비상 정지 모서리를 확인) */
export const INPUT_ACTIONS = new Set(['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag', 'mouse_move', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key']);

export const DEFAULT_MAX_EDGE = 1568;
export const MAX_EDGE_MIN = 640;
/** 한 요청에 이미지가 20장을 넘으면 한 변 2000px 이하만 받으므로 그 안에서 고릅니다 */
export const MAX_EDGE_MAX = 2000;
/** 이전 모델까지 고려한 전체 픽셀 한도 (약 1.15MP) */
export const MAX_PIXELS = 1_150_000;
export const DURATION_MAX = 300;
export const REPEAT_MAX = 100;
export const SCROLL_MAX = 100;
export const TYPE_MAX = 10_000;
/** 스크롤 휠 한 번에 움직일 줄 수 (macOS) */
export const LINES_PER_CLICK = 3;
/** 마우스를 이 좌표 안(왼쪽 위 모서리)으로 옮기면 화면 제어를 멈춥니다 */
export const FAILSAFE_PX = 2;

/** 사용자가 마우스를 왼쪽 위 모서리로 옮겨 멈춘 경우. 서버는 이 이름을 보고 작업을 끝냅니다. */
export class ComputerStopped extends Error {
  constructor(message) {
    super(message);
    this.name = 'ComputerStopped';
  }
}

export const STOP_MESSAGE = '사용자가 마우스를 화면 왼쪽 위 모서리로 옮겨 화면 제어를 멈췄습니다.';

/** @param {Record<string, string | undefined>} env */
export function parseSettings(env) {
  const raw = (env.COMPUTER_MAX_EDGE ?? '').trim();
  if (raw === '') return { maxEdge: DEFAULT_MAX_EDGE };
  if (!/^\d+$/.test(raw)) throw new Error(`COMPUTER_MAX_EDGE 값 '${raw}'은(는) 정수가 아닙니다. ${MAX_EDGE_MIN}~${MAX_EDGE_MAX} 사이로 넣으세요.`);
  const maxEdge = Number(raw);
  if (maxEdge < MAX_EDGE_MIN || maxEdge > MAX_EDGE_MAX) {
    throw new Error(`COMPUTER_MAX_EDGE 값 ${maxEdge}은(는) ${MAX_EDGE_MIN}~${MAX_EDGE_MAX} 사이여야 합니다 (모델이 받는 이미지 한도).`);
  }
  return { maxEdge };
}

/**
 * 스크린샷 크기: 긴 변은 maxEdge, 전체 픽셀은 maxPixels 를 넘지 않게 비율을 지켜 줄입니다 (키우지는 않음).
 * @param {number} w @param {number} h @param {number} maxEdge @param {number} [maxPixels]
 */
export function fitSize(w, h, maxEdge, maxPixels = MAX_PIXELS) {
  if (!(Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0)) throw new Error(`화면 크기를 알 수 없습니다 (${w}×${h}).`);
  const s = Math.min(1, maxEdge / Math.max(w, h), Math.sqrt(maxPixels / (w * h)));
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) };
}

/** 확대(zoom) 이미지: 평소 스크린샷 크기 안에 비율을 지켜 들어가게 줄입니다 (작으면 원래 해상도 그대로). */
export function fitInto(w, h, boxW, boxH) {
  const s = Math.min(1, boxW / w, boxH / h);
  return { w: Math.max(1, Math.floor(w * s)), h: Math.max(1, Math.floor(h * s)) };
}

/**
 * 화면 크기(운영체제 좌표: macOS 는 포인트, X11 은 픽셀) → 모델이 보는 스크린샷 좌표계.
 * 레티나 화면도 포인트 기준으로 줄이므로 따로 2배 보정하지 않습니다.
 */
export function geometry(screenW, screenH, maxEdge) {
  const shot = fitSize(screenW, screenH, maxEdge);
  return { screen: { w: screenW, h: screenH }, shot, sx: screenW / shot.w, sy: screenH / shot.h };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 스크린샷 좌표 → 운영체제 좌표 */
export function toScreen(x, y, geo) {
  return [clamp(Math.round(x * geo.sx), 0, geo.screen.w - 1), clamp(Math.round(y * geo.sy), 0, geo.screen.h - 1)];
}

/** 운영체제 좌표 → 스크린샷 좌표 (cursor_position 결과) */
export function fromScreen(x, y, geo) {
  return [clamp(Math.round(x / geo.sx), 0, geo.shot.w - 1), clamp(Math.round(y / geo.sy), 0, geo.shot.h - 1)];
}

export function failsafeHit(x, y) {
  return x <= FAILSAFE_PX && y <= FAILSAFE_PX;
}

const MODIFIERS = {
  shift: 'shift',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  super: 'super',
  cmd: 'super',
  command: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super',
};

/** 'Control_L' · 'cmd' 같은 이름 → shift · ctrl · alt · super, 조합 키가 아니면 null */
export function modifierName(token) {
  const t = String(token).toLowerCase().replace(/_[lr]$/, '');
  return Object.hasOwn(MODIFIERS, t) ? MODIFIERS[t] : null;
}

/** '+' 로 나눕니다. '+' 키 자체('+' · 'ctrl++')도 처리합니다. */
function splitCombo(raw) {
  if (raw === '+') return ['+'];
  if (raw.endsWith('++')) return [...raw.slice(0, -2).split('+'), '+'];
  return raw.split('+');
}

const KEY_ALIASES = {
  return: 'Return',
  enter: 'Return',
  kp_enter: 'KP_Enter',
  tab: 'Tab',
  space: 'space',
  ' ': 'space',
  backspace: 'BackSpace',
  back_space: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  escape: 'Escape',
  esc: 'Escape',
  home: 'Home',
  end: 'End',
  page_up: 'Page_Up',
  pageup: 'Page_Up',
  prior: 'Page_Up',
  page_down: 'Page_Down',
  pagedown: 'Page_Down',
  next: 'Page_Down',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  insert: 'Insert',
  caps_lock: 'Caps_Lock',
  capslock: 'Caps_Lock',
  minus: 'minus',
  '-': 'minus',
  equal: 'equal',
  '=': 'equal',
  plus: 'plus',
  '+': 'plus',
  comma: 'comma',
  ',': 'comma',
  period: 'period',
  '.': 'period',
  slash: 'slash',
  '/': 'slash',
  backslash: 'backslash',
  '\\': 'backslash',
  semicolon: 'semicolon',
  ';': 'semicolon',
  apostrophe: 'apostrophe',
  "'": 'apostrophe',
  grave: 'grave',
  '`': 'grave',
  bracketleft: 'bracketleft',
  '[': 'bracketleft',
  bracketright: 'bracketright',
  ']': 'bracketright',
};

/**
 * 키 이름을 표준 이름(xdotool keysym)으로. 모르는 이름은 known=false 로 그대로 돌려줍니다
 * (X11 은 그대로 넘기고, macOS 는 키 코드가 없으면 거절).
 */
export function normalizeKey(name) {
  const n = String(name);
  if (/^f([1-9]|1\d|2[0-4])$/i.test(n)) return { key: n.toUpperCase(), known: true };
  if (/^[a-z0-9]$/i.test(n)) return { key: n.toLowerCase(), known: true };
  const lower = n.toLowerCase();
  if (Object.hasOwn(KEY_ALIASES, lower)) return { key: KEY_ALIASES[lower], known: true };
  if (Object.hasOwn(KEY_ALIASES, n)) return { key: KEY_ALIASES[n], known: true };
  return { key: n, known: false };
}

/**
 * 'ctrl+shift+s' → { mods: ['ctrl', 'shift'], key: 's' }. 조합 키만 있는 'shift' 는 key=null.
 * 일반 키가 둘 이상이거나 빈 칸이 있으면 무엇이 틀렸는지 알려 줍니다.
 */
export function parseCombo(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('키 이름(text)이 비어 있습니다. 예: "Return", "ctrl+s".');
  const raw = text.trim();
  if (raw.length > 100) throw new Error('키 조합이 너무 깁니다 (100자까지).');
  const mods = [];
  let key = null;
  for (const part of splitCombo(raw)) {
    const p = part.trim();
    if (p === '') throw new Error(`키 조합 '${raw}'에 빈 칸이 있습니다. '+' 사이에 키 이름을 넣으세요.`);
    const mod = modifierName(p);
    if (mod !== null) {
      if (!mods.includes(mod)) mods.push(mod);
      continue;
    }
    if (key !== null) throw new Error(`키 조합 '${raw}'에 일반 키가 둘 이상입니다. 한 번에 하나만 누를 수 있습니다.`);
    const k = normalizeKey(p);
    if (!k.known && !/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k.key)) throw new Error(`알 수 없는 키 이름 '${p}'입니다.`);
    key = k;
  }
  return { mods, key: key ? key.key : null, known: key ? key.known : true };
}

/** 클릭 · 스크롤과 함께 누르는 조합 키 (text). 일반 키가 섞이면 거절합니다. */
export function parseModifiers(text) {
  if (text === undefined || text === null || text === '') return [];
  const c = parseCombo(text);
  if (c.key !== null) throw new Error(`'${text}': 클릭 · 스크롤과 함께 누를 수 있는 것은 shift · ctrl · alt · super 뿐입니다.`);
  return c.mods;
}

function numberField(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} 은(는) 숫자여야 합니다. 받은 값: ${JSON.stringify(v)}`);
  return v;
}

/** 스크린샷 좌표 검사 후 운영체제 좌표로. 스크린샷 밖이면 크기를 알려 주며 거절합니다. */
function point(v, name, geo) {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${name} 은(는) [x, y] 형태여야 합니다. 받은 값: ${JSON.stringify(v)}`);
  const x = numberField(v[0], `${name}[0]`);
  const y = numberField(v[1], `${name}[1]`);
  if (x < 0 || y < 0 || x > geo.shot.w - 1 || y > geo.shot.h - 1) {
    throw new Error(`${name} (${x}, ${y})가 스크린샷 범위(0~${geo.shot.w - 1}, 0~${geo.shot.h - 1}) 밖입니다.`);
  }
  return toScreen(x, y, geo);
}

function duration(v, name) {
  const d = numberField(v, name);
  if (d <= 0 || d > DURATION_MAX) throw new Error(`${name} 은(는) 0초보다 크고 ${DURATION_MAX}초 이하여야 합니다. 받은 값: ${d}`);
  return d;
}

function intRange(v, name, min, max, fallback) {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`${name} 은(는) ${min}~${max} 사이의 정수여야 합니다. 받은 값: ${JSON.stringify(v)}`);
  return v;
}

const CLICKS = {
  left_click: ['left', 1],
  right_click: ['right', 1],
  middle_click: ['middle', 1],
  double_click: ['left', 2],
  triple_click: ['left', 3],
};

const SCROLL_DIRS = ['up', 'down', 'left', 'right'];

/**
 * 동작 입력 검사 → 운영체제 좌표로 바꾼 요청. 틀린 입력은 무엇이 왜 틀렸는지 담아 던집니다.
 * @param {string} action @param {unknown} input @param {{ screen: {w:number,h:number}, shot: {w:number,h:number}, sx:number, sy:number }} geo
 */
export function validateAction(action, input, geo) {
  const inp = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {};
  switch (action) {
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'cursor_position':
      return { kind: 'cursor' };
    case 'left_mouse_down':
      return { kind: 'down' };
    case 'left_mouse_up':
      return { kind: 'up' };
    case 'zoom': {
      const r = inp.region;
      if (!Array.isArray(r) || r.length !== 4) throw new Error(`region 은 [x0, y0, x1, y1] 형태여야 합니다. 받은 값: ${JSON.stringify(r)}`);
      const [x0, y0, x1, y1] = r.map((v, i) => numberField(v, `region[${i}]`));
      if (x0 < 0 || y0 < 0 || x1 > geo.shot.w || y1 > geo.shot.h || x1 <= x0 || y1 <= y0) {
        throw new Error(`region [${x0}, ${y0}, ${x1}, ${y1}]은(는) 스크린샷(${geo.shot.w}×${geo.shot.h}) 안의 왼쪽 위 → 오른쪽 아래 순서여야 합니다.`);
      }
      const x = Math.round(x0 * geo.sx);
      const y = Math.round(y0 * geo.sy);
      return { kind: 'zoom', rect: { x, y, w: Math.max(1, Math.round(x1 * geo.sx) - x), h: Math.max(1, Math.round(y1 * geo.sy) - y) } };
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click': {
      const [button, count] = CLICKS[action];
      const at = inp.coordinate === undefined || inp.coordinate === null ? null : point(inp.coordinate, 'coordinate', geo);
      return { kind: 'click', button, count, at, mods: parseModifiers(inp.text) };
    }
    case 'left_click_drag':
      return { kind: 'drag', from: point(inp.start_coordinate, 'start_coordinate', geo), to: point(inp.coordinate, 'coordinate', geo), mods: parseModifiers(inp.text) };
    case 'mouse_move':
      return { kind: 'move', at: point(inp.coordinate, 'coordinate', geo) };
    case 'scroll': {
      if (!SCROLL_DIRS.includes(inp.scroll_direction)) throw new Error(`scroll_direction 은 up · down · left · right 중 하나여야 합니다. 받은 값: ${JSON.stringify(inp.scroll_direction)}`);
      const amount = intRange(inp.scroll_amount, 'scroll_amount', 1, SCROLL_MAX, 3);
      const at = inp.coordinate === undefined || inp.coordinate === null ? null : point(inp.coordinate, 'coordinate', geo);
      return { kind: 'scroll', dir: inp.scroll_direction, amount, at, mods: parseModifiers(inp.text) };
    }
    case 'type': {
      if (typeof inp.text !== 'string' || inp.text === '') throw new Error('type 의 text 가 비어 있습니다.');
      if (inp.text.length > TYPE_MAX) throw new Error(`한 번에 ${TYPE_MAX.toLocaleString()}자까지 입력할 수 있습니다. 지금 ${inp.text.length.toLocaleString()}자입니다.`);
      return { kind: 'type', text: inp.text };
    }
    case 'key': {
      const c = parseCombo(inp.text);
      return { kind: 'key', mods: c.mods, key: c.key, known: c.known, repeat: intRange(inp.repeat, 'repeat', 1, REPEAT_MAX, 1) };
    }
    case 'hold_key': {
      const c = parseCombo(inp.text);
      return { kind: 'hold', mods: c.mods, key: c.key, known: c.known, duration: duration(inp.duration, 'duration') };
    }
    case 'wait':
      return { kind: 'wait', duration: duration(inp.duration, 'duration') };
    default:
      throw new Error(`알 수 없는 화면 동작 '${action}'입니다. 쓸 수 있는 동작: ${ACTIONS.join(', ')}`);
  }
}

/* ───────── macOS ───────── */

/** macOS 가상 키 코드 (ANSI 배치 기준, 입력기 · 자판 배열과 무관한 물리 키) */
export const MAC_KEYCODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, equal: 24, 9: 25, 7: 26, minus: 27, 8: 28, 0: 29, bracketright: 30, o: 31,
  u: 32, bracketleft: 33, i: 34, p: 35, Return: 36, l: 37, j: 38, apostrophe: 39, k: 40, semicolon: 41, backslash: 42,
  comma: 43, slash: 44, n: 45, m: 46, period: 47, Tab: 48, space: 49, grave: 50, BackSpace: 51, Escape: 53,
  Caps_Lock: 57, KP_Enter: 76, F17: 64, F18: 79, F19: 80, F20: 90, F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101,
  F11: 103, F13: 105, F16: 106, F14: 107, F10: 109, F12: 111, F15: 113, Insert: 114, Home: 115, Page_Up: 116,
  Delete: 117, F4: 118, End: 119, F2: 120, Page_Down: 121, F1: 122, Left: 123, Right: 124, Down: 125, Up: 126,
};

/** 키 → { code, shift }. '+' 처럼 shift 가 필요한 키는 shift 를 함께 누릅니다. 없는 키면 null. */
export function macKey(key) {
  if (key === 'plus') return { code: MAC_KEYCODES.equal, shift: true };
  if (Object.hasOwn(MAC_KEYCODES, key)) return { code: MAC_KEYCODES[key], shift: false };
  return null;
}

/** 검사를 마친 요청 → macOS 입력 스크립트(mac-input.js) 요청 */
export function macRequest(req) {
  switch (req.kind) {
    case 'move':
      return { op: 'move', x: req.at[0], y: req.at[1] };
    case 'click':
      return { op: 'click', button: req.button, count: req.count, mods: req.mods, ...(req.at ? { x: req.at[0], y: req.at[1] } : {}) };
    case 'down':
      return { op: 'down' };
    case 'up':
      return { op: 'up' };
    case 'drag':
      return { op: 'drag', x1: req.from[0], y1: req.from[1], x2: req.to[0], y2: req.to[1], mods: req.mods };
    case 'scroll': {
      const n = LINES_PER_CLICK;
      const dy = req.dir === 'up' ? n : req.dir === 'down' ? -n : 0;
      const dx = req.dir === 'left' ? n : req.dir === 'right' ? -n : 0;
      return { op: 'scroll', dx, dy, amount: req.amount, mods: req.mods, ...(req.at ? { x: req.at[0], y: req.at[1] } : {}) };
    }
    case 'type':
      return { op: 'type', text: req.text };
    case 'key':
    case 'hold': {
      let code = null;
      const mods = [...req.mods];
      if (req.key !== null) {
        const k = macKey(req.key);
        if (!k) throw new Error(`macOS 에서 쓸 수 없는 키 이름 '${req.key}'입니다.`);
        code = k.code;
        if (k.shift && !mods.includes('shift')) mods.push('shift');
      }
      return req.kind === 'key' ? { op: 'key', mods, code, repeat: req.repeat } : { op: 'hold', mods, code, duration: req.duration };
    }
    default:
      throw new Error(`macOS 입력으로 바꿀 수 없는 동작 '${req.kind}'입니다.`);
  }
}

/** `sips -g pixelWidth -g pixelHeight` 출력 → { w, h } */
export function parseSipsSize(out) {
  const w = /pixelWidth:\s*(\d+)/.exec(out);
  const h = /pixelHeight:\s*(\d+)/.exec(out);
  if (!w || !h) throw new Error(`이미지 크기를 읽지 못했습니다: ${String(out).trim().slice(0, 120)}`);
  return { w: Number(w[1]), h: Number(h[1]) };
}

/* ───────── Linux (X11 · xdotool) ───────── */

const X_BUTTON = { left: '1', middle: '2', right: '3' };
const X_SCROLL = { up: '4', down: '5', left: '6', right: '7' };

function xCombo(mods, key) {
  return [...mods, ...(key === null ? [] : [key])].join('+');
}

/** 검사를 마친 요청 → xdotool 인자 (한 번 실행에 명령을 이어 붙임) */
export function xdotoolArgs(req) {
  const down = req.mods ? req.mods.flatMap((m) => ['keydown', m]) : [];
  const up = req.mods ? [...req.mods].reverse().flatMap((m) => ['keyup', m]) : [];
  const moveTo = (p) => (p ? ['mousemove', '--sync', String(p[0]), String(p[1])] : []);
  switch (req.kind) {
    case 'move':
      return moveTo(req.at);
    case 'click':
      return [...moveTo(req.at), ...down, 'click', '--repeat', String(req.count), '--delay', '80', X_BUTTON[req.button], ...up];
    case 'down':
      return ['mousedown', '1'];
    case 'up':
      return ['mouseup', '1'];
    case 'drag':
      return [...moveTo(req.from), ...down, 'mousedown', '1', ...moveTo(req.to), 'mouseup', '1', ...up];
    case 'scroll':
      return [...moveTo(req.at), ...down, 'click', '--repeat', String(req.amount), '--delay', '30', X_SCROLL[req.dir], ...up];
    case 'key':
      return ['key', '--repeat', String(req.repeat), '--delay', '30', '--', xCombo(req.mods, req.key)];
    case 'hold': {
      const combo = xCombo(req.mods, req.key);
      return ['keydown', combo, 'sleep', String(req.duration), 'keyup', combo];
    }
    case 'type':
      return ['type', '--delay', '12', '--', req.text];
    default:
      throw new Error(`xdotool 로 바꿀 수 없는 동작 '${req.kind}'입니다.`);
  }
}

/** `xdotool getmouselocation --shell` 출력 → [x, y] */
export function parseMouseLocation(out) {
  const x = /^X=(\d+)/m.exec(out);
  const y = /^Y=(\d+)/m.exec(out);
  if (!x || !y) throw new Error(`마우스 위치를 읽지 못했습니다: ${String(out).trim().slice(0, 120)}`);
  return [Number(x[1]), Number(y[1])];
}

/** `xdotool getdisplaygeometry` 출력 → { w, h } */
export function parseDisplayGeometry(out) {
  const m = /^(\d+)\s+(\d+)\s*$/.exec(String(out).trim());
  if (!m) throw new Error(`화면 크기를 읽지 못했습니다: ${String(out).trim().slice(0, 120)}`);
  return { w: Number(m[1]), h: Number(m[2]) };
}
