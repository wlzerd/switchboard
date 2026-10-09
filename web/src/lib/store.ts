import { useSyncExternalStore } from 'react';
import { api } from './api';
import type { ActivityItem, ApprovalView, Meta, Overview, ServerEvent, Theme } from './types';

/** 화면 전체가 함께 쓰는 상태. 서버 이벤트(WebSocket)로 갱신합니다. */
export interface AppState {
  overview: Overview | null;
  meta: Meta | null;
  approvals: ApprovalView[];
  activity: ActivityItem[];
  connected: boolean;
  theme: Theme | null;
  pulses: Record<string, number>;
  toasts: { id: number; text: string; tone: 'ok' | 'error' | 'info' }[];
}

let state: AppState = { overview: null, meta: null, approvals: [], activity: [], connected: false, theme: null, pulses: {}, toasts: [] };
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: ServerEvent) => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}

export function getState(): AppState {
  return state;
}

export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => select(state),
  );
}

/** 특정 화면이 서버 이벤트를 직접 받고 싶을 때 */
export function onServerEvent(fn: (e: ServerEvent) => void): () => void {
  eventListeners.add(fn);
  return () => eventListeners.delete(fn);
}

let toastSeq = 0;
export function toast(text: string, tone: 'ok' | 'error' | 'info' = 'info'): void {
  toastSeq += 1;
  const id = toastSeq;
  setState((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 6000 : 3200);
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export function refreshOverview(delay = 250): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void api<Overview>('/api/overview')
      .then((overview) => setState({ overview }))
      .catch(() => {});
  }, delay);
}

export async function loadInitial(): Promise<void> {
  const [overview, meta, approvals, activity, theme] = await Promise.all([
    api<Overview>('/api/overview'),
    api<Meta>('/api/meta'),
    api<{ approvals: ApprovalView[] }>('/api/approvals?status=pending'),
    api<{ items: ActivityItem[] }>('/api/activity?limit=60'),
    api<{ theme: Theme | null }>('/api/theme'),
  ]);
  setState({ overview, meta, approvals: approvals.approvals, activity: activity.items, theme: theme.theme });
}

const PULSE_MS = 4000;

function handle(e: ServerEvent): void {
  switch (e.type) {
    case 'activity':
      setState((s) => ({ activity: [e.item, ...s.activity].slice(0, 200) }));
      break;
    case 'agent.status':
      setState((s) => (s.overview ? { overview: { ...s.overview, agents: s.overview.agents.map((a) => (a.id === e.agentId ? { ...a, status: e.status, detail: e.detail } : a)) } } : {}));
      break;
    case 'task.update':
      setState((s) =>
        s.overview
          ? { overview: { ...s.overview, agents: s.overview.agents.map((a) => (a.id === e.task.agentId ? { ...a, task: { id: e.task.id, title: e.task.title, status: e.task.status, steps: e.task.steps, error: e.task.error, origin: e.task.origin, finishedAt: e.task.finishedAt } } : a)) } }
          : {},
      );
      break;
    case 'approval.created':
      setState((s) => ({ approvals: [...s.approvals.filter((a) => a.id !== e.approval.id), e.approval] }));
      refreshOverview();
      break;
    case 'approval.resolved':
      setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== e.approval.id) }));
      refreshOverview();
      break;
    case 'edge.pulse': {
      const key = `${e.from}->${e.to}`;
      const at = Date.now();
      setState((s) => ({ pulses: { ...s.pulses, [key]: at } }));
      setTimeout(() => setState((s) => (s.pulses[key] === at ? { pulses: Object.fromEntries(Object.entries(s.pulses).filter(([k]) => k !== key)) } : {})), PULSE_MS);
      break;
    }
    case 'module.status':
    case 'graph.changed':
    case 'skill.created':
      refreshOverview();
      break;
    case 'report': {
      // 조용한 작업은 알릴 것이 있을 때만 이 이벤트가 옵니다.
      const name = state.overview?.agents.find((a) => a.id === e.agentId)?.name ?? '에이전트';
      const text = e.text.replace(/\s+/g, ' ').trim();
      toast(`${name} 보고 · ${text.length > 140 ? `${text.slice(0, 140)}…` : text}`, 'info');
      refreshOverview();
      break;
    }
    case 'heartbeat.done': {
      // 사용자가 '지금 확인'을 눌렀을 때만 옵니다. 보고가 있었다면 report 이벤트로 이미 알렸습니다.
      const name = state.overview?.agents.find((a) => a.id === e.agentId)?.name ?? '에이전트';
      if (e.error) toast(`${name} 하트비트 점검 실패 · ${e.error}`, 'error');
      else if (!e.reported) toast(`${name} · 보고할 내용이 없습니다`, 'ok');
      refreshOverview();
      break;
    }
    case 'theme.changed':
      setState({ theme: e.theme });
      break;
    default:
      break;
  }
  for (const l of eventListeners) l(e);
}

let socket: WebSocket | null = null;
let retry = 0;
let stopped = false;

/** WebSocket 연결. 끊기면 1초, 2초 … 최대 15초 간격으로 다시 붙고, 붙으면 전체를 새로 읽습니다. */
export function connectEvents(): void {
  stopped = false;
  const open = (): void => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`);
    socket = ws;
    ws.onopen = () => {
      const reconnect = retry > 0;
      retry = 0;
      setState({ connected: true });
      if (reconnect) {
        void loadInitial().catch(() => {});
      }
    };
    ws.onmessage = (m) => {
      try {
        handle(JSON.parse(String(m.data)) as ServerEvent);
      } catch {
        // 형식이 맞지 않는 메시지는 버립니다.
      }
    };
    ws.onclose = () => {
      setState({ connected: false });
      if (stopped) return;
      retry += 1;
      setTimeout(open, Math.min(15_000, 1000 * 2 ** Math.min(4, retry - 1)));
    };
  };
  open();
}

export function disconnectEvents(): void {
  stopped = true;
  socket?.close();
}
