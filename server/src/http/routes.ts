import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { EFFORT_LEVELS } from '../anthropic/models.ts';
import type { App } from '../app.ts';
import { randomId } from '../crypto/secrets.ts';
import type { ApprovalStatus, ScheduleRow } from '../db/store.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import { GUARD_DEFS } from '../guards/guards.ts';
import { ACTIONS_BY_EVENT, FIELDS_BY_EVENT, CONDITION_OPS, renderHookCode, validateRuleHook } from '../hooks/rules.ts';
import { HOOK_EVENTS, type HookCtx, type HookEvent } from '../hooks/types.ts';
import { LIMIT_RULES } from '../limits/limits.ts';
import { groupModels } from '../anthropic/models.ts';
import { describeSpec, localToUtc, parseSpec } from '../scheduler/spec.ts';
import { readSourceFiles } from '../modules/install.ts';
import { buildOverview } from './overview.ts';
import { readBody } from './server.ts';

type IdParams = { Params: { id: string } };

function param(req: FastifyRequest, name: string): string {
  const v = (req.params as Record<string, string | undefined>)[name];
  if (!v) throw new ValidationError('param_missing', `경로에 ${name} 가 없습니다.`);
  return v;
}

function query(req: FastifyRequest, name: string): string | undefined {
  const v = (req.query as Record<string, unknown>)[name];
  return typeof v === 'string' ? v : undefined;
}

function intQuery(req: FastifyRequest, name: string, def: number, min: number, max: number): number {
  const raw = query(req, name);
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) throw new ValidationError('query_int', `${name} 는 정수여야 합니다. 받은 값: '${raw}'`);
  const n = Number(raw);
  if (n < min || n > max) throw new ValidationError('query_range', `${name} 는 ${min}~${max} 사이여야 합니다. 받은 값: ${n}`);
  return n;
}

/** module.json 을 맨 앞에, 나머지는 경로 순으로 */
function sortFiles<T extends { path: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => (a.path === 'module.json' ? -1 : b.path === 'module.json' ? 1 : a.path.localeCompare(b.path)));
}

/** 화면 표시용: 예약 규칙을 읽기 쉬운 문장으로 함께 보냅니다 (예: 'weekdays 09:00' → '평일 09:00'). */
function scheduleView(s: ScheduleRow): ScheduleRow & { label: string } {
  const spec = parseSpec(s.spec);
  return { ...s, label: typeof spec === 'string' ? s.spec : describeSpec(spec) };
}

function loadThemes(rootDir: string): unknown {
  const p = path.join(rootDir, 'config', 'themes.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    throw new ConflictError('themes_file', `config/themes.json 을 읽지 못했습니다: ${(err as Error).message}`);
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const THEME_TOKENS = ['bg', 'panel', 'surface', 'raised', 'line', 'line2', 'text', 'text2', 'text3', 'accent', 'onAccent', 'msg', 'skill', 'warn', 'danger'] as const;
const FONTS = ['plex', 'noto', 'system'] as const;

function validateTheme(input: Record<string, unknown>): Record<string, unknown> {
  const tokens = input['tokens'];
  if (!tokens || typeof tokens !== 'object') throw new ValidationError('theme_tokens', '테마에 색 토큰(tokens)이 없습니다.');
  const t = tokens as Record<string, unknown>;
  for (const k of THEME_TOKENS) {
    if (typeof t[k] !== 'string' || !HEX.test(t[k] as string)) throw new ValidationError('theme_color', `색 '${k}' 는 #RRGGBB 형식이어야 합니다. 받은 값: ${JSON.stringify(t[k])}`);
  }
  const radius = input['radius'];
  if (typeof radius !== 'number' || !Number.isInteger(radius) || radius < 0 || radius > 20) throw new ValidationError('theme_radius', `모서리는 0~20 사이 정수여야 합니다. 받은 값: ${JSON.stringify(radius)}`);
  const font = input['font'];
  if (!FONTS.includes(font as (typeof FONTS)[number])) throw new ValidationError('theme_font', `글꼴은 ${FONTS.join(', ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(font)}`);
  for (const k of ['density', 'motion'] as const) {
    const v = input[k];
    if (v !== 0 && v !== 1 && v !== 2) throw new ValidationError(`theme_${k}`, `${k === 'density' ? '밀도' : '움직임'}는 0, 1, 2 중 하나여야 합니다. 받은 값: ${JSON.stringify(v)}`);
  }
  const name = typeof input['name'] === 'string' && input['name'].trim() ? input['name'].trim().slice(0, 30) : '사용자 지정';
  return { name, tokens: Object.fromEntries(THEME_TOKENS.map((k) => [k, (t[k] as string).toUpperCase()])), radius, font, density: input['density'], motion: input['motion'] };
}

/** 훅 시험용 컨텍스트: 화면에서 입력한 예시 값으로 이벤트를 꾸밉니다. 시각(HH:MM)은 서버 시간대의 오늘 기준. */
function sampleCtx(event: HookEvent, sample: Record<string, unknown>): HookCtx {
  const s = (k: string): string => (typeof sample[k] === 'string' ? (sample[k] as string) : '');
  const tz = process.env['TZ'] || 'UTC';
  let now = new Date();
  const hhmm = /^(\d{2}):(\d{2})$/.exec(s('now'));
  if (hhmm) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number);
    now = new Date(localToUtc(parts[0] as number, (parts[1] as number) - 1, parts[2] as number, Number(hhmm[1]) * 60 + Number(hhmm[2]), tz));
  }
  const base = { agentId: null, agentName: s('agent') || '시험', taskId: null, now };
  switch (event) {
    case 'before_tool':
    case 'after_tool': {
      let host: string | null = s('host') || null;
      if (!host && s('url')) {
        try {
          host = new URL(s('url')).hostname;
        } catch {
          host = null;
        }
      }
      return { ...base, event, tool: s('tool') || 'http_request', category: s('category') || 'net.fetch', input: {}, workspace: '/', command: s('command') || null, paths: s('path') ? [s('path')] : [], url: s('url') || null, host, method: s('method') || null, text: s('text') || null, output: s('output') || undefined };
    }
    case 'before_send':
      return { ...base, event, channel: s('channel') || 'discord', target: s('target') || '#general', text: s('text'), perMinute: 1000 };
    case 'on_message':
      return { ...base, event, channel: s('channel') || 'discord', target: s('target') || '#general', user: s('user') || '사용자', text: s('text') };
    case 'before_install':
      return { ...base, event, kind: s('kind') === 'skill' ? 'skill' : 'module', id: s('id') || 'example', files: [] };
  }
}

export function registerRoutes(server: FastifyInstance, app: App): void {
  const { store, manager, registry, approvals } = app;

  /* ───── 전체 ───── */
  server.get('/api/overview', async () => buildOverview(app));

  server.get('/api/meta', async () => ({
    permissionDefs: manager.permissionDefs(),
    presets: [...app.presets.values()].map((p) => ({ id: p.id, name: p.name, permissions: p.permissions, message: p.message, limits: p.limits })),
    limitRules: LIMIT_RULES,
    efforts: EFFORT_LEVELS,
    hookEvents: HOOK_EVENTS,
    hookFields: FIELDS_BY_EVENT,
    hookActions: ACTIONS_BY_EVENT,
    conditionOps: CONDITION_OPS,
    guards: GUARD_DEFS,
    themes: loadThemes(app.config.rootDir),
    tz: process.env['TZ'] || 'UTC',
    envKey: Boolean(app.config.anthropicApiKey),
  }));

  server.get('/api/activity', async (req) => ({ items: store.listActivity(intQuery(req, 'limit', 50, 1, 500)) }));

  /* ───── 키·모델 ───── */
  /** 모델마다 그 모델을 쓰는 에이전트 수를 붙입니다 (같은 모델로 여러 에이전트를 둘 수 있으므로). */
  const withUsage = () => {
    const usage = new Map<string, number>();
    for (const a of store.listAgents()) usage.set(a.model, (usage.get(a.model) ?? 0) + 1);
    return <T extends { id: string }>(m: T): T & { agents: number } => ({ ...m, agents: usage.get(m.id) ?? 0 });
  };

  server.get('/api/keys', async () => ({ keys: store.listKeys().map((k) => ({ id: k.id, label: k.label, source: k.source, last4: k.last4 })) }));

  server.post('/api/keys/verify', async (req) => {
    const body = readBody(req);
    const source = body['source'];
    if (source !== 'env' && source !== 'manual') throw new ValidationError('key_source', `키 출처는 env 또는 manual 이어야 합니다. 받은 값: ${JSON.stringify(source)}`);
    const r = await app.anthropic.verify(source === 'env' ? { source: 'env' } : { source: 'manual', key: typeof body['key'] === 'string' ? body['key'] : '' });
    const view = withUsage();
    return { keyId: r.keyId, keyLabel: r.keyLabel, count: r.models.length, latest: r.grouped.latest.map(view), older: r.grouped.older.map(view) };
  });

  server.get('/api/models', async (req) => {
    const keyId = query(req, 'keyId');
    if (!keyId) throw new ValidationError('key_id', 'keyId 가 필요합니다.');
    const key = store.getKey(keyId);
    const models = await app.anthropic.models(key.id, query(req, 'refresh') === '1');
    const g = groupModels(models);
    const view = withUsage();
    return { keyId: key.id, keyLabel: key.label, count: models.length, latest: g.latest.map(view), older: g.older.map(view) };
  });

  /* ───── 에이전트 ───── */
  server.post('/api/agents', async (req, reply) => {
    const b = readBody(req);
    const agent = await manager.createAgent({ name: b['name'], color: b['color'], role: b['role'], keyId: b['keyId'], model: b['model'], effort: b['effort'], preset: b['preset'], modules: b['modules'] });
    reply.status(201);
    return { agent };
  });

  server.get<IdParams>('/api/agents/:id', async (req) => {
    const agent = store.getAgent(param(req, 'id'));
    return { agent, links: store.listAgentModules(agent.id), schedules: store.listSchedules(agent.id).map(scheduleView), live: manager.live(agent.id) };
  });

  server.patch<IdParams>('/api/agents/:id', async (req) => {
    const b = readBody(req);
    return { agent: await manager.updateAgent(param(req, 'id'), { name: b['name'], color: b['color'], role: b['role'], keyId: b['keyId'], model: b['model'], effort: b['effort'] }) };
  });

  server.delete<IdParams>('/api/agents/:id', async (req) => {
    manager.deleteAgent(param(req, 'id'));
    return { ok: true };
  });

  server.post<IdParams>('/api/agents/:id/pause', async (req) => {
    const b = readBody(req);
    if (typeof b['paused'] !== 'boolean') throw new ValidationError('paused_type', 'paused 는 true 또는 false 여야 합니다.');
    return { agent: manager.setPaused(param(req, 'id'), b['paused']) };
  });

  server.put<IdParams>('/api/agents/:id/permissions', async (req) => {
    const b = readBody(req);
    return { agent: manager.setPermissions(param(req, 'id'), b['permissions'], b['limits']) };
  });

  server.put<IdParams>('/api/agents/:id/modules', async (req) => {
    const b = readBody(req);
    return { links: manager.setModules(param(req, 'id'), b['links']) };
  });

  server.get<IdParams>('/api/agents/:id/timeline', async (req) => {
    const agent = store.getAgent(param(req, 'id'));
    const source = query(req, 'source') ?? 'console';
    const thread = store.listThreads(agent.id).find((t) => t.source === source);
    return { threadId: thread?.id ?? null, items: thread ? store.listTimeline(thread.id, intQuery(req, 'limit', 200, 1, 1000)) : [] };
  });

  server.get<IdParams>('/api/agents/:id/threads', async (req) => ({ threads: store.listThreads(store.getAgent(param(req, 'id')).id) }));

  server.post<IdParams>('/api/agents/:id/messages', async (req, reply) => {
    const agent = store.getAgent(param(req, 'id'));
    const b = readBody(req);
    const text = typeof b['text'] === 'string' ? b['text'].trim() : '';
    if (text === '') throw new ValidationError('message_empty', '지시 내용을 입력하세요.');
    if (text.length > 20_000) throw new ValidationError('message_long', `지시는 20,000자까지 보낼 수 있습니다. 지금 ${text.length}자입니다.`);
    const task = manager.enqueue({ agentId: agent.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text, reply: null });
    reply.status(202);
    return { task };
  });

  server.get<IdParams>('/api/agents/:id/tasks', async (req) => ({ tasks: store.listTasks(store.getAgent(param(req, 'id')).id, intQuery(req, 'limit', 20, 1, 200)), live: manager.live(param(req, 'id')) }));

  server.post<IdParams>('/api/tasks/:id/cancel', async (req) => {
    const id = param(req, 'id');
    const task = store.getTask(id);
    if (task.status !== 'queued' && task.status !== 'running' && task.status !== 'waiting') {
      throw new ConflictError('task_finished', `이미 끝난 작업입니다 (상태: ${task.status}).`);
    }
    if (!manager.cancelTask(id)) throw new ConflictError('task_not_live', '이 작업은 지금 실행 중이 아닙니다. 서버가 다시 시작되었다면 이미 중단되었습니다.');
    return { ok: true };
  });

  /* ───── 승인 ───── */
  server.get('/api/approvals', async (req) => {
    const status = query(req, 'status');
    if (status !== undefined && !['pending', 'approved', 'denied', 'expired'].includes(status)) {
      throw new ValidationError('approval_status', `status 는 pending, approved, denied, expired 중 하나여야 합니다. 받은 값: '${status}'`);
    }
    return { approvals: store.listApprovals(status as ApprovalStatus | undefined) };
  });

  server.post<IdParams>('/api/approvals/:id', async (req) => {
    const b = readBody(req);
    return { approval: await approvals.decide(param(req, 'id'), b['decision']) };
  });

  /* ───── 모듈 ───── */
  server.get('/api/modules', async () => {
    const o = buildOverview(app);
    return { modules: o.modules, skills: o.skills };
  });

  server.get<IdParams>('/api/modules/:id/logs', async (req) => ({ lines: registry.logs(store.getModule(param(req, 'id')).id) }));

  /** 코드 보기: 설치된(또는 승인 대기 중인) 모듈의 소스. node_modules 는 빼고 읽습니다. */
  server.get<IdParams>('/api/modules/:id/files', async (req) => {
    const row = store.getModule(param(req, 'id'));
    if (!fs.existsSync(row.dir)) throw new ConflictError('module_dir_missing', `모듈 '${row.manifest.name}'의 폴더(${row.dir})가 없습니다. 지워졌다면 모듈을 삭제한 뒤 다시 설치하세요.`);
    return { files: sortFiles(readSourceFiles(row.dir)) };
  });

  /** 코드 보기: 설치 전 점검 중인 모듈의 소스 */
  server.get<{ Params: { token: string } }>('/api/modules/staged/:token/files', async (req) => ({ files: sortFiles(readSourceFiles(registry.installer.get(param(req, 'token')).dir)) }));

  /**
   * .env 다시 읽기: 이 모듈이 선언한 환경 변수만 .env 에서 다시 읽어 바꾸고, 켜져 있으면 다시 시작합니다.
   * 서버 설정(PORT 등)은 바뀌지 않습니다 (서버를 다시 시작해야 함).
   */
  server.post<IdParams>('/api/modules/:id/reload-env', async (req) => {
    const row = store.getModule(param(req, 'id'));
    const envPath = path.join(app.config.rootDir, '.env');
    if (!fs.existsSync(envPath)) throw new ConflictError('env_file_missing', `.env 파일이 없습니다 (${envPath}). .env.example 을 복사해 .env 를 만든 뒤 다시 누르세요.`);
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(fs.readFileSync(envPath, 'utf8')) as Record<string, string>;
    } catch (err) {
      throw new ConflictError('env_file_read', `.env 를 읽지 못했습니다: ${(err as Error).message}`);
    }
    const changed: string[] = [];
    for (const e of row.manifest.env) {
      const v = parsed[e.name];
      if (v !== undefined && process.env[e.name] !== v) {
        process.env[e.name] = v;
        changed.push(e.name);
      }
    }
    const missing = row.manifest.env.filter((e) => e.required && !process.env[e.name]?.trim()).map((e) => e.name);
    const module = changed.length > 0 && row.enabled && row.status !== 'pending' ? await registry.restart(row.id) : row;
    app.bus.emit({ type: 'graph.changed' });
    return { changed, missing, module };
  });

  server.post<IdParams>('/api/modules/:id/enabled', async (req) => {
    const b = readBody(req);
    if (typeof b['enabled'] !== 'boolean') throw new ValidationError('enabled_type', 'enabled 는 true 또는 false 여야 합니다.');
    return { module: await registry.setEnabled(param(req, 'id'), b['enabled']) };
  });

  server.post<IdParams>('/api/modules/:id/restart', async (req) => ({ module: await registry.restart(param(req, 'id')) }));

  server.delete<IdParams>('/api/modules/:id', async (req) => {
    await registry.remove(param(req, 'id'));
    return { ok: true };
  });

  const decidePending = async (id: string, decision: 'once' | 'deny'): Promise<void> => {
    const row = store.getModule(id);
    if (row.status !== 'pending') throw new ConflictError('module_not_pending', `모듈 '${row.manifest.name}'은(는) 승인 대기 상태가 아닙니다 (현재: ${row.status}).`);
    const ap = store.listApprovals('pending').find((a) => a.detail.moduleId === id);
    if (ap) await approvals.decide(ap.id, decision);
    else if (decision === 'once') registry.approvePending(id);
    else registry.rejectPending(id);
  };
  server.post<IdParams>('/api/modules/:id/approve', async (req) => {
    await decidePending(param(req, 'id'), 'once');
    return { module: store.findModule(param(req, 'id')) };
  });
  server.post<IdParams>('/api/modules/:id/reject', async (req) => {
    await decidePending(param(req, 'id'), 'deny');
    return { ok: true };
  });

  const stagedView = (s: { token: string; manifest: { id: string; name: string; version: string }; report: unknown }) => ({ token: s.token, id: s.manifest.id, name: s.manifest.name, version: s.manifest.version, report: s.report });

  server.post('/api/modules/check/git', async (req) => {
    const b = readBody(req);
    const url = typeof b['url'] === 'string' ? b['url'] : '';
    const ref = typeof b['ref'] === 'string' ? b['ref'] : 'main';
    return stagedView(await registry.installer.fromGit(url, ref));
  });

  server.post('/api/modules/check/zip', async (req) => {
    const b = readBody(req);
    const name = typeof b['fileName'] === 'string' && b['fileName'].trim() ? b['fileName'].trim().slice(0, 120) : 'module.zip';
    if (!name.toLowerCase().endsWith('.zip')) throw new ValidationError('zip_name', `zip 파일만 올릴 수 있습니다. 받은 파일: ${name}`);
    if (typeof b['data'] !== 'string' || b['data'] === '') throw new ValidationError('zip_data', '파일 내용(data, base64)이 비어 있습니다.');
    const buf = Buffer.from(b['data'], 'base64');
    if (buf.length === 0) throw new ValidationError('zip_base64', '파일 내용을 base64 로 해석하지 못했습니다.');
    return stagedView(await registry.installer.fromZip(new Uint8Array(buf), name));
  });

  server.post('/api/modules/install', async (req, reply) => {
    const b = readBody(req);
    if (typeof b['token'] !== 'string') throw new ValidationError('stage_token', '설치할 점검 결과(token)가 필요합니다.');
    const row = await registry.install(b['token'], { kind: 'module', createdBy: null, enabled: true });
    app.bus.activity({ type: 'module.installed', category: 'module', tone: 'new', who: row.manifest.name, text: `설치됨 · ${row.origin}`, moduleId: row.id });
    reply.status(201);
    return { module: row };
  });

  server.post('/api/modules/discard', async (req) => {
    const b = readBody(req);
    if (typeof b['token'] === 'string') registry.installer.discard(b['token']);
    return { ok: true };
  });

  server.get('/api/templates', async () => {
    const dir = app.config.templatesDir;
    if (!fs.existsSync(dir)) return { templates: [] };
    const templates = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'module.json')))
      .map((e) => {
        const m = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'module.json'), 'utf8')) as { name?: string; description?: string; env?: unknown[] };
        return { id: e.name, name: m.name ?? e.name, description: m.description ?? '', files: fs.readdirSync(path.join(dir, e.name)), env: Array.isArray(m.env) ? m.env.length : 0 };
      });
    return { templates };
  });

  server.post('/api/modules/template', async (req, reply) => {
    const b = readBody(req);
    const template = typeof b['template'] === 'string' ? b['template'] : '';
    const id = typeof b['id'] === 'string' ? b['id'].trim() : '';
    const name = typeof b['name'] === 'string' ? b['name'] : '';
    const staged = await registry.installer.fromTemplate(template, id, name);
    const row = await registry.install(staged.token, { kind: 'module', createdBy: null, enabled: false });
    app.bus.activity({ type: 'module.installed', category: 'module', tone: 'new', who: row.manifest.name, text: `템플릿 ${template} 로 만듦 · 꺼진 상태`, moduleId: row.id });
    reply.status(201);
    return { module: row };
  });

  server.post('/api/modules/request', async (req, reply) => {
    const b = readBody(req);
    if (typeof b['agentId'] !== 'string') throw new ValidationError('request_agent', '모듈을 맡길 에이전트를 고르세요.');
    const agent = store.getAgent(b['agentId']);
    const text = typeof b['text'] === 'string' ? b['text'].trim() : '';
    if (text.length < 5) throw new ValidationError('request_text', '만들 모듈을 5자 이상으로 설명하세요.');
    if ((agent.permissions['module.create']?.mode ?? 'ask') === 'deny') {
      throw new ConflictError('request_denied', `'${agent.name}'은(는) 모듈 만들기 권한이 차단되어 있습니다. 권한 · 훅 화면에서 바꾸거나 다른 에이전트를 고르세요.`);
    }
    const task = manager.enqueue({
      agentId: agent.id,
      source: 'console',
      sourceLabel: '모듈 요청',
      origin: 'request',
      text: `다음 기능을 하는 모듈을 만들어 설치 승인을 요청해 주세요. 모듈 제작 가이드를 따르세요.\n\n${text}`,
      reply: null,
      title: `모듈 요청 · ${text.slice(0, 40)}`,
    });
    reply.status(202);
    return { task };
  });

  /* ───── 훅 ───── */
  server.get('/api/hooks', async () => {
    const today = new Date(Date.now() - 86_400_000).getTime();
    const hits = new Map<string, number>();
    for (const a of store.listActivity(500)) {
      if (a.ts < today || a.type !== 'hook.blocked') continue;
      for (const g of GUARD_DEFS) if (a.text.includes(g.name) || a.text.includes(g.id)) hits.set(g.id, (hits.get(g.id) ?? 0) + 1);
    }
    return {
      guards: GUARD_DEFS.map((g) => ({ ...g, hits24h: hits.get(g.id) ?? 0 })),
      rules: store.listHooks().map((h) => ({ ...h, code: renderHookCode(h) })),
      files: app.fileHooks.hooks.map((h) => ({ id: h.id, file: h.file, name: h.name, event: h.event, action: h.action, enabled: h.enabled, source: h.source })),
      fileErrors: app.fileHooks.errors,
    };
  });

  const envHas = (name: string): boolean => Boolean(process.env[name]?.trim());

  server.post('/api/hooks', async (req, reply) => {
    const v = validateRuleHook(readBody(req), envHas);
    const row = store.saveHook({ ...v, id: randomId('hook', 6) });
    app.bus.activity({ type: 'hook.created', category: 'hook', tone: 'pass', who: '훅', text: `'${row.name}' 추가 · ${row.event}`, data: { id: row.id } });
    reply.status(201);
    return { hook: { ...row, code: renderHookCode(row) } };
  });

  server.put<IdParams>('/api/hooks/:id', async (req) => {
    const id = param(req, 'id');
    store.getHook(id);
    const v = validateRuleHook(readBody(req), envHas);
    const row = store.saveHook({ ...v, id });
    return { hook: { ...row, code: renderHookCode(row) } };
  });

  server.delete<IdParams>('/api/hooks/:id', async (req) => {
    store.deleteHook(param(req, 'id'));
    return { ok: true };
  });

  server.post('/api/hooks/test', async (req) => {
    const b = readBody(req);
    const sample = (b['sample'] && typeof b['sample'] === 'object' ? b['sample'] : {}) as Record<string, unknown>;
    if (typeof b['guard'] === 'string') {
      const g = GUARD_DEFS.find((x) => x.id === b['guard']);
      if (!g) throw new NotFoundError('훅', String(b['guard']));
      const event = g.events[0] as HookEvent;
      const out = app.hooks.run(sampleCtx(event, sample));
      return { outcome: out };
    }
    const hook = typeof b['id'] === 'string' ? store.getHook(b['id']) : { ...validateRuleHook(b['hook'], envHas), id: 'preview' };
    return { outcome: app.hooks.test(hook, sampleCtx(hook.event, sample)) };
  });

  server.post('/api/hooks/reload', async () => {
    await app.reloadFileHooks();
    return { files: app.fileHooks.hooks.length, errors: app.fileHooks.errors };
  });

  /* ───── 예약 ───── */
  server.get<IdParams>('/api/agents/:id/schedules', async (req) => ({ schedules: store.listSchedules(store.getAgent(param(req, 'id')).id).map(scheduleView) }));
  server.patch<IdParams>('/api/schedules/:id', async (req) => {
    const b = readBody(req);
    if (typeof b['enabled'] !== 'boolean') throw new ValidationError('enabled_type', 'enabled 는 true 또는 false 여야 합니다.');
    app.scheduler.setEnabled(param(req, 'id'), b['enabled']);
    return { schedule: scheduleView(store.getSchedule(param(req, 'id'))) };
  });
  server.delete<IdParams>('/api/schedules/:id', async (req) => {
    store.deleteSchedule(param(req, 'id'));
    app.bus.emit({ type: 'graph.changed' });
    return { ok: true };
  });

  /* ───── 테마 ───── */
  server.get('/api/theme', async () => ({ theme: store.getSetting('theme') }));
  server.put('/api/theme', async (req) => {
    const theme = validateTheme(readBody(req));
    store.setSetting('theme', theme);
    app.bus.emit({ type: 'theme.changed', theme });
    return { theme };
  });
}
