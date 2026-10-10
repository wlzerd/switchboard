import { describe, expect, it } from 'vitest';
import { loginBadge, remaining, scopeName, shortUrl } from '../src/lib/login';

const scopes = [
  { value: 'repo', label: '비공개 저장소 포함' },
  { value: 'public_repo', label: '공개 저장소만' },
];

describe('모듈 로그인 표시', () => {
  it('남은 시간: 올림한 초를 m:ss 로, 지났으면 0:00', () => {
    expect(remaining(900_000, 0)).toBe('15:00');
    expect(remaining(61_001, 0)).toBe('1:02');
    expect(remaining(1, 0)).toBe('0:01');
    expect(remaining(0, 0)).toBe('0:00');
    expect(remaining(0, 5_000)).toBe('0:00');
  });

  it('권한 범위 이름: 아는 값은 화면 이름, 모르는 값은 그대로, 비었으면 (없음)', () => {
    expect(scopeName({ scopes }, 'public_repo')).toBe('공개 저장소만');
    expect(scopeName({ scopes }, 'repo,gist')).toBe('repo,gist');
    expect(scopeName({ scopes }, ' ')).toBe('(없음)');
  });

  it('상태 칩: 기다리는 중 → 로그인됨(계정 · 권한) → 로그인 안 함', () => {
    const pending = { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: 1, scope: 'repo' };
    expect(loginBadge({ scopes, pending, current: { account: 'octo', scope: 'repo', at: 1 } })).toEqual({ text: '허락 기다리는 중', tone: 'warn' });
    expect(loginBadge({ scopes, pending: null, current: { account: 'octo', scope: 'repo', at: 1 } })).toEqual({ text: '로그인됨 · @octo · 비공개 저장소 포함', tone: 'ok' });
    expect(loginBadge({ scopes, pending: null, current: { account: null, scope: 'public_repo', at: 1 } })).toEqual({ text: '로그인됨 · 공개 저장소만', tone: 'ok' });
    expect(loginBadge({ scopes, pending: null, current: null })).toEqual({ text: '로그인 안 함', tone: '' });
  });

  it('확인 주소는 https:// 와 끝 / 를 빼고 보여 줍니다', () => {
    expect(shortUrl('https://github.com/login/device')).toBe('github.com/login/device');
    expect(shortUrl('https://example.com/')).toBe('example.com');
  });
});
