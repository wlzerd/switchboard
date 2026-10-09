import type { AgentRow, Store } from '../db/store.ts';
import { ConflictError, NotFoundError, ValidationError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { Logger } from '../log.ts';
import type { ScheduleApi } from '../tools/builtin.ts';
import type { ToolEnv } from '../tools/types.ts';
import { describeSpec, nextRun, parseSpec } from './spec.ts';

const MAX_PER_AGENT = 20;
const TICK_MS = 15_000;

export interface ScheduledRun {
  agentId: string;
  scheduleId: string;
  prompt: string;
  label: string;
  reply: { moduleId: string; target: string } | null;
}

export class SchedulerService implements ScheduleApi {
  private readonly store: Store;
  private readonly bus: EventBus;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  /** 예약 시각이 되면 작업을 넣는 함수 (AgentManager 가 연결) */
  onDue: (run: ScheduledRun) => void = () => {};

  constructor(store: Store, bus: EventBus, log: Logger) {
    this.store = store;
    this.bus = bus;
    this.log = log;
  }

  private tz(): string {
    return process.env['TZ'] || 'UTC';
  }

  private fmt(ms: number): string {
    return new Intl.DateTimeFormat('ko-KR', { timeZone: this.tz(), dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  }

  create(agent: AgentRow, specText: string, prompt: string, reply: ToolEnv['reply']): string {
    const spec = parseSpec(specText);
    if (typeof spec === 'string') throw new ValidationError('schedule_spec', spec);
    const p = prompt.trim();
    if (p.length === 0) throw new ValidationError('schedule_prompt', '예약해서 할 일(prompt)이 비어 있습니다.');
    if (this.store.listSchedules(agent.id).length >= MAX_PER_AGENT) {
      throw new ConflictError('schedule_limit', `에이전트 한 명당 예약은 ${MAX_PER_AGENT}개까지입니다. schedule_cancel 로 안 쓰는 예약을 지우세요.`);
    }
    const next = nextRun(spec, Date.now(), this.tz());
    const row = this.store.insertSchedule({ agentId: agent.id, spec: specText.trim().toLowerCase(), prompt: p, reply, enabled: true, nextRun: next, createdBy: agent.id });
    this.bus.activity({ type: 'schedule.created', category: 'agent', tone: 'agent', who: agent.name, text: `예약 · ${describeSpec(spec)} · 다음 ${this.fmt(next)}`, agentId: agent.id });
    this.bus.emit({ type: 'graph.changed' });
    return `예약했습니다: ${describeSpec(spec)} · 다음 실행 ${this.fmt(next)} (${this.tz()}) · id ${row.id}`;
  }

  list(agent: AgentRow): string {
    const rows = this.store.listSchedules(agent.id);
    if (rows.length === 0) return '예약이 없습니다.';
    return rows
      .map((r) => {
        const spec = parseSpec(r.spec);
        const label = typeof spec === 'string' ? r.spec : describeSpec(spec);
        return `- ${r.id} · ${label} · ${r.enabled ? `다음 ${r.nextRun ? this.fmt(r.nextRun) : '-'}` : '꺼짐'} · ${r.prompt.slice(0, 60)}`;
      })
      .join('\n');
  }

  cancel(agent: AgentRow, id: string): string {
    let row;
    try {
      row = this.store.getSchedule(id);
    } catch {
      throw new NotFoundError('예약', id);
    }
    if (row.agentId !== agent.id) throw new ValidationError('schedule_owner', `예약 '${id}'은(는) 다른 에이전트의 예약이라 지울 수 없습니다.`);
    this.store.deleteSchedule(id);
    this.bus.emit({ type: 'graph.changed' });
    return `예약 ${id} 를 지웠습니다.`;
  }

  setEnabled(id: string, enabled: boolean): void {
    const row = this.store.getSchedule(id);
    const spec = parseSpec(row.spec);
    const next = enabled && typeof spec !== 'string' ? nextRun(spec, Date.now(), this.tz()) : null;
    this.store.setScheduleEnabled(id, enabled, next);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 시각이 지난 예약을 실행합니다. 서버가 꺼져 있던 동안 여러 번 지났어도 한 번만 실행하고 다음 시각으로 넘깁니다. */
  tick(now = Date.now()): void {
    for (const s of this.store.dueSchedules(now)) {
      const spec = parseSpec(s.spec);
      if (typeof spec === 'string') {
        this.store.setScheduleEnabled(s.id, false, null);
        this.log.warn('형식이 잘못된 예약을 껐습니다', { id: s.id, spec: s.spec, reason: spec });
        continue;
      }
      this.store.markScheduleRun(s.id, now, nextRun(spec, now, this.tz()));
      try {
        this.onDue({ agentId: s.agentId, scheduleId: s.id, prompt: s.prompt, label: describeSpec(spec), reply: s.reply });
      } catch (err) {
        this.log.error('예약 실행을 넣지 못했습니다', { id: s.id, error: (err as Error).message });
      }
    }
  }
}
