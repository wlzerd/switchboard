import { reportLabel, sameReportTarget } from '../agents/autonomy.ts';
import type { AgentRow, ScheduleRow, Store } from '../db/store.ts';
import { ConflictError, ValidationError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { Logger } from '../log.ts';
import type { ScheduleApi, ScheduleChange } from '../tools/builtin.ts';
import type { ToolEnv } from '../tools/types.ts';
import { describeSpec, nextRun, parseSpec, type ScheduleSpec } from './spec.ts';

const MAX_PER_AGENT = 20;
const TICK_MS = 15_000;
/** 목록에서 할 일을 이만큼만 보여 줍니다 (전체는 id 로 하나만 볼 때) */
const LIST_PROMPT_CHARS = 80;

const normSpec = (text: string): string => text.trim().toLowerCase().split(/\s+/).join(' ');

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

  private where(reply: ScheduleRow['reply']): string {
    return reportLabel(reply, (id) => this.store.findModule(id)?.manifest.name);
  }

  private label(r: ScheduleRow): string {
    const spec = parseSpec(r.spec);
    return typeof spec === 'string' ? r.spec : describeSpec(spec);
  }

  /** 이 에이전트의 예약인지 확인하고 가져옵니다. */
  private own(agent: AgentRow, id: string, verb: string): ScheduleRow {
    let row: ScheduleRow;
    try {
      row = this.store.getSchedule(id);
    } catch {
      throw new ValidationError('schedule_not_found', `예약 '${id}'이(가) 없습니다. schedule_list 로 id 를 확인하세요.`);
    }
    if (row.agentId !== agent.id) throw new ValidationError('schedule_owner', `예약 '${id}'은(는) 다른 에이전트의 예약이라 ${verb} 수 없습니다.`);
    return row;
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
    const row = this.store.insertSchedule({ agentId: agent.id, spec: normSpec(specText), prompt: p, reply, enabled: true, nextRun: next, createdBy: agent.id });
    this.bus.activity({ type: 'schedule.created', category: 'agent', tone: 'agent', who: agent.name, text: `예약 · ${describeSpec(spec)} · 다음 ${this.fmt(next)}`, agentId: agent.id });
    this.bus.emit({ type: 'graph.changed' });
    return `예약했습니다: ${describeSpec(spec)} · 다음 실행 ${this.fmt(next)} (${this.tz()}) · 결과 받을 곳 ${this.where(reply)} · id ${row.id}`;
  }

  private state(r: ScheduleRow): string {
    const skipped = r.skipped > 0 ? ` · 건너뜀 ${r.skipped}회(이전 실행이 안 끝났거나 일시정지 중)` : '';
    return `${r.enabled ? `다음 ${r.nextRun ? this.fmt(r.nextRun) : '-'}` : '꺼짐'}${skipped} · 결과 받을 곳 ${this.where(r.reply)}`;
  }

  list(agent: AgentRow, id?: string): string {
    if (id !== undefined) {
      const r = this.own(agent, id, '볼');
      return `${r.id} · ${this.label(r)} (${r.spec}) · ${this.state(r)}\n할 일:\n${r.prompt}`;
    }
    const rows = this.store.listSchedules(agent.id);
    if (rows.length === 0) return '예약이 없습니다.';
    return rows
      .map((r) => {
        const prompt = r.prompt.length > LIST_PROMPT_CHARS ? `${r.prompt.slice(0, LIST_PROMPT_CHARS)}…(전체 ${r.prompt.length.toLocaleString()}자)` : r.prompt;
        return `- ${r.id} · ${this.label(r)} · ${this.state(r)} · ${prompt}`;
      })
      .join('\n');
  }

  /** schedule_update 도구: 적은 항목만 바꿉니다. 켜거나 규칙을 바꾸면 지금부터 다음 시각을 다시 셉니다. */
  update(agent: AgentRow, id: string, change: ScheduleChange): string {
    const row = this.own(agent, id, '고칠');
    if (change.spec === undefined && change.prompt === undefined && change.enabled === undefined && change.reply === undefined) {
      throw new ValidationError('schedule_no_change', '바꿀 항목(spec · prompt · enabled · report_to)을 하나 이상 적으세요.');
    }
    let spec = parseSpec(row.spec);
    if (change.spec !== undefined) {
      spec = parseSpec(change.spec);
      if (typeof spec === 'string') throw new ValidationError('schedule_spec', spec);
    }
    const specText = change.spec !== undefined ? normSpec(change.spec) : row.spec;
    const prompt = change.prompt !== undefined ? change.prompt.trim() : row.prompt;
    if (prompt === '') throw new ValidationError('schedule_prompt', '예약해서 할 일(prompt)이 비어 있습니다.');
    const enabled = change.enabled ?? row.enabled;
    if (enabled && typeof spec === 'string') throw new ValidationError('schedule_spec', `저장된 규칙 '${row.spec}'이(가) 잘못되어 켤 수 없습니다 (${spec}). spec 을 함께 고치세요.`);
    const reply = change.reply === undefined ? row.reply : change.reply;

    const changed = [
      ...(specText !== row.spec ? ['규칙'] : []),
      ...(prompt !== row.prompt ? ['할 일'] : []),
      ...(!sameReportTarget(reply, row.reply) ? ['결과 받을 곳'] : []),
      ...(enabled !== row.enabled ? [enabled ? '켬' : '끔'] : []),
    ];
    if (changed.length === 0) return `예약 ${id} 는 이미 그대로라 바꾼 것이 없습니다: ${this.label(row)} · ${this.state(row)}`;

    // 끄면 다음 실행이 없고, 켜거나 규칙을 바꾸면 지금부터 다시 셉니다. 할 일 · 결과 받을 곳만 바꾸면 다음 시각은 그대로입니다.
    const restart = enabled && (specText !== row.spec || !row.enabled || row.nextRun === null);
    const next = !enabled ? null : restart ? nextRun(spec as ScheduleSpec, Date.now(), this.tz()) : row.nextRun;
    const updated = this.store.updateSchedule(id, { spec: specText, prompt, reply, enabled, nextRun: next });
    const label = this.label(updated);
    this.bus.activity({
      type: 'schedule.updated',
      category: 'agent',
      tone: 'agent',
      who: agent.name,
      text: `예약 고침 · ${label} · ${changed.join(', ')}${updated.enabled && updated.nextRun ? ` · 다음 ${this.fmt(updated.nextRun)}` : updated.enabled ? '' : ' · 꺼짐'}`,
      agentId: agent.id,
      data: { scheduleId: id },
    });
    this.bus.emit({ type: 'graph.changed' });
    const now = updated.enabled ? `다음 실행 ${updated.nextRun ? this.fmt(updated.nextRun) : '-'} (${this.tz()})` : '꺼짐 (지우지 않았으니 enabled=true 로 다시 켤 수 있습니다)';
    return `예약 ${id} 를 고쳤습니다 (${changed.join(' · ')}): ${label} · ${now} · 결과 받을 곳 ${this.where(updated.reply)}`;
  }

  cancel(agent: AgentRow, id: string): string {
    this.own(agent, id, '지울');
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
