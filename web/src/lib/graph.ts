import type { DelegationSettings, EdgeKind, Overview } from './types';

export type NodeKind = 'module' | 'agent' | 'skill' | 'builtin' | 'screen';

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
  kind: EdgeKind;
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
 * 에이전트 줄의 순서: 협조 에이전트 바로 아래에 그 에이전트를 협조 에이전트로 둔 에이전트들이 오게 합니다 (위임 선이 짧아지도록).
 * 스택으로 돌아 깊게 이어져도 재귀하지 않습니다. 서로를 협조 에이전트로 둔 경우(순환)나 없는 에이전트를 가리키면 원래 순서로 둡니다.
 */
export function orderAgents<T extends { id: string; delegation: DelegationSettings }>(agents: readonly T[]): T[] {
  const ids = new Set(agents.map((a) => a.id));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const a of agents) {
    const sup = a.delegation.supervisorId;
    if (sup && sup !== a.id && ids.has(sup)) {
      const list = children.get(sup);
      if (list) list.push(a);
      else children.set(sup, [a]);
    } else {
      roots.push(a);
    }
  }
  const out: T[] = [];
  const seen = new Set<string>();
  const stack: T[] = [...roots].reverse();
  while (stack.length > 0) {
    const a = stack.pop() as T;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
    const kids = children.get(a.id) ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as T);
  }
  for (const a of agents) if (!seen.has(a.id)) out.push(a);
  return out;
}

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * 모듈(왼쪽) · 에이전트(가운데) · 스킬(오른쪽) 세 줄로 놓습니다. 각 줄은 가장 긴 줄 기준으로 세로 가운데 정렬합니다.
 * 사용자가 끌어 옮긴 위치(saved)가 있으면 그 위치를 씁니다.
 */
export function layoutGraph(o: Overview, saved: Record<string, { x: number; y: number }> = {}): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
  const agentIds = new Set(o.agents.map((a) => a.id));
  // 화면 제어 모듈은 에이전트가 쓰는 도구라 오른쪽 줄에 둡니다. 켜져 있거나 연결된 것만 보입니다.
  const linked = new Set(o.edges.filter((e) => agentIds.has(e.from)).map((e) => e.to));
  const modules = o.modules.filter((m) => m.status !== 'rejected' && !m.computer);
  const screens = o.modules.filter((m) => m.status !== 'rejected' && m.computer && (m.enabled || linked.has(`module:${m.id}`)));
  const usedBuiltins = new Set(o.edges.filter((e) => e.to.startsWith('builtin:') && agentIds.has(e.from)).map((e) => e.to));
  const builtins = o.builtinNodes.filter((b) => usedBuiltins.has(b.id));
  const skillCount = screens.length + o.skills.length + builtins.length;

  const hM = columnHeight(modules.length, COLUMN.module.height, COLUMN.module.gap);
  const agents = orderAgents(o.agents);
  const hA = columnHeight(agents.length, COLUMN.agent.height, COLUMN.agent.gap);
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
  stack(agents.length, COLUMN.agent.height, COLUMN.agent.gap, (tall - hA) / 2).forEach((y, i) => {
    const a = agents[i];
    if (a) place(a.id, 'agent', a.id, COLUMN.agent, y);
  });
  const skillYs = stack(skillCount, COLUMN.skill.height, COLUMN.skill.gap, (tall - hS) / 2);
  screens.forEach((m, i) => place(`module:${m.id}`, 'screen', m.id, COLUMN.skill, skillYs[i] ?? 0));
  builtins.forEach((b, i) => place(b.id, 'builtin', b.id, COLUMN.skill, skillYs[screens.length + i] ?? 0));
  o.skills.forEach((s, i) => place(`skill:${s.id}`, 'skill', s.id, COLUMN.skill, skillYs[screens.length + builtins.length + i] ?? 0));

  const ids = new Set(nodes.map((n) => n.id));
  const edges: LayoutEdge[] = [];
  const seen = new Set<string>();
  // 지금 위임이 오가는 두 에이전트 사이에는 협조 관계 점선 대신 움직이는 선 하나만 그립니다.
  // 서로를 협조 에이전트로 둔 두 에이전트 사이의 점선도 하나만 그립니다.
  const active = new Set(o.edges.filter((e) => e.kind === 'delegating').map((e) => pairKey(e.from, e.to)));
  for (const e of o.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    if (e.kind === 'delegate' && active.has(pairKey(e.from, e.to))) continue;
    const id = `${e.from}->${e.to}`;
    const dedupe = e.kind === 'delegate' ? `delegate:${pairKey(e.from, e.to)}` : id;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
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

/**
 * 같은 줄에 쌓인 에이전트끼리 잇는 위임 선: 카드 오른쪽으로 둥글게 돌아 나가 사이에 있는 카드에 가려지지 않게 합니다.
 * 멀리 떨어진 사이일수록 더 크게 돌되, 스킬 줄을 덮지 않도록 120px 에서 멈춥니다.
 */
export const ARC_BOW_MIN = 36;
export const ARC_BOW_MAX = 120;

export function arcBow(dy: number): number {
  return Math.min(ARC_BOW_MAX, ARC_BOW_MIN + Math.abs(dy) * 0.22);
}

export function arcPath(sx: number, sy: number, tx: number, ty: number): string {
  const bow = arcBow(ty - sy);
  return `M${sx},${sy} C${sx + bow},${sy} ${tx + bow},${ty} ${tx},${ty}`;
}
