import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describeAnthropicError } from '../anthropic/errors.ts';
import { clampMaxTokens, type ModelSummary } from '../anthropic/models.ts';
import type { AnthropicService } from '../anthropic/service.ts';
import type { Config } from '../config/env.ts';
import { sha256 } from '../crypto/secrets.ts';
import { attachmentView, type AttachmentService } from '../attachments/service.ts';
import type { AgentRow, AttachmentRow, ReportTarget, Store, TaskRow, TaskStep } from '../db/store.ts';
import { AnthropicCallError, AppError, LimitError } from '../errors.ts';
import type { AgentLiveStatus, EventBus } from '../events/bus.ts';
import type { GuardState } from '../guards/guards.ts';
import { assertDailyBudget, assertStep, dayKey } from '../limits/limits.ts';
import type { Logger } from '../log.ts';
import type { ModuleRegistry } from '../modules/registry.ts';
import type { PermissionDef } from '../permissions/policy.ts';
import { TOOL_PERMISSION } from '../tools/builtin.ts';
import type { BuiltinTool, DelegationOrigin, ToolEnv } from '../tools/types.ts';
import { isSilentReport } from './autonomy.ts';
import type { StepReporter, ToolExecutor } from './executor.ts';
import { boundHistory, danglingToolResults, sanitizeFallbackContent, stripThinking, textOf, type HistoryMessage } from './history.ts';
import { buildSystemPrompt, userHeader } from './prompt.ts';
import { COMPUTER_TOOLSET } from './screen.ts';
import { LiveSink, QuietSink, type TaskSink } from './sink.ts';

export interface TaskInput {
  agentId: string;
  /** 대화 스레드 키: console · <모듈 id>:<대상> · schedule:<id> · heartbeat · delegation:<맡긴 에이전트 id> */
  source: string;
  sourceLabel: string;
  origin: TaskRow['origin'];
  text: string;
  reply: { moduleId: string; target: string } | null;
  title?: string;
  /** 조용한 판단: 보고할 것이 없으면 기록 · 알림 없이 끝냅니다 (하트비트, 모듈의 자동 알림) */
  quiet?: boolean;
  /** 조용한 작업이 보고하게 되면 대화 맨 앞에 보일 요청 요약 */
  trigger?: string;
  /** 조용한 작업의 보고를 보낼 곳 (없으면 웹 화면에만) */
  reportTo?: ReportTarget | null;
  /** 이 작업까지 일을 맡겨 온 에이전트 id 들 */
  chain?: string[];
  /** 다른 에이전트가 맡긴 작업이면 결과를 돌려줄 곳 */
  delegation?: DelegationOrigin | null;
  /** 사용자가 직접 시작한 하트비트 (보고가 없어도 끝났다는 것을 알려 줌) */
  manual?: boolean;
  /** 이 요청에서 에이전트별로 일을 맡긴 횟수 (결과를 받고 또 맡기는 왕복을 셈) */
  rounds?: Record<string, number>;
  /** 예약 실행이면 그 예약 id (같은 예약이 겹쳐 쌓이지 않게) */
  scheduleId?: string;
  /** 콘솔에서 붙인 첨부 (보냄 처리 · 작업 폴더 복사를 마친 것) */
  attachments?: AttachmentRow[];
}

/** 작업이 끝났을 때 AgentManager 에 알리는 내용 (위임 결과 반환 · 하트비트 알림) */
export interface TaskEnd {
  input: TaskInput;
  task: TaskRow;
  status: 'done' | 'failed' | 'cancelled';
  finalText: string;
  error: string | null;
  /** 조용한 작업이 보고 없이 끝났는지 (기록을 지움) */
  silent: boolean;
  /** 작업 중에 다른 에이전트에게 일을 맡겨, 결과 반환 의무가 후속 작업으로 넘어갔는지 */
  deferred: boolean;
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
  /** 화면 제어 도구 묶음을 거절한 모델 */
  noComputer: Set<string>;
  /** 시스템 프롬프트에 넣을 관리 중인 프로젝트 */
  projectsFor: (agent: AgentRow) => { name: string; path: string; note: string; watch: boolean }[];
  /** 콘솔 첨부: 대화 기록에 참조로 저장하고 보낼 때 펼침 (없으면 첨부를 다루지 않음) */
  attachments?: AttachmentService;
  deliver: (agent: AgentRow, env: ToolEnv, moduleId: string, target: string, text: string) => Promise<string>;
  acquireSlot: (signal: AbortSignal) => Promise<() => void>;
  onFinished: () => void;
  onTaskEnd: (end: TaskEnd) => void;
}

type Block = Record<string, unknown> & { type?: unknown };

const RETRY_LIMIT = 3;
/** 서버 측 대화 압축이 연달아 이만큼 넘게 일어나면 멈춥니다 (압축은 단계 수에 넣지 않으므로 따로 셈) */
const MAX_COMPACTIONS_IN_ROW = 3;
const MAX_STEPS_KEPT = 30;
const COMPACTION_BETA = 'compact-2026-01-12';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

class StepTracker implements StepReporter {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly taskId: string;
  /** 조용한 작업은 보고하기로 정할 때까지 단계를 저장 · 방송하지 않습니다 */
  private visible: boolean;
  steps: TaskStep[];
  private seq = 0;

  constructor(store: Store, bus: EventBus, task: TaskRow, visible: boolean) {
    this.store = store;
    this.bus = bus;
    this.taskId = task.id;
    this.steps = task.steps;
    this.visible = visible;
  }

  private save(): void {
    if (this.steps.length > MAX_STEPS_KEPT) this.steps = this.steps.slice(-MAX_STEPS_KEPT);
    if (!this.visible) return;
    const task = this.store.updateTask(this.taskId, { steps: this.steps });
    this.bus.emit({ type: 'task.update', task });
  }

  show(): void {
    this.visible = true;
    this.save();
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

/** 기다리기. 작업이 취소되면 바로 깨고, 다 기다렸으면 취소 리스너를 뗍니다 (긴 작업에서 리스너가 쌓이지 않게). */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 재시도 대기: 2초, 8초, 30초 */
export function retryBackoffMs(attempt: number): number {
  return [2000, 8000, 30000][Math.min(attempt, 3) - 1] ?? 30000;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

interface Running {
  task: TaskRow;
  threadId: string;
  scheduleId: string | null;
  abort: AbortController;
  quiet: boolean;
}

export class AgentRuntime {
  readonly agentId: string;
  private readonly d: RuntimeDeps;
  private readonly queue: { input: TaskInput; task: TaskRow }[] = [];
  private readonly running = new Map<string, Running>();
  private readonly busyThreads = new Set<string>();
  /** 조용한 작업에서 같은 오류가 되풀이되면 처음 한 번만 보이게 합니다 */
  private lastQuietError: string | null = null;
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

  /** 화면에 보이는(조용하지 않은) 실행 중 작업 수 */
  private visibleRunning(): number {
    let n = 0;
    for (const r of this.running.values()) if (!r.quiet) n += 1;
    return n;
  }

  workspace(): string {
    const dir = path.join(this.d.config.dataDir, 'workspaces', this.agentId);
    fs.mkdirSync(dir, { recursive: true });
    // 경로 비교(작업 폴더 · 허용 폴더)는 운영체제가 대소문자까지 푼 실제 경로로 합니다.
    return fs.realpathSync.native(dir);
  }

  /** 작업을 줄 세웁니다. 콘솔에 바로 보이도록 사용자 메시지를 먼저 타임라인에 넣습니다 (조용한 작업은 넣지 않음). */
  enqueue(input: TaskInput): TaskRow {
    const agent = this.d.store.getAgent(this.agentId);
    // 대기열이 끝없이 쌓이지 않게 합니다 (채널 메시지 폭주 · 일시정지 중 쌓인 일 등). 기록을 남기기 전에 막습니다.
    const max = this.d.config.agentQueueMax;
    if (this.queue.length >= max) {
      throw new LimitError('queue_full', `'${agent.name}'의 대기열이 가득 차(${max}건) 새 작업을 받지 않았습니다. 대기 중인 작업을 취소하거나 끝나기를 기다리세요.`, { max });
    }
    const thread = this.d.store.getOrCreateThread(this.agentId, input.source, input.sourceLabel);
    const files = input.attachments ?? [];
    const title = input.title ?? (input.text.trim() !== '' ? input.text.replace(/\s+/g, ' ').slice(0, 60) : `첨부 · ${files.map((a) => a.name).join(', ')}`.slice(0, 60));
    const quiet = input.quiet === true;
    const task = this.d.store.insertTask({ agentId: this.agentId, threadId: thread.id, title, origin: input.origin, quiet, delegatedBy: input.delegation?.fromAgentId ?? null });
    if (!quiet) {
      const item = this.d.store.addTimeline(thread.id, task.id, 'user', { text: input.text, src: input.sourceLabel, ...(files.length > 0 ? { attachments: files.map(attachmentView) } : {}) });
      this.d.bus.emit({ type: 'timeline.add', agentId: this.agentId, item });
      this.d.bus.emit({ type: 'task.update', task });
    }
    this.queue.push({ input, task });
    if (agent.paused && !quiet) this.setStatus('paused', `대기열 ${this.queued().length}건`);
    this.pump();
    return task;
  }

  /** 화면에 보이는 대기 작업 */
  queued(): TaskRow[] {
    return this.queue.filter((q) => q.input.quiet !== true).map((q) => q.task);
  }

  /** 화면에 보이는 실행 중 작업 */
  runningTasks(): TaskRow[] {
    return [...this.running.values()].filter((r) => !r.quiet).map((r) => r.task);
  }

  /** 조용한 작업까지 포함해 무언가 하고 있거나 기다리는지 (하트비트를 겹쳐 넣지 않기 위함) */
  busy(): boolean {
    return this.running.size > 0 || this.queue.length > 0;
  }

  /** 대기열 길이 (조용한 작업 포함 · 상한 비교용) */
  queueLength(): number {
    return this.queue.length;
  }

  /** 이 예약의 이전 실행이 대기 중이거나 실행 중인지 (예약이 겹쳐 쌓이지 않게) */
  hasSchedule(scheduleId: string): boolean {
    if (this.queue.some((q) => q.input.scheduleId === scheduleId)) return true;
    for (const r of this.running.values()) if (r.scheduleId === scheduleId) return true;
    return false;
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
      this.running.set(item.task.id, { task: item.task, threadId: item.task.threadId, scheduleId: item.input.scheduleId ?? null, abort, quiet: item.input.quiet === true });
      this.busyThreads.add(item.task.threadId);
      void this.runWithSlot(item.input, item.task, abort);
    }
  }

  /** 시작 전에 취소된 작업 정리: 조용한 작업은 흔적 없이 지우고, 위임 결과를 기다리는 쪽에는 취소를 알립니다. */
  private dropQueued(q: { input: TaskInput; task: TaskRow }, reason: string): void {
    let task = q.task;
    if (q.input.quiet === true) this.d.store.deleteTask(task.id);
    else {
      task = this.d.store.updateTask(task.id, { status: 'cancelled', finishedAt: Date.now(), error: reason });
      this.d.bus.emit({ type: 'task.update', task });
    }
    this.d.onTaskEnd({ input: q.input, task, status: 'cancelled', finalText: '', error: reason, silent: q.input.quiet === true, deferred: false });
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
    if (q) this.dropQueued(q, '시작 전에 취소했습니다.');
    return true;
  }

  cancelAll(reason: string): void {
    for (const r of this.running.values()) r.abort.abort();
    for (const q of this.queue.splice(0)) this.dropQueued(q, reason);
  }

  onPauseChanged(paused: boolean): void {
    if (paused) this.setStatus('paused', this.queued().length > 0 ? `대기열 ${this.queued().length}건` : null);
    else {
      this.setStatus(this.visibleRunning() > 0 ? 'working' : 'idle', null);
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
      if (this.visibleRunning() === 0 && this.status === 'working') this.setStatus('idle', null);
      this.pump();
      this.d.onFinished();
    }
  }

  /** 에이전트별로 연결된 모듈 · 스킬 이름 (위임 목록에 보여 줄 '도구'). 꺼졌거나 승인 전인 것은 뺍니다. */
  private peerTools(): Map<string, string[]> {
    const store = this.d.store;
    const out = new Map<string, string[]>();
    for (const l of store.listAgentModules()) {
      const m = store.findModule(l.moduleId);
      if (!m || !m.enabled || m.status === 'pending' || m.status === 'rejected') continue;
      const list = out.get(l.agentId) ?? [];
      list.push(m.manifest.name);
      out.set(l.agentId, list);
    }
    return out;
  }

  /** 도구 목록: 권한이 모두 차단인 내장 도구는 빼고, 연결된 모듈·스킬 도구를 더합니다. 이름순으로 고정해 캐시를 지킵니다. */
  private buildTools(agent: AgentRow, model: ModelSummary | null, level: number, quiet: boolean): { tools: unknown[]; hadServer: boolean; hadComputer: boolean } {
    const hasChannel = this.d.store.listAgentModules(agent.id).some((l) => {
      const ch = this.d.store.findModule(l.moduleId)?.manifest.channel;
      return Boolean(ch) && ch?.send !== false;
    });
    const custom: { name: string; description: string; input_schema: Record<string, unknown>; eager_input_streaming: true }[] = [];
    for (const t of this.d.builtins) {
      const keys = TOOL_PERMISSION[t.name] ?? [];
      if (t.name === 'send_message' && !hasChannel) continue;
      if (t.name === 'schedule_list' && agent.permissions['schedule.create']?.mode === 'deny') continue;
      if (t.name === 'delegate_task' && !agent.delegation.send) continue;
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
    // 화면 제어: 연결된 화면 제어 모듈이 있고 권한이 차단이 아니며, 조용한 작업이 아닐 때만 도구 묶음을 엽니다 (요청마다 약 4,500 토큰).
    const screen = !quiet && this.d.registry.computerFor(agent.id) !== null && (agent.permissions['screen.control']?.mode ?? 'ask') !== 'deny' && !this.d.noComputer.has(agent.model);
    const toolset = screen ? [{ type: COMPUTER_TOOLSET }] : [];
    return { tools: [...custom, ...server, ...toolset], hadServer: server.length > 0, hadComputer: screen };
  }

  /** 채널로 보내는 단계 (답장 · 보고 공통). 실패해도 작업은 끝내고 이유를 대화에 남깁니다. */
  private async deliverStep(agent: AgentRow, env: ToolEnv, steps: StepTracker, to: ReportTarget, text: string, label: string, failTitle: string): Promise<void> {
    const sendStep = steps.start(`전송 · ${label}`, '보내는 중');
    try {
      await this.d.deliver(agent, env, to.moduleId, to.target, text);
      steps.end(sendStep, true, '보냄');
    } catch (err) {
      const message = (err as Error).message;
      steps.end(sendStep, false, message.slice(0, 60));
      env.sink.timeline('error', { title: failTitle, text: message });
    }
  }

  /** 조용한 작업이 보고하기로 정했을 때: 작업을 보이게 바꾸고 모아 둔 기록을 남깁니다. */
  private reveal(sink: QuietSink, steps: StepTracker, input: TaskInput, task: TaskRow): void {
    this.d.store.revealTask(task.id);
    sink.reveal([{ kind: 'user', data: { text: input.trigger ?? input.text, src: input.sourceLabel } }]);
    steps.show();
  }

  /** 조용한 작업이 아무것도 보고하지 않을 때: 대화 기록 · 작업 기록을 남기지 않습니다. */
  private vanish(sink: QuietSink, threadId: string, baseline: number, taskId: string): void {
    sink.discard();
    this.d.store.deleteMessagesAfter(threadId, baseline);
    this.d.store.deleteTask(taskId);
  }

  private async run(input: TaskInput, startTask: TaskRow, abort: AbortController): Promise<void> {
    const { store, bus, config } = this.d;
    let agent = store.getAgent(this.agentId);
    const thread = store.getThread(startTask.threadId);
    const quiet = input.quiet === true;
    const sink: TaskSink = quiet ? new QuietSink(store, bus, agent.id, thread.id, startTask.id) : new LiveSink(store, bus, agent.id, thread.id, startTask.id);
    let task = store.updateTask(startTask.id, { status: 'running', startedAt: Date.now() });
    if (!quiet) {
      bus.emit({ type: 'task.update', task });
      this.setStatus('working', task.title);
    }
    const steps = new StepTracker(store, bus, task, !quiet);
    steps.add(`요청 수신 · ${input.sourceLabel}`, new Date().toLocaleTimeString('ko-KR', { timeZone: process.env['TZ'] || undefined, hour12: false }), 'done');

    const tz = process.env['TZ'] || 'UTC';
    const env: ToolEnv = {
      agent,
      workspace: this.workspace(),
      threadId: thread.id,
      taskId: task.id,
      signal: abort.signal,
      reply: input.reply,
      source: input.source,
      sourceLabel: input.sourceLabel,
      quiet,
      reportTo: input.reportTo ?? null,
      chain: input.chain ?? [],
      delegation: input.delegation ?? null,
      rounds: input.rounds ?? {},
      deferred: false,
      grants: new Set<string>(),
      setupShown: new Set<string>(),
      lastBlock: null,
      blockWaived: new Set<string>(),
      screen: null,
      sink,
    };
    // 조용한 작업이 보고 없이 끝나면 이 뒤에 쌓인 대화 기록을 지웁니다.
    const baseline = quiet ? store.lastMessageId(thread.id) : 0;
    let finalText = '';
    let endStatus: TaskEnd['status'] = 'done';
    let endError: string | null = null;
    let silent = false;

    try {
      // 이전 실행이 도구 호출 직후 끊겼다면 결과 짝을 채웁니다.
      const prior = store.listMessages(thread.id).map((m) => ({ role: m.role, content: m.content }));
      const fix = danglingToolResults(prior);
      if (fix) store.appendMessage(thread.id, 'user', fix.content);
      const said = `${userHeader(input.sourceLabel, new Date(), tz)}\n${input.text}`;
      store.appendMessage(thread.id, 'user', this.d.attachments && input.attachments?.length ? this.d.attachments.messageContent(said, input.attachments) : said);

      const model = await this.d.anthropic.modelInfo(agent.keyId, agent.model);
      const client = this.d.anthropic.client(agent.keyId);
      const compaction = config.compaction === 'auto' && model?.compaction === true;
      const fallback = config.refusalFallback === 'default' && model?.fallback === true;

      let step = 0;
      let compactions = 0;
      let retries = 0;
      let parseRetries = 0;
      let contextRetry = false;
      let answerStep: string | null = null;

      for (;;) {
        if (abort.signal.aborted) throw new TaskFailure('취소됨', '작업을 취소했습니다.');
        step += 1;
        agent = store.getAgent(this.agentId);
        env.agent = agent;
        assertStep(agent.name, step, agent.limits.stepsPerTask);
        assertDailyBudget(agent.name, store.usageTotal(agent.id, dayKey(new Date(), tz)), agent.limits.tokensPerDay, tz);

        const level = this.d.serverToolLevel.get(agent.model) ?? 0;
        const { tools, hadServer, hadComputer } = this.buildTools(agent, model, level, quiet);
        const links = store.listAgentModules(agent.id).map((l) => store.findModule(l.moduleId)).filter((m): m is NonNullable<typeof m> => m !== null);
        const system = buildSystemPrompt({
          agent,
          defs: this.d.defs(),
          channels: links.filter((m) => m.manifest.channel && m.manifest.channel.send !== false && m.enabled),
          connected: links,
          peers: store.listAgents(),
          peerTools: this.peerTools(),
          home: os.homedir(),
          rootDir: config.rootDir,
          screen: hadComputer,
          projects: this.d.projectsFor(agent),
        });
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
          // 첨부는 기록에 참조로만 있고, 보낼 때 최근 것부터 한도 안에서 실제 내용으로 펼칩니다.
          messages: this.d.attachments ? this.d.attachments.expand(history) : history,
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
            sink.emit({ type: 'agent.delta', agentId: agent.id, threadId: thread.id, taskId: task.id, text: delta });
          });
          final = (await stream.finalMessage()) as unknown as typeof final;
        } catch (err) {
          if (abort.signal.aborted) throw new TaskFailure('취소됨', '작업을 취소했습니다.');
          if (err instanceof Anthropic.BadRequestError && hadComputer && /computer/i.test(err.message)) {
            // 이 모델이 화면 제어 도구 묶음을 받지 않으면 빼고 다시 보냅니다 (Claude 5 계열 · Opus 4.8 만 지원).
            this.d.noComputer.add(agent.model);
            sink.timeline('system', { text: `'${agent.model}' 모델은 화면 제어 도구(${COMPUTER_TOOLSET})를 지원하지 않아 이번에는 화면 제어 없이 진행합니다. 화면 제어가 필요하면 Claude 5 계열이나 Opus 4.8 모델로 바꾸세요.` });
            this.d.log.info('화면 제어 도구 묶음을 빼고 다시 요청합니다', { model: agent.model, reason: err.message.slice(0, 160) });
            step -= 1;
            continue;
          }
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
              sink.timeline('system', { text: `${e.message} (${retries}/${RETRY_LIMIT}, ${Math.ceil(wait / 1000)}초 대기)` });
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
          sink.timeline('system', { text: `안전 분류기 판단으로 ${last.from?.model ?? '요청 모델'} 대신 ${last.to?.model ?? '대체 모델'}이(가) 이어서 답했습니다.` });
        }

        const stop = final.stop_reason;
        if (stop === 'refusal') {
          const details = final.stop_details as { category?: string | null; explanation?: string | null } | null;
          throw new TaskFailure('모델이 요청을 거절했습니다', `안전 분류기가 이 요청을 거절했습니다${details?.category ? ` (분류: ${details.category})` : ''}.${details?.explanation ? ` ${details.explanation}` : ''} 표현을 바꾸거나 다른 모델을 고르세요.`);
        }
        // 압축이 아닌 응답이 오면 연속 압축 횟수를 다시 셉니다.
        if (stop !== 'compaction') compactions = 0;
        if (stop === 'pause_turn' || stop === 'compaction') {
          store.appendMessage(thread.id, 'assistant', content);
          if (stop === 'compaction') {
            // 압축은 단계로 세지 않으므로, 연달아 되풀이되면 따로 멈춥니다 (단계 한도를 우회해 끝없이 돌지 않게).
            compactions += 1;
            if (compactions > MAX_COMPACTIONS_IN_ROW) {
              throw new TaskFailure('대화 압축이 되풀이됩니다', `서버 측 대화 압축이 ${MAX_COMPACTIONS_IN_ROW}번 넘게 연달아 일어나 멈췄습니다. 대화가 너무 길거나 마지막 입력이 너무 큽니다. 새 대화로 시작하거나 입력을 줄이세요.`);
            }
            step -= 1;
          }
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
        const toolUses = content
          .filter((b) => b.type === 'tool_use')
          .map((b) => ({ id: String(b['id']), name: String(b['name']), input: b['input'], ...(typeof b['toolset_name'] === 'string' ? { toolset: b['toolset_name'] } : {}) }));
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
          if (mid) sink.timeline('agent', { text: mid });
          if (answerStep) {
            steps.end(answerStep, true, '중간 답변');
            answerStep = null;
          }
          const results = await this.d.executor.executeAll(toolUses, env, steps);
          store.appendMessage(
            thread.id,
            'user',
            toolUses.map((u, i) => ({
              type: 'tool_result',
              tool_use_id: u.id,
              // 도구 묶음(화면 제어)의 결과에는 그 묶음 이름을 그대로 붙여야 합니다.
              ...(u.toolset ? { toolset_name: u.toolset } : {}),
              content: results[i]?.content ?? '',
              ...(results[i]?.isError ? { is_error: true } : {}),
            })),
          );
          const stopped = results.find((r) => r?.stop)?.stop;
          if (stopped) {
            // 비상 정지: 결과를 남긴 뒤 작업을 끝냅니다.
            sink.timeline('system', { text: stopped });
            abort.abort();
          }
          continue;
        }
        finalText = textOf(content);
        break;
      }

      if (answerStep) steps.end(answerStep, true, '완료');

      if (quiet && sink instanceof QuietSink) {
        this.lastQuietError = null;
        if (isSilentReport(finalText)) {
          // 보고할 것이 없음: 화면 · 채널 · 대화 기록 어디에도 남기지 않습니다.
          silent = true;
          this.vanish(sink, thread.id, baseline, task.id);
          return;
        }
        // 보고할 것이 있음: 모아 둔 기록을 남기고, 보고를 표시 · 전송합니다.
        this.reveal(sink, steps, input, task);
        sink.timeline('report', { text: finalText, source: input.sourceLabel });
        bus.activity({ type: 'agent.report', category: 'agent', tone: 'new', who: agent.name, text: `보고 · ${oneLine(finalText).slice(0, 140)}`, agentId: agent.id });
        bus.emit({ type: 'report', agentId: agent.id, text: finalText.slice(0, 500), source: input.sourceLabel });
        if (env.reportTo) await this.deliverStep(agent, env, steps, env.reportTo, finalText, '보고', '보고를 보내지 못했습니다');
      } else {
        if (finalText) sink.timeline('agent', { text: finalText });
        if (input.reply && finalText) await this.deliverStep(agent, env, steps, input.reply, finalText, input.sourceLabel, '답변을 보내지 못했습니다');
      }
      task = store.updateTask(task.id, { status: 'done', finishedAt: Date.now(), steps: steps.steps });
      bus.emit({ type: 'task.update', task });
      if (!quiet) this.setStatus(this.visibleRunning() > 1 ? 'working' : 'idle', null);
    } catch (err) {
      const cancelled = abort.signal.aborted;
      const title = err instanceof TaskFailure ? err.title : cancelled ? '취소됨' : '작업 실패';
      const message = err instanceof AppError || err instanceof Error ? err.message : String(err);
      if (!(err instanceof AppError) && !(err instanceof TaskFailure)) this.d.log.error('작업 중 예상하지 못한 오류', { agent: agent.name, error: message, stack: (err as Error).stack });
      endStatus = cancelled ? 'cancelled' : 'failed';
      endError = message;
      if (quiet && sink instanceof QuietSink && sink.hidden) {
        // 조용한 작업: 취소되었거나 직전과 같은 오류가 되풀이되면 흔적 없이 끝내고, 처음 보는 오류만 보입니다.
        if (cancelled || this.lastQuietError === message) {
          silent = true;
          this.vanish(sink, thread.id, baseline, task.id);
          return;
        }
        this.lastQuietError = message;
        this.reveal(sink, steps, input, task);
      }
      sink.timeline('error', { title, text: message });
      task = store.updateTask(task.id, { status: endStatus, finishedAt: Date.now(), error: message, steps: steps.steps });
      bus.emit({ type: 'task.update', task });
      if (!cancelled) {
        bus.activity({ type: 'task.failed', category: 'agent', tone: 'error', who: agent.name, text: `${title} · ${message.slice(0, 120)}`, agentId: agent.id });
        if (!quiet) this.setStatus('error', message.slice(0, 200));
      } else if (!quiet) this.setStatus('idle', null);
    } finally {
      this.d.onTaskEnd({ input, task, status: endStatus, finalText, error: endError, silent, deferred: env.deferred });
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
