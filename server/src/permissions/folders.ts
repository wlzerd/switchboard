/**
 * 허용 폴더: 작업 폴더 밖에서 에이전트가 쓸 수 있도록 사용자가 화면에서 정한 폴더.
 * 에이전트는 스스로 늘릴 수 없고, 폴더마다 읽기만(read) · 읽기·쓰기(write) 중 하나입니다.
 * 경로 비교는 심볼릭 링크와 대소문자를 운영체제가 푼 실제 경로(realpath.native)로 하며, 모든 함수는 재귀 없이 동작합니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.ts';

export type FolderMode = 'read' | 'write';

export interface AllowedFolder {
  /** 실제 절대 경로 (저장할 때 심볼릭 링크를 푼 값) */
  path: string;
  mode: FolderMode;
}

export const FOLDERS_MAX = 20;
const PATH_MAX = 1000;

export interface FolderPolicyEnv {
  home: string;
  /** Switchboard 설치 폴더 (서버 코드 · .env) */
  rootDir: string;
  /** DATA_DIR (DB · 다른 에이전트의 작업 폴더 · 코드 훅) */
  dataDir: string;
  platform: NodeJS.Platform;
  /** 기본 금지 조항의 비밀 폴더 이름 (.ssh 등) */
  secretDirs: readonly string[];
}

export interface FsProbe {
  realpath(p: string): string;
  isDirectory(p: string): boolean;
}

export const realFs: FsProbe = {
  realpath: (p) => fs.realpathSync.native(p),
  isDirectory: (p) => fs.statSync(p).isDirectory(),
};

/** root 안(같은 경로 포함)인지. 이름 앞부분만 같은 형제('/a/b' 와 '/a/bc')나 '..foo' 같은 이름은 상위로 보지 않습니다. */
export function isInsidePath(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/** '~' 와 '~/…' 를 홈 기준 경로로 풉니다. 그 밖의 문자열은 그대로 둡니다. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** '~이름' 처럼 다른 사용자의 홈을 가리키는 형식인지 */
export function isTildeUser(p: string): boolean {
  return /^~[^/]/.test(p);
}

/** 화면 · 승인 카드용: 홈 아래면 '~/…' 로 줄입니다. */
export function displayPath(abs: string, home: string): string {
  if (!isInsidePath(home, abs)) return abs;
  const rel = path.relative(home, abs);
  return rel === '' ? '~' : `~/${rel.split(path.sep).join('/')}`;
}

/** 존재하는 가장 깊은 조상까지 실제 경로로 풀고, 아직 없는 나머지 이름은 그대로 붙입니다. */
export function realpathNearest(abs: string, realpath: (p: string) => string): string {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpath(cur);
      return rest.length > 0 ? path.join(real, ...rest) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 도구에 들어온 경로를 실제 절대 경로로. 상대 경로는 작업 폴더 기준, '~/' 는 서버 계정의 홈 기준입니다.
 * 여기서는 위치만 풀고, 들어가도 되는 곳인지는 accessProblem(기본 금지 조항)이 판단합니다.
 */
export function resolveToolPath(input: string, workspace: string, home: string, realpath: (p: string) => string): string {
  const p = input.trim() === '' ? '.' : input.trim();
  if (isTildeUser(p)) throw new ValidationError('path_tilde_user', `'${p}' 처럼 다른 사용자의 홈을 가리키는 경로는 쓸 수 없습니다.`);
  const expanded = expandHome(p, home);
  const abs = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(workspace, expanded);
  return realpathNearest(abs, realpath);
}

export type FolderArea = { kind: 'workspace' } | { kind: 'folder'; folder: AllowedFolder };

/** 실제 경로가 드는 영역: 작업 폴더가 먼저, 그다음 가장 깊은(구체적인) 허용 폴더. 어디에도 없으면 null. */
export function areaOf(real: string, workspace: string, folders: readonly AllowedFolder[]): FolderArea | null {
  if (isInsidePath(workspace, real)) return { kind: 'workspace' };
  let best: AllowedFolder | null = null;
  for (const f of folders) {
    if (isInsidePath(f.path, real) && (best === null || f.path.length > best.path.length)) best = f;
  }
  return best ? { kind: 'folder', folder: best } : null;
}

export function folderLabel(f: AllowedFolder, home: string): string {
  return `${displayPath(f.path, home)}(${f.mode === 'write' ? '읽기·쓰기' : '읽기만'})`;
}

/**
 * 접근 검사. 문제가 있으면 에이전트에게 돌려줄 문구, 없으면 null.
 * need='write' 는 파일 쓰기와 셸 명령(무엇을 바꿀지 알 수 없음)에 씁니다.
 */
export function accessProblem(real: string, need: FolderMode, workspace: string, folders: readonly AllowedFolder[], home: string, shown: string): string | null {
  const area = areaOf(real, workspace, folders);
  if (!area) {
    const list =
      folders.length === 0
        ? '허용 폴더가 없습니다. 꼭 필요하면 사용자에게 권한 · 훅 화면에서 그 폴더를 허용 폴더로 추가해 달라고 요청하세요.'
        : `허용 폴더: ${folders.map((f) => folderLabel(f, home)).join(', ')}`;
    return `${shown} 는 작업 폴더와 허용 폴더 밖입니다. ${list}`;
  }
  if (area.kind === 'folder' && need === 'write' && area.folder.mode === 'read') {
    return `${shown} 는 읽기만 허용된 폴더(${displayPath(area.folder.path, home)}) 안이라 쓸 수 없습니다.`;
  }
  return null;
}

/** 허용 폴더로 둘 수 없는 운영체제 폴더 (안이거나 그 폴더를 품는 경우 모두) */
export function systemDirs(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/dev', '/cores'];
  if (platform === 'linux') return ['/bin', '/sbin', '/usr', '/lib', '/lib32', '/lib64', '/libx32', '/etc', '/boot', '/dev', '/proc', '/sys', '/run'];
  return [];
}

function safeReal(p: string, probe: FsProbe): string {
  try {
    return probe.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** API 로 들어온 허용 폴더 목록 검사. 무엇이 왜 안 되는지 항목마다 정확히 알려 줍니다. */
export function validateFolders(raw: unknown, env: FolderPolicyEnv, probe: FsProbe = realFs): AllowedFolder[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError('folders_type', '허용 폴더는 [{ path, mode }] 형태의 배열이어야 합니다.');
  if (raw.length > FOLDERS_MAX) throw new ValidationError('folders_too_many', `허용 폴더는 ${FOLDERS_MAX}개까지 정할 수 있습니다. 지금 ${raw.length}개입니다.`);
  const home = safeReal(env.home, probe);
  const guarded: [string, string][] = [
    [safeReal(env.rootDir, probe), 'Switchboard 설치 폴더'],
    [safeReal(env.dataDir, probe), 'Switchboard 데이터 폴더(DATA_DIR)'],
  ];
  const out: AllowedFolder[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i] as unknown;
    const n = i + 1;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new ValidationError('folder_type', `${n}번째 허용 폴더가 { path, mode } 형태가 아닙니다.`, { index: i });
    const { path: p, mode } = item as { path?: unknown; mode?: unknown };
    if (mode !== 'read' && mode !== 'write') {
      throw new ValidationError('folder_mode', `${n}번째 허용 폴더의 mode 는 'read'(읽기만) 또는 'write'(읽기·쓰기)여야 합니다. 받은 값: ${JSON.stringify(mode)}`, { index: i });
    }
    if (typeof p !== 'string' || p.trim() === '') throw new ValidationError('folder_path_empty', `${n}번째 허용 폴더의 경로가 비어 있습니다.`, { index: i });
    const typed = p.trim();
    if (typed.length > PATH_MAX) throw new ValidationError('folder_path_long', `${n}번째 허용 폴더의 경로가 ${PATH_MAX}자를 넘습니다.`, { index: i });
    if (isTildeUser(typed)) throw new ValidationError('folder_tilde_user', `'${typed}' 처럼 다른 사용자의 홈을 가리키는 경로는 쓸 수 없습니다.`, { index: i });
    const expanded = expandHome(typed, env.home);
    if (!path.isAbsolute(expanded)) throw new ValidationError('folder_relative', `'${typed}'은(는) 절대 경로가 아닙니다. / 나 ~/ 로 시작하는 서버 컴퓨터의 폴더 경로를 넣으세요.`, { index: i });

    let real: string;
    try {
      real = probe.realpath(path.resolve(expanded));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new ValidationError('folder_missing', `'${typed}' 폴더가 없습니다. 서버 컴퓨터에 있는 폴더 경로인지 확인하세요.`, { index: i });
      if (code === 'EACCES' || code === 'EPERM') throw new ValidationError('folder_denied', `'${typed}' 폴더에 서버 프로세스가 접근할 권한이 없습니다 (${code}).`, { index: i });
      throw new ValidationError('folder_unreadable', `'${typed}' 폴더를 확인하지 못했습니다: ${(err as Error).message}`, { index: i });
    }
    let isDir: boolean;
    try {
      isDir = probe.isDirectory(real);
    } catch (err) {
      throw new ValidationError('folder_unreadable', `'${typed}' 폴더를 확인하지 못했습니다: ${(err as Error).message}`, { index: i });
    }
    if (!isDir) throw new ValidationError('folder_not_dir', `'${typed}'은(는) 폴더가 아니라 파일입니다.`, { index: i });

    const shown = displayPath(real, home);
    if (path.dirname(real) === real) throw new ValidationError('folder_root', `디스크 전체(${real})는 허용할 수 없습니다. 작업할 폴더를 고르세요.`, { index: i });
    if (isInsidePath(real, home)) {
      throw new ValidationError('folder_home', `${shown === '~' ? '홈 폴더 전체' : `'${shown}'(홈 폴더를 품는 폴더)`}는 허용할 수 없습니다. 작업할 하위 폴더를 고르세요 (예: ~/Documents/보고서).`, { index: i });
    }
    for (const [dir, what] of guarded) {
      if (isInsidePath(dir, real) || isInsidePath(real, dir)) {
        throw new ValidationError('folder_switchboard', `'${shown}'은(는) ${what}와 겹쳐 허용할 수 없습니다. 서버 코드 · DB · 비밀값 · 훅 파일이 들어 있습니다.`, { index: i });
      }
    }
    for (const sys of systemDirs(env.platform)) {
      if (isInsidePath(sys, real) || isInsidePath(real, sys)) throw new ValidationError('folder_system', `'${shown}'은(는) 운영체제 폴더(${sys})와 겹쳐 허용할 수 없습니다.`, { index: i });
    }
    const secret = real.split(path.sep).find((part) => env.secretDirs.includes(part));
    if (secret) throw new ValidationError('folder_secret', `'${shown}'은(는) 비밀 폴더(${secret}) 안이라 허용할 수 없습니다.`, { index: i });
    if (env.platform === 'darwin') {
      const library = path.join(home, 'Library');
      if (real === library || isInsidePath(path.join(library, 'Keychains'), real)) {
        throw new ValidationError('folder_library', `'${shown}'은(는) 키체인과 앱 데이터가 들어 있어 허용할 수 없습니다. 그 안의 필요한 폴더만 고르세요.`, { index: i });
      }
    }
    if (out.some((f) => f.path === real)) throw new ValidationError('folder_duplicate', `'${shown}'을(를) 두 번 넣었습니다.`, { index: i });
    out.push({ path: real, mode });
  }
  return out;
}

/** 저장된 값 읽기 (DB 의 JSON). 모양이 틀린 항목은 버립니다. */
export function parseFolders(raw: unknown): AllowedFolder[] {
  if (!Array.isArray(raw)) return [];
  const out: AllowedFolder[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const { path: p, mode } = item as { path?: unknown; mode?: unknown };
    if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
    if (mode !== 'read' && mode !== 'write') continue;
    out.push({ path: p, mode });
  }
  return out;
}

/** 폴더이거나 폴더를 가리키는 심볼릭 링크인지 (예: ~/Dropbox 링크) */
function isDirEntry(dir: string, e: fs.Dirent): boolean {
  if (e.isDirectory()) return true;
  if (!e.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(dir, e.name)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 폴더 경로 입력 자동 완성: prefix 가 가리키는 폴더 아래의 하위 폴더 이름들 (파일은 빼고, 숨김 폴더는 '.' 으로 시작할 때만).
 * 화면 표시용이라 실패하면 빈 목록입니다.
 */
export function suggestDirs(prefix: string, home: string, limit = 30): string[] {
  const typed = prefix.trim() === '' ? '~/' : prefix.trim();
  if (isTildeUser(typed)) return [];
  const expanded = expandHome(typed, home);
  if (!path.isAbsolute(expanded)) return [];
  const endsWithSep = typed.endsWith('/');
  const dir = endsWithSep ? expanded : path.dirname(expanded);
  const start = endsWithSep ? '' : path.basename(expanded);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const lower = start.toLowerCase();
  const out: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isDirEntry(dir, e)) continue;
    if (e.name.startsWith('.') && !start.startsWith('.')) continue;
    if (!e.name.toLowerCase().startsWith(lower)) continue;
    out.push(`${displayPath(path.join(dir, e.name), home)}/`);
    if (out.length >= limit) break;
  }
  return out;
}
