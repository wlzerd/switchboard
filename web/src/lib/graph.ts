import type { Overview } from './types';

export type NodeKind = 'module' | 'agent' | 'skill' | 'builtin';

export interface LayoutNode {
  id: string;
  kind: NodeKind;
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  kind: 'message' | 'skill' | 'new' | 'creating';
}

export const COLUMN = {
  module: { x: 0, width: 200, height: 64, gap: 22 },
  agent: { x: 330, width: 244, height: 128, gap: 26 },
  skill: { x: 690, width: 200, height: 54, gap: 14 },
} as const;

function stack(count: number, height: number, gap: number, top: number): number[] {
  const ys: number[] = [];
  for (let i = 0; i < count; i += 1) ys.push(top + i * (height + gap));
  return ys;
}

function columnHeight(count: number, height: number, gap: number): number {
  return count === 0 ? 0 : count * height + (count - 1) * gap;
}

/**
 * 모듈(왼쪽) · 에이전트(가운데) · 스킬(오른쪽) 세 줄로 놓습니다. 각 줄은 가장 긴 줄 기준으로 세로 가운데 정렬합니다.
 * 사용자가 끌어 옮긴 위치(saved)가 있으면 그 위치를 씁니다.
 */
export function layoutGraph(o: Overview, saved: Record<string, { x: number; y: number }> = {}): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const modules = o.modules.filter((m) => m.status !== 'rejected');
  const agentIds = new Set(o.agents.map((a) => a.id));
  const usedBuiltins = new Set(o.edges.filter((e) => e.to.startsWith('builtin:') && agentIds.has(e.from)).map((e) => e.to));
  const builtins = o.builtinNodes.filter((b) => usedBuiltins.has(b.id));
  const skillCount = o.skills.length + builtins.length;

  const hM = columnHeight(modules.length, COLUMN.module.height, COLUMN.module.gap);
  const hA = columnHeight(o.agents.length, COLUMN.agent.height, COLUMN.agent.gap);
  const hS = columnHeight(skillCount, COLUMN.skill.height, COLUMN.skill.gap);
  const tall = Math.max(hM, hA, hS);

  const nodes: LayoutNode[] = [];
  const place = (id: string, kind: NodeKind, ref: string, col: (typeof COLUMN)[keyof typeof COLUMN], y: number): void => {
    const s = saved[id];
    nodes.push({ id, kind, ref, x: s?.x ?? col.x, y: s?.y ?? y, width: col.width, height: col.height });
  };

  stack(modules.length, COLUMN.module.height, COLUMN.module.gap, (tall - hM) / 2).forEach((y, i) => {
    const m = modules[i];
    if (m) place(`module:${m.id}`, 'module', m.id, COLUMN.module, y);
  });
  stack(o.agents.length, COLUMN.agent.height, COLUMN.agent.gap, (tall - hA) / 2).forEach((y, i) => {
    const a = o.agents[i];
    if (a) place(a.id, 'agent', a.id, COLUMN.agent, y);
  });
  const skillYs = stack(skillCount, COLUMN.skill.height, COLUMN.skill.gap, (tall - hS) / 2);
  builtins.forEach((b, i) => place(b.id, 'builtin', b.id, COLUMN.skill, skillYs[i] ?? 0));
  o.skills.forEach((s, i) => place(`skill:${s.id}`, 'skill', s.id, COLUMN.skill, skillYs[builtins.length + i] ?? 0));

  const ids = new Set(nodes.map((n) => n.id));
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();
  for (const e of o.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    const id = `${e.from}->${e.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({ id, source: e.from, target: e.to, kind: e.kind });
  }
  return { nodes, edges };
}

/** 선택한 노드와 선으로 바로 이어진 노드들 (선택이 없으면 null = 모두 보통 밝기) */
export function relatedTo(selected: string | null, edges: readonly LayoutEdge[]): Set<string> | null {
  if (!selected) return null;
  const out = new Set<string>([selected]);
  for (const e of edges) {
    if (e.source === selected) out.add(e.target);
    if (e.target === selected) out.add(e.source);
  }
  return out;
}
