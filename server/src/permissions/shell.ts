/**
 * 셸 명령을 구간(segment)과 단어로 나눕니다. 권한 판단과 기본 금지 조항에서 씁니다.
 * 완전한 셸 문법이 아니라 위험 판단에 필요한 만큼만 해석하며, 해석이 애매하면 보수적으로(더 막는 쪽으로) 표시합니다.
 * 재귀 없이 한 글자씩 읽는 상태 기계로 동작합니다.
 */

export type Operator = '&&' | '||' | ';' | '|' | '&' | '\n';

export interface Redirect {
  op: '>' | '>>' | '<' | '2>' | '&>';
  target: string;
}

export interface Segment {
  /** 따옴표를 푼 단어들 (리다이렉트 대상은 제외) */
  words: string[];
  redirects: Redirect[];
  /** 이 구간 앞의 연산자 (첫 구간은 null) */
  before: Operator | null;
}

export interface ParsedCommand {
  segments: Segment[];
  /** `$(...)`, 백틱, `<(...)` 처럼 안쪽 명령을 실행하는 문법이 있으면 true — 자동 허용하지 않습니다. */
  hasSubstitution: boolean;
  /** 닫히지 않은 따옴표가 있으면 true */
  unbalanced: boolean;
}

export function parseCommand(input: string): ParsedCommand {
  const segments: Segment[] = [];
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let before: Operator | null = null;
  let cur = '';
  let hasWord = false;
  let pendingRedirect: Redirect['op'] | null = null;
  let hasSubstitution = false;
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (!hasWord) return;
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: cur });
      pendingRedirect = null;
    } else {
      words.push(cur);
    }
    cur = '';
    hasWord = false;
  };
  const endSegment = (op: Operator | null): void => {
    endWord();
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, before });
    words = [];
    redirects = [];
    before = op;
  };

  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    const next = input[i + 1];

    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === '\\' && next !== undefined && '"\\$`'.includes(next)) {
        cur += next;
        i += 2;
        continue;
      } else {
        if (c === '`' || (c === '$' && next === '(')) hasSubstitution = true;
        cur += c;
      }
      i += 1;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      hasWord = true;
      i += 1;
      continue;
    }
    if (c === '\\' && next !== undefined) {
      if (next === '\n') {
        i += 2;
        continue;
      }
      cur += next;
      hasWord = true;
      i += 2;
      continue;
    }
    if (c === '`' || (c === '$' && next === '(') || ((c === '<' || c === '>') && next === '(')) {
      hasSubstitution = true;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
      continue;
    }
    if (c === '\n') {
      endSegment('\n');
      i += 1;
      continue;
    }
    if (c === '&' && next === '&') {
      endSegment('&&');
      i += 2;
      continue;
    }
    if (c === '|' && next === '|') {
      endSegment('||');
      i += 2;
      continue;
    }
    if (c === '&' && next === '>') {
      endWord();
      pendingRedirect = '&>';
      i += 2;
      continue;
    }
    if (c === ';' || c === '|' || c === '&') {
      endSegment(c as Operator);
      i += 1;
      continue;
    }
    if (c === '2' && next === '>' && !hasWord) {
      endWord();
      i += 2;
      if (input[i] === '&') {
        // 2>&1 : 오류 출력을 표준 출력으로 합치는 것 — 파일 대상이 없습니다.
        i += 2;
        continue;
      }
      pendingRedirect = '2>';
      continue;
    }
    if (c === '>' || c === '<') {
      endWord();
      if (c === '>' && next === '>') {
        pendingRedirect = '>>';
        i += 2;
      } else {
        pendingRedirect = c;
        i += 1;
      }
      continue;
    }
    cur += c;
    hasWord = true;
    i += 1;
  }
  endSegment(null);
  return { segments, hasSubstitution, unbalanced: quote !== null };
}

/** `FOO=1 BAR=2 cmd args` 에서 앞쪽 환경 변수 대입을 건너뛴 실제 명령 단어의 위치. */
export function commandIndex(words: readonly string[]): number {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string)) i += 1;
  return i;
}

/** 명령 이름(경로가 붙어 있으면 마지막 이름만). 예) /usr/bin/sudo → sudo */
export function commandName(words: readonly string[]): string | null {
  const w = words[commandIndex(words)];
  if (w === undefined) return null;
  const slash = w.lastIndexOf('/');
  return slash === -1 ? w : w.slice(slash + 1);
}

export function commandArgs(words: readonly string[]): string[] {
  return words.slice(commandIndex(words) + 1);
}

/** 패키지 설치 명령인지 판별하고 패키지 관리자 이름을 돌려줍니다. */
export function packageManagerOf(seg: Segment): string | null {
  const name = commandName(seg.words);
  const args = commandArgs(seg.words);
  const first = args[0];
  if (name === null || first === undefined) return null;
  if ((name === 'npm' || name === 'pnpm') && ['i', 'install', 'add', 'ci'].includes(first)) return name;
  if (name === 'yarn' && (first === 'add' || first === 'install')) return 'yarn';
  if ((name === 'pip' || name === 'pip3') && first === 'install') return 'pip';
  if (name === 'uv' && ((first === 'pip' && args[1] === 'install') || first === 'add')) return 'uv';
  if (name === 'python' || name === 'python3') {
    if (first === '-m' && (args[1] === 'pip' || args[1] === 'pip3') && args[2] === 'install') return 'pip';
  }
  if ((name === 'apt' || name === 'apt-get' || name === 'brew' || name === 'apk' || name === 'dnf' || name === 'yum') && first === 'install') return name;
  if (name === 'cargo' && first === 'install') return 'cargo';
  if (name === 'go' && (first === 'install' || first === 'get')) return 'go';
  return null;
}
