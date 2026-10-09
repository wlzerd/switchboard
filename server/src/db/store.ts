import type { Effort } from '../anthropic/models.ts';
import { randomId } from '../crypto/secrets.ts';
import { NotFoundError } from '../errors.ts';
import type { RuleHook } from '../hooks/rules.ts';
import type { HookAction, HookEvent } from '../hooks/types.ts';
import type { AgentLimits } from '../limits/limits.ts';
import type { Manifest } from '../modules/manifest.ts';
import type { PermissionSet } from '../permissions/policy.ts';
import type { Db, Row } from './sqlite.ts';

function parseJson<T>(raw: unknown, where: string): T {
  if (typeof raw !== 'string') throw new Error(`DB 값이 문자열이 아닙니다: ${where}`);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`DB 값이 JSON 이 아닙니다: ${where}. 직접 고친 값이 있다면 되돌리세요.`);
  }
}

const str = (r: Row, k: string): string => String(r[k]);
const strOrNull = (r: Row, k: string): string | null => (r[k] === null || r[k] === undefined ? null : String(r[k]));
const num = (r: Row, k: string): number => Number(r[k]);
const numOrNull = (r: Row, k: string): number | null => (r[k] === null || r[k] === undefined ? null : Number(r[k]));

/* ───────── API 키 ───────── */

export interface ApiKeyRow {
  id: string;
  label: string;
  source: 'env' | 'stored';
  cipher: string | null;
  last4: string;
  createdAt: number;
}

/* ───────── 에이전트 ───────── */

export interface AgentRow {
  id: string;
  name: string;
  color: string;
  role: string;
  model: string;
  effort: Effort | null;
  keyId: string;
  preset: string;
  permissions: PermissionSet;
  limits: AgentLimits;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ───────── 모듈 ───────── */

export type ModuleOrigin = 'builtin' | 'git' | 'zip' | 'template' | 'agent';
export type ModuleStatus = 'pending' | 'stopped' | 'starting' | 'running' | 'idle' | 'crashed' | 'failed' | 'rejected';

export interface InstallCheck {
  label: string;
  level: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface InstallReport {
  checks: InstallCheck[];
  source: string;
  commit: string | null;
  checkedAt: number;
}

export interface ModuleRow {
  id: string;
  kind: 'module' | 'skill';
  origin: ModuleOrigin;
  dir: string;
  manifest: Manifest;
  enabled: boolean;
  status: ModuleStatus;
  statusDetail: string | null;
  createdBy: string | null;
  report: InstallReport | null;
  installedAt: number;
  updatedAt: number;
}

export interface AgentModuleRow {
  agentId: string;
  moduleId: string;
  /** targets: 응답할 대화 대상(비면 전부) · trigger: direct=멘션·DM 일 때만, all=모든 메시지 */
  config: { targets?: string[]; trigger?: 'direct' | 'all' };
}

/* ───────── 대화·작업 ───────── */

export interface ThreadRow {
  id: string;
  agentId: string;
  source: string;
  title: string;
  frozenHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageRow {
  id: number;
  threadId: string;
  role: 'user' | 'assistant';
  content: unknown;
  createdAt: number;
}

export type TimelineKind = 'user' | 'agent' | 'tool' | 'approval' | 'hook' | 'block' | 'skill' | 'system' | 'error';

export interface TimelineRow {
  id: number;
  threadId: string;
  taskId: string | null;
  kind: TimelineKind;
  data: Record<string, unknown>;
  createdAt: number;
}

export type TaskStatus = 'queued' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type StepState = 'done' | 'active' | 'wait' | 'todo' | 'error';

export interface TaskStep {
  id: string;
  label: string;
  meta: string;
  state: StepState;
  at: number;
}

export interface TaskRow {
  id: string;
  agentId: string;
  threadId: string;
  title: string;
  origin: 'console' | 'channel' | 'schedule' | 'request';
  status: TaskStatus;
  steps: TaskStep[];
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/* ───────── 승인 ───────── */

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalDecision = 'once' | 'always' | 'deny';

export interface ApprovalDetail {
  permission: string | null;
  target: string | null;
  rule: string;
  tool: string | null;
  input: string | null;
  moduleId?: string;
}

export interface ApprovalRow {
  id: string;
  agentId: string;
  taskId: string | null;
  kind: string;
  title: string;
  detail: ApprovalDetail;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  reason: string | null;
  createdAt: number;
  decidedAt: number | null;
}

/* ───────── 활동 로그 ───────── */

export type ActivityCategory = 'hook' | 'skill' | 'module' | 'agent' | 'system';
export type ActivityTone = 'agent' | 'pass' | 'block' | 'wait' | 'new' | 'module' | 'error';

export interface ActivityRow {
  id: number;
  ts: number;
  type: string;
  category: ActivityCategory;
  tone: ActivityTone;
  who: string;
  text: string;
  agentId: string | null;
  moduleId: string | null;
  data: Record<string, unknown> | null;
}

export interface ScheduleRow {
  id: string;
  agentId: string;
  spec: string;
  prompt: string;
  reply: { moduleId: string; target: string } | null;
  enabled: boolean;
  nextRun: number | null;
  lastRun: number | null;
  createdBy: string;
  createdAt: number;
}

export interface HookRow extends RuleHook {
  createdAt: number;
  updatedAt: number;
}

/**
 * 테이블별 저장소. SQL 은 여기에만 둡니다.
 */
export class Store {
  readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /* 설정 */
  getSetting<T>(key: string): T | null {
    const r = this.db.get('SELECT value FROM settings WHERE key = :key', { key });
    return r ? parseJson<T>(r['value'], `settings.${key}`) : null;
  }
  setSetting(key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :now) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      { key, value: JSON.stringify(value), now: Date.now() },
    );
  }

  /* API 키 */
  private keyRow(r: Row): ApiKeyRow {
    return { id: str(r, 'id'), label: str(r, 'label'), source: str(r, 'source') as ApiKeyRow['source'], cipher: strOrNull(r, 'cipher'), last4: str(r, 'last4'), createdAt: num(r, 'created_at') };
  }
  listKeys(): ApiKeyRow[] {
    return this.db.all('SELECT * FROM api_keys ORDER BY created_at').map((r) => this.keyRow(r));
  }
  getKey(id: string): ApiKeyRow {
    const r = this.db.get('SELECT * FROM api_keys WHERE id = :id', { id });
    if (!r) throw new NotFoundError('API 키', id);
    return this.keyRow(r);
  }
  findEnvKey(): ApiKeyRow | null {
    const r = this.db.get("SELECT * FROM api_keys WHERE source = 'env' LIMIT 1");
    return r ? this.keyRow(r) : null;
  }
  insertKey(k: Omit<ApiKeyRow, 'id' | 'createdAt'>, fingerprint: string | null): ApiKeyRow {
    const row: ApiKeyRow = { ...k, id: randomId('key'), createdAt: Date.now() };
    this.db.run('INSERT INTO api_keys (id, label, source, cipher, last4, created_at, fingerprint) VALUES (:id, :label, :source, :cipher, :last4, :createdAt, :fingerprint)', {
      id: row.id, label: row.label, source: row.source, cipher: row.cipher, last4: row.last4, createdAt: row.createdAt, fingerprint,
    });
    return row;
  }
  findKeyByFingerprint(fingerprint: string): ApiKeyRow | null {
    const r = this.db.get('SELECT * FROM api_keys WHERE fingerprint = :fingerprint', { fingerprint });
    return r ? this.keyRow(r) : null;
  }
  updateEnvKeyLast4(id: string, last4: string): void {
    this.db.run('UPDATE api_keys SET last4 = :last4 WHERE id = :id', { id, last4 });
  }

  /* 에이전트 */
  private agentRow(r: Row): AgentRow {
    const id = str(r, 'id');
    return {
      id,
      name: str(r, 'name'),
      color: str(r, 'color'),
      role: str(r, 'role'),
      model: str(r, 'model'),
      effort: strOrNull(r, 'effort') as Effort | null,
      keyId: str(r, 'key_id'),
      preset: str(r, 'preset'),
      permissions: parseJson<PermissionSet>(r['permissions'], `agents.permissions (id=${id})`),
      limits: parseJson<AgentLimits>(r['limits'], `agents.limits (id=${id})`),
      paused: num(r, 'paused') === 1,
      createdAt: num(r, 'created_at'),
      updatedAt: num(r, 'updated_at'),
    };
  }
  listAgents(): AgentRow[] {
    return this.db.all('SELECT * FROM agents ORDER BY created_at').map((r) => this.agentRow(r));
  }
  getAgent(id: string): AgentRow {
    const r = this.db.get('SELECT * FROM agents WHERE id = :id', { id });
    if (!r) throw new NotFoundError('에이전트', id);
    return this.agentRow(r);
  }
  findAgentByName(name: string): AgentRow | null {
    const r = this.db.get('SELECT * FROM agents WHERE name = :name', { name });
    return r ? this.agentRow(r) : null;
  }
  insertAgent(a: Omit<AgentRow, 'createdAt' | 'updatedAt'>): AgentRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO agents (id, name, color, role, model, effort, key_id, preset, permissions, limits, paused, created_at, updated_at)
       VALUES (:id, :name, :color, :role, :model, :effort, :keyId, :preset, :permissions, :limits, :paused, :now, :now)`,
      {
        id: a.id, name: a.name, color: a.color, role: a.role, model: a.model, effort: a.effort, keyId: a.keyId, preset: a.preset,
        permissions: JSON.stringify(a.permissions), limits: JSON.stringify(a.limits), paused: a.paused ? 1 : 0, now,
      },
    );
    return this.getAgent(a.id);
  }
  updateAgent(id: string, patch: Partial<Omit<AgentRow, 'id' | 'createdAt' | 'updatedAt'>>): AgentRow {
    const cur = this.getAgent(id);
    const next = { ...cur, ...patch };
    this.db.run(
      `UPDATE agents SET name = :name, color = :color, role = :role, model = :model, effort = :effort, key_id = :keyId, preset = :preset,
       permissions = :permissions, limits = :limits, paused = :paused, updated_at = :now WHERE id = :id`,
      {
        id, name: next.name, color: next.color, role: next.role, model: next.model, effort: next.effort, keyId: next.keyId, preset: next.preset,
        permissions: JSON.stringify(next.permissions), limits: JSON.stringify(next.limits), paused: next.paused ? 1 : 0, now: Date.now(),
      },
    );
    return this.getAgent(id);
  }
  deleteAgent(id: string): void {
    const r = this.db.run('DELETE FROM agents WHERE id = :id', { id });
    if (r.changes === 0) throw new NotFoundError('에이전트', id);
  }

  /* 모듈 */
  private moduleRow(r: Row): ModuleRow {
    const id = str(r, 'id');
    return {
      id,
      kind: str(r, 'kind') as ModuleRow['kind'],
      origin: str(r, 'origin') as ModuleOrigin,
      dir: str(r, 'dir'),
      manifest: parseJson<Manifest>(r['manifest'], `modules.manifest (id=${id})`),
      enabled: num(r, 'enabled') === 1,
      status: str(r, 'status') as ModuleStatus,
      statusDetail: strOrNull(r, 'status_detail'),
      createdBy: strOrNull(r, 'created_by'),
      report: r['report'] ? parseJson<InstallReport>(r['report'], `modules.report (id=${id})`) : null,
      installedAt: num(r, 'installed_at'),
      updatedAt: num(r, 'updated_at'),
    };
  }
  listModules(kind?: 'module' | 'skill'): ModuleRow[] {
    const rows = kind ? this.db.all('SELECT * FROM modules WHERE kind = :kind ORDER BY installed_at', { kind }) : this.db.all('SELECT * FROM modules ORDER BY installed_at');
    return rows.map((r) => this.moduleRow(r));
  }
  findModule(id: string): ModuleRow | null {
    const r = this.db.get('SELECT * FROM modules WHERE id = :id', { id });
    return r ? this.moduleRow(r) : null;
  }
  getModule(id: string): ModuleRow {
    const m = this.findModule(id);
    if (!m) throw new NotFoundError('모듈', id);
    return m;
  }
  upsertModule(m: Omit<ModuleRow, 'installedAt' | 'updatedAt'>): ModuleRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO modules (id, kind, origin, dir, manifest, enabled, status, status_detail, created_by, report, installed_at, updated_at)
       VALUES (:id, :kind, :origin, :dir, :manifest, :enabled, :status, :statusDetail, :createdBy, :report, :now, :now)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, origin = excluded.origin, dir = excluded.dir, manifest = excluded.manifest,
         enabled = excluded.enabled, status = excluded.status, status_detail = excluded.status_detail, created_by = excluded.created_by,
         report = excluded.report, updated_at = excluded.updated_at`,
      {
        id: m.id, kind: m.kind, origin: m.origin, dir: m.dir, manifest: JSON.stringify(m.manifest), enabled: m.enabled ? 1 : 0,
        status: m.status, statusDetail: m.statusDetail, createdBy: m.createdBy, report: m.report ? JSON.stringify(m.report) : null, now,
      },
    );
    return this.getModule(m.id);
  }
  setModuleStatus(id: string, status: ModuleStatus, detail: string | null): void {
    this.db.run('UPDATE modules SET status = :status, status_detail = :detail, updated_at = :now WHERE id = :id', { id, status, detail, now: Date.now() });
  }
  setModuleEnabled(id: string, enabled: boolean): void {
    this.db.run('UPDATE modules SET enabled = :enabled, updated_at = :now WHERE id = :id', { id, enabled: enabled ? 1 : 0, now: Date.now() });
  }
  deleteModule(id: string): void {
    const r = this.db.run('DELETE FROM modules WHERE id = :id', { id });
    if (r.changes === 0) throw new NotFoundError('모듈', id);
  }

  /* 에이전트 ↔ 모듈 연결 */
  listAgentModules(agentId?: string): AgentModuleRow[] {
    const rows = agentId ? this.db.all('SELECT * FROM agent_modules WHERE agent_id = :agentId', { agentId }) : this.db.all('SELECT * FROM agent_modules');
    return rows.map((r) => ({ agentId: str(r, 'agent_id'), moduleId: str(r, 'module_id'), config: parseJson<AgentModuleRow['config']>(r['config'], 'agent_modules.config') }));
  }
  connectModule(agentId: string, moduleId: string, config: AgentModuleRow['config']): void {
    this.db.run(
      'INSERT INTO agent_modules (agent_id, module_id, config) VALUES (:agentId, :moduleId, :config) ON CONFLICT(agent_id, module_id) DO UPDATE SET config = excluded.config',
      { agentId, moduleId, config: JSON.stringify(config) },
    );
  }
  disconnectModule(agentId: string, moduleId: string): void {
    this.db.run('DELETE FROM agent_modules WHERE agent_id = :agentId AND module_id = :moduleId', { agentId, moduleId });
  }

  /* 훅 */
  private hookRow(r: Row): HookRow {
    const id = str(r, 'id');
    return {
      id,
      name: str(r, 'name'),
      event: str(r, 'event') as HookEvent,
      enabled: num(r, 'enabled') === 1,
      action: str(r, 'action') as HookAction,
      conditions: parseJson(r['conditions'], `hooks.conditions (id=${id})`),
      reason: str(r, 'reason'),
      modify: r['modify'] ? parseJson(r['modify'], `hooks.modify (id=${id})`) : null,
      createdAt: num(r, 'created_at'),
      updatedAt: num(r, 'updated_at'),
    };
  }
  listHooks(): HookRow[] {
    return this.db.all('SELECT * FROM hooks ORDER BY created_at').map((r) => this.hookRow(r));
  }
  getHook(id: string): HookRow {
    const r = this.db.get('SELECT * FROM hooks WHERE id = :id', { id });
    if (!r) throw new NotFoundError('훅', id);
    return this.hookRow(r);
  }
  saveHook(h: RuleHook): HookRow {
    const now = Date.now();
    this.db.run(
      `INSERT INTO hooks (id, name, event, enabled, action, conditions, reason, modify, created_at, updated_at)
       VALUES (:id, :name, :event, :enabled, :action, :conditions, :reason, :modify, :now, :now)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, event = excluded.event, enabled = excluded.enabled, action = excluded.action,
         conditions = excluded.conditions, reason = excluded.reason, modify = excluded.modify, updated_at = excluded.updated_at`,
      {
        id: h.id, name: h.name, event: h.event, enabled: h.enabled ? 1 : 0, action: h.action, conditions: JSON.stringify(h.conditions),
        reason: h.reason, modify: h.modify ? JSON.stringify(h.modify) : null, now,
      },
    );
    return this.getHook(h.id);
  }
  deleteHook(id: string): void {
    const r = this.db.run('DELETE FROM hooks WHERE id = :id', { id });
    if (r.changes === 0) throw new NotFoundError('훅', id);
  }

  /* 대화 스레드 */
  private threadRow(r: Row): ThreadRow {
    return {
      id: str(r, 'id'), agentId: str(r, 'agent_id'), source: str(r, 'source'), title: str(r, 'title'),
      frozenHash: strOrNull(r, 'frozen_hash'), createdAt: num(r, 'created_at'), updatedAt: num(r, 'updated_at'),
    };
  }
  getOrCreateThread(agentId: string, source: string, title: string): ThreadRow {
    const r = this.db.get('SELECT * FROM threads WHERE agent_id = :agentId AND source = :source', { agentId, source });
    if (r) return this.threadRow(r);
    const id = randomId('thr');
    const now = Date.now();
    this.db.run('INSERT INTO threads (id, agent_id, source, title, frozen_hash, created_at, updated_at) VALUES (:id, :agentId, :source, :title, NULL, :now, :now)', { id, agentId, source, title, now });
    return this.getThread(id);
  }
  getThread(id: string): ThreadRow {
    const r = this.db.get('SELECT * FROM threads WHERE id = :id', { id });
    if (!r) throw new NotFoundError('대화', id);
    return this.threadRow(r);
  }
  listThreads(agentId: string): ThreadRow[] {
    return this.db.all('SELECT * FROM threads WHERE agent_id = :agentId ORDER BY updated_at DESC', { agentId }).map((r) => this.threadRow(r));
  }
  setThreadHash(id: string, hash: string): void {
    this.db.run('UPDATE threads SET frozen_hash = :hash, updated_at = :now WHERE id = :id', { id, hash, now: Date.now() });
  }
  touchThread(id: string): void {
    this.db.run('UPDATE threads SET updated_at = :now WHERE id = :id', { id, now: Date.now() });
  }

  /* 모델에 보내는 메시지 (추가만 함) */
  appendMessage(threadId: string, role: 'user' | 'assistant', content: unknown): number {
    return this.db.run('INSERT INTO messages (thread_id, role, content, meta, created_at) VALUES (:threadId, :role, :content, NULL, :now)', {
      threadId, role, content: JSON.stringify(content), now: Date.now(),
    }).lastInsertRowid;
  }
  listMessages(threadId: string): MessageRow[] {
    return this.db
      .all('SELECT * FROM messages WHERE thread_id = :threadId ORDER BY id', { threadId })
      .map((r) => ({ id: num(r, 'id'), threadId, role: str(r, 'role') as MessageRow['role'], content: parseJson(r['content'], `messages.content (id=${num(r, 'id')})`), createdAt: num(r, 'created_at') }));
  }
  replaceMessages(threadId: string, messages: { role: 'user' | 'assistant'; content: unknown }[]): void {
    this.db.tx(() => {
      this.db.run('DELETE FROM messages WHERE thread_id = :threadId', { threadId });
      for (const m of messages) this.appendMessage(threadId, m.role, m.content);
    });
  }

  /* 사람이 보는 타임라인 */
  addTimeline(threadId: string, taskId: string | null, kind: TimelineKind, data: Record<string, unknown>): TimelineRow {
    const now = Date.now();
    const id = this.db.run('INSERT INTO timeline (thread_id, task_id, kind, data, created_at) VALUES (:threadId, :taskId, :kind, :data, :now)', {
      threadId, taskId, kind, data: JSON.stringify(data), now,
    }).lastInsertRowid;
    return { id, threadId, taskId, kind, data, createdAt: now };
  }
  updateTimeline(id: number, data: Record<string, unknown>): void {
    this.db.run('UPDATE timeline SET data = :data WHERE id = :id', { id, data: JSON.stringify(data) });
  }
  listTimeline(threadId: string, limit: number): TimelineRow[] {
    return this.db
      .all('SELECT * FROM (SELECT * FROM timeline WHERE thread_id = :threadId ORDER BY id DESC LIMIT :limit) ORDER BY id', { threadId, limit })
      .map((r) => ({ id: num(r, 'id'), threadId, taskId: strOrNull(r, 'task_id'), kind: str(r, 'kind') as TimelineKind, data: parseJson(r['data'], `timeline.data (id=${num(r, 'id')})`), createdAt: num(r, 'created_at') }));
  }
  findTimelineByApproval(approvalId: string): TimelineRow | null {
    const r = this.db.get("SELECT * FROM timeline WHERE kind = 'approval' AND json_extract(data, '$.approvalId') = :approvalId", { approvalId });
    return r ? { id: num(r, 'id'), threadId: str(r, 'thread_id'), taskId: strOrNull(r, 'task_id'), kind: 'approval', data: parseJson(r['data'], 'timeline.data'), createdAt: num(r, 'created_at') } : null;
  }

  /* 작업 */
  private taskRow(r: Row): TaskRow {
    const id = str(r, 'id');
    return {
      id, agentId: str(r, 'agent_id'), threadId: str(r, 'thread_id'), title: str(r, 'title'), origin: str(r, 'origin') as TaskRow['origin'],
      status: str(r, 'status') as TaskStatus, steps: parseJson<TaskStep[]>(r['steps'], `tasks.steps (id=${id})`), error: strOrNull(r, 'error'),
      createdAt: num(r, 'created_at'), startedAt: numOrNull(r, 'started_at'), finishedAt: numOrNull(r, 'finished_at'),
    };
  }
  insertTask(t: Pick<TaskRow, 'agentId' | 'threadId' | 'title' | 'origin'>): TaskRow {
    const id = randomId('task');
    this.db.run(
      "INSERT INTO tasks (id, agent_id, thread_id, title, origin, status, steps, error, created_at) VALUES (:id, :agentId, :threadId, :title, :origin, 'queued', '[]', NULL, :now)",
      { id, agentId: t.agentId, threadId: t.threadId, title: t.title, origin: t.origin, now: Date.now() },
    );
    return this.getTask(id);
  }
  getTask(id: string): TaskRow {
    const r = this.db.get('SELECT * FROM tasks WHERE id = :id', { id });
    if (!r) throw new NotFoundError('작업', id);
    return this.taskRow(r);
  }
  updateTask(id: string, patch: Partial<Pick<TaskRow, 'status' | 'steps' | 'error' | 'startedAt' | 'finishedAt' | 'title'>>): TaskRow {
    const cur = this.getTask(id);
    const n = { ...cur, ...patch };
    this.db.run(
      'UPDATE tasks SET title = :title, status = :status, steps = :steps, error = :error, started_at = :startedAt, finished_at = :finishedAt WHERE id = :id',
      { id, title: n.title, status: n.status, steps: JSON.stringify(n.steps), error: n.error, startedAt: n.startedAt, finishedAt: n.finishedAt },
    );
    return this.getTask(id);
  }
  listTasks(agentId: string, limit: number): TaskRow[] {
    return this.db.all('SELECT * FROM tasks WHERE agent_id = :agentId ORDER BY created_at DESC LIMIT :limit', { agentId, limit }).map((r) => this.taskRow(r));
  }
  latestTask(agentId: string): TaskRow | null {
    const r = this.db.get("SELECT * FROM tasks WHERE agent_id = :agentId ORDER BY CASE WHEN status IN ('running','waiting') THEN 0 ELSE 1 END, created_at DESC LIMIT 1", { agentId });
    return r ? this.taskRow(r) : null;
  }
  /** 서버가 꺼질 때 실행 중이던 작업을 정리합니다. */
  failUnfinishedTasks(reason: string): number {
    return this.db.run("UPDATE tasks SET status = 'failed', error = :reason, finished_at = :now WHERE status IN ('queued','running','waiting')", { reason, now: Date.now() }).changes;
  }

  /* 승인 */
  private approvalRow(r: Row): ApprovalRow {
    const id = str(r, 'id');
    return {
      id, agentId: str(r, 'agent_id'), taskId: strOrNull(r, 'task_id'), kind: str(r, 'kind'), title: str(r, 'title'),
      detail: parseJson<ApprovalDetail>(r['detail'], `approvals.detail (id=${id})`), status: str(r, 'status') as ApprovalStatus,
      decision: strOrNull(r, 'decision') as ApprovalDecision | null, reason: strOrNull(r, 'reason'), createdAt: num(r, 'created_at'), decidedAt: numOrNull(r, 'decided_at'),
    };
  }
  insertApproval(a: Pick<ApprovalRow, 'agentId' | 'taskId' | 'kind' | 'title' | 'detail'>): ApprovalRow {
    const id = randomId('apv');
    this.db.run(
      "INSERT INTO approvals (id, agent_id, task_id, kind, title, detail, status, created_at) VALUES (:id, :agentId, :taskId, :kind, :title, :detail, 'pending', :now)",
      { id, agentId: a.agentId, taskId: a.taskId, kind: a.kind, title: a.title, detail: JSON.stringify(a.detail), now: Date.now() },
    );
    return this.getApproval(id);
  }
  getApproval(id: string): ApprovalRow {
    const r = this.db.get('SELECT * FROM approvals WHERE id = :id', { id });
    if (!r) throw new NotFoundError('승인 요청', id);
    return this.approvalRow(r);
  }
  listApprovals(status?: ApprovalStatus): ApprovalRow[] {
    const rows = status ? this.db.all('SELECT * FROM approvals WHERE status = :status ORDER BY created_at', { status }) : this.db.all('SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200');
    return rows.map((r) => this.approvalRow(r));
  }
  decideApproval(id: string, status: ApprovalStatus, decision: ApprovalDecision | null, reason: string | null): ApprovalRow {
    this.db.run('UPDATE approvals SET status = :status, decision = :decision, reason = :reason, decided_at = :now WHERE id = :id', { id, status, decision, reason, now: Date.now() });
    return this.getApproval(id);
  }
  expireStaleApprovals(reason: string): number {
    return this.db.run("UPDATE approvals SET status = 'expired', reason = :reason, decided_at = :now WHERE status = 'pending'", { reason, now: Date.now() }).changes;
  }

  /* 활동 로그 */
  private activityRow(r: Row): ActivityRow {
    return {
      id: num(r, 'id'), ts: num(r, 'ts'), type: str(r, 'type'), category: str(r, 'category') as ActivityCategory, tone: str(r, 'tone') as ActivityTone,
      who: str(r, 'who'), text: str(r, 'text'), agentId: strOrNull(r, 'agent_id'), moduleId: strOrNull(r, 'module_id'),
      data: r['data'] ? parseJson(r['data'], 'activity.data') : null,
    };
  }
  addActivity(a: Omit<ActivityRow, 'id' | 'ts'>): ActivityRow {
    const ts = Date.now();
    const id = this.db.run(
      'INSERT INTO activity (ts, type, category, tone, who, text, agent_id, module_id, data) VALUES (:ts, :type, :category, :tone, :who, :text, :agentId, :moduleId, :data)',
      { ts, type: a.type, category: a.category, tone: a.tone, who: a.who, text: a.text, agentId: a.agentId, moduleId: a.moduleId, data: a.data ? JSON.stringify(a.data) : null },
    ).lastInsertRowid;
    return { ...a, id, ts };
  }
  listActivity(limit: number, before?: number): ActivityRow[] {
    const rows = before
      ? this.db.all('SELECT * FROM activity WHERE id < :before ORDER BY id DESC LIMIT :limit', { before, limit })
      : this.db.all('SELECT * FROM activity ORDER BY id DESC LIMIT :limit', { limit });
    return rows.map((r) => this.activityRow(r));
  }
  pruneActivity(keep: number): void {
    this.db.run('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET :keep)', { keep });
  }

  /* 토큰 사용량 */
  addUsage(agentId: string, day: string, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): void {
    this.db.run(
      `INSERT INTO usage_daily (agent_id, day, input_tokens, output_tokens, cache_read, cache_write) VALUES (:agentId, :day, :input, :output, :cacheRead, :cacheWrite)
       ON CONFLICT(agent_id, day) DO UPDATE SET input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens,
         cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`,
      { agentId, day, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
    );
  }
  /** 한도 계산용 합계: 입력(캐시 포함) + 출력 */
  usageTotal(agentId: string, day: string): number {
    const r = this.db.get('SELECT input_tokens + output_tokens + cache_read + cache_write AS total FROM usage_daily WHERE agent_id = :agentId AND day = :day', { agentId, day });
    return r ? num(r, 'total') : 0;
  }
  usageAll(day: string): number {
    const r = this.db.get('SELECT COALESCE(SUM(input_tokens + output_tokens + cache_read + cache_write), 0) AS total FROM usage_daily WHERE day = :day', { day });
    return r ? num(r, 'total') : 0;
  }

  /* 세션 */
  insertSession(id: string, expiresAt: number, userAgent: string | null): void {
    this.db.run('INSERT INTO sessions (id, created_at, expires_at, user_agent) VALUES (:id, :now, :expiresAt, :userAgent)', { id, now: Date.now(), expiresAt, userAgent });
  }
  getSession(id: string): { id: string; expiresAt: number } | null {
    const r = this.db.get('SELECT id, expires_at FROM sessions WHERE id = :id', { id });
    return r ? { id: str(r, 'id'), expiresAt: num(r, 'expires_at') } : null;
  }
  deleteSession(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = :id', { id });
  }
  purgeSessions(now: number): void {
    this.db.run('DELETE FROM sessions WHERE expires_at <= :now', { now });
  }

  /* 예약 */
  private scheduleRow(r: Row): ScheduleRow {
    return {
      id: str(r, 'id'), agentId: str(r, 'agent_id'), spec: str(r, 'spec'), prompt: str(r, 'prompt'),
      reply: r['reply'] ? parseJson<ScheduleRow['reply']>(r['reply'], 'schedules.reply') : null, enabled: num(r, 'enabled') === 1,
      nextRun: numOrNull(r, 'next_run'), lastRun: numOrNull(r, 'last_run'), createdBy: str(r, 'created_by'), createdAt: num(r, 'created_at'),
    };
  }
  insertSchedule(s: Omit<ScheduleRow, 'id' | 'createdAt' | 'lastRun'>): ScheduleRow {
    const id = randomId('sch');
    this.db.run(
      'INSERT INTO schedules (id, agent_id, spec, prompt, reply, enabled, next_run, last_run, created_by, created_at) VALUES (:id, :agentId, :spec, :prompt, :reply, :enabled, :nextRun, NULL, :createdBy, :now)',
      { id, agentId: s.agentId, spec: s.spec, prompt: s.prompt, reply: s.reply ? JSON.stringify(s.reply) : null, enabled: s.enabled ? 1 : 0, nextRun: s.nextRun, createdBy: s.createdBy, now: Date.now() },
    );
    return this.getSchedule(id);
  }
  getSchedule(id: string): ScheduleRow {
    const r = this.db.get('SELECT * FROM schedules WHERE id = :id', { id });
    if (!r) throw new NotFoundError('예약', id);
    return this.scheduleRow(r);
  }
  listSchedules(agentId?: string): ScheduleRow[] {
    const rows = agentId ? this.db.all('SELECT * FROM schedules WHERE agent_id = :agentId ORDER BY created_at', { agentId }) : this.db.all('SELECT * FROM schedules ORDER BY created_at');
    return rows.map((r) => this.scheduleRow(r));
  }
  dueSchedules(now: number): ScheduleRow[] {
    return this.db.all('SELECT * FROM schedules WHERE enabled = 1 AND next_run IS NOT NULL AND next_run <= :now', { now }).map((r) => this.scheduleRow(r));
  }
  markScheduleRun(id: string, lastRun: number, nextRun: number | null): void {
    this.db.run('UPDATE schedules SET last_run = :lastRun, next_run = :nextRun WHERE id = :id', { id, lastRun, nextRun });
  }
  setScheduleEnabled(id: string, enabled: boolean, nextRun: number | null): void {
    this.db.run('UPDATE schedules SET enabled = :enabled, next_run = :nextRun WHERE id = :id', { id, enabled: enabled ? 1 : 0, nextRun });
  }
  deleteSchedule(id: string): void {
    const r = this.db.run('DELETE FROM schedules WHERE id = :id', { id });
    if (r.changes === 0) throw new NotFoundError('예약', id);
  }
}
