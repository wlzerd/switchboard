import type { ActivityCategory, ActivityTone, Store, TimelineKind, TimelineRow } from '../db/store.ts';
import type { EventBus, ServerEvent } from '../events/bus.ts';

export interface ActivityInput {
  type: string;
  category: ActivityCategory;
  tone: ActivityTone;
  who: string;
  text: string;
  agentId?: string | null;
  moduleId?: string | null;
  data?: Record<string, unknown> | null;
}

/**
 * 작업 하나가 화면에 남기는 것(타임라인 · 활동 로그 · 실시간 이벤트)의 통로.
 * 일반 작업은 바로 남기고, 조용한 작업(하트비트 · 자동 알림)은 보고하기로 정할 때까지 모아 둡니다.
 */
export interface TaskSink {
  /** 지금 화면에 숨기고 있는지 */
  readonly hidden: boolean;
  timeline(kind: TimelineKind, data: Record<string, unknown>): TimelineRow | null;
  /** 이미 남긴 타임라인 항목을 고칩니다 (화면 제어 카드처럼 이어서 쌓이는 항목) */
  updateTimeline(id: number, data: Record<string, unknown>): void;
  /** 이 대화의 마지막 타임라인 항목 id (숨기는 중이면 null) */
  lastTimelineId(): number | null;
  activity(a: ActivityInput): void;
  emit(e: ServerEvent): void;
}

export class LiveSink implements TaskSink {
  readonly hidden = false;
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly agentId: string;
  private readonly threadId: string;
  private readonly taskId: string;

  constructor(store: Store, bus: EventBus, agentId: string, threadId: string, taskId: string) {
    this.store = store;
    this.bus = bus;
    this.agentId = agentId;
    this.threadId = threadId;
    this.taskId = taskId;
  }

  timeline(kind: TimelineKind, data: Record<string, unknown>): TimelineRow {
    const item = this.store.addTimeline(this.threadId, this.taskId, kind, data);
    this.bus.emit({ type: 'timeline.add', agentId: this.agentId, item });
    return item;
  }

  updateTimeline(id: number, data: Record<string, unknown>): void {
    this.store.updateTimeline(id, data);
    const item = this.store.findTimeline(id);
    if (item) this.bus.emit({ type: 'timeline.update', agentId: this.agentId, item });
  }

  lastTimelineId(): number | null {
    return this.store.lastTimelineId(this.threadId);
  }

  activity(a: ActivityInput): void {
    this.bus.activity(a);
  }

  emit(e: ServerEvent): void {
    this.bus.emit(e);
  }
}

/**
 * 조용한 작업용 통로. 숨기는 동안
 * - 타임라인과 활동은 모아 두고 (보안 차단 · 오류 활동만 바로 남김),
 * - 상태 · 선 움직임 · 글자 흐름 같은 실시간 이벤트는 버립니다.
 * 보고하기로 하면 reveal() 로 모아 둔 것을 한꺼번에 남기고, 그다음부터는 일반 작업처럼 바로 남깁니다.
 */
export class QuietSink implements TaskSink {
  private visible = false;
  private readonly live: LiveSink;
  private readonly items: { kind: TimelineKind; data: Record<string, unknown> }[] = [];
  private readonly acts: ActivityInput[] = [];

  constructor(store: Store, bus: EventBus, agentId: string, threadId: string, taskId: string) {
    this.live = new LiveSink(store, bus, agentId, threadId, taskId);
  }

  get hidden(): boolean {
    return !this.visible;
  }

  timeline(kind: TimelineKind, data: Record<string, unknown>): TimelineRow | null {
    if (this.visible) return this.live.timeline(kind, data);
    this.items.push({ kind, data });
    return null;
  }

  updateTimeline(id: number, data: Record<string, unknown>): void {
    if (this.visible) this.live.updateTimeline(id, data);
  }

  lastTimelineId(): number | null {
    return this.visible ? this.live.lastTimelineId() : null;
  }

  activity(a: ActivityInput): void {
    if (this.visible || a.tone === 'block' || a.tone === 'error') {
      this.live.activity(a);
      return;
    }
    this.acts.push(a);
  }

  emit(e: ServerEvent): void {
    if (this.visible) this.live.emit(e);
  }

  /** 보고하기로 정했을 때: first(요청 요약 등)를 먼저, 그다음 모아 둔 기록을 순서대로 남깁니다. */
  reveal(first: { kind: TimelineKind; data: Record<string, unknown> }[]): void {
    if (this.visible) return;
    this.visible = true;
    for (const it of [...first, ...this.items]) this.live.timeline(it.kind, it.data);
    for (const a of this.acts) this.live.activity(a);
    this.items.length = 0;
    this.acts.length = 0;
  }

  /** 보고할 것이 없을 때: 모아 둔 것을 버립니다. */
  discard(): void {
    this.items.length = 0;
    this.acts.length = 0;
  }
}
