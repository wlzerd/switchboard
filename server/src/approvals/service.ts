import type { Config } from '../config/env.ts';
import type { ApprovalDecision, ApprovalDetail, ApprovalRow, Store, TimelineRow } from '../db/store.ts';
import { ConflictError, ValidationError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { Logger } from '../log.ts';

/** cancelled: 승인을 기다리던 작업이 취소되어 요청을 닫음 */
export type ApprovalOutcome = { decision: ApprovalDecision } | { decision: 'expired' } | { decision: 'cancelled' };

/** 결정이 내려졌을 때 실행할 후속 처리 (권한에 항상 허용 추가, 대기 모듈 설치 등). 반환 문자열은 대기 중인 도구에 전달됩니다. */
export type DecisionHandler = (approval: ApprovalRow, decision: ApprovalDecision | 'expired') => Promise<string | null> | string | null;

interface Waiter {
  resolve: (o: ApprovalOutcome & { note: string | null }) => void;
  timer: NodeJS.Timeout;
  /** 작업 취소 신호에 붙인 리스너를 뗍니다 */
  detach: () => void;
}

export class ApprovalService {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly waiters = new Map<string, Waiter>();
  private readonly handlers = new Map<string, DecisionHandler>();

  constructor(config: Config, store: Store, bus: EventBus, log: Logger) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.log = log;
  }

  /** 서버가 다시 켜졌을 때 이전 실행에서 남은 대기 요청을 만료 처리합니다 (기다리던 작업은 이미 끝났으므로). */
  expireLeftovers(): void {
    const n = this.store.expireStaleApprovals('서버가 다시 시작되어 이전 실행의 승인 요청을 만료 처리했습니다.');
    if (n > 0) this.log.info('이전 실행의 승인 요청을 만료 처리했습니다', { count: n });
  }

  /** kind 별 후속 처리 등록. 'permission' 은 permission 이 있는 모든 요청에 적용됩니다. */
  onDecide(kind: string, handler: DecisionHandler): void {
    this.handlers.set(kind, handler);
  }

  /**
   * 승인을 요청하고 결정을 기다립니다. 대화 타임라인과 활동 로그에 함께 표시됩니다.
   * 시간이 지나면 거부로 처리하고, 기다리던 작업이 취소되면(signal) 바로 닫습니다 (취소가 승인 대기에 막히지 않게).
   */
  request(input: {
    agentId: string;
    agentName: string;
    taskId: string | null;
    threadId: string | null;
    kind: string;
    title: string;
    detail: ApprovalDetail;
    signal?: AbortSignal;
  }): { approval: ApprovalRow; wait: Promise<ApprovalOutcome & { note: string | null }> } {
    const approval = this.store.insertApproval({ agentId: input.agentId, taskId: input.taskId, kind: input.kind, title: input.title, detail: input.detail });
    if (input.threadId) {
      const item = this.store.addTimeline(input.threadId, input.taskId, 'approval', {
        approvalId: approval.id,
        perm: input.detail.permission ?? input.kind,
        rule: input.detail.rule,
        target: input.detail.target ?? input.title,
        status: 'pending',
      });
      this.bus.emit({ type: 'timeline.add', agentId: input.agentId, item });
    }
    this.bus.emit({ type: 'approval.created', approval });
    this.bus.activity({ type: 'approval.requested', category: 'hook', tone: 'wait', who: '승인 요청', text: `${input.agentName} → ${input.title}`, agentId: input.agentId, data: { approvalId: approval.id } });

    const wait = new Promise<ApprovalOutcome & { note: string | null }>((resolve) => {
      const timer = setTimeout(() => {
        void this.finish(approval.id, 'expired', `승인 대기 시간(${this.config.approvalTimeoutMinutes}분)이 지나 거부로 처리했습니다.`);
      }, this.config.approvalTimeoutMinutes * 60_000);
      const signal = input.signal;
      const onAbort = (): void => {
        void this.finish(approval.id, 'cancelled', '작업이 취소되어 승인 요청을 닫았습니다.');
      };
      this.waiters.set(approval.id, { resolve, timer, detach: () => signal?.removeEventListener('abort', onAbort) });
      if (signal?.aborted) queueMicrotask(onAbort);
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
    return { approval, wait };
  }

  /** 사용자의 결정. 이미 처리된 요청이면 무엇으로 처리됐는지 알려줍니다. */
  async decide(id: string, decision: unknown): Promise<ApprovalRow> {
    if (decision !== 'once' && decision !== 'always' && decision !== 'deny') {
      throw new ValidationError('approval_decision', `결정은 once(이번만 허용), always(항상 허용), deny(거부) 중 하나여야 합니다. 받은 값: ${JSON.stringify(decision)}`);
    }
    const row = this.store.getApproval(id);
    if (row.status !== 'pending') {
      const what = row.status === 'expired' ? '시간이 지나 만료된' : row.status === 'cancelled' ? '작업이 취소되어 닫힌' : row.status === 'approved' ? '이미 허용된' : '이미 거부된';
      throw new ConflictError('approval_closed', `${what} 승인 요청입니다${row.reason ? ` (${row.reason})` : ''}.`);
    }
    return this.finish(id, decision, null);
  }

  private async finish(id: string, decision: ApprovalDecision | 'expired' | 'cancelled', reason: string | null): Promise<ApprovalRow> {
    const before = this.store.getApproval(id);
    if (before.status !== 'pending') return before;
    const status = decision === 'expired' ? 'expired' : decision === 'cancelled' ? 'cancelled' : decision === 'deny' ? 'denied' : 'approved';
    const row = this.store.decideApproval(id, status, decision === 'expired' || decision === 'cancelled' ? null : decision, reason);

    let note: string | null = null;
    const handler = this.handlers.get(row.kind) ?? (row.detail.permission ? this.handlers.get('permission') : undefined);
    // 작업이 취소된 경우에는 후속 처리(대기 모듈 삭제 등)를 하지 않습니다. 대기 모듈은 모듈 화면에서 따로 결정할 수 있습니다.
    if (handler && decision !== 'cancelled') {
      try {
        note = await handler(row, decision);
      } catch (err) {
        note = `후속 처리 중 오류: ${(err as Error).message}`;
        this.log.error('승인 후속 처리 실패', { id, kind: row.kind, error: (err as Error).message });
      }
    }

    const t = this.store.findTimelineByApproval(id);
    if (t) {
      const data = { ...t.data, status: decision, note };
      this.store.updateTimeline(t.id, data);
      const item: TimelineRow = { ...t, data };
      this.bus.emit({ type: 'timeline.update', agentId: row.agentId, item });
    }
    this.bus.emit({ type: 'approval.resolved', approval: row });
    const label = decision === 'once' ? '이번만 허용' : decision === 'always' ? '항상 허용' : decision === 'deny' ? '거부' : decision === 'cancelled' ? '작업 취소로 닫힘' : '만료';
    const tone = decision === 'once' || decision === 'always' ? 'pass' : decision === 'cancelled' ? 'agent' : 'block';
    this.bus.activity({ type: 'approval.resolved', category: 'hook', tone, who: '승인', text: `${row.title} · ${label}`, agentId: row.agentId });

    const w = this.waiters.get(id);
    if (w) {
      clearTimeout(w.timer);
      w.detach();
      this.waiters.delete(id);
      w.resolve({ decision, note } as ApprovalOutcome & { note: string | null });
    }
    return row;
  }

  pendingCount(): number {
    return this.store.listApprovals('pending').length;
  }

  /** 서버 종료 시 기다리던 도구들을 깨웁니다. */
  shutdown(): void {
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer);
      w.detach();
      w.resolve({ decision: 'expired', note: '서버가 종료되어 승인 대기를 멈췄습니다.' });
      this.waiters.delete(id);
    }
  }
}
