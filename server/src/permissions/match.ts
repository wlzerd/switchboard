/**
 * 권한 범위(scope) 매칭. 모든 함수는 재귀 없이 동작합니다.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * 경로 glob → 정규식. 작업 폴더 기준 상대 경로에 씁니다.
 *  - `**`  : 0개 이상의 경로 구간 (`/` 포함)
 *  - `*`   : `/` 를 제외한 0개 이상의 문자
 *  - `?`   : `/` 를 제외한 문자 1개
 */
export function globToRegExp(glob: string): RegExp {
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
          // 'dir/**' → dir 자체와 그 아래 전부
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

/** 상대 경로 정리: './' 제거, 역슬래시를 '/' 로. */
export function normalizeRelPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

export function matchPath(pattern: string, relPath: string): boolean {
  return globToRegExp(normalizeRelPath(pattern)).test(normalizeRelPath(relPath));
}

/**
 * 도메인 매칭.
 *  - `*`            : 모든 호스트
 *  - `*.example.com`: 하위 도메인만 (example.com 자체는 제외)
 *  - 그 외          : 정확히 같은 호스트
 */
export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/\.$/, '');
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (p === '' || h === '') return false;
  if (p === '*') return true;
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return h.length > base.length + 1 && h.endsWith('.' + base);
  }
  return p === h;
}

/**
 * 명령 패턴 매칭. `*` 는 아무 문자열(빈 문자열 포함). 나머지 글자는 그대로 비교합니다.
 * 예) `git *` 는 'git status' 와 맞고 'gitx' 나 'git' 단독과는 맞지 않습니다.
 */
export function matchCommandPattern(pattern: string, command: string): boolean {
  const re = new RegExp('^' + pattern.trim().split('*').map(escapeRegex).join('.*') + '$');
  return re.test(command.trim());
}

/** 채널·대상 매칭: 대소문자 무시, `*` 는 모두. */
export function matchTarget(pattern: string, target: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === '*') return true;
  return p === target.trim().toLowerCase();
}
