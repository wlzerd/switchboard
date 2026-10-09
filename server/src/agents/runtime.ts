import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describeAnthropicError } from '../anthropic/errors.ts';
import { clampMaxTokens, type ModelSummary } from '../anthropic/models.ts';
import type { AnthropicService } from '../anthropic/service.ts';
import type { Config } from '../config/env.ts';
import { sha256 } from '../crypto/secrets.ts';
import type { AgentRow, Store, TaskRow, TaskStep } from '../db/store.ts';
import { AnthropicCallError, AppError } from '../errors.ts';
import type { AgentLiveStatus, EventBus } from '../events/bus.ts';
import type { GuardState } from '../guards/guards.ts';
import { assertDailyBudget, assertStep, dayKey } from '../limits/limits.ts';
import type { Logger } from '../log.ts';
import type { ModuleRegistry } from '../modules/registry.ts';
import type { PermissionDef } from '../permissions/policy.ts';
import { TOOL_PERMISSION } from '../tools/builtin.ts';
import type { BuiltinTool, ToolEnv } from '../tools/types.ts';
import type { StepReporter, ToolExecutor } from './executor.ts';
import { boundHistory, danglingToolResults, sanitizeFallbackContent, stripThinking, textOf, type HistoryMessage } from './history.ts';
import { buildSystemPrompt, userHeader } from './prompt.ts';

export interface TaskInput {
  agentId: string;
  /** 대화 스레드 키: console · <모듈 id>:<대상> · schedule:<id> */
  source: string;
  sourceLabel: string;
  origin: TaskRow['origin'];
  text: string;
  reply: { moduleId: string; target: string } | null;
  title?: string;
}

export interface RuntimeDeps {
  config: Config;
  store: Store;
  bus: EventBus;
  log: Logger;
  anthropic: AnthropicService;
  executor: ToolExecutor;
  registry: ModuleRegistry;
  builtins: BuiltinTool[];
  defs: () => PermissionDef[];
  guardState: GuardState;
  /** 모델별 서버 도구 버전 단계: 0=최신, 1=기본, 2=사용 안 함 */
  serverToolLevel: Map<string, number>;
  deliver: (agent: AgentRow, env: ToolEnv, moduleId: string, target: string, text: string) => Promise<string>;
  acquireSlot: (signal: AbortSignal) => Promise<() => void>;
  onFinished: () => void;
}

type Block = Record<string, unknown> & { type?: unknown };

const RETRY_LIMIT = 3;
const MAX_STEPS_KEPT = 30;
const COMPACTION_BETA = 'compact-2026-01-12';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

class StepTracker implements StepReporter {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly taskId: string;
  steps: TaskStep[];
  private seq = 0;

  constructor(store: Store, bus: EventBus, task: TaskRow) {
    this.store = store;
    this.bus = bus;
    this.taskId = task.id;
    this.steps = task.steps;
  }

  private save(): void {
    if (this.steps.length > MAX_STEPS_KEPT) this.steps = this.steps.slice(-MAX_STEPS_KEPT);
    const task = this.store.updateTask(this.taskId, { steps: this.steps });
    this.bus.emit({ type: 'task.update', task });
  }

  add(label: string, meta: string, state: TaskStep['state']): string {
    this.seq += 1;
    const id = `s${this.seq}`;
    this.steps.push({ id, label, meta, state, at: Date.now() });
    this.save();
    return id;
  }

  start(label: string, meta: string): string {
    return this.add(label, meta, 'active');
  }

  private patch(id: string, state: TaskStep['state'], meta: string): void {
    const s = this.steps.find((x) => x.id === id);
    if (!s) return;
    s.state = state;
    s.meta = meta;
    this.save();
  }

  wait(id: string, meta: string): void {
    this.patch(id, 'wait', meta);
  }

  end(id: string, ok: boolean, meta: string): void {
    this.patch(id, ok ? 'done' : 'error', meta);
  }
}

class TaskFailure extends Error {
  readonly title: string;
  constructor(title: string, message: string) {
    super(message);
    this.title = title;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** 재시도 대기: 2초, 8초, 30초 */
export function retryBackoffMs(attempt: number): number {
  return [2000, 8000, 30000][Math.min(attempt, 3) - 1] ?? 30000;
}

interface Running {
  task: TaskRow;
  threadId: string;
  abort: AbortController;
}

export class AgentRuntime {
  readonly agentId: string;
  private readonly d: RuntimeDeps;
  private readonly queue: { input: TaskInput; task: TaskRow }[] = [];
  private readonly running = new Map<string, Running>();
  private readonly busyThreads = new Set<string>();
  status: AgentLiveStatus = 'idle';
  detail: string | null = null;

  constructor(agentId: string, deps: RuntimeDeps) {
    this.agentId = agentId;
    this.d = deps;
    const agent = deps.store.getAgent(agentId);
    if (agent.paused) this.status = 'paused';
  }

  private setStatus(status: AgentLiveStatus, detail: string | null): void {
    if (this.status === status && this.detail === detail) return;
    this.status = status;
    this.detail = detail;
    this.d.bus.emit({ type: 'agent.status', agentId: this.agentId, status, detail });
  }

  workspace(): string {
    const dir = path.join(this.d.config.dataDir, 'workspaces', this.agentId);
    fs.mkdirSync(dir, { recursive: true });
    return fs.realpathSync(dir);
  }

  /** 작업을 줄 세웁니다. 콘솔에 바로 보이도록 사용자 메시지를 먼저 타임라인에 넣습니다. */
  enqueue(input: TaskInput): TaskRow {
    const agent = this.d.store.getAgent(this.agentId);
    const thread = this.d.store.getOrCreateThread(this.agentId, input.source, input.sourceLabel);
    const title = input.title ?? input.text.replace(/\s+/g, ' ').slice(0, 60);
    const task = this.d.store.insertTask({ agentId: this.agentId, threadId: thread.id, title, origin: input.origin });
    const item = this.d.store.addTimeline(thread.id, task.id, 'user', { text: input.text, src: input.sourceLabel });
    this.d.bus.emit({ type: 'timeline.add', agentId: this.agentId, item });
    this.d.bus.emit({ type: 'task.update', task });
    this.queue.push({ input, task });
    if (agent.paused) this.setStatus('paused', `대기열 ${this.queue.length}건`);
    this.pump();
    return task;
  }

  queued(): TaskRow[] {
    return this.queue.map((q) => q.task);
  }

  runningTasks(): TaskRow[] {
    return [...this.running.values()].map((r) => r.task);
  }

  /** 대기열에서 시작할 수 있는 작업을 꺼내 실행합니다 (같은 대화는 하나씩, 에이전트 동시 작업 한도까지). */
  pump(): void {
    const agent = this.d.store.getAgent(this.agentId);
    if (agent.paused) return;
    let i = 0;
    while (i < this.queue.length && this.running.size < agent.limits.concurrency) {
      const item = this.queue[i] as { input: TaskInput; task: TaskRow };
      if (this.busyThreads.has(item.task.threadId)) {
        i += 1;
        continue;
      }
      this.queue.splice(i, 1);
      const abort = new AbortController();
      this.running.set(item.task.id, { task: item.task, threadId: item.task.threadId, abort });
      this.busyThreads.add(item.task.threadId);
      void this.runWithSlot(item.input, item.task, abort);
    }
  }

  cancel(taskId: string): boolean {
    const r = this.running.get(taskId);
    if (r) {
      r.abort.abort();
      return true;
    }
    const idx = this.queue.findIndex((q) => q.task.id === taskId);
    if (idx === -1) return false;
    const [q] = this.queue.splice(idx, 1);
    if (q) {
      const task = this.d.store.updateTask(q.task.id, { status: 'cancelled', finishedAt: Date.now(), error: '시작 전에 취소했습니다.' });
      this.d.bus.emit({ type: 'task.update', task });
    }
    return true;
  }

  cancelAll(reason: string): void {
    for (const r of this.running.values()) r.abort.abort();
    for (const q of this.queue.splice(0)) {
      const task = this.d.store.updateTask(q.task.id, { status: 'cancelled', finishedAt: Date.now(), error: reason });
      this.d.bus.emit({ type: 'task.update', task });
    }
  }

  onPauseChanged(paused: boolean): void {
    if (paused) this.setStatus('paused', this.queue.length > 0 ? `대기열 ${this.queue.length}건` : null);
    else {
      this.setStatus(this.running.size > 0 ? 'working' : 'idle', null);
      this.pump();
    }
  }

  private async runWithSlot(input: TaskInput, task: TaskRow, abort: AbortController): Promise<void> {
    let release: (() => void) | null = null;
    try {
      release = await this.d.acquireSlot(abort.signal);
      await this.run(input, task, abort);
    } finally {
      release?.();
      this.running.delete(task.id);
      this.busyThreads.delete(task.threadId);
      this.d.guardState.endTask(task.id);
      if (this.running.size === 0 && this.status === 'working') this.setStatus('idle', null);
      this.pump();
      this.d.onFinished();
    }
  }

  /** 도구 목록: 권한이 모두 차단인 내장 도구는 빼고, 연결된 모듈·스킬 도구를 더합니다. 이름순으로 고정해 캐시를 지킵니다. */
  private buildTools(agent: AgentRow, model: ModelSummary | null, level: number): { tools: unknown[]; hadServer: boolean } {
    const hasChannel = this.d.store.listAgentModules(agent.id).some((l) => this.d.store.findModule(l.moduleId)?.manifest.channel);
    const custom: { name: string; description: string; input_schema: Record<string, unknown>; eager_input_streaming: true }[] = [];
    for (const t of this.d.builtins) {
      const keys = TOOL_PERMISSION[t.name] ?? [];
      if (t.name === 'send_message' && !hasChannel) continue;
      if (t.name === 'schedule_list' && agent.permissions['schedule.create']?.mode === 'deny') continue;
      if (keys.length > 0 && keys.every((k) => (agent.permissions[k]?.mode ?? 'ask') === 'deny')) continue;
      custom.push({ name: t.name, description: t.description, input_schema: t.input_schema, eager_input_streaming: true });
    }
    for (const t of this.d.registry.toolsFor(agent.id)) {
      custom.push({ name: t.name, description: t.description, input_schema: t.input_schema as Record<string, unknown>, eager_input_streaming: true });
    }
    custom.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const server: Record<string, unknown>[] = [];
    if (level < 2 && (model?.webSearch ?? true)) {
      if (agent.permissions['web.search']?.mode === 'allow') {
        server.push({ type: level === 0 ? 'web_search_20260209' : 'web_search_20250305', name: 'web_search', max_uses: 10 });
      }
      const net = agent.permissions['net.fetch'];
      if (net?.mode === 'allow') {
        const domains = net.scope.map((p) => p.replace(/^\*\./, '')).filter((p) => p !== '*');
        server.push({ type: level === 0 ? 'web_fetch_20260209' : 'web_fetch_20250910', name: 'web_fetch', max_uses: 10, ...(domains.length > 0 ? { allowed_domains: domains } : {}) });
      }
    }
    return { tools: [...custom, ...server], hadServer: server.length > 0 };
  }

  private async run(input: TaskInput, startTask: TaskRow, abort: AbortController): Promise<void> {
    const { store, bus, config } = this.d;
    let agent = store.getAgent(this.agentId);
    const thread = store.getThread(startTask.threadId);
    let task = store.updateTask(startTask.id, { status: 'running', startedAt: Date.now() });
    bus.emit({ type: 'task.update', task });
    this.setStatus('working', task.title);
    const steps = new StepTracker(store, bus, task);
    steps.add(`요청 수신 · ${input.sourceLabel}`, new Date().toLocaleTimeString('ko-KR', { timeZone: process.env['TZ'] || undefined, hour12: false }), 'done');

    const tz = process.env['TZ'] || 'UTC';
    const env: ToolEnv = { agent, workspace: this.workspace(), threadId: thread.id, taskId: task.id, signal: abort.signal, reply: input.reply };

    try {
      // 이전 실행이 도구 호출 직후 끊겼다면 결과 짝을 채웁니다.
      const prior = store.listMessages(thread.id).map((m) => ({ role: m.role, content: m.content }));
      const fix = danglingToolResults(prior);
      if (fix) store.appendMessage(thread.id, 'user', fix.content);
      store.appendMessage(thread.id, 'user', `${userHeader(input.sourceLabel, new Date(), tz)}\n${input.text}`);

      const model = await this.d.anthropic.modelInfo(agent.keyId, agent.model);
      const client = this.d.anthropic.client(agent.keyId);
      const compaction = config.compaction === 'auto' && model?.compaction === true;
      const fallback = config.refusalFallback === 'default' && model?.fallback === true;

      let step = 0;
      let retries = 0;
      let parseRetries = 0;
      let contextRetry = false;
      let finalText = '';
      let answerStep: string | null = null;

      for (;;) {
        if (abort.signal.aborted) throw new TaskFailure('취소됨', '작업을 취소했습니다.');
        step += 1;
        agent = store.getAgent(this.agentId);
        env.agent = agent;
        assertStep(agent.name, step, agent.limits.stepsPerTask);
        assertDailyBudget(agent.name, store.usageTotal(agent.id, dayKey(new Date(), tz)), agent.limits.tokensPerDay, tz);

        const level = this.d.serverToolLevel.get(agent.model) ?? 0;
        const { tools, hadServer } = this.buildTools(agent, model, level);
        const links = store.listAgentModules(agent.id).map((l) => store.findModule(l.moduleId)).filter((m): m is NonNullable<typeof m> => m !== null);
        const system = buildSystemPrompt({ agent, defs: this.d.defs(), channels: links.filter((m) => m.manifest.channel && m.enabled), connected: links, rootDir: config.rootDir });
        const hash = sha256(`${agent.model}\n${system}\n${JSON.stringify(tools)}`);
        const threadNow = store.getThread(thread.id);
        if (threadNow.frozenHash !== hash) {
          if (threadNow.frozenHash !== null) {
            // 시스템 프롬프트·도구가 바뀌면 이전 thinking 블록은 무효가 되므로 한 번 걷어냅니다.
            store.replaceMessages(thread.id, stripThinking(store.listMessages(thread.id).map((m) => ({ role: m.role, content: m.content }))));
          }
          store.setThreadHash(thread.id, hash);
        }

        let history: HistoryMessage[] = store.listMessages(thread.id).map((m) => ({ role: m.role, content: m.content }));
        const cap = compaction ? config.historyMaxMessages * 5 : config.historyMaxMessages;
        const bounded = boundHistory(history, cap);
        if (bounded.trimmed) {
          store.replaceMessages(thread.id, bounded.messages);
          history = bounded.messages;
        }

        const betas = [...(compaction ? [COMPACTION_BETA] : []), ...(fallback ? [FALLBACK_BETA] : [])];
        const params: Record<string, unknown> = {
          model: agent.model,
          max_tokens: clampMaxTokens(config.agentMaxTokens, model),
          system: [{ type: 'text', text: system }],
          messages: history,
          tools,
          cache_control: { type: 'ephemeral' },
          ...(betas.length > 0 ? { betas } : {}),
          ...(model?.adaptiveThinking ? { thinking: { type: 'adaptive' } } : {}),
          ...(agent.effort && model?.efforts.includes(agent.effort) ? { output_config: { effort: agent.effort } } : {}),
          ...(compaction ? { context_management: { edits: [{ type: 'compact_20260112' }] } } : {}),
          ...(fallback ? { fallbacks: 'default' } : {}),
        };

        let final: { content: Block[]; stop_reason: string | null; stop_details: unknown; usage: Record<string, unknown> };
        try {
          const stream = client.beta.messages.stream(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, { signal: abort.signal });
          stream.on('text', (delta: string) => {
            if (!answerStep) answerStep = steps.start('답변 작성', '작성 중');
            bus.emit({ type: 'agent.delta', agentId: agent.id, threadId: thread.id, taskId: task.id, text: delta });
          });
          final = (await stream.finalMessage()) as unknown as typeof final;
        } catch (err) {
          if (abort.signal.aborted) throw new TaskFailure('취소됨', '작업을 취소했습니다.');
          if (err instanceof Anthropic.BadRequestError && hadServer && level < 2) {
            // 이 모델이 해당 버전의 서버 도구(웹 검색·가져오기)를 받지 않으면 한 단계 낮춰 다시 보냅니다.
            this.d.serverToolLevel.set(agent.model, level + 1);
            this.d.log.info('서버 도구 버전을 낮춰 다시 요청합니다', { model: agent.model, level: level + 1, reason: err.message.slice(0, 160) });
            step -= 1;
            continue;
          }
          if (err instanceof Anthropic.APIError) {
            const e = describeAnthropicError(err, { op: 'message', agentName: agent.name, model: agent.model, timeoutMs: config.anthropicTimeoutMs });
            if (e.retryable && retries < RETRY_LIMIT) {
              retries += 1;
              const wait = e.retryAfterMs ?? retryBackoffMs(retries);
              const item = store.addTimeline(thread.id, task.id, 'system', { text: `${e.message} (${retries}/${RETRY_LIMIT}, ${Math.ceil(wait / 1000)}초 대기)` });
              bus.emit({ type: 'timeline.add', agentId: agent.id, item });
              await sleep(wait, abort.signal);
              step -= 1;
              continue;
            }
            throw e;
          }
          // 도구 입력 스트리밍 중 JSON 을 해석하지 못한 경우: 같은 턴을 두 번까지 다시 요청합니다.
          if (parseRetries < 2) {
            parseRetries += 1;
            step -= 1;
            continue;
          }
          throw new AnthropicCallError('stream_parse', `모델 응답을 해석하지 못했습니다: ${(err as Error).message}`, 502, false, null);
        }
        retries = 0;
        parseRetries = 0;
        this.recordUsage(agent.id, final.usage, tz);

        let content = final.content;
        const fb = content.filter((b) => b.type === 'fallback');
        if (fb.length > 0) {
          content = sanitizeFallbackContent(content);
          const last = fb[fb.length - 1] as { from?: { model?: string }; to?: { model?: string } };
          const item = store.addTimeline(thread.id, task.id, 'system', { text: `안전 분류기 판단으로 ${last.from?.model ?? '요청 모델'} 대신 ${last.to?.model ?? '대체 모델'}이(가) 이어서 답했습니다.` });
          bus.emit({ type: 'timeline.add', agentId: agent.id, item });
        }

        const stop = final.stop_reason;
        if (stop === 'refusal') {
          const details = final.stop_details as { category?: string | null; explanation?: string | null } | null;
          throw new TaskFailure('모델이 요청을 거절했습니다', `안전 분류기가 이 요청을 거절했습니다${details?.category ? ` (분류: ${details.category})` : ''}.${details?.explanation ? ` ${details.explanation}` : ''} 표현을 바꾸거나 다른 모델을 고르세요.`);
        }
        if (stop === 'pause_turn' || stop === 'compaction') {
          store.appendMessage(thread.id, 'assistant', content);
          step -= stop === 'compaction' ? 1 : 0;
          continue;
        }
        if (stop === 'model_context_window_exceeded') {
          if (contextRetry) throw new TaskFailure('대화가 너무 깁니다', '대화가 모델의 컨텍스트 한도를 넘었습니다. 기록을 줄여도 여전히 깁니다. 새 대화로 시작하세요.');
          contextRetry = true;
          const all = store.listMessages(thread.id).map((m) => ({ role: m.role, content: m.content }));
          store.replaceMessages(thread.id, boundHistory(all, Math.max(10, Math.floor(all.length / 2))).messages);
          step -= 1;
          continue;
        }
        const toolUses = content.filter((b) => b.type === 'tool_use') as unknown as { id: string; name: string; input: unknown }[];
        if (stop === 'max_tokens') {
          if (toolUses.length > 0) {
            throw new TaskFailure('출력이 잘렸습니다', `도구 입력이 최대 출력 토큰(${clampMaxTokens(config.agentMaxTokens, model)})에서 잘려 실행하지 않았습니다. AGENT_MAX_TOKENS 를 늘리거나 작업을 나누세요.`);
          }
          store.appendMessage(thread.id, 'assistant', content);
          finalText = `${textOf(content)}\n\n(최대 출력 길이에 닿아 답변이 잘렸습니다)`;
          break;
        }
        store.appendMessage(thread.id, 'assistant', content);
        if (stop === 'tool_use' && toolUses.length > 0) {
          const mid = textOf(content);
          if (mid) {
            const item = store.addTimeline(thread.id, task.id, 'agent', { text: mid });
            bus.emit({ type: 'timeline.add', agentId: agent.id, item });
          }
          if (answerStep) {
            steps.end(answerStep, true, '중간 답변');
            answerStep = null;
          }
          const results = await Promise.all(toolUses.map((u) => this.d.executor.execute(u, env, steps)));
          store.appendMessage(
            thread.id,
            'user',
            toolUses.map((u, i) => ({ type: 'tool_result', tool_use_id: u.id, content: results[i]?.content ?? '', ...(results[i]?.isError ? { is_error: true } : {}) })),
          );
          continue;
        }
        finalText = textOf(content);
        break;
      }

      if (answerStep) steps.end(answerStep, true, '완료');
      if (finalText) {
        const item = store.addTimeline(thread.id, task.id, 'agent', { text: finalText });
        bus.emit({ type: 'timeline.add', agentId: agent.id, item });
      }
      if (input.reply && finalText) {
        const sendStep = steps.start(`전송 · ${input.sourceLabel}`, '보내는 중');
        try {
          await this.d.deliver(agent, env, input.reply.moduleId, input.reply.target, finalText);
          steps.end(sendStep, true, '보냄');
        } catch (err) {
          steps.end(sendStep, false, (err as Error).message.slice(0, 60));
          const item = store.addTimeline(thread.id, task.id, 'error', { title: '답변을 보내지 못했습니다', text: (err as Error).message });
          bus.emit({ type: 'timeline.add', agentId: agent.id, item });
        }
      }
      task = store.updateTask(task.id, { status: 'done', finishedAt: Date.now(), steps: steps.steps });
      bus.emit({ type: 'task.update', task });
      this.setStatus(this.running.size > 1 ? 'working' : 'idle', null);
    } catch (err) {
      const cancelled = abort.signal.aborted;
      const title = err instanceof TaskFailure ? err.title : cancelled ? '취소됨' : '작업 실패';
      const message = err instanceof AppError || err instanceof Error ? err.message : String(err);
      if (!(err instanceof AppError) && !(err instanceof TaskFailure)) this.d.log.error('작업 중 예상하지 못한 오류', { agent: agent.name, error: message, stack: (err as Error).stack });
      const item = store.addTimeline(thread.id, task.id, 'error', { title, text: message });
      bus.emit({ type: 'timeline.add', agentId: agent.id, item });
      task = store.updateTask(task.id, { status: cancelled ? 'cancelled' : 'failed', finishedAt: Date.now(), error: message, steps: steps.steps });
      bus.emit({ type: 'task.update', task });
      if (!cancelled) {
        bus.activity({ type: 'task.failed', category: 'agent', tone: 'error', who: agent.name, text: `${title} · ${message.slice(0, 120)}`, agentId: agent.id });
        this.setStatus('error', message.slice(0, 200));
      } else this.setStatus('idle', null);
    }
  }

  private recordUsage(agentId: string, usage: Record<string, unknown>, tz: string): void {
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    let input = n(usage['input_tokens']);
    let output = n(usage['output_tokens']);
    const iterations = usage['iterations'];
    if (Array.isArray(iterations) && iterations.length > 1) {
      // 대체 모델로 넘어간 응답은 시도마다 사용량이 따로 기록됩니다.
      input = iterations.reduce((s: number, it) => s + n((it as Record<string, unknown>)['input_tokens']), 0);
      output = iterations.reduce((s: number, it) => s + n((it as Record<string, unknown>)['output_tokens']), 0);
    }
    this.d.store.addUsage(agentId, dayKey(new Date(), tz), {
      input,
      output,
      cacheRead: n(usage['cache_read_input_tokens']),
      cacheWrite: n(usage['cache_creation_input_tokens']),
    });
  }
}
