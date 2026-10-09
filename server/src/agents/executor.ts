import os from 'node:os';
import path from 'node:path';
import type { ApprovalService } from '../approvals/service.ts';
import type { Config } from '../config/env.ts';
import type { AgentRow, Store } from '../db/store.ts';
import { AppError, ModuleError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { HookEngine } from '../hooks/engine.ts';
import type { ToolCtx } from '../hooks/types.ts';
import type { ModuleRegistry, ModuleTool } from '../modules/registry.ts';
import { evaluatePermission, type PermissionDef } from '../permissions/policy.ts';
import type { SetupNeed } from '../settings/service.ts';
import { validateJson } from '../tools/json-schema.ts';
import type { BuiltinTool, Described, ToolEnv } from '../tools/types.ts';
import { capableAgents, capableLabel } from './capability.ts';
import { COMPUTER_ACTIONS, HALT_TEXT, TOOLSET_NAME, saveScreenshot, screenSummary, screenTimeoutMs, typedText, type ScreenLocks } from './screen.ts';

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
  /** 도구 묶음의 동작이면 그 묶음 이름 (화면 제어: 'computer') */
  toolset?: string;
}

/** tool_result 의 내용: 글자, 또는 글자 · 이미지 블록 (화면 제어 스크린샷) */
export type ResultContent = string | ({ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } })[];

export interface ToolOutcome {
  content: ResultContent;
  isError: boolean;
  /** 사용자가 비상 정지(마우스를 왼쪽 위 모서리로)를 했을 때: 작업을 끝낼 이유 */
  stop?: string;
}

export interface StepReporter {
  start(label: string, meta: string): string;
  wait(stepId: string, meta: string): void;
  end(stepId: string, ok: boolean, meta: string): void;
}

/** 그래프의 스킬 노드 id: 내장 도구는 묶어서, 모듈·스킬 도구는 모듈 id 로. */
export function skillNodeFor(tool: string, mod: ModuleTool | null): string | null {
  if (mod) return `${mod.kind}:${mod.moduleId}`;
  if (tool === 'fs_read' || tool === 'fs_write' || tool === 'fs_list') return 'builtin:fs';
  if (tool === 'shell_exec') return 'builtin:shell';
  if (tool === 'http_request') return 'builtin:http';
  return null;
}

const PREVIEW = 600;

/** 도구를 쓴 뒤 프로젝트 활동을 남기는 쪽 (ProjectService) */
export interface ToolActivity {
  afterTool(env: ToolEnv, tool: string, input: Record<string, unknown>, described: Described, ok: boolean): void;
}

export interface ExecutorDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  hooks: HookEngine;
  approvals: ApprovalService;
  registry: ModuleRegistry;
  builtins: Map<string, BuiltinTool>;
  defs: () => PermissionDef[];
  screenLocks: ScreenLocks;
  /** 프로젝트 활동 기록 (없으면 남기지 않음) */
  activity?: ToolActivity;
  /** 모듈의 '설정 필요' 항목 (없으면 카드를 띄우지 않음) */
  setupNeeds?: (moduleId: string) => SetupNeed[];
}

export class ToolExecutor {
  private readonly d: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.d = deps;
  }

  private block(env: ToolEnv, agent: AgentRow, title: string, text: string, code: string): void {
    env.sink.timeline('block', { title, text, code });
    env.sink.activity({ type: 'hook.blocked', category: 'hook', tone: 'block', who: '훅 차단', text: `${agent.name} · ${text}`, agentId: agent.id });
  }

  /**
   * 모듈 설정(토큰 등)이 비어 시작하지 못했을 때 대화에 '설정 필요' 카드를 남깁니다 (작업마다 모듈당 한 번).
   * 링크는 모델이 쓴 글이 아니라 서버가 만든 것이라 그대로 눌러도 됩니다: 설정 화면 · module.json 에 적힌 발급 페이지.
   */
  private showSetup(env: ToolEnv, moduleId: string): void {
    if (!this.d.setupNeeds || env.setupShown.has(moduleId)) return;
    const row = this.d.store.findModule(moduleId);
    if (!row) return;
    const needs = this.d.setupNeeds(moduleId);
    if (needs.length === 0) return;
    env.setupShown.add(moduleId);
    env.sink.timeline('setup', { moduleId, moduleName: row.manifest.name, icon: row.manifest.icon, fields: needs });
  }

  /**
   * 권한 설정 때문에 막혔을 때 덧붙이는 안내: 그 동작을 실제로 할 수 있는 에이전트(협조 에이전트가 할 수 있으면 먼저)를 알려 줍니다.
   * 맡을 수 있는 에이전트가 없으면 맡기지 말고 사용자에게 권한 변경을 요청하라고 합니다.
   * 막힌 동작은 작업에 기억해 두어, 할 수 없는 에이전트에게 넘기려 하면 delegate_task 가 한 번 막습니다.
   * 기본 금지 조항(잠긴 권한) · 훅 차단 · 사용자의 거부에는 붙이지 않습니다 (우회 방지).
   */
  private escalationHint(agent: AgentRow, env: ToolEnv, def: PermissionDef, target: string | null): string {
    if (!agent.delegation.send) return '';
    env.lastBlock = { permission: def.key, label: def.label, target };
    const candidates = this.d.store.listAgents().filter((p) => p.id !== agent.id && p.delegation.accept && !env.chain.includes(p.id));
    if (candidates.length === 0) return '';
    const workspaceOf = (id: string): string => path.join(this.d.config.dataDir, 'workspaces', id);
    const capable = capableAgents(candidates, def, target, { requester: agent, preferredId: agent.delegation.supervisorId, workspaceOf });
    if (capable.length === 0) {
      return ` 위임을 받는 에이전트 중에도 이 일을 할 수 있는 에이전트가 없습니다 (모두 '${def.label}'이(가) 차단이거나 그 경로에 접근할 수 없음). 꼭 필요하면 사용자에게 권한을 바꿔 달라고 하세요.`;
    }
    return ` 이 일을 할 수 있는 에이전트: ${capable.slice(0, 5).map(capableLabel).join(', ')}. 꼭 필요하면 delegate_task 로 그중 하나에게 맡기세요 (맡는 쪽의 권한과 승인 절차가 그대로 적용됩니다).`;
  }

  /**
   * 한 차례의 도구 호출들을 처리합니다. 일반 도구는 함께 돌리고, 화면 동작은 나온 순서대로 하나씩 돌리며
   * 하나가 실패하면 그 뒤의 화면 동작은 실행하지 않습니다 (API 규칙: 정해진 문구로 답함).
   */
  async executeAll(uses: readonly ToolUse[], env: ToolEnv, steps: StepReporter): Promise<ToolOutcome[]> {
    const out: ToolOutcome[] = new Array(uses.length);
    const others: Promise<void>[] = [];
    const screen: number[] = [];
    uses.forEach((u, i) => {
      if (u.toolset === TOOLSET_NAME) screen.push(i);
      else
        others.push(
          this.execute(u, env, steps).then((r) => {
            out[i] = r;
          }),
        );
    });
    let halted = false;
    for (const i of screen) {
      if (halted) {
        out[i] = { content: HALT_TEXT, isError: true };
        continue;
      }
      const r = await this.executeScreen(uses[i] as ToolUse, env, steps);
      out[i] = r;
      if (r.isError) halted = true;
    }
    await Promise.all(others);
    return out;
  }

  /** 화면 제어 타임라인 카드: 같은 흐름이면 카드 하나에 이어서 쌓고, 사이에 다른 기록이 끼면 새 카드를 엽니다. */
  private screenCard(env: ToolEnv, summary: string, ok: boolean, image: string | null): void {
    let run = env.screen;
    if (!run || run.cardId === null || env.sink.lastTimelineId() !== run.cardId) {
      run = { cardId: null, count: 0, actions: [], image: run?.image ?? null };
      env.screen = run;
    }
    run.count += 1;
    run.actions.push({ s: summary, ok });
    if (run.actions.length > 30) run.actions.splice(0, run.actions.length - 30);
    if (image) run.image = image;
    const data = { tool: 'screen', count: run.count, actions: run.actions, image: run.image, ok };
    if (run.cardId !== null) env.sink.updateTimeline(run.cardId, data);
    else run.cardId = env.sink.timeline('screen', data)?.id ?? null;
  }

  private async executeScreen(use: ToolUse, env: ToolEnv, steps: StepReporter): Promise<ToolOutcome> {
    const agent = env.agent;
    const fail = (text: string, stop?: string): ToolOutcome => ({ content: text, isError: true, ...(stop ? { stop } : {}) });
    if (!COMPUTER_ACTIONS.has(use.name)) return fail(`알 수 없는 화면 동작 '${use.name}'입니다.`);
    if (env.quiet) return fail('조용한 작업(하트비트 · 자동 알림) 중에는 화면을 제어하지 않습니다. 필요하면 보고에 적으세요.');
    if (env.signal.aborted) return fail('작업이 취소되어 화면 동작을 멈췄습니다.');
    const mod = this.d.registry.computerFor(agent.id);
    if (!mod) return fail('연결된 화면 제어 모듈이 없거나 꺼져 있습니다. 모듈 화면에서 화면 제어 모듈을 켜고 이 에이전트에 연결해야 합니다.');
    const input = use.input !== null && typeof use.input === 'object' && !Array.isArray(use.input) ? (use.input as Record<string, unknown>) : {};
    const summary = screenSummary(use.name, input);
    const tool = `computer.${use.name}`;

    const hookCtx: ToolCtx = {
      event: 'before_tool',
      agentId: agent.id,
      agentName: agent.name,
      taskId: env.taskId,
      now: new Date(),
      tool,
      category: 'screen.control',
      input,
      workspace: env.workspace,
      folders: agent.folders,
      home: os.homedir(),
      command: null,
      paths: [],
      url: null,
      host: null,
      method: null,
      text: typedText(use.name, input),
    };
    const outcome = this.d.hooks.run(hookCtx);
    for (const l of outcome.logs) env.sink.activity({ type: 'hook.log', category: 'hook', tone: 'pass', who: '훅 기록', text: l, agentId: agent.id });
    if (outcome.decision === 'deny') {
      const reason = outcome.reasons[0] ?? '훅이 막았습니다.';
      const by = outcome.by[0] ?? '';
      this.block(env, agent, by.startsWith('guard:') ? `훅 차단 · ${by.slice(6)}` : '훅 차단', reason, `${tool}(${summary})`);
      this.screenCard(env, summary, false, null);
      return fail(`실행하지 않았습니다. ${reason}`);
    }

    // 권한: 화면 제어는 작업마다 한 번 묻습니다 (동작마다 묻지 않음). 훅이 요구한 확인은 그 동작만 묻습니다.
    const def = this.d.defs().find((x) => x.key === 'screen.control');
    if (!def) return fail('화면 제어 권한 항목이 없습니다. 서버를 다시 시작하세요.');
    const decision = evaluatePermission(def, agent.permissions['screen.control'], null);
    if (decision.decision === 'deny') {
      this.block(env, agent, '권한 차단', decision.reason, `${tool}(${summary})`);
      this.screenCard(env, summary, false, null);
      return fail(`실행하지 않았습니다. ${decision.reason}${this.escalationHint(agent, env, def, null)}`);
    }
    const needGrant = decision.decision === 'ask' && !env.grants.has('screen.control');
    const asks = [...(needGrant ? [`${decision.reason} 이번 작업에서 화면 제어를 허락하면 작업이 끝날 때까지 다시 묻지 않습니다.`] : []), ...outcome.reasons];
    if (asks.length > 0) {
      const stepId = steps.start('화면 제어', summary);
      steps.wait(stepId, '승인 대기');
      env.sink.emit({ type: 'agent.status', agentId: agent.id, status: 'waiting', detail: '화면 제어 승인 대기' });
      const { wait } = this.d.approvals.request({
        agentId: agent.id,
        agentName: agent.name,
        taskId: env.taskId,
        threadId: env.threadId,
        kind: needGrant ? 'permission' : 'hook',
        title: `화면 제어 · ${summary}`,
        detail: { permission: 'screen.control', target: null, rule: asks.join(' / '), tool, input: JSON.stringify(input).slice(0, 2000) },
        signal: env.signal,
      });
      const result = await wait;
      env.sink.emit({ type: 'agent.status', agentId: agent.id, status: 'working', detail: null });
      if (result.decision === 'cancelled') {
        steps.end(stepId, false, '작업 취소');
        this.screenCard(env, summary, false, null);
        return fail('작업이 취소되어 화면 동작을 하지 않았습니다.');
      }
      if (result.decision === 'deny' || result.decision === 'expired') {
        steps.end(stepId, false, result.decision === 'deny' ? '거부됨' : '승인 만료');
        this.screenCard(env, summary, false, null);
        return fail(`실행하지 않았습니다. ${result.decision === 'deny' ? '사용자가 화면 제어를 거부했습니다.' : (result.note ?? '승인 대기 시간이 지나 실행하지 않았습니다.')}`);
      }
      steps.end(stepId, true, '허락됨');
      if (needGrant) env.grants.add('screen.control');
    }

    const lock = this.d.screenLocks.acquire(mod.id, { taskId: env.taskId, agentId: agent.id, agentName: agent.name });
    if (!lock.ok) {
      this.screenCard(env, summary, false, null);
      return fail(`다른 에이전트 '${lock.holder.agentName}'이(가) 지금 화면을 쓰고 있습니다. 그 작업이 끝난 뒤 다시 시도하세요.`);
    }

    env.sink.emit({ type: 'edge.pulse', from: agent.id, to: `module:${mod.id}`, kind: 'skill' });
    try {
      const r = await abortable(this.d.registry.computer(mod.id, use.name, input, screenTimeoutMs(use.name, input)), env.signal);
      let image: string | null = null;
      if (r.image) {
        try {
          image = saveScreenshot(path.join(this.d.config.dataDir, 'screens'), agent.id, env.taskId, r.image);
        } catch {
          // 화면에 보일 사본을 못 남겨도 모델에게는 그대로 보냅니다.
        }
      }
      this.screenCard(env, summary, true, image);
      if (r.image) return { content: [{ type: 'image', source: { type: 'base64', media_type: r.image.mediaType, data: r.image.data } }], isError: false };
      return { content: [{ type: 'text', text: r.output || 'OK' }], isError: false };
    } catch (err) {
      const message = err instanceof AppError || err instanceof Error ? err.message : String(err);
      this.screenCard(env, summary, false, null);
      if (err instanceof ModuleError && err.detail?.['name'] === 'ComputerStopped') return fail(message, message);
      return fail(message);
    }
  }

  /**
   * 도구 호출 하나를 처리합니다: 입력 검증 → 기본 금지 조항·훅 → 권한 → (필요하면) 승인 → 실행 → 결과 훅.
   * 어떤 단계에서 막히든 에이전트가 이유를 알 수 있도록 오류 결과로 돌려줍니다.
   */
  async execute(use: ToolUse, env: ToolEnv, steps: StepReporter): Promise<ToolOutcome> {
    const agent = env.agent;
    const builtin = this.d.builtins.get(use.name) ?? null;
    const mod = builtin ? null : (this.d.registry.toolsFor(agent.id).find((t) => t.name === use.name) ?? null);
    if (!builtin && !mod) {
      return { content: `도구 '${use.name}'이(가) 없습니다. 연결이 끊겼거나 이름이 틀렸습니다. 지금 쓸 수 있는 도구 목록에서 고르세요.`, isError: true };
    }
    const title = builtin?.title ?? mod?.title ?? use.name;

    if (use.input === null || typeof use.input !== 'object' || Array.isArray(use.input)) {
      return { content: `도구 '${use.name}'의 입력은 JSON 객체여야 합니다.`, isError: true };
    }
    const input = use.input as Record<string, unknown>;
    const schemaErr = validateJson(input, (builtin?.input_schema ?? mod?.input_schema ?? { type: 'object' }) as Record<string, unknown>);
    if (schemaErr) return { content: `입력이 도구 스키마에 맞지 않습니다 — ${schemaErr}`, isError: true };

    let described: Described;
    try {
      described = builtin ? await builtin.describe(input, env) : { permission: null, target: null, text: JSON.stringify(input), summary: JSON.stringify(input).slice(0, 120) };
    } catch (err) {
      return { content: err instanceof Error ? err.message : String(err), isError: true };
    }

    const stepId = steps.start(title, described.summary);
    const category = builtin ? (described.permission ?? `tool:${use.name}`) : `${mod?.kind}:${mod?.moduleId}`;
    const hookCtx: ToolCtx = {
      event: 'before_tool',
      agentId: agent.id,
      agentName: agent.name,
      taskId: env.taskId,
      now: new Date(),
      tool: use.name,
      category,
      input,
      workspace: env.workspace,
      cwd: described.cwd ?? env.workspace,
      folders: agent.folders,
      home: os.homedir(),
      command: described.command ?? null,
      paths: described.paths ?? [],
      url: described.url ?? null,
      host: described.host ?? null,
      method: described.method ?? null,
      text: described.text ?? null,
    };

    const outcome = this.d.hooks.run(hookCtx);
    for (const l of outcome.logs) env.sink.activity({ type: 'hook.log', category: 'hook', tone: 'pass', who: '훅 기록', text: l, agentId: agent.id });
    if (outcome.decision === 'deny') {
      const reason = outcome.reasons[0] ?? '훅이 막았습니다.';
      const by = outcome.by[0] ?? '';
      this.block(env, agent, by.startsWith('guard:') ? `훅 차단 · ${by.slice(6)}` : '훅 차단', reason, `${use.name}(${described.summary})`);
      steps.end(stepId, false, '훅 차단');
      return { content: `실행하지 않았습니다. ${reason}`, isError: true };
    }

    // 권한
    const asks: string[] = [...outcome.reasons];
    let def: PermissionDef | null = null;
    if (described.permission) {
      def = this.d.defs().find((x) => x.key === described.permission) ?? null;
      if (def) {
        const decision = evaluatePermission(def, agent.permissions[def.key], described.target);
        if (decision.decision === 'deny') {
          this.block(env, agent, '권한 차단', decision.reason, `${use.name}(${described.summary})`);
          steps.end(stepId, false, '권한 차단');
          return { content: `실행하지 않았습니다. ${decision.reason}${def.locked ? '' : this.escalationHint(agent, env, def, described.target ?? null)}`, isError: true };
        }
        if (decision.decision === 'ask') asks.unshift(decision.reason);
      }
    }

    if (asks.length > 0) {
      if (env.quiet) {
        // 조용한 판단 중에는 승인을 기다리지 않습니다 (사용자 모르게 멈춰 있지 않도록).
        steps.end(stepId, false, '승인 필요');
        return {
          content: `실행하지 않았습니다. 조용한 판단(하트비트 · 자동 알림) 중에는 승인이 필요한 동작을 할 수 없습니다: ${asks[0]} 꼭 필요하면 보고에 '승인이 필요한 일'로 적어 사용자에게 알리세요.`,
          isError: true,
        };
      }
      steps.wait(stepId, '승인 대기');
      env.sink.emit({ type: 'agent.status', agentId: agent.id, status: 'waiting', detail: `${title} 승인 대기` });
      const { wait } = this.d.approvals.request({
        agentId: agent.id,
        agentName: agent.name,
        taskId: env.taskId,
        threadId: env.threadId,
        kind: def ? 'permission' : 'hook',
        title: `${def?.label ?? title} · ${described.summary}`,
        detail: { permission: def?.key ?? null, target: described.target, rule: asks.join(' / '), tool: use.name, input: JSON.stringify(input).slice(0, 2000) },
        signal: env.signal,
      });
      const result = await wait;
      env.sink.emit({ type: 'agent.status', agentId: agent.id, status: 'working', detail: null });
      if (result.decision === 'cancelled') {
        steps.end(stepId, false, '작업 취소');
        return { content: '작업이 취소되어 실행하지 않았습니다.', isError: true };
      }
      if (result.decision === 'deny' || result.decision === 'expired') {
        steps.end(stepId, false, result.decision === 'deny' ? '거부됨' : '승인 만료');
        const why = result.decision === 'deny' ? '사용자가 이 작업을 거부했습니다.' : (result.note ?? `승인 대기 시간(${this.d.config.approvalTimeoutMinutes}분)이 지나 실행하지 않았습니다.`);
        return { content: `실행하지 않았습니다. ${why}`, isError: true };
      }
    }

    // 실행
    const node = skillNodeFor(use.name, mod);
    if (node) env.sink.emit({ type: 'edge.pulse', from: agent.id, to: node, kind: mod?.kind === 'module' ? 'message' : 'skill' });
    const t0 = Date.now();
    let output: string;
    let ok = true;
    try {
      output = builtin ? await builtin.run(input, env) : await this.d.registry.callTool(mod?.moduleId as string, use.name, input, { agentId: agent.id, agentName: agent.name, taskId: env.taskId });
    } catch (err) {
      ok = false;
      output = err instanceof AppError || err instanceof Error ? err.message : String(err);
      if (mod && err instanceof ModuleError && (err.code === 'module_env_missing' || err.code === 'module_setting_locked')) this.showSetup(env, mod.moduleId);
    }
    const ms = Date.now() - t0;

    // 프로젝트 활동 · git 저장소 자동 등록 (기록에 실패해도 도구 결과에는 영향 없음)
    if (builtin && this.d.activity) {
      try {
        this.d.activity.afterTool(env, use.name, input, described, ok);
      } catch {
        // 무시
      }
    }

    // 결과 훅
    if (ok) {
      const after = this.d.hooks.run({ ...hookCtx, event: 'after_tool', now: new Date(), output });
      if (after.decision === 'deny') {
        output = `결과를 에이전트에게 보내지 않았습니다: ${after.reasons[0] ?? '훅이 막음'}`;
        ok = false;
      } else if (after.text !== undefined) {
        output = after.text;
      }
    }

    env.sink.timeline('tool', {
      tool: use.name,
      title,
      summary: described.summary,
      ok,
      ms,
      preview: output.slice(0, PREVIEW),
      source: mod ? mod.moduleId : 'builtin',
    });
    if (mod?.kind === 'skill' || mod?.kind === 'module') {
      env.sink.activity({ type: 'tool.call', category: 'skill', tone: 'agent', who: agent.name, text: `${use.name} 호출 · ${described.summary.slice(0, 60)}${ok ? '' : ' · 실패'}`, agentId: agent.id, moduleId: mod.moduleId });
    }
    steps.end(stepId, ok, `${described.summary.slice(0, 50)} · ${(ms / 1000).toFixed(1)}초`);
    return { content: output, isError: !ok };
  }
}

/** 작업이 취소되면 오래 걸리는 화면 동작(기다리기 등)을 기다리지 않고 돌아옵니다. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('작업이 취소되어 화면 동작을 멈췄습니다.'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('작업이 취소되어 화면 동작을 멈췄습니다.'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
