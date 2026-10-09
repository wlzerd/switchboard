// 화면 제어 모듈의 macOS 입력 스크립트. 사용법: osascript -l JavaScript mac-input.js '<요청 JSON>'
// CoreGraphics 이벤트로 마우스 · 키보드를 움직이고 결과를 JSON 으로 돌려줍니다.
// 키는 자판 배열과 무관한 가상 키 코드로 누르고, 글자 입력은 입력기(한글 자판 등)에 영향받지 않도록 붙여넣기로 합니다.
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

var FLAG = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, super: 0x100000 };
var MOD_CODE = { shift: 56, ctrl: 59, alt: 58, super: 55 };
var BUTTON = {
  left: { down: 1, up: 2, drag: 6, number: 0 },
  right: { down: 3, up: 4, drag: 7, number: 1 },
  middle: { down: 25, up: 26, drag: 27, number: 2 },
};
var MOUSE_MOVED = 5;
var HID_TAP = 0;
var CLICK_STATE_FIELD = 1;
var SCROLL_UNIT_LINE = 1;
var KEY_V = 9;
var FAILSAFE_PX = 2;

function post(e) {
  $.CGEventPost(HID_TAP, e);
}

function cursor() {
  var p = $.CGEventGetLocation($.CGEventCreate(null));
  return [p.x, p.y];
}

function mouse(type, x, y, number, flags, clicks) {
  var e = $.CGEventCreateMouseEvent(null, type, { x: x, y: y }, number);
  if (flags) $.CGEventSetFlags(e, flags);
  if (clicks) $.CGEventSetIntegerValueField(e, CLICK_STATE_FIELD, clicks);
  post(e);
}

function keyEvent(code, down, flags) {
  var e = $.CGEventCreateKeyboardEvent(null, code, down);
  $.CGEventSetFlags(e, flags);
  post(e);
}

function pressMods(mods) {
  var flags = 0;
  for (var i = 0; i < mods.length; i++) {
    flags |= FLAG[mods[i]];
    keyEvent(MOD_CODE[mods[i]], true, flags);
  }
  return flags;
}

function releaseMods(mods, flags) {
  for (var i = mods.length - 1; i >= 0; i--) {
    flags &= ~FLAG[mods[i]];
    keyEvent(MOD_CODE[mods[i]], false, flags);
  }
}

function target(r) {
  return typeof r.x === 'number' ? [r.x, r.y] : cursor();
}

/** 클립보드에 글자를 넣고 ⌘V 로 붙여넣은 뒤, 원래 클립보드 글자를 되돌립니다. */
function typeText(text) {
  var pb = $.NSPasteboard.generalPasteboard;
  var prev = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString));
  pb.clearContents;
  pb.setStringForType($(text), $.NSPasteboardTypeString);
  keyEvent(MOD_CODE.super, true, FLAG.super);
  keyEvent(KEY_V, true, FLAG.super);
  keyEvent(KEY_V, false, FLAG.super);
  keyEvent(MOD_CODE.super, false, 0);
  // 앱이 클립보드를 읽어 갈 시간을 준 뒤 되돌립니다.
  delay(0.35);
  pb.clearContents;
  if (typeof prev === 'string') pb.setStringForType($(prev), $.NSPasteboardTypeString);
}

function act(r) {
  switch (r.op) {
    case 'move':
      mouse(MOUSE_MOVED, r.x, r.y, 0, 0, 0);
      return;
    case 'click': {
      var p = target(r);
      var btn = BUTTON[r.button];
      var f = pressMods(r.mods);
      mouse(MOUSE_MOVED, p[0], p[1], 0, f, 0);
      for (var i = 1; i <= r.count; i++) {
        mouse(btn.down, p[0], p[1], btn.number, f, i);
        mouse(btn.up, p[0], p[1], btn.number, f, i);
      }
      releaseMods(r.mods, f);
      return;
    }
    case 'down': {
      var d = cursor();
      mouse(BUTTON.left.down, d[0], d[1], 0, 0, 1);
      return;
    }
    case 'up': {
      var u = cursor();
      mouse(BUTTON.left.up, u[0], u[1], 0, 0, 1);
      return;
    }
    case 'drag': {
      var fd = pressMods(r.mods);
      mouse(MOUSE_MOVED, r.x1, r.y1, 0, fd, 0);
      mouse(BUTTON.left.down, r.x1, r.y1, 0, fd, 1);
      var steps = 12;
      for (var s = 1; s <= steps; s++) {
        mouse(BUTTON.left.drag, r.x1 + ((r.x2 - r.x1) * s) / steps, r.y1 + ((r.y2 - r.y1) * s) / steps, 0, fd, 1);
        delay(0.012);
      }
      mouse(BUTTON.left.up, r.x2, r.y2, 0, fd, 1);
      releaseMods(r.mods, fd);
      return;
    }
    case 'scroll': {
      if (typeof r.x === 'number') mouse(MOUSE_MOVED, r.x, r.y, 0, 0, 0);
      var fs = pressMods(r.mods);
      for (var n = 0; n < r.amount; n++) {
        var e = $.CGEventCreateScrollWheelEvent(null, SCROLL_UNIT_LINE, 2, r.dy, r.dx);
        if (fs) $.CGEventSetFlags(e, fs);
        post(e);
        delay(0.02);
      }
      releaseMods(r.mods, fs);
      return;
    }
    case 'key':
      for (var k = 0; k < r.repeat; k++) {
        var fk = pressMods(r.mods);
        if (r.code !== null) {
          keyEvent(r.code, true, fk);
          keyEvent(r.code, false, fk);
        }
        releaseMods(r.mods, fk);
        if (r.repeat > 1) delay(0.03);
      }
      return;
    case 'hold': {
      var fh = pressMods(r.mods);
      if (r.code !== null) keyEvent(r.code, true, fh);
      delay(r.duration);
      if (r.code !== null) keyEvent(r.code, false, fh);
      releaseMods(r.mods, fh);
      return;
    }
    case 'type':
      typeText(r.text);
      return;
    default:
      throw new Error('알 수 없는 입력 동작 ' + r.op);
  }
}

function run(argv) {
  var r = JSON.parse(argv[0]);
  if (r.op === 'info') {
    var b = $.CGDisplayBounds($.CGMainDisplayID());
    return JSON.stringify({ w: b.size.width, h: b.size.height, trusted: $.AXIsProcessTrusted(), cursor: cursor() });
  }
  if (r.op === 'cursor') return JSON.stringify({ cursor: cursor() });
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ untrusted: true });
  if (r.failsafe) {
    var c = cursor();
    if (c[0] <= FAILSAFE_PX && c[1] <= FAILSAFE_PX) return JSON.stringify({ stopped: true });
  }
  act(r);
  return JSON.stringify({ ok: true });
}
