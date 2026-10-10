import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EFFORT_LEVELS, type Effort } from '../anthropic/models.ts';
import type { AnthropicService } from '../anthropic/service.ts';
import type { ApprovalService } from '../approvals/service.ts';
import type { AttachmentService } from '../attachments/service.ts';
import type { Config } from '../config/env.ts';
import { randomId } from '../crypto/secrets.ts';
import type { AgentModuleRow, AgentRow, ModuleRow, ReportTarget, Store, TaskRow } from '../db/store.ts';
import { ConflictError, LimitError, ModuleError, NotFoundError, PermissionDeniedError, ValidationError } from '../errors.ts';
import type { AgentLiveStatus, EventBus } from '../events/bus.ts';
import type { GuardState } from '../guards/guards.ts';
import type { HookEngine } from '../hooks/engine.ts';
import { limitChanges, sameLimits, validateLimits, type AgentLimits } from '../limits/limits.ts';
import type { Logger } from '../log.ts';
import { TOOL_NAME_RE } from '../modules/manifest.ts';
import type { InboundMessage } from '../modules/protocol.ts';
import type { ModuleRegistry } from '../modules/registry.ts';
import type { SourceFile } from '../modules/static-check.ts';
import { folderLabel, validateFolders } from '../permissions/folders.ts';
import { addAlways, BASE_PERMISSIONS, evaluatePermission, messagePermission, validatePermissionSet, type PermissionDef, type PermissionSet } from '../permissions/policy.ts';
import type { ProjectService } from '../projects/service.ts';
import type { SchedulerService } from '../scheduler/service.ts';
import type { SettingsService } from '../settings/service.ts';
import { builtinTools, type DelegateInput, type HeartbeatToolInput, type SkillInput, type ToolServices } from '../tools/builtin.ts';
import type { ToolEnv } from '../tools/types.ts';
import {
  delegationProblem,
  delegationRequestText,
  delegationResultText,
  heartbeatDue,
  heartbeatPrompt,
  parseReportTarget,
  quietPreamble,
  validateDelegation,
  validateHeartbeat,
} from './autonomy.ts';
import { abilityFor, blockedLabel, capableAgents, capableLabel } from './capability.ts';
import { ToolExecutor } from './executor.ts';
import { ScreenLocks } from './screen.ts';
import { permissionsFromPreset, type Preset } from './presets.ts';
import { AgentRuntime, type TaskEnd, type TaskInput } from './runtime.ts';

const HEARTBEAT_TICK_MS = 15_000;
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

const NAME_RE = /^[\p{L}\p{N} _-]+$/u;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** 서버 전체 동시 작업 한도 */
class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];
  constructor(n: number) {
    this.available = n;
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    const release = (): void => {
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      const grant = (): void => resolve(release);
      this.waiters.push(grant);
      signal.addEventListener('abort', () => {
        const i = this.waiters.indexOf(grant);
        if (i !== -1) {
          this.waiters.splice(i, 1);
          resolve(() => {});
        }
      }, { once: true });
    });
  }
}

export interface ManagerDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  log: Logger;
  anthropic: AnthropicService;
  registry: ModuleRegistry;
  hooks: HookEngine;
  approvals: ApprovalService;
  guardState: GuardState;
  scheduler: SchedulerService;
  presets: Map<string, Preset>;
  /** 기본 금지 조항의 비밀 폴더 이름 (허용 폴더로 둘 수 없음) */
  secretDirs: readonly string[];
  /** 관리 중인 프로젝트 */
  projects: ProjectService;
  /** 모듈 설정 (없으면 '설정 필요' 카드를 띄우지 않음) */
  settings?: SettingsService;
  /** 콘솔 첨부 */
  attachments?: AttachmentService;
}

export interface AgentInput {
  name: unknown;
  color: unknown;
  role: unknown;
  keyId: unknown;
  model: unknown;
  effort: unknown;
  preset: unknown;
  modules: unknown;
  delegation?: unknown;
  /** 고칠 때만 (만들 때는 권한 프리셋의 한도) */
  limits?: unknown;
}

export class AgentManager {
  private readonly d: ManagerDeps;
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly slots: Semaphore;
  private readonly serverToolLevel = new Map<string, number>();
  /** 화면 제어 도구 묶음을 받지 않는 모델 (한 번 거절되면 그 모델에는 빼고 보냄) */
  private readonly noComputer = new Set<string>();
  /** 화면 하나는 한 번에 한 작업만 */
  readonly screenLocks = new ScreenLocks();
  readonly executor: ToolExecutor;
  private readonly builtins;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(deps: ManagerDeps) {
    this.d = deps;
    this.slots = new Semaphore(deps.config.agentMaxConcurrency);
    const services: ToolServices = {
      config: deps.config,
      store: deps.store,
      registry: deps.registry,
      deliver: (agent, env, moduleId, target, text) => this.deliver(agent, env, moduleId, target, text),
      createSkill: (agent, env, input) => this.createSkill(agent, env, input),
      createModule: (agent, env, files) => this.createModule(agent, env, files),
      schedules: deps.scheduler,
      delegate: (agent, env, input) => this.delegate(agent, env, input),
      heartbeat: (agent, env, input) => this.setHeartbeatFromTool(agent, env, input),
      projects: {
        track: (env, abs, input) => {
          const task = this.d.store.findTask(env.taskId);
          const { row, created } = deps.projects.track(env.agent, abs, input, { ...deps.projects.originOf(task, env), taskId: env.taskId });
          const where = deps.projects.view(row, env.agent).displayPath;
          return created
            ? `프로젝트 '${row.name}'(${where})을(를) 등록했습니다${row.watch ? ' · 하트비트 점검에 포함' : ''}. 사용자가 프로젝트 화면에서 볼 수 있습니다.`
            : `프로젝트 '${row.name}'(${where})을(를) 고쳤습니다${row.watch ? ' · 하트비트 점검에 포함' : ''}.`;
        },
        untrack: (env, abs) => {
          const p = this.d.store.findProjectByPath(env.agent.id, abs);
          if (!p) throw new ValidationError('project_not_tracked', `'${abs}'은(는) 등록된 프로젝트가 아닙니다. 등록할 때 쓴 경로를 확인하세요.`);
          deps.projects.remove(p.id);
          return `프로젝트 '${p.name}'을(를) 목록에서 뺐습니다. 폴더와 파일은 그대로입니다.`;
        },
      },
    };
    this.builtins = builtinTools(services);
    for (const t of this.builtins) deps.registry.reservedToolNames.add(t.name);
    this.executor = new ToolExecutor({
      config: deps.config,
      store: deps.store,
      bus: deps.bus,
      hooks: deps.hooks,
      approvals: deps.approvals,
      registry: deps.registry,
      builtins: new Map(this.builtins.map((t) => [t.name, t])),
      defs: () => this.permissionDefs(),
      screenLocks: this.screenLocks,
      activity: deps.projects,
      ...(deps.settings ? { setupNeeds: settingsNeeds(deps.settings, deps.store) } : {}),
    });
  }

  builtinNames(): string[] {
    return this.builtins.map((t) => t.name);
  }

  /** 권한 항목: 고정 항목 + 설치된 채널 모듈별 전송 권한 (받기만 하는 채널은 제외) */
  permissionDefs(): PermissionDef[] {
    const channels = this.d.store.listModules('module').filter((m) => m.manifest.channel && m.manifest.channel.send !== false && m.status !== 'rejected');
    return [...BASE_PERMISSIONS, ...channels.map((m) => messagePermission(m.id, m.manifest.name))];
  }

  init(): void {
    for (const a of this.d.store.listAgents()) this.runtimeFor(a.id);
    this.d.registry.onInbound = (moduleId, msg) => this.route(moduleId, msg);
    this.d.scheduler.onDue = (run) => {
      const agent = this.d.store.getAgent(run.agentId);
      const reply = run.reply && this.d.store.findModule(run.reply.moduleId) ? run.reply : null;
      // 일시정지 중이거나 이전 실행이 아직 끝나지 않았으면 쌓지 않고 건너뜁니다 (재개하는 순간 밀린 실행이 한꺼번에 돌지 않게).
      const why = agent.paused ? '일시정지 중' : this.runtimeFor(agent.id).hasSchedule(run.scheduleId) ? '이전 실행이 아직 끝나지 않음' : null;
      if (why) {
        this.skipSchedule(agent, run.scheduleId, run.label, why);
        return;
      }
      try {
        this.enqueue({
          agentId: agent.id,
          source: reply ? `${reply.moduleId}:${reply.target}` : `schedule:${run.scheduleId}`,
          sourceLabel: `예약 실행 · ${run.label}`,
          origin: 'schedule',
          text: run.prompt,
          reply,
          title: `예약 · ${run.prompt.slice(0, 40)}`,
          scheduleId: run.scheduleId,
        });
      } catch (err) {
        if (!(err instanceof LimitError)) throw err;
        this.skipSchedule(agent, run.scheduleId, run.label, '대기열이 가득 참');
      }
    };

    // 승인 후속 처리
    this.d.approvals.onDecide('permission', (approval, decision) => {
      if (decision !== 'always' || !approval.detail.permission || !approval.detail.target) return null;
      const agent = this.d.store.getAgent(approval.agentId);
      const key = approval.detail.permission;
      const rule = agent.permissions[key] ?? { mode: 'ask' as const, scope: [], always: [] };
      this.d.store.updateAgent(agent.id, { permissions: { ...agent.permissions, [key]: addAlways(rule, approval.detail.target) } });
      return `'${approval.detail.target}'을(를) 항상 허용 목록에 추가했습니다.`;
    });
    this.d.approvals.onDecide('module.install', (approval, decision) => {
      const id = approval.detail.moduleId;
      if (!id) return null;
      const row = this.d.store.findModule(id);
      if (!row || row.status !== 'pending') return null;
      if (decision === 'once' || decision === 'always') {
        const next = this.d.registry.approvePending(id);
        return `설치 승인됨 · 상태 ${next.status}`;
      }
      this.d.registry.rejectPending(id);
      return decision === 'deny' ? '설치를 거부해 파일을 지웠습니다.' : '승인 대기 시간이 지나 설치하지 않고 파일을 지웠습니다.';
    });
  }

  /** 예약 실행을 건너뛴 기록: 예약에 횟수를 남기고 활동에 알립니다. */
  private skipSchedule(agent: AgentRow, scheduleId: string, label: string, why: string): void {
    this.d.store.markScheduleSkipped(scheduleId, Date.now());
    this.d.bus.activity({ type: 'schedule.skipped', category: 'agent', tone: 'wait', who: agent.name, text: `예약 건너뜀 · ${label} · ${why}`, agentId: agent.id, data: { scheduleId } });
  }

  private runtimeFor(agentId: string): AgentRuntime {
    let rt = this.runtimes.get(agentId);
    if (!rt) {
      rt = new AgentRuntime(agentId, {
        config: this.d.config,
        store: this.d.store,
        bus: this.d.bus,
        log: this.d.log.child(`agent:${agentId}`),
        anthropic: this.d.anthropic,
        executor: this.executor,
        registry: this.d.registry,
        builtins: this.builtins,
        defs: () => this.permissionDefs(),
        guardState: this.d.guardState,
        serverToolLevel: this.serverToolLevel,
        noComputer: this.noComputer,
        projectsFor: (agent) => this.d.projects.list(agent.id).map((p) => ({ name: p.name, path: p.path, note: p.note, watch: p.watch })),
        ...(this.d.attachments ? { attachments: this.d.attachments } : {}),
        deliver: (agent, env, moduleId, target, text) => this.deliver(agent, env, moduleId, target, text),
        acquireSlot: (signal) => this.slots.acquire(signal),
        onFinished: () => this.pumpAll(),
        onTaskEnd: (end) => this.onTaskEnd(end),
      });
      this.runtimes.set(agentId, rt);
    }
    return rt;
  }

  private pumpAll(): void {
    for (const rt of this.runtimes.values()) rt.pump();
  }

  enqueue(input: TaskInput): TaskRow {
    return this.runtimeFor(input.agentId).enqueue(input);
  }

  live(agentId: string): { status: AgentLiveStatus; detail: string | null; queued: TaskRow[]; running: TaskRow[]; queueLength: number; queueMax: number } {
    const rt = this.runtimeFor(agentId);
    return { status: rt.status, detail: rt.detail, queued: rt.queued(), running: rt.runningTasks(), queueLength: rt.queueLength(), queueMax: this.d.config.agentQueueMax };
  }

  /** 대기열이 가득 차 채널 메시지를 받지 못했을 때 */
  private dropForFullQueue(agent: AgentRow, moduleName: string, targetLabel: string, moduleId: string): void {
    this.d.bus.activity({ type: 'message.dropped', category: 'agent', tone: 'error', who: agent.name, text: `대기열이 가득 차(${this.d.config.agentQueueMax}건) ${moduleName} ${targetLabel} 메시지를 받지 않았습니다.`, agentId: agent.id, moduleId });
  }

  cancelTask(taskId: string): boolean {
    for (const rt of this.runtimes.values()) if (rt.cancel(taskId)) return true;
    return false;
  }

  /* ───────── 에이전트 만들기·바꾸기 ───────── */

  private checkName(raw: unknown, exceptId: string | null): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (name.length === 0) throw new ValidationError('agent_name_empty', '이름을 입력하세요.');
    if (name.length > 24) throw new ValidationError('agent_name_long', `이름은 24자까지 쓸 수 있습니다. 지금 ${name.length}자입니다.`);
    if (!NAME_RE.test(name)) {
      const bad = [...new Set([...name].filter((c) => !NAME_RE.test(c)))].join(' ');
      throw new ValidationError('agent_name_chars', `이름에 쓸 수 없는 문자가 있습니다: ${bad} (글자, 숫자, 공백, -, _ 만 가능)`);
    }
    const dup = this.d.store.findAgentByName(name);
    if (dup && dup.id !== exceptId) throw new ConflictError('agent_name_taken', `'${name}'은(는) 이미 쓰고 있는 에이전트 이름입니다.`);
    return name;
  }

  private async checkModel(keyId: string, model: unknown, effort: unknown): Promise<{ model: string; effort: Effort | null }> {
    if (typeof model !== 'string' || model.trim() === '') throw new ValidationError('agent_model_empty', '모델을 고르세요.');
    const list = await this.d.anthropic.models(keyId);
    const info = list.find((m) => m.id === model);
    if (!info) throw new ValidationError('agent_model_unknown', `모델 '${model}'은(는) 이 키로 쓸 수 있는 목록에 없습니다. 목록에서 다시 고르세요.`);
    if (info.lifecycle === 'retired') throw new ValidationError('agent_model_retired', `'${info.name}'은(는) 서비스가 끝난 모델이라 고를 수 없습니다.`);
    if (effort === null || effort === undefined || effort === '') return { model, effort: null };
    if (!EFFORT_LEVELS.includes(effort as Effort)) throw new ValidationError('agent_effort', `노력 수준은 ${EFFORT_LEVELS.join(', ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(effort)}`);
    if (!info.efforts.includes(effort as Effort)) {
      throw new ValidationError('agent_effort_unsupported', `'${info.name}'은(는) 노력 수준 '${String(effort)}'을(를) 지원하지 않습니다. 가능한 값: ${info.efforts.join(', ') || '(노력 설정 미지원 — 모델 기본값을 고르세요)'}`);
    }
    return { model, effort: effort as Effort };
  }

  private checkLinks(raw: unknown): { moduleId: string; config: AgentModuleRow['config'] }[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new ValidationError('agent_modules_type', '연결할 모듈 목록은 배열이어야 합니다.');
    const links = raw.map((l, i) => {
      const item = l as { moduleId?: unknown; targets?: unknown; trigger?: unknown };
      if (typeof item.moduleId !== 'string') throw new ValidationError('agent_module_id', `${i + 1}번째 연결의 moduleId 가 없습니다.`);
      const m = this.d.store.getModule(item.moduleId);
      if (m.status === 'pending') throw new ValidationError('agent_module_pending', `모듈 '${m.manifest.name}'은(는) 아직 설치 승인 전이라 연결할 수 없습니다.`);
      const targets = Array.isArray(item.targets) ? item.targets.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) : [];
      const trigger = item.trigger === 'all' || item.trigger === 'none' ? item.trigger : 'direct';
      const config: AgentModuleRow['config'] = { targets, trigger };
      return { moduleId: m.id, config };
    });
    const screens = links.filter((l) => this.d.store.getModule(l.moduleId).manifest.computer);
    if (screens.length > 1) {
      throw new ValidationError('agent_computer_multi', `화면 제어 모듈은 에이전트마다 하나만 연결할 수 있습니다. 지금 ${screens.length}개입니다.`);
    }
    return links;
  }

  async createAgent(input: AgentInput): Promise<AgentRow> {
    const name = this.checkName(input.name, null);
    const color = typeof input.color === 'string' && COLOR_RE.test(input.color) ? input.color : null;
    if (!color) throw new ValidationError('agent_color', `색은 #RRGGBB 형식이어야 합니다. 받은 값: ${JSON.stringify(input.color)}`);
    const role = typeof input.role === 'string' ? input.role.trim() : '';
    if (role.length > 2000) throw new ValidationError('agent_role_long', `역할은 2,000자까지 쓸 수 있습니다. 지금 ${role.length}자입니다.`);
    if (typeof input.keyId !== 'string') throw new ValidationError('agent_key', 'API 키를 먼저 확인하세요.');
    const key = this.d.store.getKey(input.keyId);
    const { model, effort } = await this.checkModel(key.id, input.model, input.effort);
    const presetId = typeof input.preset === 'string' ? input.preset : 'helper';
    const preset = this.d.presets.get(presetId === 'custom' ? 'helper' : presetId);
    if (!preset) throw new ValidationError('agent_preset', `권한 프리셋 '${presetId}'이(가) 없습니다. 가능한 값: ${[...this.d.presets.keys(), 'custom'].join(', ')}`);
    const links = this.checkLinks(input.modules);
    const delegation = validateDelegation(input.delegation, null, this.d.store.listAgents());

    const id = randomId('agt', 6);
    const agent = this.d.store.db.tx(() => {
      const a = this.d.store.insertAgent({
        id,
        name,
        color,
        role,
        model,
        effort,
        keyId: key.id,
        preset: presetId,
        permissions: permissionsFromPreset(preset, this.permissionDefs()),
        limits: preset.limits,
        paused: false,
        delegation,
      });
      for (const l of links) this.d.store.connectModule(a.id, l.moduleId, l.config);
      return a;
    });
    this.runtimeFor(agent.id);
    this.d.bus.activity({ type: 'agent.created', category: 'agent', tone: 'new', who: agent.name, text: `고용됨 · ${model}`, agentId: agent.id });
    this.d.bus.emit({ type: 'graph.changed' });
    return agent;
  }

  async updateAgent(id: string, patch: Partial<AgentInput>): Promise<AgentRow> {
    const cur = this.d.store.getAgent(id);
    const next: Partial<AgentRow> = {};
    if (patch.name !== undefined) next.name = this.checkName(patch.name, id);
    if (patch.color !== undefined) {
      if (typeof patch.color !== 'string' || !COLOR_RE.test(patch.color)) throw new ValidationError('agent_color', `색은 #RRGGBB 형식이어야 합니다. 받은 값: ${JSON.stringify(patch.color)}`);
      next.color = patch.color;
    }
    if (patch.role !== undefined) {
      const role = typeof patch.role === 'string' ? patch.role.trim() : '';
      if (role.length > 2000) throw new ValidationError('agent_role_long', `역할은 2,000자까지 쓸 수 있습니다. 지금 ${role.length}자입니다.`);
      next.role = role;
    }
    if (patch.keyId !== undefined || patch.model !== undefined || patch.effort !== undefined) {
      const keyId = typeof patch.keyId === 'string' ? this.d.store.getKey(patch.keyId).id : cur.keyId;
      const checked = await this.checkModel(keyId, patch.model ?? cur.model, patch.effort === undefined ? cur.effort : patch.effort);
      next.keyId = keyId;
      next.model = checked.model;
      next.effort = checked.effort;
    }
    if (patch.limits !== undefined) {
      const limits = validateLimits(patch.limits);
      if (!sameLimits(limits, cur.limits)) next.limits = limits;
    }
    const row = this.d.store.updateAgent(id, next);
    if (next.limits) {
      this.d.bus.activity({ type: 'agent.limits', category: 'hook', tone: 'pass', who: row.name, text: `한도를 바꿨습니다 · ${limitChanges(cur.limits, next.limits).join(', ')}`, agentId: id });
      // 동시 작업 한도를 올렸으면 기다리던 작업을 바로 시작합니다.
      this.runtimeFor(id).pump();
    }
    this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  setPermissions(id: string, permissionsRaw: unknown): AgentRow {
    this.d.store.getAgent(id);
    const permissions: PermissionSet = validatePermissionSet(permissionsRaw, this.permissionDefs());
    const row = this.d.store.updateAgent(id, { permissions, preset: 'custom' });
    this.d.bus.activity({ type: 'agent.permissions', category: 'hook', tone: 'pass', who: row.name, text: '권한 설정을 바꿨습니다', agentId: id });
    this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  setModules(id: string, linksRaw: unknown): AgentModuleRow[] {
    this.d.store.getAgent(id);
    const links = this.checkLinks(linksRaw);
    this.d.store.db.tx(() => {
      for (const cur of this.d.store.listAgentModules(id)) if (!links.some((l) => l.moduleId === cur.moduleId)) this.d.store.disconnectModule(id, cur.moduleId);
      for (const l of links) this.d.store.connectModule(id, l.moduleId, l.config);
    });
    this.d.bus.emit({ type: 'graph.changed' });
    return this.d.store.listAgentModules(id);
  }

  setPaused(id: string, paused: boolean): AgentRow {
    const row = this.d.store.updateAgent(id, { paused });
    this.runtimeFor(id).onPauseChanged(paused);
    this.d.bus.activity({ type: paused ? 'agent.paused' : 'agent.resumed', category: 'agent', tone: 'agent', who: row.name, text: paused ? '일시정지' : '재개', agentId: id });
    return row;
  }

  deleteAgent(id: string): void {
    const row = this.d.store.getAgent(id);
    this.runtimeFor(id).cancelAll('에이전트를 삭제해 작업을 취소했습니다.');
    this.runtimes.delete(id);
    this.d.store.db.tx(() => {
      // 이 에이전트를 협조 에이전트로 둔 에이전트들은 협조 에이전트 없음으로 바꿉니다.
      for (const a of this.d.store.listAgents()) {
        if (a.delegation.supervisorId === id) this.d.store.updateAgent(a.id, { delegation: { ...a.delegation, supervisorId: null } });
      }
      this.d.store.deleteAgent(id);
    });
    // 화면 제어 기록(스크린샷)도 함께 지웁니다.
    fs.rmSync(path.join(this.d.config.dataDir, 'screens', id), { recursive: true, force: true });
    this.d.attachments?.removeAgent(id);
    this.d.bus.activity({ type: 'agent.deleted', category: 'agent', tone: 'agent', who: row.name, text: '삭제됨', agentId: null });
    this.d.bus.emit({ type: 'graph.changed' });
  }

  /* ───────── 위임 설정 · 하트비트 ───────── */

  setDelegation(id: string, raw: unknown): AgentRow {
    this.d.store.getAgent(id);
    const delegation = validateDelegation(raw, id, this.d.store.listAgents());
    const row = this.d.store.updateAgent(id, { delegation });
    const parts = [`받기 ${delegation.accept ? '허용' : '미허용'}`, `보내기 ${delegation.send ? '허용' : '미허용'}`];
    if (delegation.supervisorId) parts.push(`협조 ${this.d.store.findAgent(delegation.supervisorId)?.name ?? delegation.supervisorId}`);
    this.d.bus.activity({ type: 'agent.delegation', category: 'agent', tone: 'pass', who: row.name, text: `위임 설정 · ${parts.join(' · ')}`, agentId: id });
    this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  /** 허용 폴더: 사용자가 화면에서만 정합니다 (에이전트에게는 바꾸는 도구가 없음). */
  setFolders(id: string, raw: unknown): AgentRow {
    this.d.store.getAgent(id);
    const home = os.homedir();
    const folders = validateFolders(raw, { home, rootDir: this.d.config.rootDir, dataDir: this.d.config.dataDir, platform: process.platform, secretDirs: this.d.secretDirs });
    const row = this.d.store.updateAgent(id, { folders });
    this.d.bus.activity({
      type: 'agent.folders',
      category: 'agent',
      tone: 'pass',
      who: row.name,
      text: folders.length === 0 ? '허용 폴더 없음 · 작업 폴더만' : `허용 폴더 ${folders.length}개 · ${folders.map((f) => folderLabel(f, home)).join(', ').slice(0, 160)}`,
      agentId: id,
    });
    this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  /** 보고 받을 곳: 메시지를 보낼 수 있는 채널 모듈이어야 합니다. */
  private checkReportTarget(raw: unknown): ReportTarget | null {
    const r = parseReportTarget(raw);
    if (!r) return null;
    const mod = this.d.store.findModule(r.moduleId);
    if (!mod) throw new ValidationError('report_module_missing', `보고 채널 모듈 '${r.moduleId}'이(가) 없습니다.`);
    if (!mod.manifest.channel || mod.manifest.channel.send === false) {
      throw new ValidationError('report_module_cannot_send', `'${mod.manifest.name}'은(는) 메시지를 보낼 수 없는 모듈이라 보고 받을 곳으로 쓸 수 없습니다. Discord · Telegram 같은 채널을 고르세요.`);
    }
    return r;
  }

  /** 하트비트 · 보고 받을 곳 설정 (화면에서). 켜거나 간격을 바꾸면 지금부터 한 간격 뒤에 첫 점검을 합니다. */
  setAutonomy(id: string, rawHeartbeat: unknown, rawReport: unknown): AgentRow {
    const cur = this.d.store.getAgent(id);
    const hb = rawHeartbeat === null ? null : validateHeartbeat(rawHeartbeat, this.d.config.heartbeatMinMinutes);
    const report = this.checkReportTarget(rawReport);
    const restart = Boolean(hb?.enabled) && (!cur.heartbeat?.enabled || cur.heartbeat.everyMinutes !== hb?.everyMinutes);
    const row = this.d.store.updateAgent(id, { heartbeat: hb, report, heartbeatLastAt: restart ? Date.now() : cur.heartbeatLastAt });
    if (Boolean(cur.heartbeat?.enabled) !== Boolean(hb?.enabled) || restart) {
      this.d.bus.activity({ type: 'agent.heartbeat', category: 'agent', tone: 'pass', who: row.name, text: hb?.enabled ? `하트비트 켬 · ${hb.everyMinutes}분마다${hb.activeHours ? ` (${hb.activeHours})` : ''}` : '하트비트 끔', agentId: id });
    }
    this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  /** heartbeat_set 도구: 에이전트가 사용자의 "지켜보다가 알려줘" 요청을 하트비트로 등록합니다. */
  setHeartbeatFromTool(agent: AgentRow, env: ToolEnv, input: HeartbeatToolInput): string {
    const cur = agent.heartbeat;
    const merged = {
      enabled: input.enabled,
      everyMinutes: input.everyMinutes ?? cur?.everyMinutes ?? Math.max(60, this.d.config.heartbeatMinMinutes),
      activeHours: input.activeHours === undefined ? (cur?.activeHours ?? null) : input.activeHours || null,
      checklist: input.checklist ?? cur?.checklist ?? '',
    };
    // 보고 받을 곳이 없으면 지금 대화한 채널로 보냅니다.
    const report = agent.report ?? (env.reply && this.d.store.findModule(env.reply.moduleId)?.manifest.channel?.send !== false ? env.reply : null);
    const row = this.setAutonomy(agent.id, merged, report);
    const hb = row.heartbeat;
    const where = row.report ? `${this.d.store.findModule(row.report.moduleId)?.manifest.name ?? row.report.moduleId} ${row.report.target}` : '웹 화면';
    if (!hb?.enabled) {
      return hb?.checklist
        ? `알릴 조건을 저장했습니다 · 보고 받을 곳: ${where}. 하트비트(주기 점검)는 꺼져 있어, 연결된 모듈의 자동 알림(새 메일 등)을 받을 때 이 조건으로 판단합니다.`
        : '하트비트를 껐습니다.';
    }
    return `하트비트를 켰습니다: ${hb.everyMinutes}분마다${hb.activeHours ? ` (${hb.activeHours} 사이)` : ''} 점검 · 보고 받을 곳: ${where}. 알릴 것이 없으면 조용히 있고, 알릴 것이 있을 때만 보고합니다.`;
  }

  /**
   * 하트비트 한 번. 조용한 작업으로 넣어, 알릴 것이 있을 때만 화면과 보고 채널에 나타납니다.
   * 자동 실행은 다른 작업 중이면 건너뛰고(다음 차례에 다시 봄), 직접 실행(manual)은 이유를 알려 줍니다.
   */
  runHeartbeat(agentId: string, manual: boolean): TaskRow | null {
    const agent = this.d.store.getAgent(agentId);
    const hb = agent.heartbeat;
    if (!hb || hb.checklist.trim() === '') {
      if (manual) throw new ValidationError('heartbeat_empty', `'${agent.name}'에 점검 · 알릴 조건이 없습니다. 먼저 무엇을 확인하고 언제 알릴지 적고 저장하세요.`);
      return null;
    }
    if (agent.paused) {
      if (manual) throw new ConflictError('agent_paused', `'${agent.name}'이(가) 일시정지 중이라 점검하지 않았습니다. 재개한 뒤 다시 누르세요.`);
      return null;
    }
    if (this.runtimeFor(agentId).busy()) {
      if (manual) throw new ConflictError('heartbeat_busy', `'${agent.name}'이(가) 다른 작업 중이라 지금은 점검하지 않았습니다. 작업이 끝난 뒤 다시 누르세요.`);
      return null;
    }
    this.d.store.setHeartbeatLastAt(agentId, Date.now());
    return this.enqueue({
      agentId,
      source: 'heartbeat',
      sourceLabel: '하트비트',
      origin: 'heartbeat',
      text: heartbeatPrompt(hb.checklist, this.d.projects.watched(agent).map((p) => ({ name: p.name, path: p.path, note: p.note }))),
      reply: null,
      title: '하트비트',
      quiet: true,
      trigger: manual ? '하트비트 점검 (직접 실행)' : '하트비트 점검',
      reportTo: agent.report,
      manual,
    });
  }

  /** 15초마다: 차례가 된 에이전트의 하트비트를 넣습니다. */
  tickHeartbeats(now = Date.now()): void {
    const tz = process.env['TZ'] || 'UTC';
    for (const a of this.d.store.listAgents()) {
      if (!heartbeatDue(a.heartbeat, a.heartbeatLastAt, now, tz, { paused: a.paused, busy: this.runtimeFor(a.id).busy() })) continue;
      try {
        this.runHeartbeat(a.id, false);
      } catch (err) {
        this.d.log.warn('하트비트를 넣지 못했습니다', { agent: a.name, error: (err as Error).message });
      }
    }
  }

  startHeartbeats(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.tickHeartbeats(), HEARTBEAT_TICK_MS);
    this.heartbeatTimer.unref();
  }

  stopHeartbeats(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  /* ───────── 에이전트 간 위임 ───────── */

  /**
   * delegate_task 도구: 다른 에이전트에게 일을 맡깁니다. 결과는 기다리지 않고(동시 작업 자리를 붙잡지 않도록)
   * 맡은 쪽이 끝나면 onTaskEnd 가 결과를 맡긴 쪽 대화로 돌려보냅니다.
   */
  async delegate(agent: AgentRow, env: ToolEnv, input: DelegateInput): Promise<string> {
    const toName = input.to.trim();
    const target = this.d.store.findAgentByName(toName);
    const problem = delegationProblem({ from: agent, to: target, toName, chain: env.chain, maxDepth: this.d.config.delegationMaxDepth });
    if (problem) throw new ValidationError('delegation_rejected', problem);
    const to = target as AgentRow;
    const task = input.task.trim();
    if (task.length < 5) throw new ValidationError('delegation_task', '맡길 일을 5자 이상으로, 그 에이전트가 이 대화를 몰라도 알 수 있게 적으세요.');
    const reason = input.reason.trim().slice(0, 500);
    // 같은 일에서 같은 에이전트에게 결과를 받고 또 맡기는 왕복은 횟수를 제한합니다 (서로 끝없이 주고받지 않게).
    // 횟수는 맡긴 일의 줄기마다 따로 셉니다: 한 작업에서 서로 다른 일 여러 건(이슈 여러 개 등)을 맡기면 건마다 1번째입니다.
    const maxRounds = this.d.config.delegationMaxRounds;
    const used = env.rounds[to.id] ?? 0;
    if (used >= maxRounds) {
      throw new ValidationError('delegation_rounds', `같은 일을 '${to.name}'에게 이미 ${used}번 맡겼습니다 (결과를 받고 다시 맡기는 왕복은 ${maxRounds}번까지). 직접 마무리하거나 할 수 없다고 답하세요.`);
    }
    const rounds = { ...env.rounds, [to.id]: used + 1 };
    // 방금 권한에 막힌 일을 그 일을 할 수 없는 에이전트에게 넘기면 맡은 쪽에서도 막혀 헛걸음이 됩니다.
    // 한 번 막고 할 수 있는 에이전트를 알려 줍니다. 막힌 일과 다른 일이면 같은 요청을 다시 보내 그대로 맡길 수 있습니다.
    const blocked = env.lastBlock;
    if (blocked && !env.blockWaived.has(to.id)) {
      const def = this.permissionDefs().find((d) => d.key === blocked.permission);
      const workspaceOf = (id: string): string => path.join(this.d.config.dataDir, 'workspaces', id);
      if (def && !abilityFor(to, def, blocked.target, { requester: workspaceOf(agent.id), peer: workspaceOf(to.id) })) {
        env.blockWaived.add(to.id);
        const candidates = this.d.store.listAgents().filter((p) => p.id !== agent.id && p.delegation.accept && !env.chain.includes(p.id));
        const capable = capableAgents(candidates, def, blocked.target, { requester: agent, preferredId: agent.delegation.supervisorId, workspaceOf }).slice(0, 5);
        throw new ValidationError(
          'delegation_unable',
          `'${to.name}'은(는) 방금 막힌 일(${blockedLabel(blocked, os.homedir())})을 할 수 없습니다 ('${def.label}'이(가) 차단이거나 그 경로에 접근할 수 없음). ${capable.length > 0 ? `할 수 있는 에이전트: ${capable.map(capableLabel).join(', ')}.` : '할 수 있는 에이전트가 없으니 사용자에게 권한을 바꿔 달라고 하세요.'} 막힌 일과 다른 일을 맡기려는 것이면 같은 요청을 한 번 더 보내세요.`,
        );
      }
    }

    // 맡긴 쪽 대화에 남는 위임 카드 (결과가 오면 상태가 바뀜)
    const card = env.sink.timeline('delegate', { to: to.id, toName: to.name, task: task.slice(0, 500), reason: reason.slice(0, 300), status: 'sent', round: used + 1, maxRounds });
    const row = this.enqueue({
      agentId: to.id,
      source: `delegation:${agent.id}`,
      sourceLabel: `위임 · ${agent.name}`,
      origin: 'delegation',
      text: delegationRequestText(agent.name, task, reason),
      reply: null,
      title: `위임 · ${oneLine(task).slice(0, 50)}`,
      chain: [...env.chain, agent.id],
      delegation: {
        fromAgentId: agent.id,
        cardId: card?.id ?? null,
        back: { source: env.source, sourceLabel: env.sourceLabel, reply: env.reply, quiet: env.quiet, reportTo: env.reportTo, chain: env.chain, delegation: env.delegation, rounds },
      },
    });
    // 이 작업이 누군가에게서 맡은 일이었다면, 결과를 돌려줄 의무는 위임 결과를 받는 후속 작업으로 넘어갑니다.
    env.deferred = true;
    // 막힌 일을 맡겼으므로 그다음 위임은 따로 봅니다.
    env.lastBlock = null;
    env.sink.emit({ type: 'edge.pulse', from: agent.id, to: to.id, kind: 'delegate' });
    env.sink.activity({ type: 'delegation.sent', category: 'agent', tone: 'agent', who: agent.name, text: `${to.name}에게 위임 · ${oneLine(task).slice(0, 80)}`, agentId: agent.id });
    this.d.bus.emit({ type: 'graph.changed' });
    const paused = to.paused ? ` '${to.name}'은(는) 지금 일시정지 상태라 재개된 뒤 처리합니다.` : '';
    const next = env.quiet ? '지금은 NO_REPORT 로 답하고, 결과가 오면 그때 보고할지 판단하세요.' : '지금은 사용자에게 맡겼다는 것만 짧게 알리세요.';
    return `'${to.name}'에게 맡겼습니다 (작업 ${row.id}).${paused} 결과는 끝나는 대로 이 대화로 전달됩니다. ${next}`;
  }

  /** 작업이 끝날 때: 직접 누른 하트비트 알림, 위임 카드 갱신, 맡긴 쪽으로 결과 돌려보내기 */
  private onTaskEnd(end: TaskEnd): void {
    const { input } = end;
    // 이 작업이 잡고 있던 화면을 풉니다.
    if (this.screenLocks.releaseTask(end.task.id).length > 0) this.d.bus.emit({ type: 'graph.changed' });
    if (input.origin === 'heartbeat' && input.manual) {
      this.d.bus.emit({ type: 'heartbeat.done', agentId: input.agentId, reported: !end.silent, error: end.status === 'failed' ? end.error : null });
    }
    const del = input.delegation;
    if (!del || end.deferred) return;
    const from = this.d.store.findAgent(del.fromAgentId);
    const toName = this.d.store.findAgent(input.agentId)?.name ?? '삭제된 에이전트';
    const label = end.status === 'done' ? '완료' : end.status === 'failed' ? '실패' : '취소됨';

    if (del.cardId !== null) {
      const card = this.d.store.findTimeline(del.cardId);
      if (card) {
        const summary = oneLine(end.status === 'done' ? end.finalText : (end.error ?? '')).slice(0, 300);
        const data = { ...card.data, status: end.status, result: summary };
        this.d.store.updateTimeline(card.id, data);
        this.d.bus.emit({ type: 'timeline.update', agentId: del.fromAgentId, item: { ...card, data } });
      }
    }
    this.d.bus.emit({ type: 'graph.changed' });
    if (!from) return;
    this.d.bus.emit({ type: 'edge.pulse', from: input.agentId, to: from.id, kind: 'delegate' });
    this.d.bus.activity({ type: 'delegation.result', category: 'agent', tone: end.status === 'done' ? 'pass' : 'error', who: toName, text: `${from.name}에게 결과 전달 · ${label}`, agentId: from.id });
    try {
      this.enqueue({
        agentId: from.id,
        source: del.back.source,
        sourceLabel: `위임 결과 · ${toName}`,
        origin: 'delegation',
        text: delegationResultText(toName, end.status, end.finalText, end.error),
        reply: del.back.reply,
        title: `위임 결과 · ${toName}`,
        quiet: del.back.quiet,
        trigger: `${toName}의 위임 결과 (${label})`,
        reportTo: del.back.reportTo,
        chain: del.back.chain,
        delegation: del.back.delegation,
        rounds: del.back.rounds ?? {},
      });
    } catch (err) {
      if (err instanceof LimitError) {
        this.d.bus.activity({ type: 'delegation.lost', category: 'agent', tone: 'error', who: toName, text: `${from.name}의 대기열이 가득 차 위임 결과를 돌려주지 못했습니다 (${label}).`, agentId: from.id });
        return;
      }
      if (!(err instanceof NotFoundError)) throw err;
    }
  }

  /* ───────── 채널 메시지 ───────── */

  /** 채널 모듈이 받은 메시지를 연결된 에이전트에게 넘깁니다. 대상(targets)과 호출 방식(직접 부를 때만/모두)을 따릅니다. */
  route(moduleId: string, msg: InboundMessage): void {
    const mod = this.d.store.findModule(moduleId);
    if (!mod) return;
    for (const link of this.d.store.listAgentModules()) {
      if (link.moduleId !== moduleId) continue;
      const cfg = link.config;
      // 도구만 쓰려고 연결한 에이전트는 메시지 · 자동 알림을 받지 않습니다.
      if (cfg.trigger === 'none') continue;
      if (cfg.targets && cfg.targets.length > 0 && !cfg.targets.some((t) => t.toLowerCase() === msg.target.toLowerCase() || t.toLowerCase() === msg.targetLabel.toLowerCase())) continue;
      if ((cfg.trigger ?? 'direct') === 'direct' && !msg.direct) continue;
      const agent = this.d.store.getAgent(link.agentId);
      const outcome = this.d.hooks.run({ event: 'on_message', agentId: agent.id, agentName: agent.name, taskId: null, now: new Date(), channel: moduleId, target: msg.target, user: msg.userName, text: msg.text });
      if (outcome.decision === 'deny') {
        this.d.bus.activity({ type: 'message.dropped', category: 'hook', tone: 'block', who: '훅 차단', text: `${mod.manifest.name} → ${agent.name} 수신 차단 · ${outcome.reasons[0] ?? ''}`, agentId: agent.id, moduleId });
        continue;
      }
      if (msg.quiet === true) {
        // 모듈의 자동 알림(새 메일 등): 에이전트가 알릴 것이 있다고 판단할 때만 화면과 보고 채널에 나타납니다.
        try {
          this.enqueue({
            agentId: agent.id,
            source: `${moduleId}:${msg.target}`,
            sourceLabel: `${mod.manifest.name} · ${msg.targetLabel}`,
            origin: 'channel',
            text: `${quietPreamble('event')}\n\n${msg.text}`,
            reply: null,
            quiet: true,
            trigger: msg.text.slice(0, 1500),
            reportTo: agent.report,
          });
        } catch (err) {
          if (!(err instanceof LimitError)) throw err;
          this.dropForFullQueue(agent, mod.manifest.name, msg.targetLabel, moduleId);
        }
        continue;
      }
      this.d.bus.emit({ type: 'edge.pulse', from: `module:${moduleId}`, to: agent.id, kind: 'message' });
      this.d.bus.activity({ type: 'message.in', category: 'module', tone: 'module', who: mod.manifest.name, text: `${agent.name} ← ${msg.targetLabel} · ${msg.userName}`, agentId: agent.id, moduleId });
      try {
        this.enqueue({
          agentId: agent.id,
          source: `${moduleId}:${msg.target}`,
          sourceLabel: `${mod.manifest.name} · ${msg.targetLabel} · ${msg.userName}`,
          origin: 'channel',
          text: msg.text,
          reply: { moduleId, target: msg.target },
        });
      } catch (err) {
        if (!(err instanceof LimitError)) throw err;
        this.dropForFullQueue(agent, mod.manifest.name, msg.targetLabel, moduleId);
      }
    }
  }

  /**
   * 채널로 보내기. 전송 권한(msg.<모듈>) → 발송 전 훅(기본 금지 조항 포함) → 필요하면 승인 → 전송.
   * 작업 끝의 자동 답장과 send_message 도구가 같은 길을 씁니다.
   */
  async deliver(agent: AgentRow, env: ToolEnv, moduleId: string, target: string, text: string): Promise<string> {
    const mod = this.d.store.getModule(moduleId);
    if (!mod.manifest.channel) throw new ModuleError('module_not_channel', `모듈 '${mod.manifest.name}'은(는) 메시지를 보내는 채널이 아닙니다.`);
    if (mod.manifest.channel.send === false) throw new ModuleError('module_receive_only', `'${mod.manifest.name}' 모듈은 받기만 하고 보내지는 않습니다. 보고는 Discord · Telegram 같은 채널로 보내세요.`);
    if (!mod.enabled) throw new ModuleError('module_disabled', `'${mod.manifest.name}' 모듈이 꺼져 있어 보내지 못했습니다.`, 409);
    const def = this.permissionDefs().find((x) => x.key === `msg.${moduleId}`) ?? messagePermission(moduleId, mod.manifest.name);
    const decision = evaluatePermission(def, agent.permissions[def.key], target);
    if (decision.decision === 'deny') throw new PermissionDeniedError('send_denied', `${decision.reason} 메시지를 보내지 않았습니다.`);

    const outcome = this.d.hooks.run({ event: 'before_send', agentId: agent.id, agentName: agent.name, taskId: env.taskId, now: new Date(), channel: moduleId, target, text, perMinute: agent.limits.messagesPerMinute });
    if (outcome.decision === 'deny') {
      const reason = outcome.reasons[0] ?? '훅이 막았습니다.';
      env.sink.timeline('block', { title: outcome.by[0]?.startsWith('guard:') ? `훅 차단 · ${outcome.by[0].slice(6)}` : '훅 차단', text: reason, code: `send ${moduleId} ${target}` });
      env.sink.activity({ type: 'hook.blocked', category: 'hook', tone: 'block', who: '훅 차단', text: `${agent.name} · ${reason}`, agentId: agent.id });
      throw new PermissionDeniedError('send_blocked', `${reason}`);
    }
    const body = outcome.text ?? text;
    const asks = [...(decision.decision === 'ask' ? [decision.reason] : []), ...outcome.reasons];
    if (asks.length > 0) {
      if (env.sink.hidden) throw new PermissionDeniedError('send_needs_approval', `조용한 판단 중에는 승인이 필요한 전송을 할 수 없습니다: ${asks[0]}`);
      const { wait } = this.d.approvals.request({
        agentId: agent.id,
        agentName: agent.name,
        taskId: env.taskId,
        threadId: env.threadId,
        kind: decision.decision === 'ask' ? 'permission' : 'hook',
        title: `${mod.manifest.name} ${target} 전송`,
        detail: { permission: decision.decision === 'ask' ? def.key : null, target, rule: asks.join(' / '), tool: 'send_message', input: body.slice(0, 2000) },
        signal: env.signal,
      });
      const r = await wait;
      if (r.decision === 'cancelled') throw new PermissionDeniedError('send_cancelled', '작업이 취소되어 보내지 않았습니다.');
      if (r.decision === 'deny') throw new PermissionDeniedError('send_rejected', '사용자가 전송을 거부했습니다.');
      if (r.decision === 'expired') throw new PermissionDeniedError('send_expired', r.note ?? '승인 대기 시간이 지나 보내지 않았습니다.');
    }
    await this.d.registry.send(moduleId, target, body);
    env.sink.emit({ type: 'edge.pulse', from: agent.id, to: `module:${moduleId}`, kind: 'message' });
    env.sink.activity({ type: 'message.out', category: 'module', tone: 'agent', who: agent.name, text: `${mod.manifest.name} ${target} 전송 · ${body.length}자${outcome.text !== undefined ? ' · 훅이 내용을 고침' : ''}`, agentId: agent.id, moduleId });
    env.sink.timeline('hook', { text: `전송됨 · ${mod.manifest.name} ${target}${outcome.text !== undefined ? ' (훅이 일부 내용을 가림)' : ''}` });
    return `${mod.manifest.name} ${target} 로 보냈습니다.`;
  }

  /* ───────── 스킬 만들기 ───────── */

  async createSkill(agent: AgentRow, env: ToolEnv, input: SkillInput): Promise<string> {
    if (!TOOL_NAME_RE.test(input.name)) throw new ValidationError('skill_name', `스킬 이름 '${input.name}'은(는) 영문 소문자로 시작하고 소문자·숫자·밑줄만 쓸 수 있습니다 (예: fx_rate).`);
    if (this.builtinNames().includes(input.name) || input.name === 'web_search' || input.name === 'web_fetch') {
      throw new ValidationError('skill_name_builtin', `'${input.name}'은(는) 내장 도구 이름이라 쓸 수 없습니다.`);
    }
    const owner = this.d.registry.toolOwners().get(input.name);
    const ownRow = owner ? this.d.store.findModule(owner) : null;
    if (owner && !(ownRow?.kind === 'skill' && ownRow.createdBy === agent.id)) {
      throw new ConflictError('skill_name_taken', `도구 이름 '${input.name}'은(는) 이미 '${ownRow?.manifest.name ?? owner}'이(가) 쓰고 있습니다. 다른 이름을 쓰세요.`);
    }
    for (const d of input.net) {
      if (d.trim() === '*') throw new ValidationError('skill_net_wildcard', '모든 도메인(*)은 스킬에 허용할 수 없습니다. 필요한 도메인만 적으세요.');
    }
    const short = input.name.replace(/_/g, '-');
    const id = `skill-${short}`.length <= 32 ? `skill-${short}` : `skill-${short.slice(0, 20)}-${crypto.createHash('sha1').update(input.name).digest('hex').slice(0, 5)}`;
    const version = ownRow ? bumpPatch(ownRow.manifest.version) : '1.0.0';
    const manifest = {
      id,
      name: input.title,
      version,
      description: input.description.slice(0, 300),
      kind: 'skill',
      entry: 'index.js',
      license: 'UNLICENSED',
      author: agent.name,
      icon: 'bolt',
      permissions: { net: input.net, fsWrite: false, childProcess: false },
      tools: [{ name: input.name, title: input.title, description: input.description, input_schema: input.input_schema }],
      tests: input.tests.map((t) => ({ tool: input.name, input: t.input, ...(t.expectIncludes ? { expectIncludes: t.expectIncludes } : {}) })),
    };
    const files: SourceFile[] = [
      { path: 'module.json', content: JSON.stringify(manifest, null, 2) },
      { path: 'index.js', content: input.code },
    ];

    const install = this.d.hooks.run({ event: 'before_install', agentId: agent.id, agentName: agent.name, taskId: env.taskId, now: new Date(), kind: 'skill', id, files });
    if (install.decision === 'deny') throw new PermissionDeniedError('skill_blocked', install.reasons[0] ?? '훅이 설치를 막았습니다.');

    const staged = await this.d.registry.installer.fromFiles(files, agent.name);
    const problems = staged.report.checks.filter((c) => c.level === 'error');
    if (problems.length > 0) {
      this.d.registry.installer.discard(staged.token);
      throw new ValidationError('skill_check_failed', `스킬 점검에서 문제가 나왔습니다. 고친 뒤 다시 만드세요:\n- ${problems.map((c) => `${c.label}: ${c.detail}`).join('\n- ')}`);
    }
    if (install.decision === 'ask') {
      if (env.quiet) {
        this.d.registry.installer.discard(staged.token);
        throw new PermissionDeniedError('quiet_needs_approval', `조용한 판단 중에는 승인이 필요한 스킬 설치를 할 수 없습니다: ${install.reasons.join(' / ')}`);
      }
      const { wait } = this.d.approvals.request({ agentId: agent.id, agentName: agent.name, taskId: env.taskId, threadId: env.threadId, kind: 'hook', title: `스킬 설치 · ${input.title}`, detail: { permission: null, target: input.name, rule: install.reasons.join(' / '), tool: 'skill_create', input: input.code.slice(0, 2000) }, signal: env.signal });
      const r = await wait;
      if (r.decision === 'deny' || r.decision === 'expired' || r.decision === 'cancelled') {
        this.d.registry.installer.discard(staged.token);
        const why = r.decision === 'deny' ? '사용자가 스킬 설치를 거부했습니다.' : r.decision === 'cancelled' ? '작업이 취소되어 스킬을 설치하지 않았습니다.' : '승인 대기 시간이 지나 스킬을 설치하지 않았습니다.';
        throw new PermissionDeniedError('skill_rejected', why);
      }
    }

    const row = await this.d.registry.install(staged.token, { kind: 'skill', createdBy: agent.id, enabled: true, status: 'idle' });
    // 시험 실행
    let passed = 0;
    const failures: string[] = [];
    for (const [i, t] of input.tests.entries()) {
      try {
        const out = await this.d.registry.callTool(row.id, input.name, t.input, { agentId: agent.id, agentName: agent.name, taskId: env.taskId });
        if (t.expectIncludes && !out.includes(t.expectIncludes)) failures.push(`${i + 1}번: 결과에 '${t.expectIncludes}'이(가) 없습니다. 결과 앞부분: ${out.slice(0, 200)}`);
        else passed += 1;
      } catch (err) {
        failures.push(`${i + 1}번: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) {
      await this.d.registry.remove(row.id).catch(() => {});
      throw new ValidationError('skill_tests_failed', `테스트 ${passed}/${input.tests.length} 통과 — 실패한 테스트가 있어 스킬을 연결하지 않았습니다:\n- ${failures.join('\n- ')}`);
    }

    this.d.store.connectModule(agent.id, row.id, {});
    const testsLabel = input.tests.length > 0 ? `${passed}/${input.tests.length}` : '없음';
    env.sink.timeline('skill', {
      name: input.name,
      title: input.title,
      tests: testsLabel,
      agentName: agent.name,
      code: [`name:   ${input.name}`, `input:  ${JSON.stringify((input.input_schema['properties'] as object | undefined) ?? {}).slice(0, 120)}`, `needs:  ${input.net.length > 0 ? `net.fetch(${input.net.join(', ')})` : '외부 접속 없음'}`].join('\n'),
    });
    this.d.bus.emit({ type: 'skill.created', skillId: row.id, agentId: agent.id });
    env.sink.activity({ type: 'skill.created', category: 'skill', tone: 'new', who: '새 스킬', text: `${agent.name}가 ${input.title}(${input.name})을(를) 만들어 연결 · 테스트 ${testsLabel}`, agentId: agent.id, moduleId: row.id });
    this.d.bus.emit({ type: 'graph.changed' });
    return `스킬 '${input.title}'(${input.name}) v${version} 을(를) 만들어 연결했습니다. 테스트 ${testsLabel}. 다음 단계부터 도구로 쓸 수 있습니다.`;
  }

  /* ───────── 모듈 만들기 ───────── */

  async createModule(agent: AgentRow, env: ToolEnv, files: SourceFile[]): Promise<string> {
    const staged = await this.d.registry.installer.fromFiles(files, agent.name);
    if (staged.manifest.computer) {
      this.d.registry.installer.discard(staged.token);
      throw new ValidationError('module_computer_by_agent', '에이전트는 화면 제어 모듈(computer)을 만들 수 없습니다. 화면 제어는 사용자가 기본 제공 모듈을 켜서만 씁니다.');
    }
    // 같은 id 로 덮어쓰면 다른 에이전트나 사용자가 쓰던 모듈이 바뀔 수 있으므로, 승인 여부와 관계없이 막습니다.
    const existing = this.d.store.findModule(staged.manifest.id);
    if (existing) {
      this.d.registry.installer.discard(staged.token);
      throw new ConflictError('module_exists', `id '${staged.manifest.id}' 모듈(${existing.manifest.name} v${existing.manifest.version})이 이미 있습니다. 다른 id 를 쓰거나, 사용자에게 기존 모듈을 모듈 화면에서 지워 달라고 요청하세요.`);
    }
    const problems = staged.report.checks.filter((c) => c.level === 'error');
    if (problems.length > 0) {
      this.d.registry.installer.discard(staged.token);
      throw new ValidationError('module_check_failed', `모듈 점검에서 문제가 나왔습니다. 고친 뒤 다시 만드세요:\n- ${problems.map((c) => `${c.label}: ${c.detail}`).join('\n- ')}`);
    }
    const install = this.d.hooks.run({ event: 'before_install', agentId: agent.id, agentName: agent.name, taskId: env.taskId, now: new Date(), kind: 'module', id: staged.manifest.id, files });
    if (install.decision === 'deny') {
      this.d.registry.installer.discard(staged.token);
      throw new PermissionDeniedError('module_blocked', install.reasons[0] ?? '훅이 설치를 막았습니다.');
    }
    const def = BASE_PERMISSIONS.find((x) => x.key === 'module.install') as PermissionDef;
    const decision = evaluatePermission(def, agent.permissions['module.install'], staged.manifest.id);
    if (decision.decision === 'deny') {
      this.d.registry.installer.discard(staged.token);
      throw new PermissionDeniedError('module_install_denied', `${decision.reason} 모듈 파일은 만들었지만 설치하지 않고 지웠습니다.`);
    }
    const warns = staged.report.checks.filter((c) => c.level === 'warn').map((c) => `${c.label}: ${c.detail}`);
    if (decision.decision === 'allow' && install.decision === 'allow') {
      const row = await this.d.registry.install(staged.token, { kind: 'module', createdBy: agent.id, enabled: true });
      this.d.store.connectModule(agent.id, row.id, {});
      this.d.bus.activity({ type: 'module.installed', category: 'module', tone: 'new', who: row.manifest.name, text: `${agent.name}가 만들어 설치함`, agentId: agent.id, moduleId: row.id });
      return `모듈 '${row.manifest.name}'(${row.id})을(를) 설치하고 연결했습니다.${warns.length ? ` 확인할 점: ${warns.join(' / ')}` : ''}`;
    }

    if (env.quiet) {
      this.d.registry.installer.discard(staged.token);
      throw new PermissionDeniedError('quiet_needs_approval', '조용한 판단 중에는 승인이 필요한 모듈 설치를 할 수 없습니다. 필요하면 보고에 적어 사용자에게 알리세요.');
    }
    const row = this.d.registry.holdPending(staged, agent.id);
    const { wait } = this.d.approvals.request({
      agentId: agent.id,
      agentName: agent.name,
      taskId: env.taskId,
      threadId: env.threadId,
      kind: 'module.install',
      title: `모듈 설치 · ${row.manifest.name} v${row.manifest.version}`,
      detail: {
        permission: 'module.install',
        target: row.id,
        rule: [...(decision.decision === 'ask' ? [decision.reason] : []), ...install.reasons].join(' / ') || '모듈 설치는 승인이 필요합니다.',
        tool: 'module_create',
        input: `권한 ${row.manifest.permissions.net.length ? `net(${row.manifest.permissions.net.join(', ')})` : '없음'} · env ${row.manifest.env.map((e) => e.name).join(', ') || '없음'}`,
        moduleId: row.id,
      },
      signal: env.signal,
    });
    const r = await wait;
    if (r.decision === 'cancelled') return `작업이 취소되어 모듈 '${row.manifest.name}' 설치 승인을 더 기다리지 않습니다. 모듈은 승인 대기로 남아 있어 모듈 화면에서 설치하거나 거부할 수 있습니다.`;
    if (r.decision === 'deny') return `사용자가 모듈 '${row.manifest.name}' 설치를 거부했습니다. 파일은 지웠습니다.`;
    if (r.decision === 'expired') return r.note ?? `승인 대기 시간이 지나 모듈 '${row.manifest.name}'을(를) 설치하지 않았습니다.`;
    const after = this.d.store.findModule(row.id);
    const status = after ? `${after.status}${after.statusDetail ? ` — ${after.statusDetail}` : ''}` : '알 수 없음';
    return `모듈 '${row.manifest.name}' 설치를 승인받았습니다. 현재 상태: ${status}${warns.length ? ` · 확인할 점: ${warns.join(' / ')}` : ''}`;
  }

  shutdown(): void {
    this.stopHeartbeats();
    for (const rt of this.runtimes.values()) rt.cancelAll('서버가 종료되어 작업을 멈췄습니다.');
  }

  agentsWithModule(moduleId: string): AgentRow[] {
    const ids = new Set(this.d.store.listAgentModules().filter((l) => l.moduleId === moduleId).map((l) => l.agentId));
    return this.d.store.listAgents().filter((a) => ids.has(a.id));
  }

  moduleRows(): ModuleRow[] {
    return this.d.store.listModules();
  }
}

function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.0';
}

/** 실행기에 넘길 '설정 필요' 항목 조회 */
function settingsNeeds(settings: SettingsService, store: Store): (moduleId: string) => ReturnType<SettingsService['setupNeeds']> {
  return (moduleId) => settings.setupNeeds(store.getModule(moduleId));
}
