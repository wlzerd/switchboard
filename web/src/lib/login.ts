import type { LoginView } from './types';

/** 로그인 코드의 남은 시간 'm:ss' (지났으면 0:00) */
export function remaining(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 권한 범위 값 → 화면 이름 (모르는 값은 그대로, 비었으면 '(없음)') */
export function scopeName(login: Pick<LoginView, 'scopes'>, value: string): string {
  return login.scopes.find((x) => x.value === value)?.label ?? (value.trim() || '(없음)');
}

/** 지금 로그인 상태 표시. 서버 CLI 에서 가져온 토큰은 권한 범위 대신 어디서 왔는지 (예: gh 로그인) */
export function loginBadge(login: Pick<LoginView, 'scopes' | 'current' | 'pending' | 'cli'>): { text: string; tone: 'ok' | 'warn' | '' } {
  if (login.pending) return { text: '허락 기다리는 중', tone: 'warn' };
  const c = login.current;
  if (c) {
    const how = c.via === 'cli' ? `${login.cli?.command ?? 'CLI'} 로그인` : scopeName(login, c.scope);
    return { text: `로그인됨${c.account ? ` · @${c.account}` : ''} · ${how}`, tone: 'ok' };
  }
  return { text: '로그인 안 함', tone: '' };
}

/** 확인 주소를 짧게 (https:// 와 끝 / 를 뺌) */
export function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}
