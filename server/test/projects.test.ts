import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Config } from '../src/config/env.ts';
import { Db } from '../src/db/sqlite.ts';
import { Store, type AgentRow } from '../src/db/store.ts';
import { EventBus } from '../src/events/bus.ts';
import { GIT_FILES_SHOWN, hardeningArgs, parseLastCommit, parseStatus, readGitInfo, scanRepoConfig } from '../src/projects/git.ts';
import { PROJECT_EVENTS_KEEP, ProjectService } from '../src/projects/service.ts';
import type { ToolEnv } from '../src/tools/types.ts';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-proj-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function setup() {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'data-'));
  const store = new Store(new Db(':memory:'));
  const bus = new EventBus(store);
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const svc = new ProjectService({
    config: { dataDir, gitBin: 'git' } as Config,
    store,
    bus,
    home,
    realpath: (p) => fs.realpathSync.native(p),
    workspaceOf: (id) => {
      const d = path.join(dataDir, 'workspaces', id);
      fs.mkdirSync(d, { recursive: true });
      return fs.realpathSync.native(d);
    },
  });
  const key = store.insertKey({ label: 'k', source: 'stored', cipher: 'x', last4: '0000' }, null);
  const agent = (id: string, folders: AgentRow['folders'] = []): AgentRow =>
    store.insertAgent({
      id,
      name: id,
      color: '#000000',
      role: '',
      model: 'm',
      effort: null,
      keyId: key.id,
      preset: 'p',
      permissions: {},
      limits: { tokensPerDay: 1000, stepsPerTask: 5, concurrency: 1, messagesPerMinute: 5 },
      paused: false,
      delegation: { accept: false, send: false, supervisorId: null },
      folders,
    });
  return { store, svc, home, agent, dataDir };
}

const envOf = (agent: AgentRow, workspace: string, taskId: string, over: Partial<ToolEnv> = {}): ToolEnv =>
  ({ agent, workspace, taskId, signal: new AbortController().signal, delegation: null, quiet: false, sourceLabel: '웹 콘솔', ...over }) as unknown as ToolEnv;

describe('셸 명령이 일한 폴더', () => {
  const { svc } = setup();
  const ws = '/w';
  it.each([
    ['npm test', { workDir: '/w', created: [] }],
    ['cd shop && npm test', { workDir: '/w/shop', created: [] }],
    ['cd ~/shop', { workDir: '/w/shop', created: [] }],
    ['git clone https://example.com/org/shop-api.git', { workDir: '/w', created: ['/w/shop-api'] }],
    ['git clone https://example.com/org/shop-api.git api', { workDir: '/w', created: ['/w/api'] }],
    ['git clone --depth 1 https://example.com/org/x', { workDir: '/w', created: ['/w/x'] }],
    ['mkdir app && cd app && git init', { workDir: '/w', created: ['/w/app'] }],
    ['git init repo2', { workDir: '/w', created: ['/w/repo2'] }],
    ['git -C sub clone -b main --depth=1 git@example.com:org/tool.git', { workDir: '/w', created: ['/w/sub/tool'] }],
    ['git clone -- https://example.com/a.git b', { workDir: '/w', created: ['/w/b'] }],
    ['git status', { workDir: '/w', created: [] }],
  ])('%s', (command, expected) => {
    expect(svc.shellDirs(command, ws, ws)).toEqual(expected);
  });
});

describe('등록 · 상태', () => {
  it('작업 폴더 · 허용 폴더 밖, 없는 폴더, 파일은 등록하지 않고 이유를 알려 줍니다', () => {
    const { svc, agent, home } = setup();
    const a = agent('a1');
    const ws = svc.areas(a)[0]!.root;
    const outside = fs.mkdtempSync(path.join(home, 'x-'));
    expect(() => svc.track(a, outside, {}, { origin: 'manual', detail: '', taskId: null })).toThrow('작업 폴더 · 허용 폴더 밖이라');
    expect(() => svc.track(a, path.join(ws, 'nope'), {}, { origin: 'manual', detail: '', taskId: null })).toThrow('폴더가 없습니다');
    fs.writeFileSync(path.join(ws, 'f.txt'), 'x');
    expect(() => svc.track(a, path.join(ws, 'f.txt'), {}, { origin: 'manual', detail: '', taskId: null })).toThrow('폴더가 아닙니다');
  });

  it('같은 경로를 다시 등록하면 새로 만들지 않고 넘긴 값만 고칩니다', () => {
    const { svc, agent } = setup();
    const a = agent('a1');
    const dir = path.join(svc.areas(a)[0]!.root, 'shop');
    fs.mkdirSync(dir);
    const first = svc.track(a, dir, { note: '처음' }, { origin: 'instruction', detail: '콘솔', taskId: null });
    const again = svc.track(a, dir, { watch: true }, { origin: 'self', detail: '하트비트', taskId: null });
    expect(again.created).toBe(false);
    expect(again.row.id).toBe(first.row.id);
    expect(again.row).toMatchObject({ note: '처음', watch: true, origin: 'instruction' });
  });

  it('허용 폴더에서 빠지면 접근 불가, 폴더가 사라지면 경로 없음으로 보입니다', () => {
    const { svc, agent, store, home } = setup();
    const shared = fs.mkdtempSync(path.join(home, 'work-'));
    const a = agent('a1', [{ path: shared, mode: 'write' }]);
    const dir = path.join(shared, 'pipeline');
    fs.mkdirSync(dir);
    const { row } = svc.track(a, dir, {}, { origin: 'manual', detail: '', taskId: null });
    expect(svc.view(row, a)).toMatchObject({ status: 'ok', mode: 'write' });
    const noFolder = store.updateAgent(a.id, { folders: [] });
    expect(svc.view(row, noFolder)).toMatchObject({ status: 'denied', mode: null, area: '허용 폴더에서 빠짐' });
    fs.rmSync(dir, { recursive: true });
    expect(svc.view(row, a).status).toBe('missing');
  });

  it("화면 등록: '작업 폴더/…' · '~/…' 를 풀고, 상대 경로는 이유와 함께 거절합니다", () => {
    const { svc, agent, home } = setup();
    const shared = fs.mkdtempSync(path.join(home, 'work-'));
    const a = agent('a1', [{ path: shared, mode: 'read' }]);
    fs.mkdirSync(path.join(svc.areas(a)[0]!.root, 'blog'));
    expect(svc.trackManual(a, '작업 폴더/blog', {}).origin).toBe('manual');
    expect(svc.trackManual(a, `~/${path.basename(shared)}`, { watch: true }).watch).toBe(true);
    expect(() => svc.trackManual(a, 'blog', {})).toThrow("절대 경로나 '~/…', '작업 폴더/…' 로 적으세요");
    expect(() => svc.trackManual(a, '작업 폴더/blog', {})).toThrow('이미');
  });
});

describe('도구를 쓴 뒤: 자동 등록 · 활동 기록', () => {
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  };

  it('쓰기 영역의 git 저장소에서 파일을 쓰면 저장소 뿌리를 자동 등록하고 활동을 남깁니다', () => {
    const { svc, agent, store } = setup();
    const a = agent('a1');
    const ws = svc.areas(a)[0]!.root;
    const repo = path.join(ws, 'shop-api');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    git(repo, 'init');
    const task = store.insertTask({ agentId: a.id, threadId: store.getOrCreateThread(a.id, 'console', '웹 콘솔').id, title: '주문 API 정리', origin: 'console' });
    svc.afterTool(envOf(a, ws, task.id), 'fs_write', { path: 'shop-api/src/a.ts' }, { permission: 'fs.write', target: null, paths: [path.join(repo, 'src', 'a.ts')], summary: '' }, true);
    const list = store.listProjects(a.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: repo, name: 'shop-api', origin: 'instruction', auto: true });
    expect(list[0]!.originDetail).toContain('주문 API 정리');
    expect(store.listProjectEvents(list[0]!.id, 10)).toMatchObject([{ kind: 'write', label: '파일 쓰기', detail: 'src/a.ts', ok: true }]);
  });

  it('읽기만 했거나 실패한 쓰기는 자동 등록하지 않고, 작업 폴더 자체가 저장소여도 등록하지 않습니다', () => {
    const { svc, agent, store } = setup();
    const a = agent('a1');
    const ws = svc.areas(a)[0]!.root;
    git(ws, 'init');
    const repo = path.join(ws, 'lib');
    fs.mkdirSync(repo);
    git(repo, 'init');
    const task = store.insertTask({ agentId: a.id, threadId: store.getOrCreateThread(a.id, 'console', '웹 콘솔').id, title: 't', origin: 'console' });
    const env = envOf(a, ws, task.id);
    svc.afterTool(env, 'fs_read', {}, { permission: 'fs.read', target: null, paths: [path.join(repo, 'x')], summary: '' }, true);
    svc.afterTool(env, 'fs_write', {}, { permission: 'fs.write', target: null, paths: [path.join(repo, 'x')], summary: '' }, false);
    svc.afterTool(env, 'fs_write', {}, { permission: 'fs.write', target: null, paths: [path.join(ws, 'top.txt')], summary: '' }, true);
    expect(store.listProjects(a.id)).toEqual([]);
  });

  it('git clone 으로 만든 저장소도 명령이 성공하면 등록됩니다 (하트비트 중이면 스스로)', () => {
    const { svc, agent, store } = setup();
    const a = agent('a1');
    const ws = svc.areas(a)[0]!.root;
    const repo = path.join(ws, 'site');
    fs.mkdirSync(repo);
    git(repo, 'init');
    const task = store.insertTask({ agentId: a.id, threadId: store.getOrCreateThread(a.id, 'heartbeat', '하트비트').id, title: '하트비트', origin: 'heartbeat' });
    svc.afterTool(envOf(a, ws, task.id, { quiet: true }), 'shell_exec', { command: 'git clone https://example.com/site.git' }, { permission: 'shell.exec', target: null, summary: '' }, true);
    expect(store.listProjects(a.id)).toMatchObject([{ path: repo, origin: 'self', originDetail: '하트비트 점검' }]);
  });

  it(`활동은 프로젝트마다 ${PROJECT_EVENTS_KEEP}개만 남기고, 가장 안쪽 프로젝트에 남깁니다`, () => {
    const { svc, agent, store } = setup();
    const a = agent('a1');
    const ws = svc.areas(a)[0]!.root;
    const outer = path.join(ws, 'mono');
    const inner = path.join(outer, 'pkg');
    fs.mkdirSync(inner, { recursive: true });
    const o = svc.track(a, outer, {}, { origin: 'manual', detail: '', taskId: null }).row;
    const i = svc.track(a, inner, {}, { origin: 'manual', detail: '', taskId: null }).row;
    const task = store.insertTask({ agentId: a.id, threadId: store.getOrCreateThread(a.id, 'console', '웹 콘솔').id, title: 't', origin: 'console' });
    for (let n = 0; n < PROJECT_EVENTS_KEEP + 7; n += 1) {
      svc.afterTool(envOf(a, ws, task.id), 'fs_read', {}, { permission: 'fs.read', target: null, paths: [path.join(inner, `f${n}.txt`)], summary: '' }, true);
    }
    expect(store.listProjectEvents(i.id, 100)).toHaveLength(PROJECT_EVENTS_KEEP);
    expect(store.listProjectEvents(i.id, 1)[0]!.detail).toBe(`f${PROJECT_EVENTS_KEEP + 6}.txt`);
    expect(store.listProjectEvents(o.id, 100)).toHaveLength(0);
    expect(store.getProject(i.id).lastActivity).toBe(`파일 읽기 · f${PROJECT_EVENTS_KEEP + 6}.txt`);
  });
});

describe('git 정보 해석', () => {
  it('브랜치 · 원격 · 앞섬/뒤처짐 · 바뀐 파일 (공백 · 이름 바뀜 · 새 파일)', () => {
    const out = [
      '# branch.oid 3a91c2e0',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a b.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts',
      'old name.ts',
      '? notes/todo.md',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '',
    ].join('\0');
    expect(parseStatus(out)).toEqual({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      changed: 4,
      files: [
        { code: 'M', path: 'src/a b.ts' },
        { code: 'R', path: 'new name.ts' },
        { code: '??', path: 'notes/todo.md' },
        { code: 'U', path: 'conflict.ts' },
      ],
    });
  });

  it(`분리된 HEAD · 원격 없음 · 바뀐 파일이 많으면 앞의 ${GIT_FILES_SHOWN}개만`, () => {
    const files = Array.from({ length: GIT_FILES_SHOWN + 5 }, (_, i) => `? f${i}`);
    const r = parseStatus(['# branch.head (detached)', ...files, ''].join('\0'));
    expect(r).toMatchObject({ branch: null, upstream: null, ahead: 0, behind: 0, changed: GIT_FILES_SHOWN + 5 });
    expect(r.files).toHaveLength(GIT_FILES_SHOWN);
  });

  it('마지막 커밋: 없거나 형식이 다르면 null', () => {
    expect(parseLastCommit('3a91c2e\x1f주문 조회\x1f1760000000\n')).toEqual({ hash: '3a91c2e', subject: '주문 조회', at: 1760000000000 });
    expect(parseLastCommit('')).toBeNull();
    expect(parseLastCommit('abc\x1fx\x1fnot-a-time')).toBeNull();
  });

  it('저장소 설정: filter 이름을 모아 끄고, include 가 있으면 읽지 않습니다', () => {
    expect(scanRepoConfig('[core]\n\tbare = false\n[filter "lfs"]\n\tclean = git-lfs clean\n[filter "e\\"vil"]\n\tclean = x')).toEqual({ filters: ['lfs', 'e"vil'] });
    expect(scanRepoConfig('[include]\n\tpath = ../other')).toHaveProperty('refuse');
    expect(scanRepoConfig('[includeIf "gitdir:~/x/"]\n\tpath = y')).toHaveProperty('refuse');
    expect(hardeningArgs(['lfs'])).toEqual(expect.arrayContaining(['-c', 'core.fsmonitor=false', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=']));
  });
});

describe('git 정보 읽기: 저장소에 심은 명령이 서버에서 돌지 않음 (실제 git)', () => {
  it('core.fsmonitor 와 clean filter 에 적은 명령을 실행하지 않고 정보를 읽습니다', async () => {
    const repo = fs.mkdtempSync(path.join(tmp, 'evil-'));
    const marker = path.join(tmp, `pwned-${Date.now()}`);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init'], { cwd: repo, stdio: 'ignore', env });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    execFileSync('git', ['add', 'a.txt'], { cwd: repo, stdio: 'ignore', env });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', '첫 커밋'], { cwd: repo, stdio: 'ignore', env });
    // 에이전트가 쓸 수 있는 곳이라 .git/config 에 명령을 심을 수 있습니다.
    fs.appendFileSync(path.join(repo, '.git', 'config'), `[core]\n\tfsmonitor = touch ${marker}-fsmonitor\n[filter "evil"]\n\tclean = touch ${marker}-filter\n\trequired = true\n`);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* filter=evil\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    const r = await readGitInfo(repo, 'git', path.join(tmp, 'git-home'));
    expect(fs.existsSync(`${marker}-fsmonitor`)).toBe(false);
    expect(fs.existsSync(`${marker}-filter`)).toBe(false);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.info.branch).toBe('main');
      expect(r.info.commit?.subject).toBe('첫 커밋');
      expect(r.info.files.map((f) => f.path)).toEqual(expect.arrayContaining(['a.txt', '.gitattributes']));
    }
  });

  it('include 로 다른 설정을 끌어오는 저장소는 읽지 않고 이유를 알려 줍니다', async () => {
    const repo = fs.mkdtempSync(path.join(tmp, 'inc-'));
    execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    fs.appendFileSync(path.join(repo, '.git', 'config'), '[include]\n\tpath = ../../evil.cfg\n');
    expect(await readGitInfo(repo, 'git', path.join(tmp, 'git-home'))).toEqual({ ok: false, reason: 'git 설정에 다른 설정 파일을 끌어오는 include 가 있어 git 정보를 읽지 않았습니다.' });
  });

  it('git 저장소가 아닌 폴더 · 없는 git 프로그램', async () => {
    const plain = fs.mkdtempSync(path.join(tmp, 'plain-'));
    expect(await readGitInfo(plain, 'git', path.join(tmp, 'git-home'))).toEqual({ ok: false, reason: 'git 저장소가 아닙니다.' });
    const repo = fs.mkdtempSync(path.join(tmp, 'nogit-'));
    fs.mkdirSync(path.join(repo, '.git'));
    const r = await readGitInfo(repo, path.join(tmp, 'no-such-git'), path.join(tmp, 'git-home'));
    expect(r.ok === false ? r.reason : '').toContain('을 찾지 못했습니다. GIT_BIN 을 확인하세요');
  });
});
