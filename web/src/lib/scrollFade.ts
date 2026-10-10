/**
 * 스크롤 영역의 가장자리 흐림.
 * 사이트 안의 스크롤바는 숨기고(app.css), 대신 더 볼 내용이 있는 쪽 가장자리를 흐리게 보여 줍니다.
 * 대상(.scroll-fade · .codebox)에 data-fade="t b l r" 중 해당하는 쪽만 붙이고, 흐림은 CSS 마스크가 그립니다.
 * React 가 관리하는 className 을 건드리지 않도록 data 속성을 씁니다.
 */

export const FADE_SELECTOR = '.scroll-fade, .codebox';
/** 반올림 · 확대 배율로 생기는 1px 안팎의 오차는 끝에 닿은 것으로 봅니다 */
const SLACK = 1;

export interface ScrollBox {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

/**
 * 더 볼 내용이 있는 쪽: t(위) · b(아래) · l(왼쪽) · r(오른쪽)을 공백으로 이은 문자열.
 * reverseY: flex-direction column-reverse 인 영역 (아래가 시작이라 scrollTop 이 0 에서 음수로 내려감)
 */
export function fadeEdges(b: ScrollBox, reverseY = false): string {
  const sides: string[] = [];
  const maxY = b.scrollHeight - b.clientHeight;
  if (maxY > SLACK) {
    const fromTop = Math.min(maxY, Math.max(0, reverseY ? maxY + b.scrollTop : b.scrollTop));
    if (fromTop > SLACK) sides.push('t');
    if (fromTop < maxY - SLACK) sides.push('b');
  }
  const maxX = b.scrollWidth - b.clientWidth;
  if (maxX > SLACK) {
    const fromLeft = Math.min(maxX, Math.max(0, b.scrollLeft));
    if (fromLeft > SLACK) sides.push('l');
    if (fromLeft < maxX - SLACK) sides.push('r');
  }
  return sides.join(' ');
}

interface Tracked {
  onScroll: () => void;
  content: MutationObserver;
  reverseY: boolean;
}

/** 스크롤이 맨 아래에 붙어 있는지 (몇 px 모자라도 붙은 것으로 봄) */
export function atBottom(el: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
}

/**
 * root 아래의 대상 요소를 찾아(나중에 생기는 모달 등 포함) 스크롤 · 크기 · 내용이 바뀔 때마다 흐릴 쪽을 다시 정합니다.
 * 계산은 화면을 그리기 직전 한 번으로 모읍니다. 돌려준 함수로 모두 해제합니다.
 */
export function installScrollFade(root: HTMLElement = document.body): () => void {
  const tracked = new Map<HTMLElement, Tracked>();
  const pending = new Set<HTMLElement>();
  let frame = 0;
  let rescan = false;

  const reversed = (el: HTMLElement): boolean => getComputedStyle(el).flexDirection === 'column-reverse';

  const apply = (el: HTMLElement): void => {
    const t = tracked.get(el);
    if (!t) return;
    const next = fadeEdges(el, t.reverseY);
    if ((el.dataset['fade'] ?? '') !== next) el.dataset['fade'] = next;
  };

  const flush = (): void => {
    frame = 0;
    if (rescan) {
      rescan = false;
      scan();
    }
    pending.forEach(apply);
    pending.clear();
  };

  const schedule = (el: HTMLElement | null): void => {
    if (el) pending.add(el);
    else rescan = true;
    if (!frame) frame = requestAnimationFrame(flush);
  };

  const resize = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = e.target as HTMLElement;
      const t = tracked.get(el);
      if (t) t.reverseY = reversed(el);
      schedule(el);
    }
  });

  const attach = (el: HTMLElement): void => {
    if (tracked.has(el)) return;
    const onScroll = (): void => schedule(el);
    // 대화가 이어지거나 기록을 더 읽으면 크기는 그대로인데 내용 높이만 바뀝니다.
    const content = new MutationObserver(() => schedule(el));
    content.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', onScroll, { passive: true });
    // 나중에 읽히는 그림(스크린샷 등)도 내용 높이를 바꿉니다 (load 는 거품이 없어 잡기 단계에서 받음).
    el.addEventListener('load', onScroll, true);
    resize.observe(el);
    tracked.set(el, { onScroll, content, reverseY: reversed(el) });
    pending.add(el);
  };

  const detach = (el: HTMLElement): void => {
    const t = tracked.get(el);
    if (!t) return;
    el.removeEventListener('scroll', t.onScroll);
    el.removeEventListener('load', t.onScroll, true);
    t.content.disconnect();
    resize.unobserve(el);
    tracked.delete(el);
    pending.delete(el);
  };

  function scan(): void {
    root.querySelectorAll<HTMLElement>(FADE_SELECTOR).forEach(attach);
    for (const el of [...tracked.keys()]) if (!el.isConnected) detach(el);
  }

  const tree = new MutationObserver(() => schedule(null));
  tree.observe(root, { childList: true, subtree: true });
  scan();
  schedule(null);

  return () => {
    tree.disconnect();
    resize.disconnect();
    for (const el of [...tracked.keys()]) detach(el);
    if (frame) cancelAnimationFrame(frame);
  };
}
