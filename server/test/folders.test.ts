import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import guardsJson from '../../config/guards.json' with { type: 'json' };
import { GuardState, runGuards, type GuardEnv } from '../src/guards/guards.ts';
import type { ToolCtx } from '../src/hooks/types.ts';
import {
  FOLDERS_MAX,
  accessProblem,
  areaOf,
  displayPath,
  expandHome,
  isInsidePath,
  isTildeUser,
  parseFolders,
  realpathNearest,
  resolveToolPath,
  suggestDirs,
  validateFolders,
  type AllowedFolder,
  type FolderPolicyEnv,
  type FsProbe,
} from '../src/permissions/folders.ts';

// 실제 디스크에 폴더 구조를 만들어 심볼릭 링크 · 대소문자까지 운영체제가 푸는 그대로 시험합니다.
const T = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-folders-')));
const HOME = path.join(T, 'home');
const REPO = path.join(T, 'apps', 'switchboard');
const DATA = path.join(T, 'srv', 'data');
const WS = path.join(DATA, 'workspaces', 'agt_1');
for (const d of [HOME, path.join(HOME, 'docs', 'sub'), path.join(HOME, 'pics'), path.join(HOME, '.ssh'), REPO, path.join(REPO, 'server'), WS, path.join(T, 'outside')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(HOME, 'note.txt'), 'x');
fs.writeFileSync(path.join(HOME, '.ssh', 'id_rsa'), 'secret');
fs.writeFileSync(path.join(T, 'outside', 'data.txt'), 'x');
fs.symlinkSync(path.join(HOME, 'docs'), path.join(HOME, 'docs-link'));
fs.symlinkSync(path.join(REPO, 'server'), path.join(HOME, 'sneaky'));
fs.symlinkSync(path.join(T, 'outside'), path.join(WS, 'outl'));
fs.symlinkSync(path.join(HOME, '.ssh', 'id_rsa'), path.join(WS, 'innocent'));

afterAll(() => fs.rmSync(T, { recursive: true, force: true }));

const env: FolderPolicyEnv = { home: HOME, rootDir: REPO, dataDir: DATA, platform: 'linux', secretDirs: guardsJson.secretDirectories };
const real = (p: string): string => fs.realpathSync.native(p);
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'no-code';
  }
};

describe('경로 도우미', () => {
  it('isInsidePath: 자기 자신은 안, 이름 앞부분만 같은 형제와 상위는 밖', () => {
    expect(isInsidePath('/a/b', '/a/b')).toBe(true);
    expect(isInsidePath('/a/b', '/a/b/c')).toBe(true);
    expect(isInsidePath('/a/b', '/a/bc')).toBe(false);
    expect(isInsidePath('/a/b', '/a/b/..c')).toBe(true);
    expect(isInsidePath('/a/b', '/a')).toBe(false);
    expect(isInsidePath('/', '/anything')).toBe(true);
  });

  it('~ 풀기와 표시: 홈 자신은 ~, 홈 밖은 그대로, ~이름 은 풀지 않음', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/a/b', '/h')).toBe('/h/a/b');
    expect(expandHome('~bob/a', '/h')).toBe('~bob/a');
    expect(isTildeUser('~bob/a')).toBe(true);
    expect(isTildeUser('~/a')).toBe(false);
    expect(isTildeUser('~')).toBe(false);
    expect(displayPath('/h', '/h')).toBe('~');
    expect(displayPath('/h/a/b', '/h')).toBe('~/a/b');
    expect(displayPath('/hx/a', '/h')).toBe('/hx/a');
  });

  it('realpathNearest: 없는 이름은 붙이고, 존재하는 조상의 링크는 풉니다', () => {
    expect(realpathNearest(path.join(HOME, 'docs-link', 'new', 'a.md'), real)).toBe(path.join(HOME, 'docs', 'new', 'a.md'));
    expect(realpathNearest('/no/such/root/x', () => {
      throw new Error('ENOENT');
    })).toBe('/no/such/root/x');
  });

  it('resolveToolPath: 상대 경로는 작업 폴더, ~/ 는 홈, ~이름 은 거절', () => {
    expect(resolveToolPath('a/b.txt', WS, HOME, real)).toBe(path.join(WS, 'a', 'b.txt'));
    expect(resolveToolPath('', WS, HOME, real)).toBe(WS);
    expect(resolveToolPath('~/docs/x.md', WS, HOME, real)).toBe(path.join(HOME, 'docs', 'x.md'));
    expect(resolveToolPath(path.join(WS, 'outl', 'data.txt'), WS, HOME, real)).toBe(path.join(T, 'outside', 'data.txt'));
    expect(codeOf(() => resolveToolPath('~root/x', WS, HOME, real))).toBe('path_tilde_user');
  });

  it('areaOf: 작업 폴더가 먼저, 겹치는 허용 폴더는 가장 깊은 것', () => {
    const folders: AllowedFolder[] = [
      { path: path.join(HOME, 'docs'), mode: 'read' },
      { path: path.join(HOME, 'docs', 'sub'), mode: 'write' },
    ];
    expect(areaOf(path.join(WS, 'x'), WS, folders)).toEqual({ kind: 'workspace' });
    expect(areaOf(path.join(HOME, 'docs', 'sub', 'x'), WS, folders)).toEqual({ kind: 'folder', folder: folders[1] });
    expect(areaOf(path.join(HOME, 'docs', 'x'), WS, folders)).toEqual({ kind: 'folder', folder: folders[0] });
    expect(areaOf(path.join(HOME, 'docsx'), WS, folders)).toBeNull();
  });

  it('accessProblem: 밖 · 읽기만 폴더 쓰기 · 허용 폴더가 없을 때 문구가 다릅니다', () => {
    const folders: AllowedFolder[] = [{ path: path.join(HOME, 'docs'), mode: 'read' }];
    expect(accessProblem(path.join(HOME, 'docs', 'a'), 'read', WS, folders, HOME, 'a')).toBeNull();
    expect(accessProblem(path.join(HOME, 'docs', 'a'), 'write', WS, folders, HOME, 'a')).toContain('읽기만 허용된 폴더(~/docs)');
    expect(accessProblem('/etc/passwd', 'read', WS, folders, HOME, '/etc/passwd')).toContain('허용 폴더: ~/docs(읽기만)');
    expect(accessProblem('/etc/passwd', 'read', WS, [], HOME, '/etc/passwd')).toContain('허용 폴더로 추가해 달라고 요청');
  });

  it('parseFolders: 저장된 값 중 모양이 틀린 항목만 버립니다', () => {
    expect(parseFolders([{ path: '/a', mode: 'read' }, { path: 'rel', mode: 'read' }, { path: '/b', mode: 'rw' }, null, 'x'])).toEqual([{ path: '/a', mode: 'read' }]);
    expect(parseFolders('nope')).toEqual([]);
  });
});

describe('validateFolders', () => {
  it('없음 · 빈 목록은 빈 목록, 배열이 아니면 거절', () => {
    expect(validateFolders(undefined, env)).toEqual([]);
    expect(validateFolders([], env)).toEqual([]);
    expect(codeOf(() => validateFolders({ path: '/x' }, env))).toBe('folders_type');
  });

  it('~/ 와 링크를 실제 경로로 풀어 저장합니다', () => {
    expect(validateFolders([{ path: '~/docs', mode: 'write' }], env)).toEqual([{ path: path.join(HOME, 'docs'), mode: 'write' }]);
    expect(validateFolders([{ path: path.join(HOME, 'docs-link'), mode: 'read' }], env)).toEqual([{ path: path.join(HOME, 'docs'), mode: 'read' }]);
  });

  it(`개수 경계: ${FOLDERS_MAX}개까지 되고 하나 넘으면 거절`, () => {
    const many = Array.from({ length: FOLDERS_MAX + 1 }, (_, i) => {
      const d = path.join(HOME, 'many', `f${i}`);
      fs.mkdirSync(d, { recursive: true });
      return { path: d, mode: 'read' as const };
    });
    expect(validateFolders(many.slice(0, FOLDERS_MAX), env)).toHaveLength(FOLDERS_MAX);
    expect(codeOf(() => validateFolders(many, env))).toBe('folders_too_many');
  });

  it.each([
    [{ path: '~/docs', mode: 'rw' }, 'folder_mode'],
    [{ path: '  ', mode: 'read' }, 'folder_path_empty'],
    [{ path: 'docs', mode: 'read' }, 'folder_relative'],
    [{ path: '~bob/docs', mode: 'read' }, 'folder_tilde_user'],
    [{ path: '~/nope', mode: 'read' }, 'folder_missing'],
    [{ path: '~/note.txt', mode: 'read' }, 'folder_not_dir'],
    [{ path: '~', mode: 'read' }, 'folder_home'],
    [{ path: T, mode: 'read' }, 'folder_home'],
    [{ path: REPO, mode: 'read' }, 'folder_switchboard'],
    [{ path: path.join(REPO, 'server'), mode: 'read' }, 'folder_switchboard'],
    [{ path: path.join(T, 'apps'), mode: 'read' }, 'folder_switchboard'],
    [{ path: WS, mode: 'write' }, 'folder_switchboard'],
    [{ path: '~/sneaky', mode: 'read' }, 'folder_switchboard'],
    [{ path: '~/.ssh', mode: 'read' }, 'folder_secret'],
    ['~/docs', 'folder_type'],
  ])('%j → %s', (item, code) => {
    expect(codeOf(() => validateFolders([item], env))).toBe(code);
  });

  it('같은 폴더를 다른 표기(~/ · 끝 슬래시 · 링크)로 두 번 넣으면 거절', () => {
    expect(codeOf(() => validateFolders([{ path: '~/docs', mode: 'read' }, { path: `${path.join(HOME, 'docs')}/`, mode: 'write' }], env))).toBe('folder_duplicate');
    expect(codeOf(() => validateFolders([{ path: '~/docs', mode: 'read' }, { path: '~/docs-link', mode: 'write' }], env))).toBe('folder_duplicate');
  });

  it('부모는 읽기만, 자식은 읽기·쓰기처럼 겹쳐 둘 수 있습니다', () => {
    expect(validateFolders([{ path: '~/docs', mode: 'read' }, { path: '~/docs/sub', mode: 'write' }], env)).toHaveLength(2);
  });

  it('운영체제 폴더와 디스크 전체 · macOS 키체인은 거절 (가짜 파일 시스템으로)', () => {
    const probe: FsProbe = { realpath: (p) => path.resolve(p), isDirectory: () => true };
    const mac: FolderPolicyEnv = { home: '/Users/me', rootDir: '/opt/sb', dataDir: '/opt/sb/data', platform: 'darwin', secretDirs: ['.ssh'] };
    expect(codeOf(() => validateFolders([{ path: '/', mode: 'read' }], mac, probe))).toBe('folder_root');
    expect(codeOf(() => validateFolders([{ path: '/usr/local/projects', mode: 'read' }], mac, probe))).toBe('folder_system');
    expect(codeOf(() => validateFolders([{ path: '/private', mode: 'read' }], mac, probe))).toBe('folder_system');
    expect(codeOf(() => validateFolders([{ path: '~/Library', mode: 'read' }], mac, probe))).toBe('folder_library');
    expect(codeOf(() => validateFolders([{ path: '~/Library/Keychains/login', mode: 'read' }], mac, probe))).toBe('folder_library');
    expect(validateFolders([{ path: '~/Library/Mobile Documents', mode: 'write' }], mac, probe)).toEqual([{ path: '/Users/me/Library/Mobile Documents', mode: 'write' }]);
    expect(validateFolders([{ path: '/Volumes/USB/work', mode: 'write' }], mac, probe)).toHaveLength(1);
    const linux: FolderPolicyEnv = { ...mac, home: '/home/me', platform: 'linux' };
    expect(codeOf(() => validateFolders([{ path: '/run/user', mode: 'read' }], linux, probe))).toBe('folder_system');
    expect(validateFolders([{ path: '/var/www/site', mode: 'write' }], linux, probe)).toHaveLength(1);
  });

  it('권한 오류는 원인 코드를 짚어 알려 줍니다', () => {
    const probe: FsProbe = {
      realpath: () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
      isDirectory: () => true,
    };
    expect(codeOf(() => validateFolders([{ path: '/x/y', mode: 'read' }], env, probe))).toBe('folder_denied');
  });
});

describe('기본 금지 조항과 허용 폴더', () => {
  const genv: GuardEnv = { lists: guardsJson, knownSecrets: () => [], selfHosts: [], protectedPaths: [], floodPerMinute: 20, loopRepeat: 5, realpath: real };
  const folders: AllowedFolder[] = [
    { path: path.join(HOME, 'docs'), mode: 'read' },
    { path: path.join(HOME, 'docs', 'sub'), mode: 'write' },
    { path: path.join(HOME, 'pics'), mode: 'write' },
  ];
  const ctx = (over: Partial<ToolCtx>): ToolCtx => ({
    event: 'before_tool',
    agentId: 'a1',
    agentName: '정리이',
    taskId: null,
    now: new Date(),
    tool: 'fs_read',
    category: 'fs.read',
    input: {},
    workspace: WS,
    folders,
    home: HOME,
    command: null,
    paths: [],
    url: null,
    host: null,
    method: null,
    text: null,
    ...over,
  });
  const run = (over: Partial<ToolCtx>) => runGuards(ctx(over), genv, new GuardState());
  const sh = (command: string, cwd?: string) => run({ tool: 'shell_exec', category: 'shell.exec', command, ...(cwd ? { cwd } : {}) });

  it('파일 읽기는 읽기만 폴더에서도, 쓰기는 읽기·쓰기 폴더(가장 깊은 설정)에서만', () => {
    expect(run({ paths: [path.join(HOME, 'docs', 'a.md')] })).toBeNull();
    expect(run({ tool: 'fs_write', category: 'fs.write', paths: [path.join(HOME, 'docs', 'a.md')] })?.reason).toContain('읽기만 허용된 폴더(~/docs)');
    expect(run({ tool: 'fs_write', category: 'fs.write', paths: [path.join(HOME, 'docs', 'sub', 'a.md')] })).toBeNull();
    expect(run({ paths: [path.join(HOME, 'note.txt')] })?.guard).toBe('escape');
  });

  it('허용 폴더가 없으면 예전처럼 작업 폴더만', () => {
    expect(run({ folders: [], paths: [path.join(HOME, 'docs', 'a.md')] })?.reason).toContain('허용 폴더가 없습니다');
  });

  it('셸: 읽기·쓰기 폴더는 되고, 읽기만 폴더는 셸에서 막습니다', () => {
    expect(sh(`ls ${path.join(HOME, 'pics')}`)).toBeNull();
    expect(sh(`cat ${path.join(HOME, 'docs', 'a.md')}`)?.reason).toContain('셸 명령에서 쓸 수 없습니다');
    expect(sh(`cp ${path.join(HOME, 'pics', 'a.png')} ${path.join(HOME, 'docs', 'sub')}/`)).toBeNull();
  });

  it('셸 cwd: 상대 경로는 실행 폴더 기준으로 검사합니다', () => {
    const cwd = path.join(HOME, 'pics');
    expect(sh('mv a.png b.png', cwd)).toBeNull();
    expect(sh('cat ../note.txt', cwd)?.guard).toBe('escape');
    expect(sh('cat ../docs/sub/x.md', cwd)).toBeNull();
  });

  it('작업 폴더 안의 심볼릭 링크로 밖이나 비밀 파일에 닿으면 막습니다', () => {
    expect(sh('cat outl/data.txt')?.guard).toBe('escape');
    expect(sh('cat innocent')?.guard).toBe('secret-files');
    expect(run({ paths: [realpathNearest(path.join(WS, 'outl', 'data.txt'), real)] })?.guard).toBe('escape');
  });
});

describe('폴더 자동 완성', () => {
  it('하위 폴더(폴더를 가리키는 링크 포함)만 · 숨김 폴더는 . 으로 시작할 때만 · ~ 로 표시', () => {
    expect(suggestDirs('~/', HOME)).toEqual(['~/docs/', '~/docs-link/', '~/many/', '~/pics/', '~/sneaky/']);
    expect(suggestDirs('~/do', HOME)).toEqual(['~/docs/', '~/docs-link/']);
    expect(suggestDirs('~/DO', HOME)).toEqual(['~/docs/', '~/docs-link/']);
    expect(suggestDirs('~/.s', HOME)).toEqual(['~/.ssh/']);
    expect(suggestDirs('~/nope/', HOME)).toEqual([]);
    expect(suggestDirs('relative', HOME)).toEqual([]);
    expect(suggestDirs('~bob/', HOME)).toEqual([]);
  });
});
