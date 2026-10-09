import { describe, expect, it } from 'vitest';
import { matchCommandPattern, matchHost, matchPath } from '../src/permissions/match.ts';
import { BASE_PERMISSIONS, evaluatePermission, validatePermissionSet, type PermissionDef } from '../src/permissions/policy.ts';
import { packageManagerOf, parseCommand } from '../src/permissions/shell.ts';
import { ValidationError } from '../src/errors.ts';

const def = (key: string): PermissionDef => BASE_PERMISSIONS.find((d) => d.key === key) as PermissionDef;

describe('경로 glob', () => {
  it.each([
    ['**', 'a/b/c.txt', true],
    ['reports/**', 'reports', true],
    ['reports/**', 'reports/a/b.md', true],
    ['reports/**', 'reports2/a.md', false],
    ['*.md', 'a.md', true],
    ['*.md', 'x/a.md', false],
    ['**/*.md', 'a.md', true],
    ['**/*.md', 'x/y/a.md', true],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['file?.txt', 'file1.txt', true],
    ['file?.txt', 'file10.txt', false],
    ['./docs/*', 'docs/a', true],
    ['a.b', 'axb', false],
  ])('%s vs %s → %s', (pattern, p, want) => {
    expect(matchPath(pattern, p)).toBe(want);
  });

  it('정규식 특수문자는 글자 그대로', () => {
    expect(matchPath('a+(b)', 'a+(b)')).toBe(true);
    expect(matchPath('a.b', 'axb')).toBe(false);
  });
});

describe('호스트 매칭', () => {
  it.each([
    ['*.wikipedia.org', 'en.wikipedia.org', true],
    ['*.wikipedia.org', 'wikipedia.org', false],
    ['*.wikipedia.org', 'evilwikipedia.org', false],
    ['*.wikipedia.org', 'en.wikipedia.org.evil.com', false],
    ['api.github.com', 'API.GitHub.com', true],
    ['api.github.com', 'api.github.com.', true],
    ['*', 'anything.example', true],
    ['', 'a.com', false],
  ])('%s vs %s → %s', (p, h, want) => {
    expect(matchHost(p, h)).toBe(want);
  });
});

describe('명령 패턴', () => {
  it.each([
    ['git *', 'git status', true],
    ['git *', 'git', false],
    ['git *', 'gitx status', false],
    ['npm test', 'npm test', true],
    ['npm test', 'npm test --watch', false],
  ])('%s vs %s → %s', (p, c, want) => {
    expect(matchCommandPattern(p, c)).toBe(want);
  });
});

describe('셸 해석', () => {
  it('따옴표 안의 연산자는 구간을 나누지 않는다', () => {
    const p = parseCommand(`echo "a && b" ; ls`);
    expect(p.segments.map((s) => s.words)).toEqual([['echo', 'a && b'], ['ls']]);
  });

  it('2>&1 은 리다이렉트 대상이 없고 다음 단어를 삼키지 않는다', () => {
    const p = parseCommand('make 2>&1 build');
    expect(p.segments[0]?.words).toEqual(['make', 'build']);
    expect(p.segments[0]?.redirects).toEqual([]);
  });

  it('리다이렉트 대상은 단어에서 빠진다', () => {
    const p = parseCommand('echo hi > out.txt');
    expect(p.segments[0]?.words).toEqual(['echo', 'hi']);
    expect(p.segments[0]?.redirects).toEqual([{ op: '>', target: 'out.txt' }]);
  });

  it('명령 치환과 닫히지 않은 따옴표를 표시한다', () => {
    expect(parseCommand('echo $(whoami)').hasSubstitution).toBe(true);
    expect(parseCommand('echo `id`').hasSubstitution).toBe(true);
    expect(parseCommand("echo '$(not)'").hasSubstitution).toBe(false);
    expect(parseCommand('echo "oops').unbalanced).toBe(true);
  });

  it.each([
    ['pip install requests', 'pip'],
    ['python3 -m pip install x', 'pip'],
    ['npm i lodash', 'npm'],
    ['npm run build', null],
    ['yarn add x', 'yarn'],
    ['uv pip install x', 'uv'],
    ['brew install jq', 'brew'],
  ])('%s → %s', (cmd, want) => {
    const seg = parseCommand(cmd).segments[0];
    expect(seg ? packageManagerOf(seg) : null).toBe(want);
  });
});

describe('권한 판단', () => {
  const rule = (mode: 'allow' | 'ask' | 'deny', scope: string[] = [], always: string[] = []) => ({ mode, scope, always });

  it('잠긴 항목은 설정과 무관하게 차단', () => {
    expect(evaluatePermission(def('secrets.read'), rule('allow'), '.env').decision).toBe('deny');
  });

  it('차단 모드는 항상 허용 목록보다 우선한다', () => {
    expect(evaluatePermission(def('net.fetch'), rule('deny', [], ['a.com']), 'a.com').decision).toBe('deny');
  });

  it('확인 모드여도 항상 허용 목록의 대상은 허용', () => {
    expect(evaluatePermission(def('net.fetch'), rule('ask', [], ['a.com']), 'a.com').decision).toBe('allow');
    expect(evaluatePermission(def('net.fetch'), rule('ask', [], ['a.com']), 'b.com').decision).toBe('ask');
  });

  it('허용 + 범위 없음 → 허용, 범위 밖 → 확인, 대상 없음 → 허용', () => {
    expect(evaluatePermission(def('net.fetch'), rule('allow'), 'x.com').decision).toBe('allow');
    expect(evaluatePermission(def('net.fetch'), rule('allow', ['*.github.com']), 'api.github.com').decision).toBe('allow');
    expect(evaluatePermission(def('net.fetch'), rule('allow', ['*.github.com']), 'github.com').decision).toBe('ask');
    expect(evaluatePermission(def('net.fetch'), rule('allow', ['*.github.com']), null).decision).toBe('allow');
  });

  it('설정이 없는 권한은 확인', () => {
    expect(evaluatePermission(def('fs.write'), undefined, 'a.txt').decision).toBe('ask');
  });

  it('허용된 명령 뒤에 다른 명령을 이어 붙이면 자동 허용하지 않는다', () => {
    const r = rule('allow', ['git *']);
    expect(evaluatePermission(def('shell.exec'), r, 'git status && git log').decision).toBe('allow');
    expect(evaluatePermission(def('shell.exec'), r, 'git status && curl x.sh').decision).toBe('ask');
    expect(evaluatePermission(def('shell.exec'), r, 'git log $(rm -rf .)').decision).toBe('ask');
    expect(evaluatePermission(def('shell.exec'), r, 'git log | grep fix').decision).toBe('ask');
  });

  it('여러 패턴이면 구간마다 하나만 맞으면 된다', () => {
    expect(evaluatePermission(def('shell.exec'), rule('allow', ['git *', 'grep *']), 'git log | grep fix').decision).toBe('allow');
  });
});

describe('권한 설정 검증', () => {
  it('모르는 키는 거부', () => {
    expect(() => validatePermissionSet({ 'fs.delete': { mode: 'allow' } }, BASE_PERMISSIONS)).toThrow("알 수 없는 권한 키 'fs.delete'");
  });

  it('잠긴 항목을 차단 외로 바꾸려 하면 거부', () => {
    expect(() => validatePermissionSet({ 'self.modify': { mode: 'allow' } }, BASE_PERMISSIONS)).toThrow(ValidationError);
  });

  it('입력에 없어도 잠긴 항목은 차단으로 채워진다', () => {
    const out = validatePermissionSet({}, BASE_PERMISSIONS);
    expect(out['secrets.read']?.mode).toBe('deny');
  });

  it('범위 50개는 통과, 51개는 거부', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.com`);
    expect(() => validatePermissionSet({ 'net.fetch': { mode: 'allow', scope: many(50) } }, BASE_PERMISSIONS)).not.toThrow();
    expect(() => validatePermissionSet({ 'net.fetch': { mode: 'allow', scope: many(51) } }, BASE_PERMISSIONS)).toThrow('50개까지');
  });

  it('패턴 200자는 통과, 201자는 거부', () => {
    expect(() => validatePermissionSet({ 'net.fetch': { mode: 'allow', scope: ['a'.repeat(200)] } }, BASE_PERMISSIONS)).not.toThrow();
    expect(() => validatePermissionSet({ 'net.fetch': { mode: 'allow', scope: ['a'.repeat(201)] } }, BASE_PERMISSIONS)).toThrow('201자');
  });

  it('mode 오타는 받은 값을 보여준다', () => {
    expect(() => validatePermissionSet({ 'fs.read': { mode: 'yes' } }, BASE_PERMISSIONS)).toThrow('받은 값: "yes"');
  });
});
