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

  it('상태 칩: 기다리는 중 → 로그인됨(계정 · 권한 또는 어디서 가져왔는지) → 로그인 안 함', () => {
    const pending = { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: 1, scope: 'repo' };
    const cli = { label: '서버의 gh 로그인 가져오기', command: 'gh', loginCommand: 'gh auth login', installUrl: 'https://cli.github.com' };
    const device = (account: string | null, scope: string) => ({ account, scope, at: 1, via: 'device' as const });
    expect(loginBadge({ scopes, cli, pending, current: device('octo', 'repo') })).toEqual({ text: '허락 기다리는 중', tone: 'warn' });
    expect(loginBadge({ scopes, cli, pending: null, current: device('octo', 'repo') })).toEqual({ text: '로그인됨 · @octo · 비공개 저장소 포함', tone: 'ok' });
    expect(loginBadge({ scopes, cli: null, pending: null, current: device(null, 'public_repo') })).toEqual({ text: '로그인됨 · 공개 저장소만', tone: 'ok' });
    // 서버 CLI 에서 가져온 토큰은 권한 범위 대신 어디서 왔는지
    expect(loginBadge({ scopes, cli, pending: null, current: { account: 'octo', scope: 'gist, read:org, repo, workflow', at: 1, via: 'cli' } })).toEqual({ text: '로그인됨 · @octo · gh 로그인', tone: 'ok' });
    expect(loginBadge({ scopes, cli, pending: null, current: null })).toEqual({ text: '로그인 안 함', tone: '' });
  });

  it('확인 주소는 https:// 와 끝 / 를 빼고 보여 줍니다', () => {
    expect(shortUrl('https://github.com/login/device')).toBe('github.com/login/device');
    expect(shortUrl('https://example.com/')).toBe('example.com');
  });
});
