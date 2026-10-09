import type { AgentView, DelegationSettings, HeartbeatSettings, ModuleView, ReportTarget } from './types';

/* ───────── 위임 ───────── */

export const DEFAULT_DELEGATION: DelegationSettings = { accept: false, send: false, supervisorId: null };

type Delegator = { id: string; name: string; delegation: DelegationSettings };

/**
 * 상위 에이전트로 고를 수 있는 에이전트 (서버 규칙과 같음).
 * 위임 받기를 허용했고, 자기 자신이 아니며, 고르면 상위 관계가 순환하지 않아야 합니다.
 * 순환이 생기는 후보 = 자기 아래(하위의 하위까지)에 있는 에이전트이므로, 아래쪽을 한 번만 훑어 모읍니다 (스택 사용, 에이전트 수에 비례).
 */
export function supervisorChoices<T extends Delegator>(agents: readonly T[], selfId: string | null): T[] {
  const below = new Set<string>();
  if (selfId !== null) {
    const children = new Map<string, string[]>();
    for (const a of agents) {
      const sup = a.delegation.supervisorId;
      if (!sup) continue;
      const list = children.get(sup);
      if (list) list.push(a.id);
      else children.set(sup, [a.id]);
    }
    const stack = [selfId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      for (const c of children.get(id) ?? []) {
        if (below.has(c)) continue;
        below.add(c);
        stack.push(c);
      }
    }
  }
  return agents.filter((a) => a.id !== selfId && a.delegation.accept && !below.has(a.id));
}

/** 이 에이전트를 상위로 둔 에이전트들 (받기를 끌 수 없는 이유) */
export function dependentsOf<T extends Delegator>(agents: readonly T[], id: string): T[] {
  return agents.filter((a) => a.id !== id && a.delegation.supervisorId === id);
}

/** 화면 검사 (서버 규칙과 같음). 문제가 없으면 null. */
export function delegationProblem<T extends Delegator>(d: DelegationSettings, agents: readonly T[], selfId: string | null): string | null {
  if (selfId !== null && !d.accept) {
    const deps = dependentsOf(agents, selfId);
    if (deps.length > 0) return `${deps.map((a) => `'${a.name}'`).join(', ')}의 상위 에이전트라서 위임 받기를 끌 수 없습니다.`;
  }
  if (d.supervisorId === null) return null;
  if (!d.send) return '상위 에이전트에게 일을 넘기려면 위임 요청 보내기를 허용해야 합니다.';
  if (!supervisorChoices(agents, selfId).some((a) => a.id === d.supervisorId)) {
    const sup = agents.find((a) => a.id === d.supervisorId);
    if (!sup) return '고른 상위 에이전트가 없습니다. 삭제되었는지 확인하세요.';
    if (!sup.delegation.accept) return `'${sup.name}'은(는) 위임 받기가 꺼져 있어 상위 에이전트로 정할 수 없습니다.`;
    return `'${sup.name}'을(를) 상위로 두면 상위 관계가 순환합니다.`;
  }
  return null;
}

export function delegationChips(d: DelegationSettings, agents: readonly { id: string; name: string }[]): string[] {
  const out = [`받기 ${d.accept ? '허용' : '미허용'}`, `보내기 ${d.send ? '허용' : '미허용'}`];
  if (d.supervisorId) out.push(`상위 ${agents.find((a) => a.id === d.supervisorId)?.name ?? '삭제됨'}`);
  return out;
}

/* ───────── 하트비트 ───────── */

export interface HeartbeatLimits {
  minMinutes: number;
  maxMinutes: number;
  checklistMax: number;
}

/** 화면에서 고치는 하트비트 · 보고 설정 */
export interface HeartbeatForm {
  enabled: boolean;
  everyMinutes: number;
  allDay: boolean;
  start: string;
  end: string;
  checklist: string;
  /** '' 이면 보고를 화면에만 남깁니다 */
  reportModule: string;
  reportTarget: string;
}

const PRESET_MINUTES = [5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function heartbeatFormOf(agent: Pick<AgentView, 'heartbeat' | 'report'>, limits: HeartbeatLimits): HeartbeatForm {
  const hb = agent.heartbeat;
  const [start, end] = hb?.activeHours ? hb.activeHours.split('-') : ['09:00', '18:00'];
  return {
    enabled: hb?.enabled ?? false,
    everyMinutes: hb?.everyMinutes ?? Math.max(limits.minMinutes, 30),
    allDay: !hb?.activeHours,
    start: start ?? '09:00',
    end: end ?? '18:00',
    checklist: hb?.checklist ?? '',
    reportModule: agent.report?.moduleId ?? '',
    reportTarget: agent.report?.target ?? '',
  };
}

/** 간격 선택지: 자주 쓰는 값 중 범위 안의 것 + 최솟값 + 지금 값 (에이전트가 45분처럼 정해 두었을 수 있음) */
export function intervalChoices(limits: HeartbeatLimits, current: number): number[] {
  const set = new Set(PRESET_MINUTES.filter((m) => m >= limits.minMinutes && m <= limits.maxMinutes));
  if (limits.minMinutes <= limits.maxMinutes) set.add(limits.minMinutes);
  if (Number.isInteger(current) && current >= limits.minMinutes && current <= limits.maxMinutes) set.add(current);
  return [...set].sort((a, b) => a - b);
}

export function intervalLabel(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) return minutes === 1440 ? '하루' : `${minutes / 1440}일`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}분`;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

/** 저장 전 검사 (서버 규칙과 같음). 문제가 없으면 null. */
export function heartbeatFormProblem(f: HeartbeatForm, limits: HeartbeatLimits, modules: readonly Pick<ModuleView, 'id' | 'name' | 'canSend'>[]): string | null {
  if (!Number.isInteger(f.everyMinutes) || f.everyMinutes < limits.minMinutes || f.everyMinutes > limits.maxMinutes) {
    return `확인 간격은 ${intervalLabel(limits.minMinutes)} 이상 ${intervalLabel(limits.maxMinutes)} 이하여야 합니다.`;
  }
  if (!f.allDay) {
    if (!HHMM.test(f.start) || !HHMM.test(f.end)) return '활동 시간은 00:00~23:59 사이로 정하세요.';
    if (f.start === f.end) return '활동 시간의 시작과 끝이 같습니다.';
  }
  const checklist = f.checklist.trim();
  if (checklist.length > limits.checklistMax) return `점검 · 알릴 조건은 ${limits.checklistMax.toLocaleString()}자까지 쓸 수 있습니다. 지금 ${checklist.length.toLocaleString()}자입니다.`;
  if (f.enabled && checklist === '') return '하트비트를 켜려면 점검 · 알릴 조건을 적으세요.';
  if (f.reportModule !== '') {
    const m = modules.find((x) => x.id === f.reportModule);
    if (!m) return '보고 채널 모듈이 없습니다. 지워졌는지 확인하세요.';
    if (!m.canSend) return `'${m.name}'은(는) 메시지를 보낼 수 없는 모듈입니다.`;
    const target = f.reportTarget.trim();
    if (target === '') return `'${m.name}'에서 보고를 받을 대상(채널 이름이나 대화 id)을 적으세요.`;
    if (target.length > 200) return `보고 대상은 200자까지 쓸 수 있습니다. 지금 ${target.length}자입니다.`;
  }
  return null;
}

export function heartbeatPayload(f: HeartbeatForm): { heartbeat: HeartbeatSettings; report: ReportTarget | null } {
  return {
    heartbeat: { enabled: f.enabled, everyMinutes: f.everyMinutes, activeHours: f.allDay ? null : `${f.start}-${f.end}`, checklist: f.checklist.trim() },
    report: f.reportModule === '' ? null : { moduleId: f.reportModule, target: f.reportTarget.trim() },
  };
}

/** 저장된 설정과 화면 값이 같은지 (저장 버튼 상태) */
export function sameHeartbeat(a: HeartbeatForm, b: HeartbeatForm): boolean {
  const pa = heartbeatPayload(a);
  const pb = heartbeatPayload(b);
  return JSON.stringify(pa) === JSON.stringify(pb);
}
