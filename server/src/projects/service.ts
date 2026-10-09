/**
 * 에이전트가 관리하는 프로젝트(경로).
 *  - 에이전트가 project_track 도구로 등록하거나, git 저장소에서 파일을 쓰면 자동으로 등록됩니다. 사용자는 화면에서 직접 등록할 수 있습니다.
 *  - 등록한 계기(사용자 지시 · 스스로 · 위임 · 직접 등록)와 그 뒤의 도구 활동을 남겨, 어디서 무엇을 하는지 한눈에 봅니다.
 *  - 프로젝트는 작업 폴더나 허용 폴더 안이어야 합니다. 허용 폴더에서 빠지면 '접근 불가'로 보입니다.
 * 폴더 위로 올라가는 탐색은 재귀 없이 반복문으로, 영역의 뿌리에서 멈춥니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.ts';
import type { AgentRow, ProjectEventRow, ProjectOrigin, ProjectRow, Store, TaskRow } from '../db/store.ts';
import { ConflictError, ValidationError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import { displayPath, isInsidePath, realpathNearest, resolveToolPath } from '../permissions/folders.ts';
import { commandArgs, commandName, parseCommand } from '../permissions/shell.ts';
import type { Described, ToolEnv } from '../tools/types.ts';
import { readGitInfo, type GitResult } from './git.ts';

/** git 의 전역 옵션 중 값을 받는 것 (git -C 폴더 clone …) */
const GIT_GLOBAL_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env']);
/** git clone · init 의 옵션 중 값을 받는 것 (--depth 1 처럼 다음 낱말이 값) */
const GIT_SUB_VALUE = new Set(['--depth', '-b', '--branch', '-o', '--origin', '--reference', '--reference-if-able', '--separate-git-dir', '--template', '-c', '--config', '-j', '--jobs', '--filter', '--shallow-since', '--shallow-exclude', '-u', '--upload-pack', '--server-option', '--bundle-uri', '--object-format', '--ref-format', '--shared']);

/** 옵션(과 그 값)을 건너뛴 위치 인자들 */
function positionals(args: readonly string[], valueOpts: ReadonlySet<string>): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i] as string;
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-')) {
      // '--depth=1' 처럼 = 로 붙은 값은 한 낱말
      i += !a.includes('=') && valueOpts.has(a) ? 2 : 1;
      continue;
    }
    out.push(a);
    i += 1;
  }
  return out;
}

/** 프로젝트마다 남기는 활동 수 */
export const PROJECT_EVENTS_KEEP = 50;
/** 에이전트 한 명이 등록할 수 있는 프로젝트 수 */
export const PROJECTS_MAX = 100;

export interface Area {
  root: string;
  mode: 'read' | 'write';
  label: string;
}

export interface ProjectView {
  id: string;
  agentId: string;
  name: string;
  path: string;
  displayPath: string;
  note: string;
  origin: ProjectOrigin;
  originDetail: string;
  watch: boolean;
  auto: boolean;
  createdAt: number;
  lastActivityAt: number | null;
  lastActivity: string | null;
  status: 'ok' | 'missing' | 'denied';
  mode: 'read' | 'write' | null;
  area: string;
  isGit: boolean;
}

export interface ProjectDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  home: string;
  realpath: (p: string) => string;
  workspaceOf: (agentId: string) => string;
}

export class ProjectService {
  private readonly d: ProjectDeps;

  constructor(deps: ProjectDeps) {
    this.d = deps;
  }

  /** 에이전트가 쓸 수 있는 영역: 작업 폴더(쓰기) + 허용 폴더 */
  areas(agent: AgentRow): Area[] {
    const ws = this.d.workspaceOf(agent.id);
    return [
      { root: ws, mode: 'write', label: '작업 폴더' },
      ...agent.folders.map((f) => ({ root: f.path, mode: f.mode, label: `허용 폴더 ${displayPath(f.path, this.d.home)}` })),
    ];
  }

  /** 경로가 드는 가장 구체적인 영역 (허용 폴더 규칙과 같음) */
  areaOf(agent: AgentRow, abs: string): Area | null {
    let best: Area | null = null;
    for (const a of this.areas(agent)) {
      if (!isInsidePath(a.root, abs)) continue;
      if (!best || a.root.length > best.root.length) best = a;
    }
    return best;
  }

  private shown(agent: AgentRow, abs: string): string {
    const ws = this.d.workspaceOf(agent.id);
    if (isInsidePath(ws, abs)) {
      const rel = path.relative(ws, abs);
      return rel === '' ? '작업 폴더' : `작업 폴더/${rel.split(path.sep).join('/')}`;
    }
    return displayPath(abs, this.d.home);
  }

  view(p: ProjectRow, agent: AgentRow): ProjectView {
    const exists = fs.existsSync(p.path);
    const area = this.areaOf(agent, p.path);
    const status: ProjectView['status'] = !exists ? 'missing' : area ? 'ok' : 'denied';
    let isGit = false;
    try {
      isGit = exists && fs.statSync(path.join(p.path, '.git')).isDirectory();
    } catch {
      isGit = false;
    }
    return {
      id: p.id,
      agentId: p.agentId,
      name: p.name,
      path: p.path,
      displayPath: this.shown(agent, p.path),
      note: p.note,
      origin: p.origin,
      originDetail: p.originDetail,
      watch: p.watch,
      auto: p.auto,
      createdAt: p.createdAt,
      lastActivityAt: p.lastActivityAt,
      lastActivity: p.lastActivity,
      status,
      mode: area?.mode ?? null,
      area: area ? area.label : '허용 폴더에서 빠짐',
      isGit,
    };
  }

  list(agentId?: string): ProjectView[] {
    const agents = new Map(this.d.store.listAgents().map((a) => [a.id, a]));
    const out: ProjectView[] = [];
    for (const p of this.d.store.listProjects(agentId)) {
      const a = agents.get(p.agentId);
      if (a) out.push(this.view(p, a));
    }
    return out;
  }

  /** 하트비트 점검에 넣을 프로젝트 (접근할 수 있는 것만) */
  watched(agent: AgentRow): ProjectView[] {
    return this.list(agent.id).filter((p) => p.watch && p.status === 'ok');
  }

  /** 사람이 읽을 등록 계기: 작업이 어디서 왔는지로 정합니다. */
  originOf(task: TaskRow | null, env: Pick<ToolEnv, 'delegation' | 'quiet' | 'sourceLabel'>): { origin: ProjectOrigin; detail: string } {
    if (env.delegation) {
      const from = this.d.store.findAgent(env.delegation.fromAgentId)?.name ?? '다른 에이전트';
      return { origin: 'delegation', detail: `${from}이(가) 맡긴 일${task ? ` · ${task.title}` : ''}` };
    }
    if (task?.origin === 'heartbeat') return { origin: 'self', detail: '하트비트 점검' };
    if (task?.origin === 'schedule') return { origin: 'self', detail: env.sourceLabel };
    if (env.quiet) return { origin: 'self', detail: `자동 알림 · ${env.sourceLabel}` };
    return { origin: 'instruction', detail: `${env.sourceLabel}${task ? ` · ${task.title}` : ''}`.slice(0, 200) };
  }

  /**
   * 등록하거나(없으면) 이름 · 메모 · 점검 여부를 고칩니다(있으면). abs 는 이미 실제 경로로 푼 값.
   * 작업 폴더나 허용 폴더 안의 폴더여야 합니다.
   */
  track(agent: AgentRow, abs: string, input: { name?: string; note?: string; watch?: boolean }, origin: { origin: ProjectOrigin; detail: string; taskId: string | null }, auto = false): { row: ProjectRow; created: boolean } {
    const shown = this.shown(agent, abs);
    if (!this.areaOf(agent, abs)) throw new ValidationError('project_outside', `'${shown}'은(는) ${agent.name}의 작업 폴더 · 허용 폴더 밖이라 프로젝트로 등록할 수 없습니다. 권한 · 훅 화면에서 허용 폴더를 먼저 추가하세요.`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new ValidationError('project_missing', `'${shown}' 폴더가 없습니다. 먼저 만든 뒤 등록하세요.`);
    }
    if (!stat.isDirectory()) throw new ValidationError('project_not_dir', `'${shown}'은(는) 폴더가 아닙니다. 프로젝트는 폴더로 등록합니다.`);
    const name = (input.name ?? '').trim().slice(0, 60) || path.basename(abs) || shown;
    const note = (input.note ?? '').trim().slice(0, 300);
    const existing = this.d.store.findProjectByPath(agent.id, abs);
    if (existing) {
      const patch: Partial<Pick<ProjectRow, 'name' | 'note' | 'watch'>> = {};
      if (input.name !== undefined && input.name.trim() !== '') patch.name = name;
      if (input.note !== undefined) patch.note = note;
      if (input.watch !== undefined) patch.watch = input.watch;
      const row = Object.keys(patch).length > 0 ? this.d.store.updateProject(existing.id, patch) : existing;
      return { row, created: false };
    }
    if (this.d.store.listProjects(agent.id).length >= PROJECTS_MAX) {
      throw new ConflictError('projects_many', `${agent.name}의 프로젝트가 ${PROJECTS_MAX}개라 더 등록할 수 없습니다. 더 관리하지 않는 프로젝트를 목록에서 빼세요.`);
    }
    const row = this.d.store.insertProject({ agentId: agent.id, path: abs, name, note, origin: origin.origin, originDetail: origin.detail.slice(0, 200), originTaskId: origin.taskId, watch: input.watch === true, auto });
    this.d.bus.activity({ type: 'project.tracked', category: 'agent', tone: 'new', who: agent.name, text: `프로젝트 ${auto ? '자동 ' : ''}등록 · ${name} · ${shown}`, agentId: agent.id, data: { projectId: row.id } });
    this.d.bus.emit({ type: 'graph.changed' });
    return { row, created: true };
  }

  /** 화면에서 직접 등록: 경로 문자열('~/…' · 절대 경로 · '작업 폴더/…')을 풀어 검사합니다. */
  trackManual(agent: AgentRow, rawPath: unknown, input: { name?: unknown; note?: unknown; watch?: unknown }): ProjectRow {
    if (typeof rawPath !== 'string' || rawPath.trim() === '') throw new ValidationError('project_path_empty', '경로를 입력하세요.');
    const ws = this.d.workspaceOf(agent.id);
    let p = rawPath.trim();
    if (p === '작업 폴더' || p.startsWith('작업 폴더/')) p = path.join(ws, p.slice('작업 폴더'.length));
    else if (!p.startsWith('/') && !p.startsWith('~')) throw new ValidationError('project_path_relative', `'${rawPath.trim()}': 절대 경로나 '~/…', '작업 폴더/…' 로 적으세요.`);
    let abs: string;
    try {
      abs = resolveToolPath(p, ws, this.d.home, this.d.realpath);
    } catch (err) {
      throw new ValidationError('project_path', (err as Error).message);
    }
    if (this.d.store.findProjectByPath(agent.id, abs)) throw new ConflictError('project_exists', `'${this.shown(agent, abs)}'은(는) 이미 ${agent.name}의 프로젝트로 등록되어 있습니다.`);
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    return this.track(agent, abs, { name: str(input.name), note: str(input.note), watch: input.watch === true }, { origin: 'manual', detail: '화면에서 등록', taskId: null }).row;
  }

  update(id: string, raw: { name?: unknown; note?: unknown; watch?: unknown }): ProjectRow {
    const cur = this.d.store.getProject(id);
    const patch: Partial<Pick<ProjectRow, 'name' | 'note' | 'watch'>> = {};
    if (raw.name !== undefined) {
      if (typeof raw.name !== 'string' || raw.name.trim() === '') throw new ValidationError('project_name', '프로젝트 이름이 비어 있습니다.');
      if (raw.name.trim().length > 60) throw new ValidationError('project_name_long', `프로젝트 이름은 60자까지 쓸 수 있습니다. 지금 ${raw.name.trim().length}자입니다.`);
      patch.name = raw.name.trim();
    }
    if (raw.note !== undefined) {
      if (typeof raw.note !== 'string') throw new ValidationError('project_note', '메모는 문자열이어야 합니다.');
      if (raw.note.trim().length > 300) throw new ValidationError('project_note_long', `메모는 300자까지 쓸 수 있습니다. 지금 ${raw.note.trim().length}자입니다.`);
      patch.note = raw.note.trim();
    }
    if (raw.watch !== undefined) {
      if (typeof raw.watch !== 'boolean') throw new ValidationError('project_watch', 'watch 는 true 또는 false 여야 합니다.');
      patch.watch = raw.watch;
    }
    const row = this.d.store.updateProject(cur.id, patch);
    if (patch.watch !== undefined && patch.watch !== cur.watch) this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  /** 목록에서만 뺍니다. 폴더와 파일은 그대로입니다. */
  remove(id: string): ProjectRow {
    const row = this.d.store.getProject(id);
    this.d.store.deleteProject(id);
    const agent = this.d.store.findAgent(row.agentId);
    this.d.bus.activity({ type: 'project.untracked', category: 'agent', tone: 'agent', who: agent?.name ?? '에이전트', text: `프로젝트 목록에서 뺌 · ${row.name}`, agentId: row.agentId });
    this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  events(id: string, limit = 20): ProjectEventRow[] {
    return this.d.store.listProjectEvents(id, limit);
  }

  git(row: ProjectRow): Promise<GitResult> {
    return readGitInfo(row.path, this.d.config.gitBin, path.join(this.d.config.dataDir, 'tmp', 'git-home'));
  }

  /** 경로를 품은 가장 구체적인 등록 프로젝트 */
  private projectFor(agentId: string, abs: string): ProjectRow | null {
    let best: ProjectRow | null = null;
    for (const p of this.d.store.listProjects(agentId)) {
      if (!isInsidePath(p.path, abs)) continue;
      if (!best || p.path.length > best.path.length) best = p;
    }
    return best;
  }

  /** abs 에서 위로 올라가며 .git 폴더가 있는 곳을 찾습니다. 영역의 뿌리(그 자신 포함)에서 멈춥니다. */
  gitRootOf(abs: string, stopAt: string): string | null {
    let cur = abs;
    for (;;) {
      try {
        if (fs.statSync(path.join(cur, '.git')).isDirectory()) return cur;
      } catch {
        // 없으면 위로
      }
      if (cur === stopAt || !isInsidePath(stopAt, cur)) return null;
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }

  /**
   * 셸 명령이 실제로 일한 폴더: 맨 앞이 'cd 폴더' 면 그 폴더, 아니면 실행 폴더.
   * 'git clone 주소 [폴더]' · 'git init [폴더]' 가 있으면 만들어질 저장소 폴더도 돌려줍니다.
   */
  shellDirs(command: string, cwd: string, workspace: string): { workDir: string; created: string[] } {
    const parsed = parseCommand(command);
    let workDir = cwd;
    const created: string[] = [];
    const resolveArg = (dir: string, arg: string): string => (arg.startsWith('~') ? path.join(workspace, arg.slice(1)) : path.resolve(dir, arg));
    let dir = cwd;
    for (const seg of parsed.segments) {
      const name = commandName(seg.words);
      const args = commandArgs(seg.words);
      if (name === 'cd' && args.length === 1) {
        dir = resolveArg(dir, args[0] as string);
        if (seg === parsed.segments[0]) workDir = dir;
        continue;
      }
      if (name === 'git') {
        // 전역 옵션: -C 폴더 는 그 폴더에서 실행
        let gitDir = dir;
        let i = 0;
        while (i < args.length && (args[i] as string).startsWith('-')) {
          const a = args[i] as string;
          if (a === '-C' && args[i + 1] !== undefined) gitDir = resolveArg(gitDir, args[i + 1] as string);
          i += !a.includes('=') && GIT_GLOBAL_VALUE.has(a) ? 2 : 1;
        }
        const sub = args[i];
        const rest = positionals(args.slice(i + 1), GIT_SUB_VALUE);
        if (sub === 'clone' && rest.length >= 1) {
          const target = rest[1] ?? (rest[0] as string).replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? '';
          if (target) created.push(resolveArg(gitDir, target));
        } else if (sub === 'init') {
          created.push(rest[0] ? resolveArg(gitDir, rest[0]) : gitDir);
        }
      }
    }
    return { workDir, created };
  }

  /**
   * 도구를 쓴 뒤: 등록된 프로젝트 안이면 활동을 남기고, 쓰기 영역의 git 저장소에서 일했으면 자동으로 등록합니다.
   * 프로젝트 기록에 실패해도 도구 결과에는 영향을 주지 않습니다 (호출부에서 오류를 삼킴).
   */
  afterTool(env: ToolEnv, tool: string, input: Record<string, unknown>, described: Described, ok: boolean): void {
    const agent = env.agent;
    let kind: ProjectEventRow['kind'];
    let label: string;
    let at: string | null = null;
    let created: string[] = [];
    if (tool === 'fs_write' || tool === 'fs_read' || tool === 'fs_list') {
      kind = tool === 'fs_write' ? 'write' : tool === 'fs_read' ? 'read' : 'list';
      label = tool === 'fs_write' ? '파일 쓰기' : tool === 'fs_read' ? '파일 읽기' : '목록 보기';
      at = described.paths?.[0] ?? null;
    } else if (tool === 'shell_exec') {
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      const dirs = this.shellDirs(command, described.cwd ?? env.workspace, env.workspace);
      at = dirs.workDir;
      created = ok ? dirs.created : [];
      kind = /\bgit\s+commit\b/.test(command) ? 'commit' : 'shell';
      label = kind === 'commit' ? '커밋' : '셸';
    } else {
      return;
    }
    if (at === null) return;

    // 쓰기 영역의 git 저장소에서 일했으면 자동 등록 (git clone · git init 으로 만든 저장소 포함)
    if (ok && kind !== 'read' && kind !== 'list') {
      const task = this.d.store.getTask(env.taskId);
      for (const candidate of [...created, at]) {
        const area = this.areaOf(agent, candidate);
        if (!area || area.mode !== 'write') continue;
        // 셸 명령이 지웠거나 아직 없는 경로여도 있는 데까지 실제 경로로 풉니다.
        const real = realpathNearest(candidate, this.d.realpath);
        const isDir = fs.existsSync(real) && fs.statSync(real).isDirectory();
        const root = this.gitRootOf(isDir ? real : path.dirname(real), area.root);
        if (!root || root === this.d.workspaceOf(agent.id) || this.d.store.findProjectByPath(agent.id, root)) continue;
        try {
          this.track(agent, root, {}, { ...this.originOf(task, env), taskId: env.taskId }, true);
        } catch {
          // 한도 · 경로 문제로 자동 등록을 못 해도 도구 결과에는 영향이 없습니다.
        }
      }
    }

    const project = this.projectFor(agent.id, at);
    if (!project) return;
    const relPath = path.relative(project.path, at).split(path.sep).join('/');
    const detail = kind === 'shell' || kind === 'commit' ? (typeof input['command'] === 'string' ? input['command'] : described.summary).replace(/\s+/g, ' ').slice(0, 160) : relPath || '.';
    this.d.store.addProjectEvent({ projectId: project.id, kind, label, detail, ok, taskId: env.taskId }, PROJECT_EVENTS_KEEP);
  }
}
