import { EventEmitter } from 'node:events';
import type { ActivityCategory, ActivityRow, ActivityTone, ApprovalRow, ModuleStatus, Store, TaskRow, TimelineRow } from '../db/store.ts';

export type AgentLiveStatus = 'idle' | 'working' | 'waiting' | 'paused' | 'error';

/** 브라우저(WebSocket)로 보내는 실시간 이벤트 */
export type ServerEvent =
  | { type: 'activity'; item: ActivityRow }
  | { type: 'agent.status'; agentId: string; status: AgentLiveStatus; detail: string | null }
  | { type: 'agent.delta'; agentId: string; threadId: string; taskId: string; text: string }
  | { type: 'task.update'; task: TaskRow }
  | { type: 'timeline.add'; agentId: string; item: TimelineRow }
  | { type: 'timeline.update'; agentId: string; item: TimelineRow }
  | { type: 'edge.pulse'; from: string; to: string; kind: 'message' | 'skill' | 'delegate' }
  /** 조용한 작업(하트비트 · 자동 알림)이 보고할 것을 찾았을 때만 */
  | { type: 'report'; agentId: string; text: string; source: string }
  /** 사용자가 직접 누른 하트비트 점검이 끝났을 때 (보고가 없었다는 것도 알려 주기 위함) */
  | { type: 'heartbeat.done'; agentId: string; reported: boolean; error: string | null }
  | { type: 'approval.created'; approval: ApprovalRow }
  | { type: 'approval.resolved'; approval: ApprovalRow }
  | { type: 'module.status'; moduleId: string; status: ModuleStatus; detail: string | null }
  | { type: 'skill.created'; skillId: string; agentId: string | null }
  | { type: 'graph.changed' }
  | { type: 'theme.changed'; theme: unknown };

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
    this.emitter.setMaxListeners(200);
  }

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(fn: (e: ServerEvent) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  /** 활동 로그를 남기고 바로 화면에 알립니다. */
  activity(a: { type: string; category: ActivityCategory; tone: ActivityTone; who: string; text: string; agentId?: string | null; moduleId?: string | null; data?: Record<string, unknown> | null }): ActivityRow {
    const item = this.store.addActivity({
      type: a.type,
      category: a.category,
      tone: a.tone,
      who: a.who,
      text: a.text,
      agentId: a.agentId ?? null,
      moduleId: a.moduleId ?? null,
      data: a.data ?? null,
    });
    this.emit({ type: 'activity', item });
    return item;
  }
}
