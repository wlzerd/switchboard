import { useSyncExternalStore } from 'react';

/** 아주 작은 라우터: 주소 경로를 그대로 화면 이름으로 씁니다. */
const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (location.pathname + location.search === to) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  listeners.forEach((l) => l());
  if (!opts.replace) window.scrollTo({ top: 0 });
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => location.pathname,
  );
}

export interface Route {
  page: 'canvas' | 'console' | 'hire' | 'projects' | 'modules' | 'guard' | 'settings' | 'theme';
  param: string | null;
}

export function parseRoute(path: string): Route {
  const parts = path.split('/').filter(Boolean);
  const head = parts[0] ?? '';
  const param = parts[1] ? decodeURIComponent(parts[1]) : null;
  switch (head) {
    case 'console':
      return { page: 'console', param };
    case 'hire':
      return { page: 'hire', param: null };
    case 'projects':
      return { page: 'projects', param };
    case 'modules':
      return { page: 'modules', param: null };
    case 'settings':
      return { page: 'settings', param };
    case 'guard':
      return { page: 'guard', param };
    case 'theme':
      return { page: 'theme', param: null };
    default:
      return { page: 'canvas', param: null };
  }
}
