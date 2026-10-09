import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, ChipInput, Modal, ModuleIcon, Seg, Switch } from '../components/ui';
import { api, errorText } from '../lib/api';
import { relTime } from '../lib/format';
import { navigate } from '../lib/router';
import { refreshOverview, toast, useApp } from '../lib/store';
import type { AgentView, InstallCheck, InstallReport, ModuleStatus, ModuleView, Overview } from '../lib/types';

/** 서버 요청 본문 한도(16MB) 안에 base64 로 들어가는 크기 */
const ZIP_MAX_BYTES = 12_000_000;
const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

type Filter = 'all' | 'channel' | 'tool' | 'skill' | 'agent' | 'pending';

const STATUS_VIEW: Record<ModuleStatus, { text: string; tone: 'ok' | 'warn' | 'bad' | '' }> = {
  running: { text: '실행 중', tone: 'ok' },
  idle: { text: '대기', tone: 'ok' },
  starting: { text: '시작 중', tone: 'warn' },
  stopped: { text: '중지됨', tone: '' },
  crashed: { text: '다시 시작 중', tone: 'warn' },
  failed: { text: '시작 실패', tone: 'bad' },
  pending: { text: '승인 대기', tone: 'warn' },
  rejected: { text: '거부됨', tone: 'bad' },
};

const ORIGIN_LABEL: Record<ModuleView['origin'], string> = { builtin: '기본 제공', git: 'Git', zip: '파일', template: '템플릿', agent: '에이전트 제작' };

interface StagedView {
  token: string;
  id: string;
  name: string;
  version: string;
  report: InstallReport;
}

interface SourceFile {
  path: string;
  content: string;
}

interface Template {
  id: string;
  name: string;
  description: string;
  files: string[];
  env: number;
}

function checkCounts(checks: InstallCheck[]): { ok: number; warn: number; error: number } {
  let ok = 0;
  let warn = 0;
  let error = 0;
  for (const c of checks) {
    if (c.level === 'ok') ok += 1;
    else if (c.level === 'warn') warn += 1;
    else error += 1;
  }
  return { ok, warn, error };
}

function CheckList({ checks }: { checks: InstallCheck[] }) {
  return (
    <ul className="check-list">
      {checks.map((c, i) => (
        <li key={`${c.label}-${i}`} style={{ animationDelay: `${Math.min(i, 10) * 0.04}s` }}>
          {c.level === 'ok' ? (
            <span className="ok-dot">
              <Icon name="check" size={11} stroke={3} />
            </span>
          ) : c.level === 'warn' ? (
            <span className="warn-dot">!</span>
          ) : (
            <span className="bad-dot">
              <Icon name="x" size={11} stroke={3} />
            </span>
          )}
          <span style={{ fontWeight: 600 }}>{c.label}</span>
          <span className={c.level === 'error' ? undefined : 'dim'} style={{ color: c.level === 'error' ? 'var(--danger)' : undefined, overflowWrap: 'anywhere' }}>
            {c.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function CheckSummary({ checks }: { checks: InstallCheck[] }) {
  const n = checkCounts(checks);
  return (
    <span className="chips">
      {n.error > 0 ? <span className="chip bad">오류 {n.error}</span> : null}
      {n.warn > 0 ? <span className="chip warn">주의 {n.warn}</span> : null}
      <span className="chip ok">통과 {n.ok}</span>
    </span>
  );
}

/* ───────── 코드 · 로그 ───────── */

function CodeModal({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const [files, setFiles] = useState<SourceFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    api<{ files: SourceFile[] }>(url, { signal: ac.signal })
      .then((r) => setFiles(r.files))
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') setError(errorText(err));
      });
    return () => ac.abort();
  }, [url]);
  const file = files?.[active];
  return (
    <Modal title={`${title} · 코드`} onClose={onClose}>
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
      {!files && !error ? <span className="spinner" /> : null}
      {files ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <div role="tablist" aria-label="파일" style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '60vh', overflowY: 'auto' }}>
            {files.map((f, i) => (
              <button key={f.path} type="button" role="tab" aria-selected={i === active} className="hook-item mono" style={{ fontSize: 12 }} aria-pressed={i === active} onClick={() => setActive(i)}>
                {f.path}
              </button>
            ))}
          </div>
          <pre className="codebox" style={{ flex: '999 1 360px', minWidth: 0, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre' }} role="tabpanel">
            {file?.content ?? ''}
          </pre>
        </div>
      ) : null}
    </Modal>
  );
}

function LogsModal({ module, onClose }: { module: ModuleView; onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => {
      api<{ lines: string[] }>(`/api/modules/${module.id}/logs`)
        .then((r) => {
          if (alive) {
            setLines(r.lines);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (alive) setError(errorText(err));
        });
    };
    load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [module.id]);
  return (
    <Modal title={`${module.name} · 로그`} onClose={onClose}>
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
      {lines && lines.length === 0 ? <div className="empty">기록이 없습니다</div> : null}
      {lines && lines.length > 0 ? (
        <pre className="codebox" style={{ maxHeight: '60vh', overflow: 'auto' }}>
          {lines.join('\n')}
        </pre>
      ) : null}
    </Modal>
  );
}

/* ───────── 에이전트 연결 ───────── */

interface Draft {
  on: boolean;
  targets: string[];
  trigger: 'direct' | 'all' | 'none';
}

function LinksModal({ module, agents, onClose }: { module: ModuleView; agents: AgentView[]; onClose: () => void }) {
  const initial = useMemo(() => {
    const out: Record<string, Draft> = {};
    for (const a of agents) {
      const l = a.links.find((x) => x.moduleId === module.id);
      out[a.id] = { on: Boolean(l), targets: l?.targets ?? [], trigger: l?.trigger ?? 'direct' };
    }
    return out;
  }, [agents, module.id]);
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const changed = agents.filter((a) => JSON.stringify(draft[a.id]) !== JSON.stringify(initial[a.id]));

  const save = async (): Promise<void> => {
    setBusy(true);
    const errs: Record<string, string> = {};
    for (const a of changed) {
      const d = draft[a.id];
      if (!d) continue;
      const others = a.links.filter((l) => l.moduleId !== module.id);
      const links = d.on ? [...others, { moduleId: module.id, targets: d.targets, trigger: d.trigger }] : others;
      try {
        await api(`/api/agents/${a.id}/modules`, { method: 'PUT', body: { links } });
      } catch (err) {
        errs[a.id] = errorText(err);
      }
    }
    setErrors(errs);
    setBusy(false);
    refreshOverview(0);
    if (Object.keys(errs).length === 0) {
      toast(`${module.name} 연결을 저장했습니다`, 'ok');
      onClose();
    }
  };

  return (
    <Modal title={`${module.name} · 연결`} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {agents.length === 0 ? <div className="empty">에이전트가 없습니다</div> : null}
        {agents.map((a) => {
          const d = draft[a.id] ?? { on: false, targets: [], trigger: 'direct' as const };
          const set = (patch: Partial<Draft>): void => setDraft((x) => ({ ...x, [a.id]: { ...d, ...patch } }));
          return (
            <div key={a.id} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '10px 12px', borderRadius: 12, background: 'var(--panel)', border: `1px solid ${d.on ? 'color-mix(in srgb, var(--msg) 40%, transparent)' : 'var(--line)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Avatar name={a.name} color={a.color} size={28} />
                <b style={{ fontSize: 14 }}>{a.name}</b>
                <span style={{ marginLeft: 'auto' }}>
                  <Switch checked={d.on} label={`${a.name} 연결`} onChange={(on) => set({ on })} />
                </span>
              </div>
              {d.on && module.canSend ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingLeft: 38 }}>
                  <ChipInput value={d.targets} onChange={(targets) => set({ targets })} label={`${a.name} 대상`} placeholder="모든 대화 · #채널 또는 ID" />
                  <Seg
                    value={d.trigger}
                    options={[
                      { value: 'direct', label: '부를 때만' },
                      { value: 'all', label: '모든 메시지' },
                    ]}
                    onChange={(trigger) => set({ trigger })}
                    label={`${a.name} 응답 방식`}
                  />
                </div>
              ) : null}
              {d.on && !module.canSend && module.channel ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingLeft: 38 }}>
                  <Seg
                    value={d.trigger === 'none' ? 'none' : 'direct'}
                    options={[
                      { value: 'direct', label: '알림 받기' },
                      { value: 'none', label: '도구만' },
                    ]}
                    onChange={(trigger) => set({ trigger })}
                    label={`${a.name} 받는 방식`}
                  />
                </div>
              ) : null}
              {errors[a.id] ? <span className="err">{errors[a.id]}</span> : null}
            </div>
          );
        })}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn primary" disabled={busy || changed.length === 0} onClick={() => void save()}>
            {busy ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
            저장
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ───────── 모듈 카드 ───────── */

function ModuleCard({ m, agents, index }: { m: ModuleView; agents: AgentView[]; index: number }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [modal, setModal] = useState<'code' | 'logs' | 'links' | 'delete' | null>(null);
  const status = STATUS_VIEW[m.status];
  const linked = agents.filter((a) => a.links.some((l) => l.moduleId === m.id));
  const missing = m.settingsMissing;
  const pending = m.status === 'pending';
  const failed = m.status === 'failed' || m.status === 'crashed';
  // 승인 대기 카드는 주황 테두리를 지키도록 '새로 설치됨' 강조에서 뺍니다.
  const fresh = !pending && (m.isNew ?? (Date.now() - m.installedAt < 10 * 60_000 && m.origin === 'agent'));

  const run = async (what: string, fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(what);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
      refreshOverview(0);
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const reloadEnv = (): Promise<void> =>
    run('env', async () => {
      const r = await api<{ changed: string[]; missing: string[] }>(`/api/modules/${m.id}/reload-env`, { body: {} });
      if (r.missing.length > 0) toast(`아직 비어 있는 필수 설정: ${r.missing.join(', ')}`, 'error');
      else toast(r.changed.length > 0 ? `${r.changed.join(', ')} 를 다시 읽어 ${m.enabled ? '다시 시작했습니다' : '반영했습니다'}` : '.env 에서 바뀐 값이 없습니다', r.changed.length > 0 ? 'ok' : 'info');
    });

  return (
    <article className={`card mod-card${!m.enabled && !pending ? ' off' : ''}${pending ? ' pending' : ''}${failed ? ' failed' : ''}${fresh ? ' fresh' : ''}`} style={{ animationDelay: `${Math.min(index, 10) * 0.04}s` }} aria-label={m.name}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 38, height: 38, flex: 'none', borderRadius: 10, display: 'grid', placeItems: 'center', background: m.kind === 'skill' ? 'var(--skill-dim)' : m.channel ? 'var(--msg-dim)' : 'var(--raised)', color: m.kind === 'skill' ? 'var(--skill)' : m.channel ? 'var(--msg)' : 'var(--text2)' }}>
          {m.kind === 'skill' ? <Icon name="bolt" size={18} stroke={2} /> : <ModuleIcon icon={m.icon} size={19} />}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
            <b style={{ fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name}</b>
            <span className="mono muted" style={{ fontSize: 11.5 }}>
              v{m.version}
            </span>
          </span>
          <span className="muted" style={{ fontSize: 12 }}>
            {m.createdByName ? `${m.createdByName} 제작` : ORIGIN_LABEL[m.origin]} · {relTime(m.installedAt)}
          </span>
        </div>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className={`chip ${!m.enabled && !pending ? '' : status.tone}`}>{!m.enabled && !pending ? '꺼짐' : status.text}</span>
          {!pending ? <Switch checked={m.enabled} label={`${m.name} 켜기`} disabled={busy !== null} onChange={(on) => void run('enable', () => api(`/api/modules/${m.id}/enabled`, { body: { enabled: on } }))} /> : null}
        </span>
      </div>
      {m.description ? (
        <p className="dim" style={{ margin: 0, fontSize: 13 }}>
          {m.description}
        </p>
      ) : null}
      <div className="kv">
        <span>제공</span>
        <span className="chips">
          {m.channel ? <span className="chip msg">{m.canSend ? '채널' : '받기 전용 채널'}</span> : null}
          {m.computer ? <span className="chip warn">화면 제어{m.screenHolder ? ` · ${m.screenHolder.agentName} 사용 중` : ''}</span> : null}
          {m.tools.map((t) => (
            <span key={t.name} className="chip mono skill" title={t.title}>
              {t.name}
            </span>
          ))}
          {!m.channel && !m.computer && m.tools.length === 0 ? <span className="muted">없음</span> : null}
        </span>
        <span>에이전트</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          {linked.length === 0 ? <span className="muted">연결 없음</span> : null}
          {linked.map((a) => (
            <span key={a.id} title={a.name}>
              <Avatar name={a.name} color={a.color} size={22} />
            </span>
          ))}
        </span>
        <span>설정</span>
        <span className="chips">
          {m.env.length === 0 ? <span className="muted">필요 없음</span> : null}
          {m.env.map((e) => (
            <span key={e.name} title={e.name} className={`chip ${e.source === 'db' ? 'ok' : e.source === 'env' ? 'warn' : e.required ? 'bad' : ''}`}>
              {e.source === 'db' ? '✓ ' : e.source === 'env' ? '.env ' : e.source === 'locked' ? '풀 수 없음 ' : e.required ? '✗ ' : ''}
              {e.label}
              {e.source === 'empty' && !e.required ? ' · 기본값' : ''}
            </span>
          ))}
        </span>
        <span>권한</span>
        <span className="chips">
          {m.permissions.net.map((h) => (
            <span key={h} className="chip mono">
              {h === '*' ? '모든 주소' : h}
            </span>
          ))}
          {m.permissions.fsWrite ? <span className="chip">파일 쓰기</span> : null}
          {m.permissions.childProcess ? <span className="chip warn">하위 프로세스</span> : null}
          {m.permissions.net.length === 0 && !m.permissions.fsWrite && !m.permissions.childProcess ? <span className="muted">외부 접속 없음</span> : null}
        </span>
        <span>라이선스</span>
        <span className="mono" style={{ fontSize: 12 }}>
          {m.license}
        </span>
      </div>
      {failed && m.statusDetail ? (
        <div className="alert" role="alert">
          <Icon name="x" size={14} stroke={2.6} />
          <span style={{ overflowWrap: 'anywhere' }}>{m.statusDetail}</span>
        </div>
      ) : null}
      {!failed && m.enabled && m.status === 'running' && m.statusDetail ? (
        <div className="alert warn" role="status">
          <Icon name="alert" size={14} stroke={2.4} />
          <span style={{ overflowWrap: 'anywhere' }}>{m.statusDetail}</span>
        </div>
      ) : null}
      {missing.length > 0 && !pending ? (
        <div className="alert warn">
          <Icon name="key" size={14} stroke={2.2} />
          <span style={{ flex: 1 }}>설정 필요 · {missing.join(', ')}</span>
          <button type="button" className="btn xs light" onClick={() => navigate(`/settings/${encodeURIComponent(m.id)}`)}>
            설정
          </button>
        </div>
      ) : null}
      {missing.length === 0 && m.envLeft.length > 0 && !pending ? (
        <div className="alert warn">
          <Icon name="doc" size={14} stroke={2.2} />
          <span style={{ flex: 1 }}>.env에서 읽는 중 · {m.envLeft.join(', ')}</span>
          <button
            type="button"
            className="btn xs warn-solid"
            disabled={busy !== null}
            onClick={() =>
              void run('move', async () => {
                const r = await api<{ moved: string[] }>('/api/settings/import-env', { body: { moduleId: m.id } });
                toast(r.moved.length > 0 ? `${r.moved.join(', ')} 를 DB로 옮겼습니다. .env 에서 그 줄을 지워도 됩니다.` : '.env 에서 옮길 값이 없습니다.', 'ok');
              })
            }
          >
            DB로 옮기기
          </button>
        </div>
      ) : null}
      {pending && m.report ? (
        <>
          <CheckSummary checks={m.report.checks} />
          <CheckList checks={m.report.checks} />
        </>
      ) : null}
      <div className="card-actions">
        <button type="button" className="btn xs" onClick={() => setModal('code')}>
          <Icon name="code" size={13} stroke={2.2} />
          코드 보기
        </button>
        {pending ? (
          <>
            <button type="button" className="btn xs primary" disabled={busy !== null} onClick={() => void run('approve', () => api(`/api/modules/${m.id}/approve`, { body: {} }), `${m.name} 설치를 승인했습니다`)}>
              승인
            </button>
            <button type="button" className="btn xs danger" disabled={busy !== null} onClick={() => void run('reject', () => api(`/api/modules/${m.id}/reject`, { body: {} }), `${m.name} 설치를 거부했습니다`)}>
              거부
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn xs" onClick={() => setModal('links')}>
              <Icon name="link" size={13} stroke={2.2} />
              연결
            </button>
            <button type="button" className="btn xs" onClick={() => setModal('logs')}>
              <Icon name="logs" size={13} stroke={2.2} />
              로그
            </button>
            {m.env.length > 0 ? (
              <button type="button" className="btn xs" onClick={() => navigate(`/settings/${encodeURIComponent(m.id)}`)}>
                <Icon name="key" size={13} stroke={2.2} />
                설정
              </button>
            ) : null}
            {m.envLeft.length > 0 ? (
              <button type="button" className="btn xs" disabled={busy !== null} onClick={() => void reloadEnv()}>
                {busy === 'env' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="refresh" size={13} stroke={2.2} />}
                .env 다시 읽기
              </button>
            ) : null}
            {m.enabled && (m.channel || m.computer) ? (
              <button type="button" className="btn xs" disabled={busy !== null} onClick={() => void run('restart', () => api(`/api/modules/${m.id}/restart`, { body: {} }), `${m.name} 다시 시작`)}>
                다시 시작
              </button>
            ) : null}
            {m.origin !== 'builtin' ? (
              <button type="button" className="btn xs danger" style={{ marginLeft: 'auto' }} onClick={() => setModal('delete')}>
                <Icon name="trash" size={13} />
              </button>
            ) : null}
          </>
        )}
      </div>
      {modal === 'code' ? <CodeModal title={m.name} url={`/api/modules/${m.id}/files`} onClose={() => setModal(null)} /> : null}
      {modal === 'logs' ? <LogsModal module={m} onClose={() => setModal(null)} /> : null}
      {modal === 'links' ? <LinksModal module={m} agents={agents} onClose={() => setModal(null)} /> : null}
      {modal === 'delete' ? (
        <Modal title={`${m.name} 삭제`} onClose={() => setModal(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <span>{linked.length > 0 ? `연결된 에이전트 ${linked.length}명에서 빠지고 ` : ''}모듈 파일이 지워지며 되돌릴 수 없습니다.</span>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" className="btn" onClick={() => setModal(null)}>
                취소
              </button>
              <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void run('delete', () => api(`/api/modules/${m.id}`, { method: 'DELETE' }), `${m.name}을(를) 삭제했습니다`).then(() => setModal(null))}>
                삭제
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </article>
  );
}

/* ───────── 추가 ───────── */

function StagedResult({ staged, onDone }: { staged: StagedView; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState(false);
  const blocking = staged.report.checks.some((c) => c.level === 'error');
  const install = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/modules/install', { body: { token: staged.token } });
      toast(`${staged.name} 설치 완료`, 'ok');
      refreshOverview(0);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const discard = (): void => {
    void api('/api/modules/discard', { body: { token: staged.token } }).catch(() => {});
    onDone();
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'rise .3s ease backwards' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <b style={{ fontSize: 15 }}>{staged.name}</b>
        <span className="mono muted" style={{ fontSize: 12 }}>
          {staged.id} · v{staged.version}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <CheckSummary checks={staged.report.checks} />
        </span>
      </div>
      <CheckList checks={staged.report.checks} />
      {staged.report.commit ? (
        <span className="mono muted" style={{ fontSize: 11.5 }}>
          커밋 {staged.report.commit.slice(0, 12)}
        </span>
      ) : null}
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn sm" onClick={() => setCode(true)}>
          <Icon name="code" size={14} stroke={2.2} />
          코드 보기
        </button>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn sm" onClick={discard}>
          취소
        </button>
        <button type="button" className="btn sm primary" disabled={busy || blocking} onClick={() => void install()}>
          {busy ? <span className="spinner" style={{ width: 13, height: 13, borderTopColor: 'var(--onAccent)' }} /> : null}
          설치
        </button>
      </div>
      {code ? <CodeModal title={staged.name} url={`/api/modules/staged/${encodeURIComponent(staged.token)}/files`} onClose={() => setCode(false)} /> : null}
    </div>
  );
}

function GitTab({ onStaged }: { onStaged: (s: StagedView) => void }) {
  const [url, setUrl] = useState('');
  const [ref, setRef] = useState('main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onStaged(await api<StagedView>('/api/modules/check/git', { body: { url: url.trim(), ref: ref.trim() || 'main' } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        void check();
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '3 1 280px' }}>
          저장소
          <input className={`input mono${error ? ' bad' : ''}`} style={{ fontSize: 13 }} placeholder="https://github.com/owner/repo" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        </label>
        <label className="field" style={{ flex: '1 1 120px' }}>
          태그 · 커밋
          <input className="input mono" style={{ fontSize: 13 }} value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} />
        </label>
        <button type="submit" className="btn primary" disabled={busy || url.trim() === ''}>
          {busy ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
          검사
        </button>
      </div>
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(`'${file.name}' 파일을 읽지 못했습니다: ${r.error?.message ?? '알 수 없는 오류'}`));
    r.onload = () => {
      const s = String(r.result);
      const comma = s.indexOf(',');
      resolve(comma === -1 ? '' : s.slice(comma + 1));
    };
    r.readAsDataURL(file);
  });
}

function ZipTab({ onStaged }: { onStaged: (s: StagedView) => void }) {
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null);
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setError(`zip 파일만 올릴 수 있습니다. 고른 파일: ${file.name}`);
      return;
    }
    if (file.size > ZIP_MAX_BYTES) {
      setError(`zip 파일은 ${ZIP_MAX_BYTES / 1_000_000}MB 까지 올릴 수 있습니다. 고른 파일은 ${(file.size / 1_000_000).toFixed(1)}MB 입니다. node_modules 없이 소스만 압축하세요.`);
      return;
    }
    if (file.size === 0) {
      setError(`'${file.name}' 은(는) 빈 파일입니다.`);
      return;
    }
    setBusy(true);
    try {
      const data = await readBase64(file);
      onStaged(await api<StagedView>('/api/modules/check/zip', { body: { fileName: file.name, data } }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(e.dataTransfer.files[0]);
        }}
      >
        {busy ? <span className="spinner" style={{ width: 22, height: 22 }} /> : <Icon name="upload" size={24} />}
        <span className="mono dim">module.zip</span>
        <button type="button" className="btn sm" disabled={busy} onClick={() => input.current?.click()}>
          파일 선택
        </button>
        <input ref={input} type="file" accept=".zip,application/zip" className="sr-only" tabIndex={-1} onChange={(e) => void upload(e.target.files?.[0])} />
      </div>
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

function TemplateTab({ onCreated }: { onCreated: () => void }) {
  const [list, setList] = useState<Template[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: Template[] }>('/api/templates')
      .then((r) => {
        setList(r.templates);
        setPick(r.templates[0]?.id ?? null);
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, []);

  const idProblem = id === '' ? null : MODULE_ID_RE.test(id) ? null : 'id 는 영문 소문자로 시작하고 소문자·숫자·하이픈만, 2~32자여야 합니다 (예: notion-sync).';
  const create = async (): Promise<void> => {
    if (!pick) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/modules/template', { body: { template: pick, id, name: name.trim() } });
      toast(`${name.trim() || id} 모듈을 만들었습니다 · 꺼진 상태`, 'ok');
      refreshOverview(0);
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <span className="err">{loadError}</span>;
  if (!list) return <span className="spinner" />;
  if (list.length === 0) return <div className="empty">templates 폴더에 템플릿이 없습니다</div>;
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <div className="pick-grid" role="radiogroup" aria-label="템플릿">
        {list.map((t, i) => (
          <button key={t.id} type="button" role="radio" aria-checked={pick === t.id} className="pick" style={{ animationDelay: `${i * 0.04}s` }} onClick={() => setPick(t.id)}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <b>{t.name}</b>
              <span className="radio" />
            </span>
            <span className="dim" style={{ fontSize: 12.5 }}>
              {t.description}
            </span>
            <span className="mono muted" style={{ fontSize: 11.5 }}>
              {t.files.join(' · ')}
            </span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' }}>
        <label className="field" style={{ flex: '1 1 180px' }}>
          id
          <input className={`input mono${idProblem ? ' bad' : ''}`} style={{ fontSize: 13 }} placeholder="my-module" value={id} maxLength={32} onChange={(e) => setId(e.target.value.toLowerCase())} spellCheck={false} />
        </label>
        <label className="field" style={{ flex: '1 1 180px' }}>
          이름
          <input className="input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" className="btn primary" disabled={busy || !pick || id === '' || idProblem !== null}>
          {busy ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
          만들기
        </button>
      </div>
      {idProblem ? <span className="err">{idProblem}</span> : null}
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
    </form>
  );
}

function RequestTab({ agents }: { agents: AgentView[] }) {
  const [agentId, setAgentId] = useState<string | null>(agents[0]?.id ?? null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async (): Promise<void> => {
    if (!agentId) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/modules/request', { body: { agentId, text: text.trim() } });
      toast('요청을 보냈습니다', 'ok');
      navigate(`/console/${agentId}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (agents.length === 0) {
    return (
      <div className="empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
        <span>에이전트가 없습니다</span>
        <button type="button" className="btn sm" onClick={() => navigate('/hire')}>
          새 에이전트
        </button>
      </div>
    );
  }
  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div role="radiogroup" aria-label="맡길 에이전트" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {agents.map((a) => (
          <button key={a.id} type="button" role="radio" aria-checked={agentId === a.id} className="pick" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 10, animation: 'none' }} onClick={() => setAgentId(a.id)}>
            <Avatar name={a.name} color={a.color} size={24} />
            <b style={{ fontSize: 13.5 }}>{a.name}</b>
          </button>
        ))}
      </div>
      <textarea className={`textarea${error ? ' bad' : ''}`} rows={4} maxLength={4000} placeholder="예: 매일 아침 9시에 날씨를 가져와 디스코드 #general 에 보내는 모듈" value={text} onChange={(e) => setText(e.target.value)} aria-label="만들 모듈 설명" />
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="submit" className="btn primary" disabled={busy || !agentId || text.trim().length < 5}>
          {busy ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : <Icon name="arrowUp" size={15} stroke={2.4} />}
          요청
        </button>
      </div>
    </form>
  );
}

type AddTab = 'git' | 'zip' | 'template' | 'request';
const ADD_TABS: { id: AddTab; label: string; icon: string }[] = [
  { id: 'git', label: 'Git 저장소', icon: 'git' },
  { id: 'zip', label: 'zip 파일', icon: 'upload' },
  { id: 'template', label: '템플릿', icon: 'doc' },
  { id: 'request', label: '에이전트에게 요청', icon: 'chat' },
];

function AddPanel({ agents, onClose }: { agents: AgentView[]; onClose: () => void }) {
  const [tab, setTab] = useState<AddTab>('git');
  const [staged, setStaged] = useState<StagedView | null>(null);
  let body: ReactNode;
  if (staged) body = <StagedResult staged={staged} onDone={() => setStaged(null)} />;
  else if (tab === 'git') body = <GitTab onStaged={setStaged} />;
  else if (tab === 'zip') body = <ZipTab onStaged={setStaged} />;
  else if (tab === 'template') body = <TemplateTab onCreated={onClose} />;
  else body = <RequestTab agents={agents} />;
  return (
    <section className="card" style={{ animation: 'rise .3s ease backwards', overflow: 'hidden' }} aria-label="모듈 추가">
      <div className="tabs" role="tablist">
        {ADD_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={staged !== null && tab !== t.id}
            onClick={() => setTab(t.id)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
          >
            <Icon name={t.icon} size={15} />
            {t.label}
          </button>
        ))}
        <button type="button" aria-label="닫기" style={{ marginLeft: 'auto' }} onClick={onClose}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="card-pad" role="tabpanel">
        {body}
      </div>
    </section>
  );
}

/* ───────── 페이지 ───────── */

export function ModulesPage() {
  const overview = useApp((s) => s.overview) as Overview;
  const [filter, setFilter] = useState<Filter>('all');
  const [adding, setAdding] = useState(false);
  const all = useMemo(() => [...overview.modules, ...overview.skills].filter((m) => m.status !== 'rejected'), [overview.modules, overview.skills]);
  const counts: Record<Filter, number> = {
    all: all.length,
    channel: all.filter((m) => m.channel).length,
    tool: all.filter((m) => m.kind === 'module' && !m.channel).length,
    skill: all.filter((m) => m.kind === 'skill').length,
    agent: all.filter((m) => m.origin === 'agent').length,
    pending: all.filter((m) => m.status === 'pending').length,
  };
  const filters: { value: Filter; label: string }[] = [
    { value: 'all', label: `전체 ${counts.all}` },
    { value: 'channel', label: `채널 ${counts.channel}` },
    { value: 'tool', label: `도구 ${counts.tool}` },
    { value: 'skill', label: `스킬 ${counts.skill}` },
    { value: 'agent', label: `에이전트 제작 ${counts.agent}` },
    ...(counts.pending > 0 ? [{ value: 'pending' as const, label: `승인 대기 ${counts.pending}` }] : []),
  ];
  const shown = all
    .filter((m) => {
      switch (filter) {
        case 'channel':
          return m.channel;
        case 'tool':
          return m.kind === 'module' && !m.channel;
        case 'skill':
          return m.kind === 'skill';
        case 'agent':
          return m.origin === 'agent';
        case 'pending':
          return m.status === 'pending';
        default:
          return true;
      }
    })
    .sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || b.installedAt - a.installedAt);

  return (
    <>
      <div className="page-head">
        <h1>모듈</h1>
        <Seg value={filter} options={filters} onChange={setFilter} label="모듈 종류" />
        <button type="button" className={`btn ${adding ? '' : 'primary'}`} style={{ marginLeft: 'auto' }} aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Icon name={adding ? 'x' : 'plus'} size={16} stroke={2.4} />
          {adding ? '닫기' : '모듈 추가'}
        </button>
      </div>
      {adding ? <AddPanel agents={overview.agents} onClose={() => setAdding(false)} /> : null}
      {shown.length === 0 ? <div className="card empty">해당하는 모듈이 없습니다</div> : null}
      <div className="mod-grid">
        {shown.map((m, i) => (
          <ModuleCard key={m.id} m={m} agents={overview.agents} index={i} />
        ))}
      </div>
    </>
  );
}
