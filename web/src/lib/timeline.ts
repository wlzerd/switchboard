import type { TimelineItem } from './types';

/** 오래 열어 둔 화면에 쌓아 두는 기록 수. 넘치면 앞쪽을 버리고 '이전 기록 더 보기'로 다시 읽습니다. */
export const TIMELINE_KEEP = 400;
/** 한 번에 읽는 기록 수 */
export const TIMELINE_PAGE = 200;

/** 새 기록을 뒤에 붙이고, 상한을 넘으면 앞쪽을 버립니다. 버렸으면 dropped. 이미 있는 기록이면 그대로 둡니다. */
export function appendCapped(items: readonly TimelineItem[], item: TimelineItem, keep = TIMELINE_KEEP): { items: TimelineItem[]; dropped: boolean } {
  if (items.some((i) => i.id === item.id)) return { items: [...items], dropped: false };
  const next = [...items, item];
  if (next.length <= keep) return { items: next, dropped: false };
  return { items: next.slice(next.length - keep), dropped: true };
}

/**
 * 이전 기록을 앞에 붙입니다 (이미 있는 것은 뺌).
 * 읽어 온 만큼 상한도 늘려, 방금 읽은 기록이 다음 새 메시지에 바로 밀려나지 않게 합니다.
 * 상한은 사용자가 누른 만큼만 늘어나므로 시간이 지나도 끝없이 쌓이지 않습니다.
 * 읽는 사이 맨 앞 기록이 바뀌었으면(앞쪽이 잘렸거나 다른 대화로 바뀜) 이어 붙이면 틈이 생기므로 null.
 */
export function prependOlder(items: readonly TimelineItem[], older: readonly TimelineItem[], keep: number, anchorId: number): { items: TimelineItem[]; keep: number } | null {
  if (items[0]?.id !== anchorId) return null;
  const have = new Set(items.map((i) => i.id));
  const fresh = older.filter((i) => !have.has(i.id));
  return { items: [...fresh, ...items], keep: keep + fresh.length };
}
