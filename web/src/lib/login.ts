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

/** 지금 로그인 상태 표시 */
export function loginBadge(login: Pick<LoginView, 'scopes' | 'current' | 'pending'>): { text: string; tone: 'ok' | 'warn' | '' } {
  if (login.pending) return { text: '허락 기다리는 중', tone: 'warn' };
  if (login.current) return { text: `로그인됨${login.current.account ? ` · @${login.current.account}` : ''} · ${scopeName(login, login.current.scope)}`, tone: 'ok' };
  return { text: '로그인 안 함', tone: '' };
}

/** 확인 주소를 짧게 (https:// 와 끝 / 를 뺌) */
export function shortUrl(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}
