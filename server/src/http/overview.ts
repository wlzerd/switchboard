import type { App } from '../app.ts';
import type { AgentRow, ModuleRow } from '../db/store.ts';
import { dayKey } from '../limits/limits.ts';

export const BUILTIN_NODES = [
  { id: 'builtin:web', label: '웹 검색', tools: ['web_search', 'web_fetch'], permissions: ['web.search', 'net.fetch'] },
  { id: 'builtin:http', label: 'HTTP 요청', tools: ['http_request'], permissions: ['net.fetch'] },
  { id: 'builtin:shell', label: '셸 명령', tools: ['shell_exec'], permissions: ['shell.exec', 'pkg.install'] },
  { id: 'builtin:fs', label: '파일', tools: ['fs_read', 'fs_write', 'fs_list'], permissions: ['fs.read', 'fs.write'] },
] as const;

/** 방금 만든 스킬로 보는 시간 (그래프에서 NEW 표시) */
const NEW_SKILL_MS = 30 * 60_000;

function moduleView(app: App, m: ModuleRow, agentsById: Map<string, AgentRow>) {
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
    tools: m.manifest.tools.map((t) => ({ name: t.name, title: t.title ?? t.name })),
    env: m.manifest.env.map((e) => ({ name: e.name, required: e.required, present: Boolean(process.env[e.name]?.trim()) })),
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
  const agents = app.store.listAgents();
  const agentsById = new Map(agents.map((a) => [a.id, a]));
  const links = app.store.listAgentModules();
  const modules = app.store.listModules();
  const keys = new Map(app.store.listKeys().map((k) => [k.id, k]));

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
      task: current ? { id: current.id, title: current.title, status: current.status, steps: current.steps, error: current.error, origin: current.origin, finishedAt: current.finishedAt } : null,
      tokensToday: app.store.usageTotal(a.id, day),
      tokenLimit: a.limits.tokensPerDay,
      limits: a.limits,
      links: links.filter((l) => l.agentId === a.id).map((l) => ({ moduleId: l.moduleId, targets: l.config.targets ?? [], trigger: l.config.trigger ?? 'direct' })),
    };
  });

  const edges: { from: string; to: string; kind: 'message' | 'skill' | 'new' | 'creating' }[] = [];
  for (const l of links) {
    const m = modules.find((x) => x.id === l.moduleId);
    if (!m) continue;
    if (m.kind === 'module') edges.push({ from: `module:${m.id}`, to: l.agentId, kind: 'message' });
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
