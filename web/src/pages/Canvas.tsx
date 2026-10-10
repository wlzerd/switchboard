import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  getBezierPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { Icon } from '../components/Icon';
import { shortModel } from '../components/Shell';
import { Avatar, ModuleIcon, Seg, StatusLine, Steps } from '../components/ui';
import { api, errorText } from '../lib/api';
import { delegationChips, intervalLabel } from '../lib/autonomy';
import { MODE_LABEL } from '../lib/folders';
import { clock, compactTokens, percent, relTime } from '../lib/format';
import { tokenLimitText } from '../lib/limits';
import { arcPath, layoutGraph, relatedTo, type LayoutEdge } from '../lib/graph';
import { navigate } from '../lib/router';
import { toast, useApp } from '../lib/store';
import type { ActivityItem, AgentView, ModuleView, Overview } from '../lib/types';

type XY = { x: number; y: number };
type Dim = { width: number; height: number };

const POS_KEY = 'sb.graph.positions';

function loadPositions(): Record<string, XY> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(POS_KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, XY>) : {};
  } catch {
    return {};
  }
}

function savePositions(p: Record<string, XY>): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(p));
  } catch {
    // 저장소를 쓸 수 없는 브라우저(사생활 보호 모드 등)에서는 위치 기억만 빠집니다.
  }
}

function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return undefined;
    const mq = matchMedia(query);
    const on = (): void => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

/* ───────── 노드 ───────── */

type AgentData = { agent: AgentView; selected: boolean; dim: boolean; delay: number; dlg: boolean };
type ModuleData = { module: ModuleView; dim: boolean; delay: number };
type SkillData = { skill: ModuleView | null; label: string; icon: string; dim: boolean; delay: number };
type ScreenData = { module: ModuleView; dim: boolean; delay: number };

/**
 * 연결점(Handle)은 떠오르며 나타나는 카드(.gnode) 밖에 둡니다. 카드 안에 두면 React Flow 가 애니메이션 도중(아래로 10px)의
 * 위치를 재어 선 끝이 연결점보다 아래에 붙습니다. 연결점은 카드와 같은 투명도로, 움직임 없이 나타나게만 합니다.
 */
function handleStyle(opacity: number, delay: number): { opacity: number; animationDelay: string } {
  return { opacity, animationDelay: `${delay}s` };
}

function progressOf(a: AgentView): { pct: number | null; done: number; total: number } {
  const steps = a.task?.steps ?? [];
  const total = steps.length;
  const done = steps.filter((s) => s.state === 'done').length;
  return { pct: total > 1 ? Math.round((done / total) * 100) : null, done, total };
}

function AgentNode({ data }: NodeProps<Node<AgentData, 'agent'>>) {
  const a = data.agent;
  const status = a.paused ? 'paused' : a.status;
  const p = progressOf(a);
  const busy = status === 'working' || status === 'waiting';
  const bar = status === 'working' ? (p.pct === null ? ' indet' : ' shimmer') : status === 'waiting' ? ' warn' : '';
  const width = status === 'working' ? (p.pct === null ? undefined : `${p.pct}%`) : status === 'waiting' ? `${p.pct ?? 100}%` : '0%';
  const handle = handleStyle(data.dim ? 0.45 : 1, data.delay);
  return (
    <>
      <Handle type="target" position={Position.Left} className="gh" style={handle} isConnectable={false} />
      <div className={`gnode gnode-agent${data.selected ? ' selected' : ''}`} style={{ width: 244, height: 128, opacity: handle.opacity, animationDelay: `${data.delay}s` }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <Avatar name={a.name} color={a.color} size={28} />
          <span className="title" style={{ fontSize: 15, fontWeight: 700 }}>
            {a.name}
          </span>
          {a.heartbeat?.enabled ? (
            <span className="hb-mark" title={`하트비트 · ${intervalLabel(a.heartbeat.everyMinutes)}마다`}>
              <Icon name="pulse" size={13} stroke={2.2} />
            </span>
          ) : null}
          <span className="model-chip">{shortModel(a.model, a.modelName)}</span>
        </span>
        <StatusLine status={status} detail={busy && p.total > 1 ? `${p.done}/${p.total} 단계` : a.queued > 0 ? `대기열 ${a.queued}` : null} />
        <span className="sub" style={{ fontSize: 12.5, color: 'var(--text2)' }}>
          {a.task && busy ? a.task.title : a.task ? `최근: ${a.task.title}` : '작업 없음'}
        </span>
        <span className={`progress${bar}`}>
          <span style={{ width }} />
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="gh skill" style={handle} isConnectable={false} />
      {/* 위임 선(에이전트 ↔ 에이전트)은 오른쪽 위에서 나가고 들어옵니다. 기본 선과 겹치지 않게 아래에 둡니다. */}
      <Handle type="source" id="dlg-out" position={Position.Right} className="gh dlg" style={{ ...handle, top: 22, opacity: data.dlg ? handle.opacity : 0 }} isConnectable={false} />
      <Handle type="target" id="dlg-in" position={Position.Right} className="gh dlg" style={{ ...handle, top: 22, opacity: data.dlg ? handle.opacity : 0 }} isConnectable={false} />
    </>
  );
}

function moduleSub(m: ModuleView): string {
  if (m.status === 'pending') return '설치 승인 대기';
  if (m.status === 'failed') return '시작 실패';
  if (m.status === 'crashed') return '다시 시작 중';
  if (!m.enabled) return '꺼짐';
  if (m.origin === 'builtin') return m.status === 'running' ? '기본 · 연결됨' : '기본';
  if (m.createdByName) return `${m.createdByName} 제작`;
  if (m.origin === 'git') return 'Git 설치';
  if (m.origin === 'zip') return '파일 설치';
  return '템플릿';
}

function ModuleNode({ data }: NodeProps<Node<ModuleData, 'module'>>) {
  const m = data.module;
  const failed = m.status === 'failed' || m.status === 'crashed';
  const tone = m.origin === 'agent' ? 'accent' : m.channel ? 'msg' : 'text2';
  const handle = handleStyle(data.dim ? 0.38 : m.enabled || m.status === 'pending' ? 1 : 0.6, data.delay);
  return (
    <>
      <div
        className={`gnode${m.status === 'pending' ? ' creating' : ''}${failed ? ' failed' : ''}`}
        style={{ width: 200, height: 64, opacity: handle.opacity, animationDelay: `${data.delay}s` }}
        title={m.statusDetail ?? undefined}
      >
        <span className="tile" style={{ width: 32, height: 32, background: tone === 'text2' ? 'var(--raised)' : `var(--${tone}-dim)`, color: `var(--${tone})` }}>
          <ModuleIcon icon={m.icon} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
          <span className="title">{m.name}</span>
          <span className="sub" style={{ color: failed ? 'var(--danger)' : m.status === 'pending' ? 'var(--warn)' : undefined }}>
            {moduleSub(m)}
          </span>
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="gh" style={handle} isConnectable={false} />
    </>
  );
}

function SkillNode({ data }: NodeProps<Node<SkillData, 'skill'>>) {
  const s = data.skill;
  const isNew = s?.isNew ?? false;
  const handle = handleStyle(data.dim ? 0.38 : 1, data.delay);
  return (
    <>
      <Handle type="target" position={Position.Left} className={`gh ${isNew ? 'new' : 'skill'}`} style={handle} isConnectable={false} />
      <div className={`gnode${isNew ? ' new' : ''}`} style={{ position: 'relative', width: 200, height: 54, opacity: handle.opacity, animationDelay: `${data.delay}s` }}>
        <span className="tile" style={{ width: 26, height: 26, borderRadius: 7, background: isNew ? 'var(--accent-dim)' : 'var(--skill-dim)', color: isNew ? 'var(--accent)' : 'var(--skill)' }}>
          <Icon name={data.icon} size={15} stroke={1.9} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.25 }}>
          <span className="title" style={s ? { fontFamily: 'var(--mono)', fontSize: 12.5 } : undefined}>
            {data.label}
          </span>
          <span className="sub" style={{ color: isNew ? 'var(--accent)' : undefined }}>
            {s ? `${s.createdByName ? `${s.createdByName} 제작 · ` : ''}${relTime(s.installedAt)}` : '내장 도구'}
          </span>
        </span>
        {isNew ? <span className="badge-new">NEW</span> : null}
      </div>
    </>
  );
}

/** 화면 제어 모듈: 지금 화면을 쓰는 에이전트가 있으면 이름과 함께 살아 있는 점을 보여 줍니다. */
function ScreenNode({ data }: NodeProps<Node<ScreenData, 'screen'>>) {
  const m = data.module;
  const holder = m.screenHolder;
  const failed = m.status === 'failed' || m.status === 'crashed';
  const sub = holder ? `${holder.agentName} 사용 중` : !m.enabled ? '꺼짐' : failed ? '시작 실패' : m.status === 'running' ? '준비됨' : '대기';
  const handle = handleStyle(data.dim ? 0.38 : m.enabled ? 1 : 0.6, data.delay);
  return (
    <>
      <Handle type="target" position={Position.Left} className="gh skill" style={handle} isConnectable={false} />
      <div className={`gnode${failed ? ' failed' : ''}`} style={{ position: 'relative', width: 200, height: 54, opacity: handle.opacity, animationDelay: `${data.delay}s` }} title={m.statusDetail ?? undefined}>
        <span className="tile" style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--skill-dim)', color: 'var(--skill)' }}>
          <Icon name="screen" size={15} stroke={1.9} />
        </span>
        <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.25 }}>
          <span className="title">{m.name}</span>
          <span className="sub" style={{ color: failed ? 'var(--danger)' : holder ? 'var(--skill)' : undefined }}>
            {sub}
          </span>
        </span>
        {holder ? <span className="status-dot working" style={{ marginLeft: 'auto', flex: 'none' }} /> : null}
      </div>
    </>
  );
}

const BUILTIN_ICON: Record<string, string> = { 'builtin:web': 'globe', 'builtin:http': 'link', 'builtin:shell': 'terminal', 'builtin:fs': 'folder' };

/* ───────── 선 ───────── */

type FlowData = { kind: LayoutEdge['kind']; flow: 'forward' | 'reverse' | null; particle: boolean; dim: boolean; flipped: boolean; builtin: boolean };

function DelegationEdge({ path, kind, flow, particle, dim }: { path: string; kind: 'delegate' | 'delegating'; flow: FlowData['flow']; particle: boolean; dim: boolean }) {
  const color = 'var(--text2)';
  // 진행 중인 위임은 늘 흐르고, 결과가 돌아올 때(반대 방향 펄스)는 거꾸로 흐릅니다.
  const dir = kind === 'delegating' ? (flow === 'reverse' ? 'reverse' : 'forward') : flow;
  return (
    <g style={{ opacity: dim ? 0.14 : 1, transition: 'opacity .3s ease' }}>
      <path d={path} className="edge-base" style={{ stroke: color, strokeWidth: 1.6, strokeOpacity: kind === 'delegate' ? 0.5 : 0.3, strokeDasharray: kind === 'delegate' ? '4 5' : undefined }} />
      {dir ? <path d={path} className="edge-flow" style={{ stroke: color, strokeWidth: 2, animationDirection: dir === 'reverse' ? 'reverse' : 'normal' }} /> : null}
      {dir && particle ? (
        <circle r={3.5} style={{ fill: color, filter: `drop-shadow(0 0 5px ${color})` }}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} keyPoints={dir === 'reverse' ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" />
        </circle>
      ) : null}
    </g>
  );
}

function FlowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<FlowData, 'flow'>>) {
  const kind = data?.kind ?? 'skill';
  const flow = data?.flow ?? null;
  if (kind === 'delegate' || kind === 'delegating') {
    return <DelegationEdge path={arcPath(sourceX, sourceY, targetX, targetY)} kind={kind} flow={flow} particle={data?.particle ?? false} dim={data?.dim ?? false} />;
  }
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const color = kind === 'message' ? 'var(--msg)' : kind === 'skill' ? 'var(--skill)' : 'var(--accent)';
  // 내장 도구로 가는 선은 에이전트마다 여러 개라 흐리게 두고, 쓰는 순간(flow)에만 또렷하게 그립니다.
  const baseOpacity = kind === 'new' ? 1 : kind === 'creating' ? 0 : flow ? 0.3 : data?.builtin ? 0.16 : 0.45;
  return (
    <g style={{ opacity: data?.dim ? 0.14 : 1, transition: 'opacity .3s ease' }}>
      <path
        d={path}
        className={`edge-base${kind === 'new' ? ' edge-draw' : ''}`}
        style={{ stroke: color, strokeWidth: kind === 'new' || flow ? 2 : 1.6, strokeOpacity: baseOpacity, filter: kind === 'new' ? 'drop-shadow(0 0 4px var(--accent-glow))' : undefined }}
      />
      {flow ? <path d={path} className="edge-flow" style={{ stroke: color, strokeWidth: 2, animationDirection: flow === 'reverse' ? 'reverse' : 'normal' }} /> : null}
      {kind === 'creating' ? <path d={path} className="edge-creating" style={{ stroke: color, strokeWidth: 1.8, strokeOpacity: 0.75, animationDirection: data?.flipped ? 'reverse' : 'normal' }} /> : null}
      {flow && data?.particle ? (
        <circle r={3.5} style={{ fill: color, filter: `drop-shadow(0 0 5px ${color})` }}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} keyPoints={flow === 'reverse' ? '1;0' : '0;1'} keyTimes="0;1" calcMode="linear" />
        </circle>
      ) : null}
    </g>
  );
}

function LabelNode({ data }: NodeProps<Node<{ text: string }, 'label'>>) {
  return <div className="col-label">{data.text}</div>;
}

const nodeTypes = { agent: AgentNode, module: ModuleNode, skill: SkillNode, screen: ScreenNode, label: LabelNode };
const edgeTypes = { flow: FlowEdge };

/* ───────── 그래프 ───────── */

function ZoomControls({ onReset }: { onReset: () => void }) {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  return (
    <div className="zoom-ctl">
      <button type="button" aria-label="축소" title="축소" onClick={() => void rf.zoomOut({ duration: 200 })}>
        <Icon name="minus" size={16} stroke={2} />
      </button>
      <span className="mono" style={{ minWidth: 46, textAlign: 'center', fontSize: 12, color: 'var(--text2)' }}>
        {Math.round(zoom * 100)}%
      </span>
      <button type="button" aria-label="확대" title="확대" onClick={() => void rf.zoomIn({ duration: 200 })}>
        <Icon name="plus" size={16} stroke={2} />
      </button>
      <span style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 2px' }} />
      <button type="button" aria-label="화면에 맞춤" title="화면에 맞춤" onClick={() => void rf.fitView({ padding: 0.15, duration: 300 })}>
        <Icon name="fit" size={16} stroke={2} />
      </button>
      <button
        type="button"
        aria-label="배치 되돌리기"
        title="배치 되돌리기"
        onClick={() => {
          onReset();
          setTimeout(() => void rf.fitView({ padding: 0.15, duration: 300 }), 50);
        }}
      >
        <Icon name="refresh" size={15} stroke={2} />
      </button>
    </div>
  );
}

function Graph({ overview, selected, onSelect }: { overview: Overview; selected: string | null; onSelect: (id: string | null) => void }) {
  const pulses = useApp((s) => s.pulses);
  const motion = useApp((s) => s.theme?.motion ?? s.meta?.themes.default.motion ?? 2);
  const reduced = usePrefersReducedMotion();
  const particle = motion === 2 && !reduced;
  const [positions, setPositions] = useState<Record<string, XY>>(loadPositions);
  const [measured, setMeasured] = useState<Record<string, Dim>>({});

  // 끌어 옮기는 동안은 매 프레임 바뀌므로, 멈춘 뒤 한 번만 저장합니다.
  useEffect(() => {
    const t = setTimeout(() => savePositions(positions), 300);
    return () => clearTimeout(t);
  }, [positions]);

  const layout = useMemo(() => layoutGraph(overview, positions), [overview, positions]);
  const related = useMemo(() => relatedTo(selected, layout.edges), [selected, layout.edges]);
  const delegating = useMemo(() => {
    const ids = new Set<string>();
    for (const e of layout.edges) {
      if (e.kind !== 'delegate' && e.kind !== 'delegating') continue;
      ids.add(e.source);
      ids.add(e.target);
    }
    return ids;
  }, [layout.edges]);

  const nodes: Node[] = useMemo(
    () =>
      layout.nodes.map((n, i): Node => {
        const dim = related !== null && !related.has(n.id);
        const delay = Math.min(i, 12) * 0.05;
        const base = { id: n.id, position: { x: n.x, y: n.y }, measured: measured[n.id] };
        if (n.kind === 'agent') {
          const agent = overview.agents.find((a) => a.id === n.ref) as AgentView;
          return { ...base, type: 'agent', data: { agent, selected: selected === n.id, dim, delay, dlg: delegating.has(n.id) } satisfies AgentData };
        }
        if (n.kind === 'module') {
          const module = overview.modules.find((m) => m.id === n.ref) as ModuleView;
          return { ...base, type: 'module', data: { module, dim, delay } satisfies ModuleData };
        }
        if (n.kind === 'screen') {
          const module = overview.modules.find((m) => m.id === n.ref) as ModuleView;
          return { ...base, type: 'screen', data: { module, dim, delay } satisfies ScreenData };
        }
        if (n.kind === 'skill') {
          const skill = overview.skills.find((m) => m.id === n.ref) ?? null;
          return { ...base, type: 'skill', data: { skill, label: skill ? (skill.tools[0]?.name ?? skill.name) : n.ref, icon: 'bolt', dim, delay } satisfies SkillData };
        }
        const b = overview.builtinNodes.find((x) => x.id === n.ref);
        return { ...base, type: 'skill', data: { skill: null, label: b?.label ?? n.ref, icon: BUILTIN_ICON[n.ref] ?? 'cube', dim, delay } satisfies SkillData };
      }),
    [layout.nodes, overview, related, selected, measured, delegating],
  );

  // 각 줄 맨 위에 붙는 이름표. 그래프와 함께 움직이고 확대됩니다.
  const labels: Node[] = useMemo(() => {
    const groups: { id: string; text: string; kinds: string[] }[] = [
      { id: 'label:module', text: `모듈 ${layout.nodes.filter((n) => n.kind === 'module').length}`, kinds: ['module'] },
      { id: 'label:agent', text: `에이전트 ${overview.agents.length}`, kinds: ['agent'] },
      {
        id: 'label:skill',
        text: `스킬 ${overview.skills.length} · 내장 도구 ${layout.nodes.filter((n) => n.kind === 'builtin').length}${layout.nodes.some((n) => n.kind === 'screen') ? ` · 화면 ${layout.nodes.filter((n) => n.kind === 'screen').length}` : ''}`,
        kinds: ['skill', 'builtin', 'screen'],
      },
    ];
    const out: Node[] = [];
    for (const g of groups) {
      const members = layout.nodes.filter((n) => g.kinds.includes(n.kind));
      if (members.length === 0) continue;
      const x = Math.min(...members.map((n) => n.x));
      const y = Math.min(...members.map((n) => n.y)) - 30;
      out.push({ id: g.id, type: 'label', position: { x, y }, data: { text: g.text }, draggable: false, selectable: false, focusable: false, measured: measured[g.id] });
    }
    return out;
  }, [layout.nodes, overview.agents.length, overview.skills.length, measured]);
  const allNodes = useMemo(() => [...labels, ...nodes], [labels, nodes]);

  // 상세 패널이 열리고 닫히거나 창 크기가 바뀌어 그래프 영역 폭이 달라지면 다시 화면에 맞춥니다.
  const box = useRef<HTMLDivElement>(null);
  const rf = useReactFlow();
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let width = el.clientWidth;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (Math.abs(el.clientWidth - width) < 2) return;
      width = el.clientWidth;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void rf.fitView({ padding: 0.15, duration: 300 }), 120);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [rf]);

  // 왼쪽 줄 모듈(채널 등). 화면 제어 모듈은 오른쪽 줄이라 뒤집지 않습니다.
  const leftModules = useMemo(() => new Set(layout.nodes.filter((n) => n.kind === 'module').map((n) => n.id)), [layout.nodes]);
  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map((e): Edge => {
        const between = e.kind === 'delegate' || e.kind === 'delegating';
        // 모듈은 왼쪽 줄에 있으므로 모듈로 들어가는 선은 모듈 → 에이전트 방향으로 그립니다.
        const flipped = !between && leftModules.has(e.target);
        const source = flipped ? e.target : e.source;
        const target = flipped ? e.source : e.target;
        const fwd = pulses[`${source}->${target}`] ?? 0;
        const rev = pulses[`${target}->${source}`] ?? 0;
        const flow = fwd === 0 && rev === 0 ? null : fwd >= rev ? 'forward' : 'reverse';
        const dim = selected !== null && e.source !== selected && e.target !== selected;
        const handles = between ? { sourceHandle: 'dlg-out', targetHandle: 'dlg-in' } : {};
        return { id: e.id, source, target, ...handles, type: 'flow', data: { kind: e.kind, flow, particle, dim, flipped, builtin: target.startsWith('builtin:') } satisfies FlowData };
      }),
    [layout.edges, pulses, selected, particle, leftModules],
  );

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const pos: Record<string, XY> = {};
    const dims: Record<string, Dim> = {};
    let movedAny = false;
    let measuredAny = false;
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        pos[c.id] = { x: Math.round(c.position.x), y: Math.round(c.position.y) };
        movedAny = true;
      } else if (c.type === 'dimensions' && c.dimensions) {
        dims[c.id] = c.dimensions;
        measuredAny = true;
      }
    }
    if (movedAny) setPositions((p) => ({ ...p, ...pos }));
    if (measuredAny) setMeasured((m) => ({ ...m, ...dims }));
  }, []);

  return (
    <div className="graph-box" ref={box}>
      <ReactFlow
        nodes={allNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={1.6}
        nodesConnectable={false}
        elementsSelectable={false}
        edgesFocusable={false}
        onNodeClick={(_e, n) => {
          if (n.type !== 'label') onSelect(n.id === selected ? null : n.id);
        }}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--line)" />
        <ZoomControls onReset={() => setPositions({})} />
      </ReactFlow>
      {overview.agents.length === 0 ? (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', zIndex: 6 }}>
          <button type="button" className="btn primary" style={{ pointerEvents: 'auto' }} onClick={() => navigate('/hire')}>
            <Icon name="plus" size={16} stroke={2.4} />첫 에이전트 고용
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ───────── 상세 ───────── */

function Inspector({ agent, overview, onClose }: { agent: AgentView; overview: Overview; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const status = agent.paused ? 'paused' : agent.status;
  const live = agent.task !== null && (agent.task.status === 'running' || agent.task.status === 'waiting' || agent.task.status === 'queued');
  const skills = overview.edges.filter((e) => e.from === agent.id && (e.to.startsWith('skill:') || e.to.startsWith('builtin:')));
  const modules = agent.links.map((l) => overview.modules.find((m) => m.id === l.moduleId)).filter((m): m is ModuleView => m !== undefined && m.kind === 'module');
  const screenInUse = overview.modules.find((m) => m.screenHolder?.agentId === agent.id);
  const creating = overview.edges.filter((e) => e.from === agent.id && e.kind === 'creating');
  const unlimited = agent.tokenLimit === 0;
  const used = percent(agent.tokensToday, agent.tokenLimit);
  const nameOf = (id: string): string => overview.agents.find((a) => a.id === id)?.name ?? '삭제된 에이전트';
  const handing = overview.edges.filter((e) => e.kind === 'delegating' && (e.from === agent.id || e.to === agent.id));
  const hb = agent.heartbeat;

  const togglePause = async (): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/pause`, { body: { paused: !agent.paused } });
      toast(agent.paused ? `${agent.name} 다시 시작` : `${agent.name} 일시정지`, 'ok');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card inspector side" aria-label={`${agent.name} 상세`} key={agent.id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Avatar name={agent.name} color={agent.color} size={40} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>{agent.name}</span>
          <span className="mono muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
            {agent.model}
          </span>
        </div>
        <button type="button" className="icon-btn" style={{ marginLeft: 'auto', width: 32, height: 32, flex: 'none' }} aria-label="닫기" onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <StatusLine status={status} detail={agent.detail} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">{live ? '현재 작업' : '마지막 작업'}</span>
        {agent.task ? (
          <>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{agent.task.title}</span>
            {agent.task.error ? (
              <span className="err" style={{ animation: 'none' }}>
                {agent.task.error}
              </span>
            ) : null}
            <Steps steps={agent.task.steps} />
          </>
        ) : (
          <span className="muted">아직 작업이 없습니다</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">스킬</span>
        <div className="chips">
          {skills.length === 0 && creating.length === 0 ? <span className="muted">없음</span> : null}
          {skills.map((e) => {
            const s = overview.skills.find((x) => `skill:${x.id}` === e.to);
            const b = overview.builtinNodes.find((x) => x.id === e.to);
            return (
              <span key={e.to} className={`chip ${s ? 'mono ' : ''}${e.kind === 'new' ? 'new' : 'skill'}`}>
                {s ? (s.tools[0]?.name ?? s.name) : (b?.label ?? e.to)}
              </span>
            );
          })}
          {creating.map((e) => {
            const m = overview.modules.find((x) => `module:${x.id}` === e.to);
            return (
              <span key={e.to} className="chip warn">
                <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} />
                {m?.name ?? e.to} 승인 대기
              </span>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">연결 모듈</span>
        <div className="chips">
          {modules.length === 0 ? <span className="muted">없음</span> : null}
          {modules.map((m) => (
            <span key={m.id} className={`chip ${m.computer ? 'skill' : 'msg'}`}>
              {m.computer ? <Icon name="screen" size={11} stroke={2.2} /> : null}
              {m.name}
              {screenInUse?.id === m.id ? ' · 사용 중' : ''}
            </span>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">위임</span>
        <div className="chips">
          {delegationChips(agent.delegation, overview.agents).map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
          {handing.map((e) => (
            <span key={`${e.from}->${e.to}`} className="chip new">
              <Icon name="forward" size={11} stroke={2.4} />
              {e.from === agent.id ? `${nameOf(e.to)}에게 맡김` : `${nameOf(e.from)}의 일 처리 중`}
            </span>
          ))}
        </div>
      </div>
      {agent.projects.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="section-label">프로젝트 {agent.projectCount}</span>
            <button type="button" className="link-btn" style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none' }} onClick={() => navigate('/projects')}>
              모두 보기
            </button>
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {agent.projects.slice(0, 5).map((p) => (
              <button key={p.id} type="button" className="insp-proj" onClick={() => navigate(`/projects/${p.id}`)}>
                <span className={`proj-tile ${p.status === 'missing' ? 'missing' : p.isGit ? 'git' : ''}`} style={{ width: 30, height: 30, borderRadius: 9 }}>
                  <Icon name={p.isGit ? 'branch' : 'folder'} size={15} stroke={1.9} />
                </span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
                  <b style={{ fontSize: 13 }}>{p.name}</b>
                  <span className="mono dim" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.displayPath}
                  </span>
                </span>
                {p.status === 'missing' ? <span className="chip bad">경로 없음</span> : p.status === 'denied' ? <span className="chip warn">접근 불가</span> : p.watch ? <span className="chip ok"><Icon name="pulse" size={11} stroke={2.4} />점검</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {agent.folders.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="section-label">허용 폴더</span>
          <div className="chips">
            {agent.folders.map((f) => (
              <span key={f.path} className={`chip mono${f.mode === 'write' ? ' new' : ''}`} title={MODE_LABEL[f.mode]}>
                <Icon name="folder" size={11} stroke={2.2} />
                {f.path}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">하트비트</span>
        <div className="chips">
          {hb?.enabled ? (
            <>
              <span className="chip new">
                <Icon name="pulse" size={11} stroke={2.4} />
                {intervalLabel(hb.everyMinutes)}마다
              </span>
              {hb.activeHours ? <span className="chip mono">{hb.activeHours}</span> : null}
              <span className="chip">{hb.lastAt ? `마지막 ${relTime(hb.lastAt)}` : '아직 안 돎'}</span>
            </>
          ) : (
            <span className="muted">꺼짐</span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5 }}>
          <span className="dim">오늘 토큰</span>
          <span className="mono">
            {compactTokens(agent.tokensToday)} / {tokenLimitText(agent.tokenLimit)}
          </span>
        </div>
        {!unlimited ? (
          <span className="progress" style={{ height: 6 }}>
            <span style={{ width: `${used}%`, background: used >= 90 ? 'var(--danger)' : 'var(--msg)' }} />
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn primary" style={{ flex: '1 1 120px' }} onClick={() => navigate(`/console/${agent.id}`)}>
          <Icon name="terminal" size={15} stroke={2.1} />
          콘솔 열기
        </button>
        <button type="button" className="btn" style={{ flex: '1 1 120px' }} disabled={busy} onClick={() => void togglePause()}>
          <Icon name={agent.paused ? 'play' : 'pause'} size={15} stroke={2.1} />
          {agent.paused ? '재개' : '일시정지'}
        </button>
      </div>
    </aside>
  );
}

/* ───────── 활동 ───────── */

type Filter = 'all' | ActivityItem['category'];
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '전체' },
  { value: 'hook', label: '훅' },
  { value: 'skill', label: '스킬' },
  { value: 'module', label: '모듈' },
  { value: 'agent', label: '에이전트' },
];

function Activity() {
  const items = useApp((s) => s.activity);
  const tz = useApp((s) => s.meta?.tz);
  const connected = useApp((s) => s.connected);
  const [filter, setFilter] = useState<Filter>('all');
  const shown = useMemo(() => items.filter((i) => filter === 'all' || i.category === filter).slice(0, 40), [items, filter]);
  return (
    <section className="card activity" aria-label="활동" style={{ padding: '14px 18px 8px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, paddingBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>활동</h2>
        <span className={`status-dot${connected ? ' working' : ' error'}`} style={{ width: 6, height: 6 }} />
        <div style={{ marginLeft: 'auto' }}>
          <Seg value={filter} options={FILTERS} onChange={setFilter} label="활동 종류" />
        </div>
      </div>
      {shown.length === 0 ? <div className="empty">기록이 없습니다</div> : null}
      <ol className="scroll-fade" style={{ maxHeight: 380, overflowY: 'auto' }}>
        {shown.map((i) => (
          <li key={i.id}>
            <span className="mono muted" style={{ fontSize: 12 }}>
              {clock(i.ts, tz)}
            </span>
            <span className={`who tone-${i.tone}`}>{i.who}</span>
            <span className="text" title={i.text}>
              {i.text}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LegendLine({ color, glow, dashed }: { color: string; glow?: boolean; dashed?: boolean }) {
  return (
    <svg width="26" height="8" aria-hidden="true">
      <path d="M1 4H25" className={glow || dashed ? undefined : 'edge-flow'} style={{ stroke: color, strokeWidth: 2, strokeDasharray: dashed ? '4 4' : undefined, filter: glow ? 'drop-shadow(0 0 3px var(--accent-glow))' : undefined }} />
    </svg>
  );
}

export function CanvasPage() {
  const overview = useApp((s) => s.overview) as Overview;
  const connected = useApp((s) => s.connected);
  const [selected, setSelected] = useState<string | null>(() => overview.agents.find((a) => a.status === 'working')?.id ?? null);
  const agent = selected ? (overview.agents.find((a) => a.id === selected) ?? null) : null;

  useEffect(() => {
    if (selected && !layoutGraph(overview).nodes.some((n) => n.id === selected)) setSelected(null);
  }, [overview, selected]);
  const select = useCallback((id: string | null) => setSelected(id), []);

  return (
    <>
      <div className="page-head">
        <h1>캔버스</h1>
        <span className={`chip ${connected ? 'new' : 'bad'}`} style={{ height: 26, borderRadius: 999 }}>
          <span className={`status-dot ${connected ? 'working' : 'error'}`} style={{ width: 6, height: 6 }} />
          {connected ? '실시간' : '연결 끊김'}
        </span>
        <div className="legend">
          <span>
            <LegendLine color="var(--msg)" />
            메시지
          </span>
          <span>
            <LegendLine color="var(--skill)" />
            스킬 호출
          </span>
          <span>
            <LegendLine color="var(--accent)" glow />새 스킬
          </span>
          <span>
            <LegendLine color="var(--text2)" dashed />
            위임
          </span>
        </div>
        <button type="button" className="btn primary" onClick={() => navigate('/hire')}>
          <Icon name="plus" size={16} stroke={2.4} />새 에이전트
        </button>
      </div>
      <div className="row">
        <div className="grow">
          <ReactFlowProvider>
            <Graph overview={overview} selected={selected} onSelect={select} />
          </ReactFlowProvider>
        </div>
        {agent ? <Inspector agent={agent} overview={overview} onClose={() => setSelected(null)} /> : null}
      </div>
      <Activity />
    </>
  );
}
