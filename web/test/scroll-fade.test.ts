import { describe, expect, it } from 'vitest';
import { atBottom, fadeEdges } from '../src/lib/scrollFade';

const box = (o: Partial<{ scrollTop: number; scrollLeft: number; scrollHeight: number; scrollWidth: number; clientHeight: number; clientWidth: number }>) => ({
  scrollTop: 0,
  scrollLeft: 0,
  scrollHeight: 100,
  scrollWidth: 100,
  clientHeight: 100,
  clientWidth: 100,
  ...o,
});

describe('스크롤 가장자리 흐림', () => {
  it('넘치지 않으면 흐리지 않음 (1px 오차는 넘친 것으로 보지 않음)', () => {
    expect(fadeEdges(box({}))).toBe('');
    expect(fadeEdges(box({ scrollHeight: 101, scrollWidth: 101 }))).toBe('');
  });

  it.each([
    [0, 'b'],
    [1, 'b'],
    [2, 't b'],
    [150, 't b'],
    [298, 't b'],
    [299, 't'],
    [300, 't'],
  ])('세로: scrollTop %d → %j', (scrollTop, fade) => {
    expect(fadeEdges(box({ scrollHeight: 400, scrollTop }))).toBe(fade);
  });

  it('가로: 처음에는 오른쪽만, 끝에서는 왼쪽만, 중간은 양쪽', () => {
    expect(fadeEdges(box({ scrollWidth: 1006, clientWidth: 375 }))).toBe('r');
    expect(fadeEdges(box({ scrollWidth: 1006, clientWidth: 375, scrollLeft: 300 }))).toBe('l r');
    expect(fadeEdges(box({ scrollWidth: 1006, clientWidth: 375, scrollLeft: 631 }))).toBe('l');
  });

  it('아래부터 쌓이는 영역(column-reverse): 맨 아래(scrollTop 0)면 위만, 위로 올리면(음수) 양쪽, 맨 위면 아래만', () => {
    expect(fadeEdges(box({ scrollHeight: 400, scrollTop: 0 }), true)).toBe('t');
    expect(fadeEdges(box({ scrollHeight: 400, scrollTop: -150 }), true)).toBe('t b');
    expect(fadeEdges(box({ scrollHeight: 400, scrollTop: -300 }), true)).toBe('b');
  });

  it('범위를 벗어난 값(관성 스크롤 튕김)은 끝으로 봄', () => {
    expect(fadeEdges(box({ scrollHeight: 400, scrollTop: -20 }))).toBe('b');
    expect(fadeEdges(box({ scrollHeight: 400, scrollTop: 330 }))).toBe('t');
    expect(fadeEdges(box({ scrollWidth: 500, scrollLeft: -10 }))).toBe('r');
  });

  it('세로 · 가로가 함께 넘치면 둘 다', () => {
    expect(fadeEdges(box({ scrollHeight: 400, scrollWidth: 300, scrollTop: 50, scrollLeft: 50 }))).toBe('t b l r');
  });
});

describe('맨 아래에 붙어 있는지 (작업 단계 목록이 새 단계를 따라 내려갈지)', () => {
  it.each([
    [{ scrollTop: 274, clientHeight: 226, scrollHeight: 500 }, true],
    [{ scrollTop: 270, clientHeight: 226, scrollHeight: 500 }, true],
    [{ scrollTop: 269, clientHeight: 226, scrollHeight: 500 }, false],
    [{ scrollTop: 0, clientHeight: 226, scrollHeight: 500 }, false],
    [{ scrollTop: 0, clientHeight: 226, scrollHeight: 226 }, true],
  ])('%j → %s', (el, want) => {
    expect(atBottom(el)).toBe(want);
  });
});
