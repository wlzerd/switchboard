import { describe, expect, it } from 'vitest';
import { compileGlob, matchCommandPattern, matchPath, runGlob, wildcardMatch } from '../src/permissions/match.ts';

// 예전 정규식 구현 (비교 기준). 새 매처는 정규식을 만들지 않지만 뜻은 같아야 합니다.
function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
function oldGlobToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const prevIsSep = i === 0 || glob[i - 1] === '/';
        const nextIsSep = glob[i + 2] === '/';
        if (prevIsSep && nextIsSep) {
          out += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (prevIsSep && i + 2 === glob.length) {
          if (out.endsWith('/')) out = out.slice(0, -1) + '(?:/.*)?';
          else out += '.*';
          i += 2;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    out += escapeRegex(c);
    i += 1;
  }
  return new RegExp(`^${out}$`);
}
const oldCommand = (pattern: string, command: string): boolean => new RegExp('^' + pattern.trim().split('*').map(escapeRegex).join('.*') + '$').test(command.trim());

/** 같은 씨앗이면 같은 수열 (실패를 다시 만들 수 있게) */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
const build = (r: () => number, parts: readonly string[], max: number): string => {
  const n = Math.floor(r() * (max + 1));
  let s = '';
  for (let i = 0; i < n; i += 1) s += pick(r, parts);
  return s;
};

describe('경로 glob: 예전 정규식과 같은 뜻 (무작위 비교)', () => {
  it('20,000 쌍에서 결과가 모두 같다', () => {
    const r = rng(20261009);
    const patParts = ['a', 'b', '/', '*', '**', '?', '.', '**/', '/**', 'a/', '/a'];
    const textParts = ['a', 'b', '/', '.', 'ab', '/a', 'b/', ''];
    const diffs: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const pattern = build(r, patParts, 6);
      const text = build(r, textParts, 8);
      const expected = oldGlobToRegExp(pattern).test(text);
      const actual = runGlob(compileGlob(pattern), text);
      if (expected !== actual && diffs.length < 5) diffs.push(`${JSON.stringify(pattern)} ~ ${JSON.stringify(text)}: 예전 ${expected}, 지금 ${actual}`);
    }
    expect(diffs).toEqual([]);
  });

  it.each([
    ['', '', true],
    ['', 'a', false],
    ['*', '', true],
    ['*', 'a/b', false],
    ['**', 'a/b/c', true],
    ['?', '', false],
    ['?', '/', false],
    ['dir/**', 'dir', true],
    ['dir/**', 'dir/', true],
    ['dir/**', 'dir/a/b', true],
    ['dir/**', 'dirx', false],
    ['**/x', 'x', true],
    ['**/x', 'a/b/x', true],
    ['**/x', 'ax', false],
    ['a/**/b', 'a/b', true],
    ['a/**/b', 'a/x/y/b', true],
    ['a**b', 'a/x/b', true],
  ])('%j ~ %j → %s', (pattern, text, expected) => {
    expect(runGlob(compileGlob(pattern), text)).toBe(expected);
    expect(oldGlobToRegExp(pattern).test(text)).toBe(expected);
  });

  it("'**' 는 예전처럼 줄바꿈을 건너뛰지 않습니다", () => {
    expect(matchPath('**', 'a\nb')).toBe(false);
    expect(matchPath('a*', 'a\nb')).toBe(true);
  });
});

describe('명령 패턴: 예전 정규식과 같은 뜻 (무작위 비교, 줄바꿈 없는 명령)', () => {
  it('20,000 쌍에서 결과가 모두 같다', () => {
    const r = rng(7);
    const patParts = ['a', 'b', ' ', '*', '-', '.', '**', 'ab'];
    const textParts = ['a', 'b', ' ', '-', '.', 'x', 'ab'];
    const diffs: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const pattern = build(r, patParts, 6);
      const command = build(r, textParts, 9);
      const expected = oldCommand(pattern, command);
      const actual = matchCommandPattern(pattern, command);
      if (expected !== actual && diffs.length < 5) diffs.push(`${JSON.stringify(pattern)} ~ ${JSON.stringify(command)}: 예전 ${expected}, 지금 ${actual}`);
    }
    expect(diffs).toEqual([]);
  });

  it.each([
    ['', '', true],
    ['*', '', true],
    ['git *', 'git status', true],
    ['git *', 'git', false],
    ['git *', 'gitx status', false],
    ['*.log', '.log', true],
    ['a*b*c', 'abc', true],
    ['a*b*c', 'acb', false],
    ['**', 'anything', true],
  ])('%j ~ %j → %s', (pattern, command, expected) => {
    expect(wildcardMatch(pattern, command)).toBe(expected);
  });
});

describe('되추적 폭발 없음 (입력 길이 × 패턴 길이 안에 끝남)', () => {
  it('별이 여럿인 항상 허용 패턴 × 4,000자 명령 (예전 방식은 수 분)', () => {
    const command = `cp ${'a/b.md '.repeat(570)}x`;
    const t = performance.now();
    expect(matchCommandPattern('cp */*.md */*/*.md backup/', command)).toBe(false);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it('별 12개 명령 패턴 × 맞지 않는 4,000자', () => {
    const t = performance.now();
    expect(matchCommandPattern(`${'a*'.repeat(12)}b`, 'a'.repeat(4000))).toBe(false);
    expect(performance.now() - t).toBeLessThan(200);
  });

  it('경로 glob 별 여럿 × 맞지 않는 긴 경로', () => {
    const t = performance.now();
    expect(matchPath('**/a*a*a*a*a*a*/**/z', `${'a/'.repeat(500)}${'a'.repeat(500)}`)).toBe(false);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
