import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, errorText } from '../lib/api';
import { compactTokens, uptime } from '../lib/format';
import { navigate, type Route } from '../lib/router';
import { toast, useApp } from '../lib/store';
import type { ApprovalView } from '../lib/types';
import { BrandMark, Icon } from './Icon';
import { Avatar, Modal, STATUS_LABEL } from './ui';

/** 화면용 짧은 모델 이름: 'Claude Opus 5.5' → 'Opus 5.5', 이름을 아직 모르면 'claude-opus-5-5' → 'opus-5-5' */
function shortModel(id: string, name: string | null): string {
  return name ? name.replace(/^Claude\s+/i, '') : id.replace(/^claude-/i, '');
}

function Search() {
  const overview = useApp((s) => s.overview);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term || !overview) return [];
    const out: { key: string; label: string; sub: string; go: () => void }[] = [];
    for (const a of overview.agents) if (a.name.toLowerCase().includes(term)) out.push({ key: a.id, label: a.name, sub: `에이전트 · ${shortModel(a.model, a.modelName)}`, go: () => navigate(`/console/${a.id}`) });
    for (const m of overview.modules) if (m.name.toLowerCase().includes(term) || m.id.includes(term)) out.push({ key: m.id, label: m.name, sub: `모듈 · v${m.version}`, go: () => navigate('/modules') });
    for (const s of overview.skills) if (s.name.toLowerCase().includes(term) || s.tools.some((t) => t.name.includes(term))) out.push({ key: s.id, label: s.name, sub: `스킬 · ${s.tools[0]?.name ?? ''}`, go: () => navigate('/modules') });
    return out.slice(0, 8);
  }, [q, overview]);

  const pick = (i: number): void => {
    const r = results[i];
    if (!r) return;
    r.go();
    setQ('');
    setOpen(false);
    ref.current?.blur();
  };

  return (
    <label className="search">
      <Icon name="search" size={16} stroke={1.9} />
      <input
        ref={ref}
        type="search"
        aria-label="검색"
        placeholder="에이전트 · 모듈 · 스킬"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(results.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            pick(active);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      <span className="kbd">⌘K</span>
      {open && q.trim() ? (
        <div className="search-results" role="listbox">
          {results.length === 0 ? (
            <div className="empty" style={{ padding: 12 }}>'{q.trim()}'와 맞는 항목이 없습니다</div>
          ) : (
            results.map((r, i) => (
              <button key={r.key} type="button" role="option" aria-selected={i === active} data-active={i === active} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(i)}>
                <span style={{ fontWeight: 600 }}>{r.label}</span>
                <span className="muted" style={{ fontSize: 12 }}>{r.sub}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </label>
  );
}

function ApprovalsModal({ onClose }: { onClose: () => void }) {
  const approvals = useApp((s) => s.approvals);
  const agents = useApp((s) => s.overview?.agents ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (a: ApprovalView, decision: 'once' | 'always' | 'deny'): Promise<void> => {
    setBusy(a.id);
    try {
      await api(`/api/approvals/${a.id}`, { body: { decision } });
      toast(decision === 'deny' ? '거부했습니다' : '허용했습니다', decision === 'deny' ? 'info' : 'ok');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal title={`승인 대기 ${approvals.length}`} onClose={onClose}>
      {approvals.length === 0 ? <div className="empty">대기 중인 승인 요청이 없습니다</div> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {approvals.map((a) => {
          const agent = agents?.find((x) => x.id === a.agentId);
          return (
            <div key={a.id} className="approval-card pending">
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                {agent ? <Avatar name={agent.name} color={agent.color} size={22} /> : null}
                <b style={{ fontSize: 13.5 }}>{agent?.name ?? '삭제된 에이전트'}</b>
                <span className="chip mono">{a.detail.permission ?? a.kind}</span>
                <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{a.detail.rule}</span>
              </div>
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{a.title}</div>
              {a.detail.input ? <pre className="codebox" style={{ maxHeight: 140 }}>{a.detail.input}</pre> : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="btn primary sm" disabled={busy === a.id} onClick={() => void decide(a, 'once')}>이번만 허용</button>
                {a.detail.permission && a.detail.target ? (
                  <button type="button" className="btn sm" disabled={busy === a.id} onClick={() => void decide(a, 'always')}>항상 허용</button>
                ) : null}
                <button type="button" className="btn danger sm" disabled={busy === a.id} onClick={() => void decide(a, 'deny')}>거부</button>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function TopBar({ onLogout }: { onLogout: () => void }) {
  const server = useApp((s) => s.overview?.server ?? null);
  const pending = useApp((s) => s.approvals.length);
  const connected = useApp((s) => s.connected);
  const [now, setNow] = useState(Date.now());
  const [showApprovals, setShowApprovals] = useState(false);
  const offset = useRef(0);

  useEffect(() => {
    if (server) offset.current = server.now - Date.now();
  }, [server]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="topbar">
      <button type="button" className="brand" onClick={() => navigate('/')}>
        <span className="brand-mark">
          <BrandMark />
        </span>
        <span className="brand-name">Switchboard</span>
      </button>
      <Search />
      <div className="top-right">
        {connected ? (
          <span className="pill">
            <span className="status-dot working" />
            가동 <b>{server ? uptime(now + offset.current - server.startedAt) : '--:--:--'}</b>
          </span>
        ) : (
          <span className="pill pill-off">
            <span className="spinner" style={{ width: 12, height: 12 }} />
            서버 연결 끊김 · 다시 연결 중
          </span>
        )}
        <span className="pill">
          오늘 <b>{compactTokens(server?.tokensToday ?? 0)}</b> 토큰
        </span>
        {pending > 0 ? (
          <button type="button" className="pill pill-warn" onClick={() => setShowApprovals(true)}>
            <span className="status-dot waiting" />
            승인 대기 {pending}
          </button>
        ) : null}
        <button type="button" className="icon-btn round" aria-label="로그아웃" title="로그아웃" onClick={onLogout}>
          <Icon name="logout" size={17} />
        </button>
      </div>
      {showApprovals ? <ApprovalsModal onClose={() => setShowApprovals(false)} /> : null}
    </header>
  );
}

const NAV: { page: Route['page']; label: string; icon: string; path: string }[] = [
  { page: 'canvas', label: '캔버스', icon: 'graph', path: '/' },
  { page: 'console', label: '콘솔', icon: 'terminal', path: '/console' },
  { page: 'modules', label: '모듈', icon: 'cube', path: '/modules' },
  { page: 'guard', label: '권한 · 훅', icon: 'shield', path: '/guard' },
  { page: 'theme', label: '테마', icon: 'palette', path: '/theme' },
];

function Sidebar({ route }: { route: Route }) {
  const overview = useApp((s) => s.overview);
  const agents = overview?.agents ?? [];
  const moduleCount = (overview?.modules.length ?? 0) + (overview?.skills.length ?? 0);
  return (
    <nav className="sidebar" aria-label="주 메뉴">
      <div className="nav-list">
        {NAV.map((n) => (
          <button key={n.page} type="button" className="nav-item" aria-current={route.page === n.page ? 'page' : undefined} onClick={() => navigate(n.path)}>
            <Icon name={n.icon} />
            {n.label}
            {n.page === 'modules' ? <span className="nav-count">{moduleCount}</span> : null}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="side-head">
          <span>에이전트 {agents.length}</span>
          <button type="button" className="icon-btn" style={{ width: 30, height: 30, border: 0 }} aria-label="새 에이전트" onClick={() => navigate('/hire')}>
            <Icon name="plus" size={16} stroke={2} />
          </button>
        </div>
        <div className="nav-list">
          {agents.map((a) => (
            <button key={a.id} type="button" className="agent-row" aria-current={route.page === 'console' && route.param === a.id} onClick={() => navigate(`/console/${a.id}`)}>
              <Avatar name={a.name} color={a.color} status={a.paused ? 'paused' : a.status} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{a.name}</span>
                <span className="sub">
                  {shortModel(a.model, a.modelName)} · {a.paused ? '일시정지' : STATUS_LABEL[a.status]}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </nav>
  );
}

export function Shell({ route, onLogout, children }: { route: Route; onLogout: () => void; children: ReactNode }) {
  return (
    <div className="app">
      <TopBar onLogout={onLogout} />
      <div className="body">
        <Sidebar route={route} />
        <main className="main">{children}</main>
      </div>
    </div>
  );
}

export { shortModel };
