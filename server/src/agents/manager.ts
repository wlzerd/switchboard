import crypto from 'node:crypto';
import { EFFORT_LEVELS, type Effort } from '../anthropic/models.ts';
import type { AnthropicService } from '../anthropic/service.ts';
import type { ApprovalService } from '../approvals/service.ts';
import type { Config } from '../config/env.ts';
import { randomId } from '../crypto/secrets.ts';
import type { AgentModuleRow, AgentRow, ModuleRow, Store, TaskRow } from '../db/store.ts';
import { ConflictError, ModuleError, PermissionDeniedError, ValidationError } from '../errors.ts';
import type { AgentLiveStatus, EventBus } from '../events/bus.ts';
import type { GuardState } from '../guards/guards.ts';
import type { HookEngine } from '../hooks/engine.ts';
import { validateLimits, type AgentLimits } from '../limits/limits.ts';
import type { Logger } from '../log.ts';
import { TOOL_NAME_RE } from '../modules/manifest.ts';
import type { InboundMessage } from '../modules/protocol.ts';
import type { ModuleRegistry } from '../modules/registry.ts';
import type { SourceFile } from '../modules/static-check.ts';
import { addAlways, BASE_PERMISSIONS, evaluatePermission, messagePermission, validatePermissionSet, type PermissionDef, type PermissionSet } from '../permissions/policy.ts';
import type { SchedulerService } from '../scheduler/service.ts';
import { builtinTools, type SkillInput, type ToolServices } from '../tools/builtin.ts';
import type { ToolEnv } from '../tools/types.ts';
import { ToolExecutor } from './executor.ts';
import { permissionsFromPreset, type Preset } from './presets.ts';
import { AgentRuntime, type TaskInput } from './runtime.ts';

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
}

export class AgentManager {
  private readonly d: ManagerDeps;
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly slots: Semaphore;
  private readonly serverToolLevel = new Map<string, number>();
  readonly executor: ToolExecutor;
  private readonly builtins;

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
    });
  }

  builtinNames(): string[] {
    return this.builtins.map((t) => t.name);
  }

  /** 권한 항목: 고정 항목 + 설치된 채널 모듈별 전송 권한 */
  permissionDefs(): PermissionDef[] {
    const channels = this.d.store.listModules('module').filter((m) => m.manifest.channel && m.status !== 'rejected');
    return [...BASE_PERMISSIONS, ...channels.map((m) => messagePermission(m.id, m.manifest.name))];
  }

  init(): void {
    for (const a of this.d.store.listAgents()) this.runtimeFor(a.id);
    this.d.registry.onInbound = (moduleId, msg) => this.route(moduleId, msg);
    this.d.scheduler.onDue = (run) => {
      const agent = this.d.store.getAgent(run.agentId);
      const reply = run.reply && this.d.store.findModule(run.reply.moduleId) ? run.reply : null;
      this.enqueue({
        agentId: agent.id,
        source: reply ? `${reply.moduleId}:${reply.target}` : `schedule:${run.scheduleId}`,
        sourceLabel: `예약 실행 · ${run.label}`,
        origin: 'schedule',
        text: run.prompt,
        reply,
        title: `예약 · ${run.prompt.slice(0, 40)}`,
      });
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
        deliver: (agent, env, moduleId, target, text) => this.deliver(agent, env, moduleId, target, text),
        acquireSlot: (signal) => this.slots.acquire(signal),
        onFinished: () => this.pumpAll(),
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

  live(agentId: string): { status: AgentLiveStatus; detail: string | null; queued: TaskRow[]; running: TaskRow[] } {
    const rt = this.runtimeFor(agentId);
    return { status: rt.status, detail: rt.detail, queued: rt.queued(), running: rt.runningTasks() };
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
    return raw.map((l, i) => {
      const item = l as { moduleId?: unknown; targets?: unknown; trigger?: unknown };
      if (typeof item.moduleId !== 'string') throw new ValidationError('agent_module_id', `${i + 1}번째 연결의 moduleId 가 없습니다.`);
      const m = this.d.store.getModule(item.moduleId);
      if (m.status === 'pending') throw new ValidationError('agent_module_pending', `모듈 '${m.manifest.name}'은(는) 아직 설치 승인 전이라 연결할 수 없습니다.`);
      const targets = Array.isArray(item.targets) ? item.targets.filter((t): t is string => typeof t === 'string' && t.trim() !== '').map((t) => t.trim()) : [];
      const trigger = item.trigger === 'all' ? 'all' : 'direct';
      const config: AgentModuleRow['config'] = { targets, trigger };
      return { moduleId: m.id, config };
    });
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
    const row = this.d.store.updateAgent(id, next);
    this.d.bus.emit({ type: 'graph.changed' });
    return row;
  }

  setPermissions(id: string, permissionsRaw: unknown, limitsRaw: unknown): AgentRow {
    this.d.store.getAgent(id);
    const permissions: PermissionSet = validatePermissionSet(permissionsRaw, this.permissionDefs());
    const limits: AgentLimits = validateLimits(limitsRaw);
    const row = this.d.store.updateAgent(id, { permissions, limits, preset: 'custom' });
    this.d.bus.activity({ type: 'agent.permissions', category: 'hook', tone: 'pass', who: row.name, text: '권한·한도 설정을 바꿨습니다', agentId: id });
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
    this.d.store.deleteAgent(id);
    this.d.bus.activity({ type: 'agent.deleted', category: 'agent', tone: 'agent', who: row.name, text: '삭제됨', agentId: null });
    this.d.bus.emit({ type: 'graph.changed' });
  }

  /* ───────── 채널 메시지 ───────── */

  /** 채널 모듈이 받은 메시지를 연결된 에이전트에게 넘깁니다. 대상(targets)과 호출 방식(직접 부를 때만/모두)을 따릅니다. */
  route(moduleId: string, msg: InboundMessage): void {
    const mod = this.d.store.findModule(moduleId);
    if (!mod) return;
    for (const link of this.d.store.listAgentModules()) {
      if (link.moduleId !== moduleId) continue;
      const cfg = link.config;
      if (cfg.targets && cfg.targets.length > 0 && !cfg.targets.some((t) => t.toLowerCase() === msg.target.toLowerCase() || t.toLowerCase() === msg.targetLabel.toLowerCase())) continue;
      if ((cfg.trigger ?? 'direct') === 'direct' && !msg.direct) continue;
      const agent = this.d.store.getAgent(link.agentId);
      const outcome = this.d.hooks.run({ event: 'on_message', agentId: agent.id, agentName: agent.name, taskId: null, now: new Date(), channel: moduleId, target: msg.target, user: msg.userName, text: msg.text });
      if (outcome.decision === 'deny') {
        this.d.bus.activity({ type: 'message.dropped', category: 'hook', tone: 'block', who: '훅 차단', text: `${mod.manifest.name} → ${agent.name} 수신 차단 · ${outcome.reasons[0] ?? ''}`, agentId: agent.id, moduleId });
        continue;
      }
      this.d.bus.emit({ type: 'edge.pulse', from: `module:${moduleId}`, to: agent.id, kind: 'message' });
      this.d.bus.activity({ type: 'message.in', category: 'module', tone: 'module', who: mod.manifest.name, text: `${agent.name} ← ${msg.targetLabel} · ${msg.userName}`, agentId: agent.id, moduleId });
      this.enqueue({
        agentId: agent.id,
        source: `${moduleId}:${msg.target}`,
        sourceLabel: `${mod.manifest.name} · ${msg.targetLabel} · ${msg.userName}`,
        origin: 'channel',
        text: msg.text,
        reply: { moduleId, target: msg.target },
      });
    }
  }

  /**
   * 채널로 보내기. 전송 권한(msg.<모듈>) → 발송 전 훅(기본 금지 조항 포함) → 필요하면 승인 → 전송.
   * 작업 끝의 자동 답장과 send_message 도구가 같은 길을 씁니다.
   */
  async deliver(agent: AgentRow, env: ToolEnv, moduleId: string, target: string, text: string): Promise<string> {
    const mod = this.d.store.getModule(moduleId);
    if (!mod.manifest.channel) throw new ModuleError('module_not_channel', `모듈 '${mod.manifest.name}'은(는) 메시지를 보내는 채널이 아닙니다.`);
    if (!mod.enabled) throw new ModuleError('module_disabled', `'${mod.manifest.name}' 모듈이 꺼져 있어 보내지 못했습니다.`, 409);
    const def = this.permissionDefs().find((x) => x.key === `msg.${moduleId}`) ?? messagePermission(moduleId, mod.manifest.name);
    const decision = evaluatePermission(def, agent.permissions[def.key], target);
    if (decision.decision === 'deny') throw new PermissionDeniedError('send_denied', `${decision.reason} 메시지를 보내지 않았습니다.`);

    const outcome = this.d.hooks.run({ event: 'before_send', agentId: agent.id, agentName: agent.name, taskId: env.taskId, now: new Date(), channel: moduleId, target, text, perMinute: agent.limits.messagesPerMinute });
    if (outcome.decision === 'deny') {
      const reason = outcome.reasons[0] ?? '훅이 막았습니다.';
      const item = this.d.store.addTimeline(env.threadId, env.taskId, 'block', { title: outcome.by[0]?.startsWith('guard:') ? `훅 차단 · ${outcome.by[0].slice(6)}` : '훅 차단', text: reason, code: `send ${moduleId} ${target}` });
      this.d.bus.emit({ type: 'timeline.add', agentId: agent.id, item });
      this.d.bus.activity({ type: 'hook.blocked', category: 'hook', tone: 'block', who: '훅 차단', text: `${agent.name} · ${reason}`, agentId: agent.id });
      throw new PermissionDeniedError('send_blocked', `${reason}`);
    }
    const body = outcome.text ?? text;
    const asks = [...(decision.decision === 'ask' ? [decision.reason] : []), ...outcome.reasons];
    if (asks.length > 0) {
      const { wait } = this.d.approvals.request({
        agentId: agent.id,
        agentName: agent.name,
        taskId: env.taskId,
        threadId: env.threadId,
        kind: decision.decision === 'ask' ? 'permission' : 'hook',
        title: `${mod.manifest.name} ${target} 전송`,
        detail: { permission: decision.decision === 'ask' ? def.key : null, target, rule: asks.join(' / '), tool: 'send_message', input: body.slice(0, 2000) },
      });
      const r = await wait;
      if (r.decision === 'deny') throw new PermissionDeniedError('send_rejected', '사용자가 전송을 거부했습니다.');
      if (r.decision === 'expired') throw new PermissionDeniedError('send_expired', r.note ?? '승인 대기 시간이 지나 보내지 않았습니다.');
    }
    await this.d.registry.send(moduleId, target, body);
    this.d.bus.emit({ type: 'edge.pulse', from: agent.id, to: `module:${moduleId}`, kind: 'message' });
    this.d.bus.activity({ type: 'message.out', category: 'module', tone: 'agent', who: agent.name, text: `${mod.manifest.name} ${target} 전송 · ${body.length}자${outcome.text !== undefined ? ' · 훅이 내용을 고침' : ''}`, agentId: agent.id, moduleId });
    const item = this.d.store.addTimeline(env.threadId, env.taskId, 'hook', { text: `전송됨 · ${mod.manifest.name} ${target}${outcome.text !== undefined ? ' (훅이 일부 내용을 가림)' : ''}` });
    this.d.bus.emit({ type: 'timeline.add', agentId: agent.id, item });
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
      const { wait } = this.d.approvals.request({ agentId: agent.id, agentName: agent.name, taskId: env.taskId, threadId: env.threadId, kind: 'hook', title: `스킬 설치 · ${input.title}`, detail: { permission: null, target: input.name, rule: install.reasons.join(' / '), tool: 'skill_create', input: input.code.slice(0, 2000) } });
      const r = await wait;
      if (r.decision === 'deny' || r.decision === 'expired') {
        this.d.registry.installer.discard(staged.token);
        throw new PermissionDeniedError('skill_rejected', r.decision === 'deny' ? '사용자가 스킬 설치를 거부했습니다.' : '승인 대기 시간이 지나 스킬을 설치하지 않았습니다.');
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
    const item = this.d.store.addTimeline(env.threadId, env.taskId, 'skill', {
      name: input.name,
      title: input.title,
      tests: testsLabel,
      agentName: agent.name,
      code: [`name:   ${input.name}`, `input:  ${JSON.stringify((input.input_schema['properties'] as object | undefined) ?? {}).slice(0, 120)}`, `needs:  ${input.net.length > 0 ? `net.fetch(${input.net.join(', ')})` : '외부 접속 없음'}`].join('\n'),
    });
    this.d.bus.emit({ type: 'timeline.add', agentId: agent.id, item });
    this.d.bus.emit({ type: 'skill.created', skillId: row.id, agentId: agent.id });
    this.d.bus.activity({ type: 'skill.created', category: 'skill', tone: 'new', who: '새 스킬', text: `${agent.name}가 ${input.title}(${input.name})을(를) 만들어 연결 · 테스트 ${testsLabel}`, agentId: agent.id, moduleId: row.id });
    this.d.bus.emit({ type: 'graph.changed' });
    return `스킬 '${input.title}'(${input.name}) v${version} 을(를) 만들어 연결했습니다. 테스트 ${testsLabel}. 다음 단계부터 도구로 쓸 수 있습니다.`;
  }

  /* ───────── 모듈 만들기 ───────── */

  async createModule(agent: AgentRow, env: ToolEnv, files: SourceFile[]): Promise<string> {
    const staged = await this.d.registry.installer.fromFiles(files, agent.name);
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
    });
    const r = await wait;
    if (r.decision === 'deny') return `사용자가 모듈 '${row.manifest.name}' 설치를 거부했습니다. 파일은 지웠습니다.`;
    if (r.decision === 'expired') return r.note ?? `승인 대기 시간이 지나 모듈 '${row.manifest.name}'을(를) 설치하지 않았습니다.`;
    const after = this.d.store.findModule(row.id);
    const status = after ? `${after.status}${after.statusDetail ? ` — ${after.statusDetail}` : ''}` : '알 수 없음';
    return `모듈 '${row.manifest.name}' 설치를 승인받았습니다. 현재 상태: ${status}${warns.length ? ` · 확인할 점: ${warns.join(' / ')}` : ''}`;
  }

  shutdown(): void {
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
