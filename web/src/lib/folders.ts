/** 허용 폴더 입력 검사 (서버 규칙의 앞부분과 같음. 폴더가 실제로 있는지 · 막힌 폴더인지는 서버가 확인) */

export type FolderMode = 'read' | 'write';

export interface FolderView {
  path: string;
  mode: FolderMode;
}

export const FOLDERS_MAX = 20;

/** 앞뒤 공백과 끝의 슬래시를 지웁니다 ('/' 와 '~/' 자체는 남김). */
export function normalizeFolderInput(raw: string): string {
  const t = raw.trim();
  if (t === '/' || t === '~/') return t;
  return t.replace(/\/+$/, '');
}

/** 추가하려는 경로의 문제. 없으면 null. */
export function folderInputProblem(raw: string, list: readonly FolderView[]): string | null {
  const p = normalizeFolderInput(raw);
  if (p === '') return '폴더 경로를 입력하세요.';
  if (/^~[^/]/.test(p)) return '~이름 형식(다른 사용자의 홈)은 쓸 수 없습니다.';
  if (p === '~' || p === '~/') return '홈 폴더 전체는 허용할 수 없습니다. 작업할 하위 폴더를 고르세요.';
  if (p === '/') return '디스크 전체(/)는 허용할 수 없습니다.';
  if (!p.startsWith('/') && !p.startsWith('~/')) return '/ 나 ~/ 로 시작하는 서버 컴퓨터의 폴더 경로를 넣으세요.';
  if (list.some((f) => normalizeFolderInput(f.path) === p)) return '이미 넣은 폴더입니다.';
  if (list.length >= FOLDERS_MAX) return `허용 폴더는 ${FOLDERS_MAX}개까지 정할 수 있습니다.`;
  return null;
}

/** 저장된 목록과 고친 목록의 차이 수 (추가 · 삭제 · 범위 변경) */
export function folderChanges(base: readonly FolderView[], draft: readonly FolderView[]): number {
  const b = new Map(base.map((f) => [normalizeFolderInput(f.path), f.mode]));
  const d = new Map(draft.map((f) => [normalizeFolderInput(f.path), f.mode]));
  let n = 0;
  for (const [p, mode] of d) {
    const was = b.get(p);
    if (was === undefined || was !== mode) n += 1;
  }
  for (const p of b.keys()) if (!d.has(p)) n += 1;
  return n;
}

export const MODE_LABEL: Record<FolderMode, string> = { read: '읽기만', write: '읽기·쓰기' };
