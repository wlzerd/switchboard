/**
 * 권한 범위(scope) 매칭. 모든 함수는 재귀 없이 동작하고, 정규식을 만들지 않습니다.
 * '*' 가 많은 패턴도 되추적으로 오래 걸리지 않도록, 걸리는 시간이 (패턴 길이 × 입력 길이)를 넘지 않는 방식으로 비교합니다.
 */

/** 정규식의 '.' 처럼 줄바꿈은 '**' 가 건너뛰지 않습니다 (경로에 줄바꿈이 있는 경우는 막아 둠). */
const LINE_BREAK = new Set(['\n', '\r', ' ', ' ']);

type EdgeKind = 'ch' | 'notSlash' | 'any';
interface GlobNode {
  /** 글자를 먹지 않고 넘어가는 다음 상태 */
  eps: number[];
  edges: { kind: EdgeKind; ch: string; to: number }[];
}

export interface CompiledGlob {
  nodes: GlobNode[];
  accept: number;
}

/**
 * 경로 glob → 작은 상태 기계. 작업 폴더 기준 상대 경로에 씁니다.
 *  - `**`  : 0개 이상의 경로 구간 (`/` 포함)
 *  - `*`   : `/` 를 제외한 0개 이상의 문자
 *  - `?`   : `/` 를 제외한 문자 1개
 *  - `dir/**` 는 dir 자체와 그 아래 전부
 */
export function compileGlob(glob: string): CompiledGlob {
  const nodes: GlobNode[] = [{ eps: [], edges: [] }];
  const add = (): number => {
    nodes.push({ eps: [], edges: [] });
    return nodes.length - 1;
  };
  const node = (i: number): GlobNode => nodes[i] as GlobNode;
  let cur = 0;
  /** 마지막으로 넣은 것이 글자 '/' 였다면 그 '/' 직전 상태 ('dir/**' 처리용) */
  let beforeSlash: number | null = null;
  let i = 0;
  while (i < glob.length) {
    const c = glob[i] as string;
    if (c === '*' && glob[i + 1] === '*') {
      const prevIsSep = i === 0 || glob[i - 1] === '/';
      const nextIsSep = glob[i + 2] === '/';
      if (prevIsSep && nextIsSep) {
        // '**/' : 통째로 건너뛰거나, 아무 글자들 뒤 '/' 까지
        const loop = add();
        const next = add();
        node(cur).eps.push(next, loop);
        node(loop).edges.push({ kind: 'any', ch: '', to: loop }, { kind: 'ch', ch: '/', to: next });
        cur = next;
        beforeSlash = null;
        i += 3;
        continue;
      }
      if (prevIsSep && i + 2 === glob.length && beforeSlash !== null) {
        // 'dir/**' : 앞의 '/' 부터 선택 → dir 자체, 또는 dir/ 아래 아무것
        const end = add();
        node(beforeSlash).eps.push(end);
        node(cur).edges.push({ kind: 'any', ch: '', to: cur });
        node(cur).eps.push(end);
        cur = end;
        beforeSlash = null;
        i += 2;
        continue;
      }
      node(cur).edges.push({ kind: 'any', ch: '', to: cur });
      beforeSlash = null;
      i += 2;
      continue;
    }
    if (c === '*') {
      node(cur).edges.push({ kind: 'notSlash', ch: '', to: cur });
      beforeSlash = null;
      i += 1;
      continue;
    }
    const next = add();
    if (c === '?') {
      node(cur).edges.push({ kind: 'notSlash', ch: '', to: next });
      beforeSlash = null;
    } else {
      node(cur).edges.push({ kind: 'ch', ch: c, to: next });
      beforeSlash = c === '/' ? cur : null;
    }
    cur = next;
    i += 1;
  }
  return { nodes, accept: cur };
}

function closure(nodes: readonly GlobNode[], start: Iterable<number>): Set<number> {
  const out = new Set<number>(start);
  const stack = [...out];
  while (stack.length > 0) {
    const s = stack.pop() as number;
    for (const t of (nodes[s] as GlobNode).eps) {
      if (!out.has(t)) {
        out.add(t);
        stack.push(t);
      }
    }
  }
  return out;
}

/** 상태 기계로 문자열 전체가 맞는지 봅니다. 글자마다 지금 가능한 상태들의 집합만 들고 갑니다. */
export function runGlob(g: CompiledGlob, text: string): boolean {
  let cur = closure(g.nodes, [0]);
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k] as string;
    const next = new Set<number>();
    for (const s of cur) {
      for (const e of (g.nodes[s] as GlobNode).edges) {
        const ok = e.kind === 'ch' ? e.ch === ch : e.kind === 'notSlash' ? ch !== '/' : !LINE_BREAK.has(ch);
        if (ok) next.add(e.to);
      }
    }
    if (next.size === 0) return false;
    cur = closure(g.nodes, next);
  }
  return cur.has(g.accept);
}

/**
 * '*' 만 특별한 와일드카드 비교 (그 밖의 글자는 그대로). 전체가 맞아야 합니다.
 * '*' 를 만나면 위치를 기억해 두고, 어긋나면 마지막 '*' 가 한 글자 더 먹게 하는 고전적인 방법입니다.
 */
export function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = t;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/** 상대 경로 정리: './' 제거, 역슬래시를 '/' 로. */
export function normalizeRelPath(p: string): string {
  let s = p.replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

export function matchPath(pattern: string, relPath: string): boolean {
  return runGlob(compileGlob(normalizeRelPath(pattern)), normalizeRelPath(relPath));
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
  return wildcardMatch(pattern.trim(), command.trim());
}

/** 채널·대상 매칭: 대소문자 무시, `*` 는 모두. */
export function matchTarget(pattern: string, target: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (p === '*') return true;
  return p === target.trim().toLowerCase();
}
