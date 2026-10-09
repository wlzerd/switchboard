import type { ApprovalService } from '../approvals/service.ts';
import type { Config } from '../config/env.ts';
import type { AgentRow, Store } from '../db/store.ts';
import { AppError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { HookEngine } from '../hooks/engine.ts';
import type { ToolCtx } from '../hooks/types.ts';
import type { ModuleRegistry, ModuleTool } from '../modules/registry.ts';
import { evaluatePermission, type PermissionDef } from '../permissions/policy.ts';
import { validateJson } from '../tools/json-schema.ts';
import type { BuiltinTool, Described, ToolEnv } from '../tools/types.ts';

export interface ToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
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

export interface ExecutorDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  hooks: HookEngine;
  approvals: ApprovalService;
  registry: ModuleRegistry;
  builtins: Map<string, BuiltinTool>;
  defs: () => PermissionDef[];
}

export class ToolExecutor {
  private readonly d: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.d = deps;
  }

  private block(env: ToolEnv, agent: AgentRow, title: string, text: string, code: string): void {
    const item = this.d.store.addTimeline(env.threadId, env.taskId, 'block', { title, text, code });
    this.d.bus.emit({ type: 'timeline.add', agentId: agent.id, item });
    this.d.bus.activity({ type: 'hook.blocked', category: 'hook', tone: 'block', who: '훅 차단', text: `${agent.name} · ${text}`, agentId: agent.id });
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
      command: described.command ?? null,
      paths: described.paths ?? [],
      url: described.url ?? null,
      host: described.host ?? null,
      method: described.method ?? null,
      text: described.text ?? null,
    };

    const outcome = this.d.hooks.run(hookCtx);
    for (const l of outcome.logs) this.d.bus.activity({ type: 'hook.log', category: 'hook', tone: 'pass', who: '훅 기록', text: l, agentId: agent.id });
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
          return { content: `실행하지 않았습니다. ${decision.reason}`, isError: true };
        }
        if (decision.decision === 'ask') asks.unshift(decision.reason);
      }
    }

    if (asks.length > 0) {
      steps.wait(stepId, '승인 대기');
      this.d.bus.emit({ type: 'agent.status', agentId: agent.id, status: 'waiting', detail: `${title} 승인 대기` });
      const { wait } = this.d.approvals.request({
        agentId: agent.id,
        agentName: agent.name,
        taskId: env.taskId,
        threadId: env.threadId,
        kind: def ? 'permission' : 'hook',
        title: `${def?.label ?? title} · ${described.summary}`,
        detail: { permission: def?.key ?? null, target: described.target, rule: asks.join(' / '), tool: use.name, input: JSON.stringify(input).slice(0, 2000) },
      });
      const result = await wait;
      this.d.bus.emit({ type: 'agent.status', agentId: agent.id, status: 'working', detail: null });
      if (result.decision === 'deny' || result.decision === 'expired') {
        steps.end(stepId, false, result.decision === 'deny' ? '거부됨' : '승인 만료');
        const why = result.decision === 'deny' ? '사용자가 이 작업을 거부했습니다.' : (result.note ?? `승인 대기 시간(${this.d.config.approvalTimeoutMinutes}분)이 지나 실행하지 않았습니다.`);
        return { content: `실행하지 않았습니다. ${why}`, isError: true };
      }
    }

    // 실행
    const node = skillNodeFor(use.name, mod);
    if (node) this.d.bus.emit({ type: 'edge.pulse', from: agent.id, to: node, kind: mod?.kind === 'module' ? 'message' : 'skill' });
    const t0 = Date.now();
    let output: string;
    let ok = true;
    try {
      output = builtin ? await builtin.run(input, env) : await this.d.registry.callTool(mod?.moduleId as string, use.name, input, { agentId: agent.id, agentName: agent.name, taskId: env.taskId });
    } catch (err) {
      ok = false;
      output = err instanceof AppError || err instanceof Error ? err.message : String(err);
    }
    const ms = Date.now() - t0;

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

    const item = this.d.store.addTimeline(env.threadId, env.taskId, 'tool', {
      tool: use.name,
      title,
      summary: described.summary,
      ok,
      ms,
      preview: output.slice(0, PREVIEW),
      source: mod ? mod.moduleId : 'builtin',
    });
    this.d.bus.emit({ type: 'timeline.add', agentId: agent.id, item });
    if (mod?.kind === 'skill' || mod?.kind === 'module') {
      this.d.bus.activity({ type: 'tool.call', category: 'skill', tone: 'agent', who: agent.name, text: `${use.name} 호출 · ${described.summary.slice(0, 60)}${ok ? '' : ' · 실패'}`, agentId: agent.id, moduleId: mod.moduleId });
    }
    steps.end(stepId, ok, `${described.summary.slice(0, 50)} · ${(ms / 1000).toFixed(1)}초`);
    return { content: output, isError: !ok };
  }
}
