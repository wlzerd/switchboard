import type { AgentView, ProjectOrigin, ProjectView } from './types';

export interface ProjectFilter {
  agent: string | 'all';
  origin: ProjectOrigin | 'all';
  query: string;
}

const ORIGIN_LABEL: Record<ProjectOrigin, string> = { instruction: '사용자 지시', self: '스스로', delegation: '위임', manual: '직접 등록' };
const ORIGIN_CHIP: Record<ProjectOrigin, string> = { instruction: 'msg', self: 'ok', delegation: 'skill', manual: '' };

export function originLabel(o: ProjectOrigin): string {
  return ORIGIN_LABEL[o];
}

/** 에이전트 · 등록 계기 · 검색어(이름 · 경로 · 메모, 대소문자 무시)로 거릅니다. 순서는 그대로 둡니다. */
export function projectsBy(list: readonly ProjectView[], f: ProjectFilter): ProjectView[] {
  const q = f.query.trim().toLowerCase();
  return list.filter((p) => {
    if (f.agent !== 'all' && p.agentId !== f.agent) return false;
    if (f.origin !== 'all' && p.origin !== f.origin) return false;
    if (q === '') return true;
    return [p.name, p.path, p.displayPath, p.note].some((s) => s.toLowerCase().includes(q));
  });
}

/**
 * 목록 한 줄의 모양.
 * 점검 칩: 하트비트 점검에 넣었고 에이전트 하트비트가 켜져 있으며 접근할 수 있을 때만 '점검 N분'(켜짐),
 * 하트비트가 꺼져 있으면 '하트비트 꺼짐', 경로 문제로 볼 수 없으면 '점검 멈춤'.
 */
export function projectRowView(p: ProjectView, agent: Pick<AgentView, 'heartbeat'> | undefined): { tile: 'git' | 'folder' | 'missing'; originChip: string; originText: string; watchOn: boolean; watchText: string } {
  const hb = agent?.heartbeat?.enabled ? agent.heartbeat : null;
  const watchOn = p.watch && hb !== null && p.status === 'ok';
  const watchText = !p.watch ? '' : p.status !== 'ok' ? '점검 멈춤' : hb ? `점검 ${hb.everyMinutes}분` : '하트비트 꺼짐';
  return {
    tile: p.status === 'missing' ? 'missing' : p.isGit ? 'git' : 'folder',
    originChip: ORIGIN_CHIP[p.origin],
    originText: ORIGIN_LABEL[p.origin],
    watchOn,
    watchText,
  };
}
