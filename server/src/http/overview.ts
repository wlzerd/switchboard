import type { App } from '../app.ts';
import os from 'node:os';
import type { AgentRow, ModuleRow } from '../db/store.ts';
import { dayKey } from '../limits/limits.ts';
import { displayPath } from '../permissions/folders.ts';

export const BUILTIN_NODES = [
  { id: 'builtin:web', label: '웹 검색', tools: ['web_search', 'web_fetch'], permissions: ['web.search', 'net.fetch'] },
  { id: 'builtin:http', label: 'HTTP 요청', tools: ['http_request'], permissions: ['net.fetch'] },
  { id: 'builtin:shell', label: '셸 명령', tools: ['shell_exec'], permissions: ['shell.exec', 'pkg.install'] },
  { id: 'builtin:fs', label: '파일', tools: ['fs_read', 'fs_write', 'fs_list'], permissions: ['fs.read', 'fs.write'] },
] as const;

/** 방금 만든 스킬로 보는 시간 (그래프에서 NEW 표시) */
const NEW_SKILL_MS = 30 * 60_000;

function moduleView(app: App, m: ModuleRow, agentsById: Map<string, AgentRow>) {
  const fields = app.settings.moduleFields(m);
  return {
    id: m.id,
    kind: m.kind,
    name: m.manifest.name,
    version: m.manifest.version,
    description: m.manifest.description,
    origin: m.origin,
    icon: m.manifest.icon,
    enabled: m.enabled,
    status: app.registry.liveStatus(m.id),
    statusDetail: m.statusDetail,
    channel: m.manifest.channel !== null,
    /** 메시지를 보낼 수 있는 채널인지 (받기만 하는 이메일 등은 false) */
    canSend: m.manifest.channel !== null && m.manifest.channel.send !== false,
    /** 화면 제어 모듈인지, 지금 화면을 쓰는 에이전트 */
    computer: m.manifest.computer !== null,
    screenHolder: m.manifest.computer ? (app.manager.screenLocks.holder(m.id) ?? null) : null,
    tools: m.manifest.tools.map((t) => ({ name: t.name, title: t.title ?? t.name })),
    env: fields.map((f) => ({ name: f.name, label: f.label, required: f.required, present: f.source === 'db' || f.source === 'env', source: f.source })),
    /** 필수인데 비었거나 풀 수 없는 설정 · 아직 .env 에서 읽는 설정 */
    settingsMissing: fields.filter((f) => f.required && (f.source === 'empty' || f.source === 'locked')).map((f) => f.label),
    envLeft: fields.filter((f) => f.source === 'env').map((f) => f.name),
    permissions: m.manifest.permissions,
    license: m.manifest.license,
    createdBy: m.createdBy,
    createdByName: m.createdBy ? (agentsById.get(m.createdBy)?.name ?? null) : null,
    installedAt: m.installedAt,
    report: m.report,
  };
}

export function buildOverview(app: App) {
  const tz = process.env['TZ'] || 'UTC';
  const day = dayKey(new Date(), tz);
  const home = os.homedir();
  const agents = app.store.listAgents();
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const links = app.store.listAgentModules();
  const modules = app.store.listModules();
  const keys = new Map(app.store.listKeys().map((k) => [k.id, k]));
  const projects = app.projects.list();

  const agentViews = agents.map((a) => {
    const live = app.manager.live(a.id);
    const current = live.running[0] ?? app.store.latestTask(a.id);
    return {
      id: a.id,
      name: a.name,
      color: a.color,
      role: a.role,
      model: a.model,
      modelName: app.anthropic.cachedModelName(a.keyId, a.model),
      effort: a.effort,
      keyLabel: keys.get(a.keyId)?.label ?? '삭제된 키',
      preset: a.preset,
      paused: a.paused,
      status: live.status,
      detail: live.detail,
      queued: live.queued.length,
      queueLength: live.queueLength,
      queueMax: live.queueMax,
      task: current ? { id: current.id, title: current.title, status: current.status, steps: current.steps, error: current.error, origin: current.origin, finishedAt: current.finishedAt } : null,
      tokensToday: app.store.usageTotal(a.id, day),
      tokenLimit: a.limits.tokensPerDay,
      /** 오늘 프롬프트 캐시: 읽기 · 쓰기 · 캐시 밖 입력 (적중률 = 읽기 / 합계) */
      cacheToday: (() => {
        const u = app.store.usageDay(a.id, day);
        return u ? { read: u.cacheRead, write: u.cacheWrite, uncached: u.input } : null;
      })(),
      limits: a.limits,
      links: links.filter((l) => l.agentId === a.id).map((l) => ({ moduleId: l.moduleId, targets: l.config.targets ?? [], trigger: l.config.trigger ?? 'direct' })),
      delegation: a.delegation,
      heartbeat: a.heartbeat ? { ...a.heartbeat, lastAt: a.heartbeatLastAt } : null,
      report: a.report,
      /** 허용 폴더 (화면에는 홈을 ~ 로 줄인 경로) */
      folders: a.folders.map((f) => ({ path: displayPath(f.path, home), mode: f.mode })),
      /** 관리 중인 프로젝트 (캔버스 패널용 요약) */
      projects: projects
        .filter((p) => p.agentId === a.id)
        .slice(0, 20)
        .map((p) => ({ id: p.id, name: p.name, displayPath: p.displayPath, status: p.status, watch: p.watch, isGit: p.isGit })),
      projectCount: projects.filter((p) => p.agentId === a.id).length,
    };
  });

  const edges: { from: string; to: string; kind: 'message' | 'skill' | 'new' | 'creating' | 'delegate' | 'delegating' }[] = [];
  for (const l of links) {
    const m = modules.find((x) => x.id === l.moduleId);
    if (!m) continue;
    // 화면 제어 모듈은 에이전트가 쓰는 도구라 스킬처럼 에이전트 → 모듈 방향으로 잇습니다.
    if (m.kind === 'module' && m.manifest.computer) edges.push({ from: l.agentId, to: `module:${m.id}`, kind: 'skill' });
    else if (m.kind === 'module') edges.push({ from: `module:${m.id}`, to: l.agentId, kind: 'message' });
    else edges.push({ from: l.agentId, to: `skill:${m.id}`, kind: Date.now() - m.installedAt < NEW_SKILL_MS && m.createdBy === l.agentId ? 'new' : 'skill' });
  }
  for (const m of modules) {
    if (m.status === 'pending' && m.createdBy) edges.push({ from: m.createdBy, to: `module:${m.id}`, kind: 'creating' });
  }
  for (const a of agents) {
    for (const n of BUILTIN_NODES) {
      if (n.permissions.some((p) => (a.permissions[p]?.mode ?? 'ask') !== 'deny')) edges.push({ from: a.id, to: n.id, kind: 'skill' });
    }
  }
  // 위임: 협조 에이전트 관계(점선)와 지금 진행 중인 위임(움직이는 선)
  const ids = new Set(agents.map((a) => a.id));
  for (const a of agents) {
    if (a.delegation.supervisorId && ids.has(a.delegation.supervisorId)) edges.push({ from: a.id, to: a.delegation.supervisorId, kind: 'delegate' });
  }
  for (const d of app.store.activeDelegations()) {
    if (ids.has(d.from) && ids.has(d.to)) edges.push({ from: d.from, to: d.to, kind: 'delegating' });
  }

  return {
    server: {
      startedAt: app.startedAt,
      now: Date.now(),
      tz,
      tokensToday: app.store.usageAll(day),
      approvalsPending: app.approvals.pendingCount(),
      envKey: Boolean(app.config.anthropicApiKey),
    },
    agents: agentViews,
    modules: modules.filter((m) => m.kind === 'module').map((m) => moduleView(app, m, agentsById)),
    skills: modules.filter((m) => m.kind === 'skill').map((m) => ({ ...moduleView(app, m, agentsById), isNew: Date.now() - m.installedAt < NEW_SKILL_MS })),
    builtinNodes: BUILTIN_NODES.map((n) => ({ id: n.id, label: n.label, tools: [...n.tools] })),
    edges,
  };
}
