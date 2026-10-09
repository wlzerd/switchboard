import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AgentEditModal } from '../components/AgentEdit';
import { Icon } from '../components/Icon';
import { shortModel } from '../components/Shell';
import { Avatar, Modal, Seg, StatusLine, Steps, Switch } from '../components/ui';
import { EFFORT_LABEL } from '../lib/agent';
import { api, errorText } from '../lib/api';
import { MODE_LABEL } from '../lib/folders';
import { delegationChips, heartbeatFormOf, heartbeatFormProblem, heartbeatPayload, intervalChoices, intervalLabel, sameHeartbeat, type HeartbeatForm } from '../lib/autonomy';
import { clock, relTime } from '../lib/format';
import { navigate } from '../lib/router';
import { onServerEvent, refreshOverview, toast, useApp } from '../lib/store';
import type { AgentView, Meta, Overview, ScheduleView, TaskView, ThreadView, TimelineItem } from '../lib/types';

const ACTIVE: ReadonlySet<string> = new Set(['queued', 'running', 'waiting']);
const MESSAGE_MAX = 20_000;
const DRAFT_KEY = 'sb.draft.';

function str(d: Record<string, unknown>, k: string): string {
  const v = d[k];
  return typeof v === 'string' ? v : '';
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const next = { ...rec };
  delete next[key];
  return next;
}

function readDraft(agentId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY + agentId) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(agentId: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY + agentId, text);
    else localStorage.removeItem(DRAFT_KEY + agentId);
  } catch {
    // 저장소를 쓸 수 없으면 초안 기억만 빠집니다.
  }
}

/* ───────── 타임라인 데이터 ───────── */

interface TimelineState {
  threadId: string | null;
  items: TimelineItem[];
  loading: boolean;
  error: string | null;
}

function useTimeline(agentId: string, source: string) {
  const [state, setState] = useState<TimelineState>({ threadId: null, items: [], loading: true, error: null });
  const [live, setLive] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    api<{ threadId: string | null; items: TimelineItem[] }>(`/api/agents/${agentId}/timeline?source=${encodeURIComponent(source)}`, { signal: ac.signal })
      .then((r) => {
        setState({ threadId: r.threadId, items: r.items, loading: false, error: null });
        setLive({});
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') setState((s) => ({ ...s, loading: false, error: errorText(err) }));
      });
    return () => ac.abort();
  }, [agentId, source, reload]);

  const threadId = state.threadId;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    // 아직 대화방이 없을 때(첫 지시)는 서버가 만든 방을 다시 읽어 옵니다.
    const refetch = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setReload((n) => n + 1), 150);
    };
    const off = onServerEvent((e) => {
      switch (e.type) {
        case 'timeline.add': {
          if (e.agentId !== agentId) return;
          if (threadId === null) {
            refetch();
            return;
          }
          if (e.item.threadId !== threadId) return;
          setState((s) => (s.items.some((i) => i.id === e.item.id) ? s : { ...s, items: [...s.items, e.item] }));
          const taskId = e.item.taskId;
          if (taskId) setLive((l) => without(l, taskId));
          return;
        }
        case 'timeline.update':
          if (e.agentId !== agentId || e.item.threadId !== threadId) return;
          setState((s) => ({ ...s, items: s.items.map((i) => (i.id === e.item.id ? e.item : i)) }));
          return;
        case 'agent.delta':
          if (e.agentId !== agentId || threadId === null || e.threadId !== threadId) return;
          setLive((l) => ({ ...l, [e.taskId]: (l[e.taskId] ?? '') + e.text }));
          return;
        case 'task.update':
          if (e.task.agentId !== agentId || ACTIVE.has(e.task.status)) return;
          setLive((l) => without(l, e.task.id));
          return;
        default:
          return;
      }
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [agentId, threadId]);

  return { ...state, live, retry: () => setReload((n) => n + 1) };
}

/* ───────── 타임라인 항목 ───────── */

const TOOL_ICON: Record<string, string> = {
  fs_read: 'folder',
  fs_write: 'folder',
  fs_list: 'folder',
  shell_exec: 'terminal',
  http_request: 'link',
  send_message: 'chat',
  skill_create: 'bolt',
  module_create: 'cube',
  schedule_create: 'clock',
  schedule_list: 'clock',
  schedule_cancel: 'clock',
  delegate_task: 'forward',
  heartbeat_set: 'pulse',
  email_search: 'mail',
  email_read: 'mail',
};

function ToolItem({ d }: { d: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const ok = d['ok'] !== false;
  const ms = typeof d['ms'] === 'number' ? d['ms'] : null;
  const tool = str(d, 'tool');
  const preview = str(d, 'preview');
  return (
    <div className="tool-card indent">
      <button type="button" aria-expanded={preview ? open : undefined} onClick={() => setOpen(!open)} style={{ cursor: preview ? 'pointer' : 'default' }}>
        <span style={{ width: 26, height: 26, flex: 'none', borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--skill-dim)', color: 'var(--skill)' }}>
          <Icon name={TOOL_ICON[tool] ?? 'bolt'} size={14} stroke={2} />
        </span>
        <span className="mono" style={{ fontSize: 12.5, fontWeight: 500 }}>
          {tool}
        </span>
        <span className="dim" style={{ fontSize: 13, flex: '1 1 160px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {str(d, 'summary') || str(d, 'title')}
        </span>
        <span className={`chip ${ok ? 'ok' : 'bad'}`}>
          {ok ? '성공' : '실패'}
          {ms !== null ? ` · ${(ms / 1000).toFixed(1)}초` : ''}
        </span>
        {preview ? <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} stroke={2} /> : null}
      </button>
      {open && preview ? (
        <pre className="codebox preview" style={{ maxHeight: 300 }}>
          {preview}
        </pre>
      ) : null}
    </div>
  );
}

const DECISION: Record<string, { text: string; tone: 'ok' | 'bad' }> = {
  once: { text: '이번만 허용', tone: 'ok' },
  always: { text: '항상 허용', tone: 'ok' },
  deny: { text: '거부', tone: 'bad' },
  expired: { text: '만료', tone: 'bad' },
};

function ApprovalItem({ d }: { d: Record<string, unknown> }) {
  const defs = useApp((s) => s.meta?.permissionDefs);
  const [busy, setBusy] = useState(false);
  const status = str(d, 'status') || 'pending';
  const pending = status === 'pending';
  const perm = str(d, 'perm');
  const decided = DECISION[status];
  const canAlways = defs?.some((p) => p.key === perm && p.scope !== 'none') ?? false;
  const decide = async (decision: 'once' | 'always' | 'deny'): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/approvals/${str(d, 'approvalId')}`, { body: { decision } });
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`approval-card indent${pending ? ' pending' : ''}`}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ color: pending ? 'var(--warn)' : 'var(--text3)', display: 'grid' }}>
          <Icon name="shieldAlert" size={16} stroke={2} />
        </span>
        <b style={{ fontSize: 13.5 }}>{pending ? '승인이 필요합니다' : '승인 요청'}</b>
        <span className="chip mono">{perm}</span>
        {decided ? (
          <span className={`chip ${decided.tone}`} style={{ marginLeft: 'auto' }}>
            {decided.text}
          </span>
        ) : null}
      </div>
      <code className="mono" style={{ fontSize: 12.5, overflowWrap: 'anywhere', color: 'var(--text)' }}>
        {str(d, 'target')}
      </code>
      <span className="muted" style={{ fontSize: 12 }}>
        {str(d, 'rule')}
      </span>
      {str(d, 'note') ? (
        <span className="dim" style={{ fontSize: 12.5 }}>
          {str(d, 'note')}
        </span>
      ) : null}
      {pending ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="btn primary sm" disabled={busy} onClick={() => void decide('once')}>
            이번만 허용
          </button>
          {canAlways ? (
            <button type="button" className="btn sm" disabled={busy} onClick={() => void decide('always')}>
              항상 허용
            </button>
          ) : null}
          <button type="button" className="btn danger sm" disabled={busy} onClick={() => void decide('deny')}>
            거부
          </button>
        </div>
      ) : null}
    </div>
  );
}

const DELEGATE_STATUS: Record<string, { text: string; tone: string }> = {
  sent: { text: '처리 중', tone: '' },
  done: { text: '완료', tone: 'ok' },
  failed: { text: '실패', tone: 'bad' },
  cancelled: { text: '취소됨', tone: 'bad' },
};

function DelegateItem({ d }: { d: Record<string, unknown> }) {
  const agents = useApp((s) => s.overview?.agents);
  const status = str(d, 'status') || 'sent';
  const view = DELEGATE_STATUS[status] ?? { text: status, tone: '' };
  const to = agents?.find((a) => a.id === str(d, 'to'));
  return (
    <div className="delegate-card indent">
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--text2)', display: 'grid' }}>
          <Icon name="forward" size={16} stroke={2.2} />
        </span>
        {to ? <Avatar name={to.name} color={to.color} size={20} /> : null}
        <b style={{ fontSize: 13.5 }}>{to?.name ?? str(d, 'toName')}에게 위임</b>
        <span className={`chip ${view.tone}`} style={{ marginLeft: 'auto' }}>
          {view.text}
        </span>
      </div>
      {status === 'sent' ? <span className="flow-line" /> : null}
      <span style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{str(d, 'task')}</span>
      {str(d, 'reason') ? (
        <span className="muted" style={{ fontSize: 12 }}>
          이유 · {str(d, 'reason')}
        </span>
      ) : null}
      {str(d, 'result') ? (
        <span className="dim" style={{ fontSize: 12.5, borderTop: '1px solid var(--line)', paddingTop: 8, overflowWrap: 'anywhere' }}>
          {str(d, 'result')}
        </span>
      ) : null}
    </div>
  );
}

/** 화면 제어 카드: 이어진 동작들을 한 카드에 모으고, 에이전트가 마지막으로 본 화면을 보여 줍니다. */
function ScreenItem({ d }: { d: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const [big, setBig] = useState(false);
  const count = typeof d['count'] === 'number' ? d['count'] : 0;
  const actions = Array.isArray(d['actions']) ? (d['actions'] as { s?: unknown; ok?: unknown }[]).filter((a) => typeof a.s === 'string') : [];
  const image = typeof d['image'] === 'string' ? d['image'] : null;
  const last = actions[actions.length - 1];
  const ok = d['ok'] !== false;
  return (
    <div className="screen-card indent">
      <button type="button" className="screen-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span style={{ width: 26, height: 26, flex: 'none', borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--skill-dim)', color: 'var(--skill)' }}>
          <Icon name="screen" size={14} stroke={2} />
        </span>
        <b style={{ fontSize: 13 }}>화면 제어</b>
        <span className="dim" style={{ fontSize: 13, flex: '1 1 140px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {String(last?.s ?? '')}
        </span>
        <span className={`chip ${ok ? 'ok' : 'bad'}`}>동작 {count}개</span>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} stroke={2} />
      </button>
      {image ? (
        <button type="button" className="screen-thumb" aria-label="에이전트가 본 화면 크게 보기" onClick={() => setBig(true)}>
          <img src={`/api/screens/${image}`} alt="에이전트가 마지막으로 본 화면" loading="lazy" />
        </button>
      ) : null}
      {open ? (
        <ol className="screen-actions">
          {actions.map((a, i) => (
            <li key={i} className={a.ok === false ? 'bad' : undefined}>
              {String(a.s)}
            </li>
          ))}
        </ol>
      ) : null}
      {big && image ? (
        <Modal title="에이전트가 본 화면" onClose={() => setBig(false)}>
          <img src={`/api/screens/${image}`} alt="에이전트가 마지막으로 본 화면" style={{ width: '100%', borderRadius: 8, display: 'block' }} />
        </Modal>
      ) : null}
    </div>
  );
}

function TimelineEntry({ item, agent, tz }: { item: TimelineItem; agent: AgentView; tz: string }) {
  const d = item.data;
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg-user">
          <div className="bubble">{str(d, 'text')}</div>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {str(d, 'src') ? `${str(d, 'src')} · ` : ''}
            {clock(item.createdAt, tz)}
          </span>
        </div>
      );
    case 'agent':
      return (
        <div className="msg-agent">
          <Avatar name={agent.name} color={agent.color} size={28} />
          <div className="text" title={clock(item.createdAt, tz)}>
            {str(d, 'text')}
          </div>
        </div>
      );
    case 'tool':
      return <ToolItem d={d} />;
    case 'approval':
      return <ApprovalItem d={d} />;
    case 'hook':
      return (
        <div className="hook-line indent">
          <Icon name="shield" size={14} stroke={2} />
          {str(d, 'text')}
        </div>
      );
    case 'block':
      return (
        <div className="block-card indent">
          <span style={{ color: 'var(--danger)', display: 'grid', paddingTop: 2 }}>
            <Icon name="shieldAlert" size={17} stroke={2} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <b style={{ fontSize: 13.5, color: 'var(--danger)' }}>{str(d, 'title')}</b>
            <span style={{ fontSize: 13 }}>{str(d, 'text')}</span>
            {str(d, 'code') ? (
              <code className="mono muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>
                {str(d, 'code')}
              </code>
            ) : null}
          </div>
        </div>
      );
    case 'skill':
      return (
        <div className="skill-card indent">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 26, height: 26, borderRadius: 7, display: 'grid', placeItems: 'center', background: 'var(--accent)', color: 'var(--onAccent)' }}>
              <Icon name="bolt" size={15} stroke={2.2} />
            </span>
            <b style={{ fontSize: 13.5 }}>새 스킬 · {str(d, 'title')}</b>
            <span className="chip mono new">{str(d, 'name')}</span>
            <span className="chip ok" style={{ marginLeft: 'auto' }}>
              테스트 {str(d, 'tests')}
            </span>
          </div>
          {str(d, 'code') ? (
            <pre className="codebox" style={{ fontSize: 11.5 }}>
              {str(d, 'code')}
            </pre>
          ) : null}
        </div>
      );
    case 'system':
      return (
        <div className="sys-line">
          <span className="chip" style={{ height: 'auto', minHeight: 24, whiteSpace: 'normal', padding: '3px 10px', textAlign: 'center' }}>
            {str(d, 'text')}
          </span>
        </div>
      );
    case 'delegate':
      return <DelegateItem d={d} />;
    case 'screen':
      return <ScreenItem d={d} />;
    case 'report':
      return (
        <div className="report-card indent">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <span style={{ color: 'var(--msg)', display: 'grid' }}>
              <Icon name="report" size={16} stroke={2.2} />
            </span>
            <b style={{ fontSize: 13.5 }}>보고</b>
            <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
              {str(d, 'source') ? `${str(d, 'source')} · ` : ''}
              {clock(item.createdAt, tz)}
            </span>
          </div>
          <div className="body">{str(d, 'text')}</div>
        </div>
      );
    case 'error':
      return (
        <div className="error-card indent" role="alert">
          <span style={{ color: 'var(--danger)', display: 'grid', paddingTop: 2 }}>
            <Icon name="x" size={16} stroke={2.6} />
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <b style={{ fontSize: 13.5, color: 'var(--danger)' }}>{str(d, 'title')}</b>
            <span style={{ fontSize: 13, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{str(d, 'text')}</span>
          </div>
        </div>
      );
    default:
      return null;
  }
}

/* ───────── 대화 ───────── */

function Composer({ agent, running, onSent }: { agent: AgentView; running: TaskView | null; onSent: () => void }) {
  const [text, setText] = useState(() => readDraft(agent.id));
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, el.scrollHeight)}px`;
  }, [text]);

  useEffect(() => {
    const t = setTimeout(() => writeDraft(agent.id, text), 400);
    return () => clearTimeout(t);
  }, [agent.id, text]);

  const send = async (): Promise<void> => {
    const body = text.trim();
    if (!body || sending) return;
    if (body.length > MESSAGE_MAX) {
      setError(`지시는 ${MESSAGE_MAX.toLocaleString()}자까지 보낼 수 있습니다. 지금 ${body.length.toLocaleString()}자입니다.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await api(`/api/agents/${agent.id}/messages`, { body: { text: body } });
      setText('');
      writeDraft(agent.id, '');
      onSent();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSending(false);
      ref.current?.focus({ preventScroll: true });
    }
  };

  const stop = async (): Promise<void> => {
    if (!running) return;
    setStopping(true);
    try {
      await api(`/api/tasks/${running.id}/cancel`, { body: {} });
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setStopping(false);
    }
  };

  const length = text.trim().length;
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="composer-box">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          aria-label={`${agent.name}에게 보낼 지시`}
          placeholder={agent.paused ? `${agent.name} 일시정지 중 · 재개하면 처리합니다` : `${agent.name}에게 지시`}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="chip mono">{shortModel(agent.model, agent.modelName)}</span>
          {agent.effort ? <span className="chip">{EFFORT_LABEL[agent.effort]}</span> : null}
          {length > MESSAGE_MAX * 0.9 ? (
            <span className="mono" style={{ fontSize: 11.5, color: length > MESSAGE_MAX ? 'var(--danger)' : 'var(--warn)' }}>
              {length.toLocaleString()}/{MESSAGE_MAX.toLocaleString()}
            </span>
          ) : null}
          <span style={{ marginLeft: 'auto' }} />
          {running ? (
            <button type="button" className="btn danger sm" disabled={stopping} onClick={() => void stop()}>
              <Icon name="stop" size={13} stroke={2.4} />
              중지
            </button>
          ) : null}
          <button type="submit" className="btn primary sm" style={{ width: 36, padding: 0 }} aria-label="보내기" disabled={sending || length === 0}>
            {sending ? <span className="spinner" style={{ width: 14, height: 14, borderTopColor: 'var(--onAccent)' }} /> : <Icon name="arrowUp" size={17} stroke={2.4} />}
          </button>
        </div>
      </div>
      {error ? (
        <span className="err" role="alert" style={{ display: 'block', marginTop: 8 }}>
          {error}
        </span>
      ) : null}
    </form>
  );
}

function Chat({ agent, source, threads, onSource }: { agent: AgentView; source: string; threads: ThreadView[]; onSource: (s: string) => void }) {
  const tz = useApp((s) => s.meta?.tz ?? 'UTC');
  const { items, live, loading, error, retry } = useTimeline(agent.id, source);
  const status = agent.paused ? 'paused' : agent.status;
  const task = agent.task;
  const running = task && ACTIVE.has(task.status) && items.some((i) => i.taskId === task.id) ? task : null;
  const liveEntries = Object.entries(live).filter(([, t]) => t.length > 0);
  const options = useMemo(() => {
    // 웹 콘솔을 항상 맨 앞에, 나머지 채널 대화방은 최근 순서대로
    const others = threads.filter((t) => t.source !== 'console').map((t) => ({ value: t.source, label: t.title }));
    return [{ value: 'console', label: '웹 콘솔' }, ...others];
  }, [threads]);
  const scroller = useRef<HTMLDivElement>(null);
  // 아래부터 쌓이는 목록(column-reverse)이라 scrollTop 0 이 가장 최근 메시지입니다.
  const toLatest = (): void => scroller.current?.scrollTo({ top: 0, behavior: 'smooth' });

  return (
    <section className="card chat" aria-label={`${agent.name} 대화`}>
      <div className="card-head">
        <Avatar name={agent.name} color={agent.color} size={30} status={status} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
          <h2>{agent.name}</h2>
          <StatusLine status={status} detail={agent.detail} />
        </div>
        {options.length > 1 ? (
          <div style={{ marginLeft: 'auto', maxWidth: '100%', overflowX: 'auto' }}>
            <Seg value={source} options={options} onChange={onSource} label="대화방" />
          </div>
        ) : null}
      </div>
      <div className="chat-scroll" ref={scroller}>
        <div className="chat-list" aria-live="polite">
          {loading && items.length === 0 ? (
            <div className="empty">
              <span className="spinner" />
            </div>
          ) : null}
          {error ? (
            <div className="error-card" role="alert">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <b style={{ color: 'var(--danger)' }}>대화를 불러오지 못했습니다</b>
                <span style={{ fontSize: 13 }}>{error}</span>
                <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={retry}>
                  다시 시도
                </button>
              </div>
            </div>
          ) : null}
          {!loading && !error && items.length === 0 ? (
            <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              <Avatar name={agent.name} color={agent.color} size={44} />
              <span>{agent.name}</span>
            </div>
          ) : null}
          {items.map((item) => (
            <TimelineEntry key={item.id} item={item} agent={agent} tz={tz} />
          ))}
          {liveEntries.map(([taskId, text]) => (
            <div key={`live-${taskId}`} className="msg-agent">
              <Avatar name={agent.name} color={agent.color} size={28} />
              <div className="text">
                {text}
                <span className="caret" />
              </div>
            </div>
          ))}
          {running && liveEntries.length === 0 && running.status === 'running' && agent.status === 'working' ? (
            <div className="msg-agent">
              <Avatar name={agent.name} color={agent.color} size={28} />
              <div className="typing" aria-label="작업 중">
                <span />
                <span />
                <span />
              </div>
            </div>
          ) : null}
          {running && running.status === 'queued' ? (
            <div className="hook-line indent">
              <Icon name="clock" size={14} stroke={2} />
              대기열에서 차례를 기다리는 중
            </div>
          ) : null}
        </div>
      </div>
      {source === 'console' ? (
        <Composer agent={agent} running={running} onSent={toLatest} />
      ) : (
        <div className="composer" style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text3)', fontSize: 12.5 }}>
          <Icon name="eye" size={15} />
          읽기 전용 · {options.find((o) => o.value === source)?.label ?? source}
        </div>
      )}
    </section>
  );
}

/* ───────── 오른쪽 패널 ───────── */

function Schedules({ agentId }: { agentId: string }) {
  const tz = useApp((s) => s.meta?.tz ?? 'UTC');
  const [list, setList] = useState<ScheduleView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api<{ schedules: ScheduleView[] }>(`/api/agents/${agentId}/schedules`)
        .then((r) => {
          if (!alive) return;
          setList(r.schedules);
          setError(null);
        })
        .catch((err: unknown) => {
          if (alive) setError(errorText(err));
        });
    };
    load();
    const off = onServerEvent((e) => {
      if (e.type === 'graph.changed' || (e.type === 'task.update' && e.task.agentId === agentId && !ACTIVE.has(e.task.status))) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [agentId]);

  const toggle = async (s: ScheduleView, enabled: boolean): Promise<void> => {
    setBusy(s.id);
    try {
      const r = await api<{ schedule: ScheduleView }>(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled } });
      setList((l) => l?.map((x) => (x.id === s.id ? r.schedule : x)) ?? null);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (s: ScheduleView): Promise<void> => {
    setBusy(s.id);
    try {
      await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
      setList((l) => l?.filter((x) => x.id !== s.id) ?? null);
      toast(`예약 '${s.label}'을(를) 지웠습니다`, 'ok');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="section-label">예약 {list ? list.length : ''}</span>
      {error ? <span className="err">{error}</span> : null}
      {list && list.length === 0 ? <span className="muted">없음</span> : null}
      {list?.map((s) => (
        <div key={s.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--line)', opacity: s.enabled ? 1 : 0.6, animation: 'rise .3s ease backwards' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="clock" size={14} stroke={2} />
            <b style={{ fontSize: 13 }}>{s.label}</b>
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Switch checked={s.enabled} label={`${s.label} 켜기`} disabled={busy === s.id} onChange={(v) => void toggle(s, v)} />
              <button type="button" className="icon-btn" style={{ width: 28, height: 28, border: 0 }} aria-label={`${s.label} 지우기`} disabled={busy === s.id} onClick={() => void remove(s)}>
                <Icon name="trash" size={14} />
              </button>
            </span>
          </div>
          <span className="dim" style={{ fontSize: 12.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={s.prompt}>
            {s.prompt}
          </span>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {s.enabled && s.nextRun ? `다음 ${new Intl.DateTimeFormat('ko-KR', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(s.nextRun))}` : '꺼짐'}
            {s.lastRun ? ` · 마지막 ${relTime(s.lastRun)}` : ''}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 하트비트 · 보고 받을 곳. 조용한 작업(하트비트 · 새 메일 같은 자동 알림)의 보고가 이리로 갑니다. */
function HeartbeatPanel({ agent }: { agent: AgentView }) {
  const meta = useApp((s) => s.meta) as Meta;
  const modules = useApp((s) => s.overview?.modules) ?? [];
  const limits = meta.heartbeat;
  const saved = useMemo(() => heartbeatFormOf(agent, limits), [agent, limits]);
  const [form, setForm] = useState<HeartbeatForm>(saved);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 에이전트가 heartbeat_set 으로 바꾸는 등 서버 값이 바뀌면, 고치던 중이 아닐 때만 화면 값을 맞춥니다.
  const shown = useRef(saved);
  useEffect(() => {
    setForm((f) => (sameHeartbeat(f, shown.current) ? saved : f));
    shown.current = saved;
  }, [saved]);

  useEffect(() => {
    if (!checking) return undefined;
    const off = onServerEvent((e) => {
      if (e.type === 'heartbeat.done' && e.agentId === agent.id) setChecking(false);
    });
    // 끝 알림을 놓쳐도(연결 끊김 등) 버튼이 계속 돌지 않게 합니다.
    const t = setTimeout(() => setChecking(false), 5 * 60_000);
    return () => {
      off();
      clearTimeout(t);
    };
  }, [checking, agent.id]);

  const dirty = !sameHeartbeat(form, saved);
  const senders = modules.filter((m) => m.canSend);
  const choices = intervalChoices(limits, form.everyMinutes);
  const set = (patch: Partial<HeartbeatForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
    setError(null);
  };

  const save = async (next: HeartbeatForm): Promise<boolean> => {
    const problem = heartbeatFormProblem(next, limits, modules);
    if (problem) {
      setError(problem);
      return false;
    }
    try {
      await api(`/api/agents/${agent.id}/heartbeat`, { method: 'PUT', body: heartbeatPayload(next) });
      shown.current = next;
      setForm(next);
      refreshOverview(0);
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    }
  };

  const onSave = async (next: HeartbeatForm): Promise<void> => {
    setBusy('save');
    const was = saved.enabled;
    if (await save(next)) toast(next.enabled && !was ? `하트비트 켬 · ${intervalLabel(next.everyMinutes)}마다` : !next.enabled && was ? '하트비트 끔' : '하트비트 설정을 저장했습니다', 'ok');
    setBusy(null);
  };

  const onRun = async (): Promise<void> => {
    setBusy('run');
    try {
      if (dirty && !(await save(form))) return;
      await api(`/api/agents/${agent.id}/heartbeat/run`, { body: {} });
      setChecking(true);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const hb = agent.heartbeat;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {hb?.enabled ? (
            <span className="hb-mark">
              <Icon name="pulse" size={13} stroke={2.2} />
            </span>
          ) : null}
          하트비트
        </span>
        <span className="muted" style={{ fontSize: 11.5 }}>
          {hb?.lastAt ? `마지막 ${relTime(hb.lastAt)}` : ''}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Switch checked={form.enabled} label="하트비트 켜기" disabled={busy !== null} onChange={(enabled) => void onSave({ ...form, enabled })} />
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <select className="select" style={{ height: 34, fontSize: 13, flex: '1 1 110px' }} aria-label="확인 간격" value={form.everyMinutes} onChange={(e) => set({ everyMinutes: Number(e.target.value) })}>
          {choices.map((m) => (
            <option key={m} value={m}>
              {intervalLabel(m)}마다
            </option>
          ))}
        </select>
        <Seg
          value={form.allDay ? 'all' : 'hours'}
          options={[
            { value: 'all', label: '하루 종일' },
            { value: 'hours', label: '시간 지정' },
          ]}
          onChange={(v) => set({ allDay: v === 'all' })}
          label="활동 시간"
        />
      </div>
      {!form.allDay ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, animation: 'rise .25s ease backwards' }}>
          <input className="input mono" type="time" style={{ height: 34, fontSize: 13, flex: 1, minWidth: 0 }} aria-label="활동 시작" value={form.start} onChange={(e) => set({ start: e.target.value })} />
          <span className="muted">–</span>
          <input className="input mono" type="time" style={{ height: 34, fontSize: 13, flex: 1, minWidth: 0 }} aria-label="활동 끝" value={form.end} onChange={(e) => set({ end: e.target.value })} />
        </div>
      ) : null}
      <textarea
        className="textarea"
        rows={3}
        style={{ fontSize: 13 }}
        aria-label="점검 · 알릴 조건"
        placeholder="점검 · 알릴 조건"
        maxLength={limits.checklistMax + 200}
        value={form.checklist}
        onChange={(e) => set({ checklist: e.target.value })}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span className="section-label" style={{ flex: 'none' }}>
          보고
        </span>
        <select className="select" style={{ height: 34, fontSize: 13, flex: '1 1 100px', minWidth: 0 }} aria-label="보고 받을 채널" value={form.reportModule} onChange={(e) => set({ reportModule: e.target.value })}>
          <option value="">화면에만</option>
          {senders.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {form.reportModule ? (
          <input className="input mono" style={{ height: 34, fontSize: 13, flex: '1 1 120px', minWidth: 0 }} aria-label="보고 받을 대상" placeholder="#채널 또는 대화 id" value={form.reportTarget} onChange={(e) => set({ reportTarget: e.target.value })} />
        ) : null}
      </div>
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn primary sm" disabled={!dirty || busy !== null} onClick={() => void onSave(form)}>
          {busy === 'save' ? <span className="spinner" style={{ width: 12, height: 12, borderTopColor: 'var(--onAccent)' }} /> : null}
          저장
        </button>
        <button type="button" className="btn sm" disabled={busy !== null || checking || form.checklist.trim() === ''} onClick={() => void onRun()}>
          {busy === 'run' || checking ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="pulse" size={13} stroke={2.2} />}
          {checking ? '확인 중' : '지금 확인'}
        </button>
      </div>
    </div>
  );
}

function AgentPanel({ agent }: { agent: AgentView }) {
  const meta = useApp((s) => s.meta) as Meta;
  const modules = useApp((s) => s.overview?.modules);
  const agents = useApp((s) => s.overview?.agents) ?? [];
  const [edit, setEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = agent.paused ? 'paused' : agent.status;
  const preset = agent.preset === 'custom' ? '사용자 지정' : (meta.presets.find((p) => p.id === agent.preset)?.name ?? agent.preset);
  const task = agent.task;
  const live = task !== null && ACTIVE.has(task.status);

  const togglePause = async (): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}/pause`, { body: { paused: !agent.paused } });
      refreshOverview(0);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}`, { method: 'DELETE' });
      writeDraft(agent.id, '');
      toast(`${agent.name}을(를) 삭제했습니다`, 'ok');
      refreshOverview(0);
      navigate('/');
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
    }
  };

  return (
    <aside className="card side" style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: 18, animation: 'slidein .35s ease both' }} aria-label={`${agent.name} 정보`}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn sm" onClick={() => setEdit(true)}>
          <Icon name="user" size={14} stroke={2} />
          설정
        </button>
        <button type="button" className="btn sm" onClick={() => navigate(`/guard/${agent.id}`)}>
          <Icon name="shield" size={14} stroke={2} />
          권한 · 훅
        </button>
        <button type="button" className="btn sm" disabled={busy} onClick={() => void togglePause()}>
          <Icon name={agent.paused ? 'play' : 'pause'} size={14} stroke={2.2} />
          {agent.paused ? '재개' : '일시정지'}
        </button>
      </div>
      <div className="kv">
        <span>모델</span>
        <span className="mono" style={{ overflowWrap: 'anywhere' }}>
          {agent.model}
          {agent.effort ? ` · ${EFFORT_LABEL[agent.effort]}` : ''}
        </span>
        <span>키</span>
        <span>{agent.keyLabel}</span>
        <span>권한</span>
        <span>{preset}</span>
        {agent.role ? (
          <>
            <span style={{ alignSelf: 'start' }}>역할</span>
            <span className="dim" style={{ whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
              {agent.role}
            </span>
          </>
        ) : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">{live ? '현재 작업' : '마지막 작업'}</span>
        {task ? (
          <>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{task.title}</span>
            <StatusLine status={live ? status : task.status === 'failed' ? 'error' : 'idle'} detail={live ? null : task.status === 'done' ? '완료' : task.status === 'cancelled' ? '취소됨' : task.error} />
            <Steps steps={task.steps} />
          </>
        ) : (
          <span className="muted">아직 작업이 없습니다</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">연결</span>
        <div className="chips">
          {agent.links.length === 0 ? <span className="muted">없음</span> : null}
          {agent.links.map((l) => {
            const m = modules?.find((x) => x.id === l.moduleId);
            if (!m) return null;
            return (
              <span key={l.moduleId} className={`chip ${m.kind === 'skill' ? 'skill mono' : 'msg'}`} title={l.targets.length > 0 ? l.targets.join(', ') : undefined}>
                {m.kind === 'skill' ? (m.tools[0]?.name ?? m.name) : m.name}
                {m.canSend ? ` · ${l.trigger === 'all' ? '모든 메시지' : '호출 시'}` : ''}
              </span>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="section-label">위임</span>
        <div className="chips">
          {delegationChips(agent.delegation, agents).map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>
      </div>
      {agent.folders.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span className="section-label">허용 폴더</span>
          <div className="chips">
            {agent.folders.map((f) => (
              <span key={f.path} className={`chip mono${f.mode === 'write' ? ' new' : ''}`} title={MODE_LABEL[f.mode]}>
                <Icon name="folder" size={11} stroke={2.2} />
                {f.path} · {MODE_LABEL[f.mode]}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <HeartbeatPanel agent={agent} />
      <Schedules agentId={agent.id} />
      <button type="button" className="btn danger sm" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmDelete(true)}>
        <Icon name="trash" size={14} />
        에이전트 삭제
      </button>
      {edit ? <AgentEditModal agent={agent} onClose={() => setEdit(false)} /> : null}
      {confirmDelete ? (
        <Modal title={`${agent.name} 삭제`} onClose={() => setConfirmDelete(false)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <span>대화 기록 · 작업 · 예약 · 모듈 연결이 함께 삭제되며 되돌릴 수 없습니다.</span>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                취소
              </button>
              <button type="button" className="btn danger" disabled={busy} onClick={() => void remove()}>
                삭제
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </aside>
  );
}

function AgentConsole({ agent }: { agent: AgentView }) {
  const [source, setSource] = useState('console');
  const [threads, setThreads] = useState<ThreadView[]>([]);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api<{ threads: ThreadView[] }>(`/api/agents/${agent.id}/threads`)
        .then((r) => {
          if (alive) setThreads(r.threads);
        })
        .catch(() => {
          // 대화방 목록은 보조 정보라 실패해도 웹 콘솔 대화는 그대로 씁니다.
        });
    };
    load();
    const off = onServerEvent((e) => {
      // 조용한 작업은 보고할 때에만 대화방이 보이므로 report 때도 목록을 다시 읽습니다.
      if ((e.type === 'task.update' && e.task.agentId === agent.id && e.task.status === 'queued') || (e.type === 'report' && e.agentId === agent.id)) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [agent.id]);

  return (
    <div className="row">
      <div className="grow">
        <Chat key={source} agent={agent} source={source} threads={threads} onSource={setSource} />
      </div>
      <AgentPanel agent={agent} />
    </div>
  );
}

export function ConsolePage({ agentId }: { agentId: string | null }) {
  const overview = useApp((s) => s.overview) as Overview;
  const agent = agentId ? overview.agents.find((a) => a.id === agentId) : undefined;
  const first = overview.agents[0];

  useEffect(() => {
    if (!agentId && first) navigate(`/console/${first.id}`, { replace: true });
  }, [agentId, first]);

  if (overview.agents.length === 0) {
    return (
      <div className="card empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 48 }}>
        <Icon name="terminal" size={28} />
        <span>고용한 에이전트가 없습니다</span>
        <button type="button" className="btn primary" onClick={() => navigate('/hire')}>
          <Icon name="plus" size={16} stroke={2.4} />새 에이전트
        </button>
      </div>
    );
  }
  if (!agentId) return null;
  if (!agent) {
    return (
      <div className="card empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, padding: 48 }} role="alert">
        <span>에이전트 '{agentId}'를 찾을 수 없습니다. 삭제되었거나 주소가 잘못되었습니다.</span>
        <button type="button" className="btn" onClick={() => navigate('/')}>
          캔버스로
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="page-head">
        <h1>콘솔</h1>
      </div>
      <AgentConsole key={agent.id} agent={agent} />
    </>
  );
}
