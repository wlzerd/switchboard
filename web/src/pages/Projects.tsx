import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, Switch } from '../components/ui';
import { api, errorText } from '../lib/api';
import { relTime } from '../lib/format';
import { originLabel, projectRowView, projectsBy, type ProjectFilter } from '../lib/projects';
import { navigate } from '../lib/router';
import { onServerEvent, toast, useApp } from '../lib/store';
import type { AgentView, ProjectDetail, ProjectEvent, ProjectOrigin, ProjectView } from '../lib/types';

const ORIGINS: (ProjectOrigin | 'all')[] = ['all', 'instruction', 'self', 'delegation', 'manual'];
const EVENT_ICON: Record<ProjectEvent['kind'], string> = { write: 'pen', read: 'doc', list: 'folder', shell: 'terminal', commit: 'commit' };

/** 관리 중인 프로젝트: 에이전트가 사용자 지시로 · 스스로 · 위임으로 맡은 경로와 그 활동 */
export function ProjectsPage({ projectId }: { projectId: string | null }) {
  const overview = useApp((s) => s.overview);
  const agents = useMemo(() => overview?.agents ?? [], [overview]);
  const [projects, setProjects] = useState<ProjectView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProjectFilter>({ agent: 'all', origin: 'all', query: '' });
  const [selected, setSelected] = useState<string | null>(projectId);
  const [addOpen, setAddOpen] = useState(false);
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    api<{ projects: ProjectView[] }>('/api/projects')
      .then((r) => {
        if (!alive) return;
        setProjects(r.projects);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  // 에이전트가 프로젝트를 등록 · 해제하거나 그 안에서 일하면 다시 읽습니다 (잦은 변화는 묶어서).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onServerEvent((e) => {
      const relevant = e.type === 'graph.changed' || (e.type === 'activity' && e.item.type.startsWith('project.')) || (e.type === 'task.update' && e.task.status === 'done');
      if (!relevant) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 400);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  useEffect(() => setSelected(projectId), [projectId]);

  const visible = useMemo(() => projectsBy(projects ?? [], filter), [projects, filter]);
  const current = useMemo(() => (projects ?? []).find((p) => p.id === selected) ?? visible[0] ?? null, [projects, selected, visible]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const pick = (id: string): void => {
    setSelected(id);
    navigate(`/projects/${id}`, { replace: true });
  };

  const counts = (key: 'agentId' | 'origin', value: string): number => (projects ?? []).filter((p) => p[key] === value).length;

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="page-head">
        <h1 style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          프로젝트<span className="mono" style={{ fontSize: 14, fontWeight: 500, color: 'var(--text3)' }}>{projects?.length ?? ''}</span>
        </h1>
        <label className="search" style={{ flex: '0 1 260px' }}>
          <Icon name="search" size={15} />
          <input type="search" aria-label="프로젝트 검색" placeholder="이름 · 경로" value={filter.query} onChange={(e) => setFilter({ ...filter, query: e.target.value })} />
        </label>
        <button type="button" className={`btn ${addOpen ? '' : 'primary'}`} style={{ marginLeft: 'auto' }} aria-expanded={addOpen} onClick={() => setAddOpen(!addOpen)}>
          <Icon name="plus" size={16} stroke={2.4} className={addOpen ? 'rot45' : undefined} />
          {addOpen ? '닫기' : '경로 추가'}
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 12px' }}>
        <div className="seg filter" role="group" aria-label="에이전트">
          <button type="button" aria-pressed={filter.agent === 'all'} onClick={() => setFilter({ ...filter, agent: 'all' })}>
            전체<span className="nav-count">{projects?.length ?? 0}</span>
          </button>
          {agents.map((a) => (
            <button key={a.id} type="button" aria-pressed={filter.agent === a.id} onClick={() => setFilter({ ...filter, agent: a.id })}>
              <span className="status-dot" style={{ background: a.color }} />
              {a.name}
              <span className="nav-count">{counts('agentId', a.id)}</span>
            </button>
          ))}
        </div>
        <div className="seg filter" role="group" aria-label="등록한 계기">
          {ORIGINS.map((o) => (
            <button key={o} type="button" aria-pressed={filter.origin === o} onClick={() => setFilter({ ...filter, origin: o })}>
              {o === 'all' ? '전체' : originLabel(o)}
              <span className="nav-count">{o === 'all' ? (projects?.length ?? 0) : counts('origin', o)}</span>
            </button>
          ))}
        </div>
      </div>

      {addOpen ? (
        <AddProject
          agents={agents}
          onDone={(p) => {
            setAddOpen(false);
            setFilter({ agent: 'all', origin: 'all', query: '' });
            setProjects((cur) => [p, ...(cur ?? []).filter((x) => x.id !== p.id)]);
            pick(p.id);
          }}
        />
      ) : null}

      {error ? (
        <div className="card card-pad" role="alert">
          <b>프로젝트를 불러오지 못했습니다</b>
          <p className="dim">{error}</p>
          <button type="button" className="btn sm" onClick={reload}>
            다시 불러오기
          </button>
        </div>
      ) : projects === null ? (
        <div className="empty">
          <span className="spinner" />
        </div>
      ) : (
        <div className="row">
          <section aria-label="프로젝트 목록" className="grow proj-list">
            {visible.length === 0 ? (
              <div className="empty proj-empty">
                <Icon name="folder" size={28} stroke={1.6} />
                {projects.length === 0 ? '관리 중인 프로젝트 없음' : '맞는 프로젝트 없음'}
              </div>
            ) : (
              visible.map((p, i) => <ProjectRow key={p.id} p={p} agent={agentById.get(p.agentId)} on={current?.id === p.id} index={i} onPick={() => pick(p.id)} />)
            )}
          </section>
          {current ? (
            <ProjectPanel
              key={current.id}
              project={current}
              agent={agentById.get(current.agentId)}
              tick={tick}
              onChanged={(p) => setProjects((cur) => (cur ?? []).map((x) => (x.id === p.id ? p : x)))}
              onRemoved={(id) => {
                setProjects((cur) => (cur ?? []).filter((x) => x.id !== id));
                setSelected(null);
                navigate('/projects', { replace: true });
              }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ProjectRow({ p, agent, on, index, onPick }: { p: ProjectView; agent: AgentView | undefined; on: boolean; index: number; onPick: () => void }) {
  const v = projectRowView(p, agent);
  return (
    <button type="button" className="proj-row" aria-pressed={on} onClick={onPick} style={{ animationDelay: `${Math.min(index, 12) * 35}ms` }}>
      <span className={`proj-tile ${v.tile}`}>
        <Icon name={p.isGit ? 'branch' : 'folder'} size={19} />
      </span>
      <span className="proj-main">
        <span className="proj-title">
          <b>{p.name}</b>
          <span className={`chip ${v.originChip}`}>{v.originText}</span>
          {p.status === 'missing' ? (
            <span className="chip bad">
              <Icon name="alert" size={12} stroke={2.2} />
              경로 없음
            </span>
          ) : null}
          {p.status === 'denied' ? (
            <span className="chip warn">
              <Icon name="lock" size={12} stroke={2.2} />
              접근 불가
            </span>
          ) : null}
        </span>
        <span className="mono proj-path">{p.displayPath}</span>
        <span className="chips">
          {agent ? (
            <span className="chip agent-chip">
              <Avatar name={agent.name} color={agent.color} size={18} />
              {agent.name}
            </span>
          ) : null}
          {p.isGit ? <span className="chip mono">git</span> : null}
          {p.auto ? <span className="chip">자동 등록</span> : null}
          {p.watch ? (
            <span className={`chip ${v.watchOn ? 'ok' : 'warn'}`}>
              <Icon name="pulse" size={12} stroke={2.2} className={v.watchOn ? 'beat' : undefined} />
              {v.watchText}
            </span>
          ) : null}
        </span>
      </span>
      <span className="proj-last">
        <span>{p.lastActivity ?? '활동 없음'}</span>
        <span className="mono">{p.lastActivityAt ? relTime(p.lastActivityAt) : relTime(p.createdAt)}</span>
      </span>
    </button>
  );
}

function ProjectPanel({ project, agent, tick, onChanged, onRemoved }: { project: ProjectView; agent: AgentView | undefined; tick: number; onChanged: (p: ProjectView) => void; onRemoved: (id: string) => void }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(project.note);

  useEffect(() => {
    let alive = true;
    api<ProjectDetail>(`/api/projects/${project.id}`)
      .then((r) => {
        if (!alive) return;
        setDetail(r);
        setLoadError(null);
      })
      .catch((err) => {
        if (alive) setLoadError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [project.id, tick]);

  useEffect(() => setNote(project.note), [project.note]);

  const p = detail?.project ?? project;
  const v = projectRowView(p, agent);
  const hb = agent?.heartbeat?.enabled ? agent.heartbeat : null;

  const patch = async (body: Record<string, unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await api<{ project: ProjectView }>(`/api/projects/${p.id}`, { method: 'PATCH', body });
      onChanged(r.project);
      setDetail((d) => (d ? { ...d, project: r.project } : d));
      toast(done, 'ok');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(p.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('클립보드에 복사하지 못했습니다. 브라우저가 복사를 막고 있습니다.', 'error');
    }
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api(`/api/projects/${p.id}`, { method: 'DELETE' });
      toast(`'${p.name}'을(를) 목록에서 뺐습니다. 폴더와 파일은 그대로입니다.`, 'ok');
      onRemoved(p.id);
    } catch (err) {
      toast(errorText(err), 'error');
      setBusy(false);
    }
  };

  const git = detail?.git ?? null;

  return (
    <aside aria-label="프로젝트 정보" className="side card proj-panel">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{p.name}</h2>
          <span className={`chip ${v.originChip}`}>{v.originText}</span>
        </div>
        <div className="proj-pathbox">
          <span className="mono">{p.path}</span>
          <button type="button" className="btn xs" aria-label="경로 복사" onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} size={14} stroke={2} />
            {copied ? '복사됨' : '복사'}
          </button>
        </div>
      </div>

      {p.status === 'missing' ? (
        <div role="status" className="proj-alert bad">
          <Icon name="alert" size={16} stroke={2} />
          폴더가 없습니다. 지워졌거나 옮겨졌습니다.
        </div>
      ) : null}
      {p.status === 'denied' ? (
        <div role="status" className="proj-alert warn">
          <span style={{ flex: '999 1 220px' }}>허용 폴더에서 빠져 {agent?.name ?? '에이전트'}이(가) 이 경로에 접근할 수 없습니다.</span>
          <button type="button" className="btn xs" onClick={() => navigate(`/guard/${p.agentId}`)}>
            허용 폴더 추가
          </button>
        </div>
      ) : null}

      <dl className="proj-dl">
        <dt>에이전트</dt>
        <dd>
          {agent ? (
            <>
              <Avatar name={agent.name} color={agent.color} size={22} />
              {agent.name}
            </>
          ) : (
            '삭제된 에이전트'
          )}
        </dd>
        <dt>등록</dt>
        <dd style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
          <span>{p.originDetail || originLabel(p.origin)}</span>
          <span className="mono dim" style={{ fontSize: 11.5 }}>
            {new Date(p.createdAt).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
            {p.auto ? ' · 자동 등록' : ''}
          </span>
        </dd>
        <dt>영역</dt>
        <dd>
          <span>{p.area}</span>
          {p.mode ? <span className={`chip ${p.mode === 'write' ? 'ok' : 'msg'}`}>{p.mode === 'write' ? '쓰기' : '읽기'}</span> : null}
        </dd>
        <dt>메모</dt>
        <dd style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          {editingNote ? (
            <>
              <textarea className="textarea" rows={3} maxLength={300} value={note} aria-label="메모" onChange={(e) => setNote(e.target.value)} />
              <span style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="btn xs primary"
                  disabled={busy}
                  onClick={() => {
                    setEditingNote(false);
                    void patch({ note }, '메모를 저장했습니다.');
                  }}
                >
                  저장
                </button>
                <button
                  type="button"
                  className="btn xs"
                  onClick={() => {
                    setEditingNote(false);
                    setNote(p.note);
                  }}
                >
                  취소
                </button>
              </span>
            </>
          ) : (
            <button type="button" className="proj-note" onClick={() => setEditingNote(true)}>
              {p.note || <span className="dim">메모 없음</span>}
              <Icon name="pen" size={13} />
            </button>
          )}
        </dd>
      </dl>

      {loadError ? <p className="err">{loadError}</p> : null}
      {git === null ? null : git.ok ? (
        <section aria-label="git" className="git-box">
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Icon name="branch" size={15} stroke={2} />
            <span className="mono" style={{ fontWeight: 600 }}>{git.info.branch ?? '(분리된 HEAD)'}</span>
            <span className="mono dim" style={{ fontSize: 12 }}>{git.info.upstream ? `→ ${git.info.upstream}` : '원격 없음'}</span>
            <span className="mono" style={{ marginLeft: 'auto', display: 'flex', gap: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--msg)' }}>↑{git.info.ahead}</span>
              <span className="dim">↓{git.info.behind}</span>
            </span>
          </div>
          {git.info.changed === 0 ? (
            <span className="dim" style={{ fontSize: 12.5 }}>
              변경 없음
            </span>
          ) : (
            <ul className="git-files">
              {git.info.files.map((f) => (
                <li key={`${f.code}:${f.path}`}>
                  <span className={`git-code c-${f.code === '??' ? 'new' : f.code === 'M' ? 'mod' : f.code === 'D' ? 'del' : 'etc'}`}>{f.code}</span>
                  <span className="mono">{f.path}</span>
                </li>
              ))}
              {git.info.changed > git.info.files.length ? <li className="dim">외 {git.info.changed - git.info.files.length}개</li> : null}
            </ul>
          )}
          {git.info.commit ? (
            <div className="git-commit">
              <span className="mono" style={{ color: 'var(--accent)' }}>{git.info.commit.hash}</span>
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{git.info.commit.subject}</span>
              <span className="dim" style={{ flex: 'none', fontSize: 12 }}>
                {relTime(git.info.commit.at)}
              </span>
            </div>
          ) : (
            <span className="dim" style={{ fontSize: 12.5 }}>
              커밋 없음
            </span>
          )}
        </section>
      ) : (
        <div className="git-box dim" style={{ fontSize: 12.5 }}>
          {git.reason}
        </div>
      )}

      <div className="proj-watch">
        <span className={`proj-watch-ico ${p.watch && hb && p.status === 'ok' ? 'on' : ''}`}>
          <Icon name="pulse" size={16} stroke={2} className={p.watch && hb && p.status === 'ok' ? 'beat' : undefined} />
        </span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600 }}>하트비트 점검에 포함</span>
          {hb ? (
            <span className="dim" style={{ fontSize: 12 }}>
              {hb.everyMinutes}분마다{hb.activeHours ? ` · ${hb.activeHours}` : ''}
            </span>
          ) : (
            <span style={{ display: 'flex', gap: 6, fontSize: 12, color: 'var(--warn)' }}>
              하트비트 꺼짐
              <button type="button" className="link-btn" onClick={() => navigate(`/console/${p.agentId}`)}>
                켜기
              </button>
            </span>
          )}
        </span>
        <Switch checked={p.watch} disabled={busy || p.status !== 'ok'} label="하트비트 점검에 포함" onChange={(v) => void patch({ watch: v }, v ? `'${p.name}'을(를) 하트비트 점검에 넣었습니다.` : `'${p.name}'을(를) 하트비트 점검에서 뺐습니다.`)} />
      </div>

      <section aria-label="최근 활동" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="section-label">최근 활동</span>
        {detail === null ? (
          <span className="spinner" style={{ width: 16, height: 16 }} />
        ) : detail.events.length === 0 ? (
          <span className="dim" style={{ fontSize: 12.5 }}>
            아직 없음
          </span>
        ) : (
          <ol className="ev-list">
            {detail.events.map((e) => (
              <li key={e.id} className={e.ok ? undefined : 'fail'}>
                <span className="ev-ico">
                  <Icon name={EVENT_ICON[e.kind]} size={13} stroke={2} />
                </span>
                <span className="ev-text">
                  <span className="dim">{e.label}</span>
                  <span className="mono">{e.detail}</span>
                </span>
                <span className="dim ev-time">{relTime(e.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button type="button" className="btn light" style={{ flex: '1 1 140px' }} onClick={() => navigate(`/console/${p.agentId}`)}>
          <Icon name="terminal" size={15} />
          콘솔에서 열기
        </button>
        {confirmRemove ? (
          <span style={{ flex: '1 1 220px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" className="btn danger sm" disabled={busy} onClick={() => void remove()}>
              목록에서 빼기
            </button>
            <button type="button" className="btn sm" onClick={() => setConfirmRemove(false)}>
              취소
            </button>
          </span>
        ) : (
          <button type="button" className="btn danger" style={{ flex: '1 1 140px' }} onClick={() => setConfirmRemove(true)}>
            <Icon name="minusCircle" size={15} />
            목록에서 빼기
          </button>
        )}
      </div>
    </aside>
  );
}

function AddProject({ agents, onDone }: { agents: AgentView[]; onDone: (p: ProjectView) => void }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [watch, setWatch] = useState(false);
  const [areas, setAreas] = useState<{ path: string; mode: 'read' | 'write' }[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const agent = agents.find((a) => a.id === agentId);

  useEffect(() => {
    if (!agentId) return undefined;
    let alive = true;
    api<{ areas: { path: string; mode: 'read' | 'write' }[] }>(`/api/agents/${agentId}/areas`)
      .then((r) => {
        if (alive) setAreas(r.areas);
      })
      .catch(() => {
        if (alive) setAreas([]);
      });
    return () => {
      alive = false;
    };
  }, [agentId]);

  const submit = async (): Promise<void> => {
    if (!agentId) {
      setProblem('프로젝트를 맡을 에이전트를 고르세요.');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ project: ProjectView }>('/api/projects', { body: { agentId, path, name, note, watch } });
      toast(`'${r.project.name}'을(를) ${agent?.name ?? '에이전트'}의 프로젝트로 등록했습니다.`, 'ok');
      onDone(r.project);
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const base = path.trim().replace(/\/+$/, '').split('/').pop() ?? '';

  return (
    <section aria-label="경로 추가" className="card card-pad rise" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <label className="field" style={{ flex: '1 1 150px' }}>
          에이전트
          <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: '999 1 300px' }}>
          경로
          <input
            className={`input mono ${problem ? 'bad' : ''}`}
            value={path}
            spellCheck={false}
            placeholder="~/work/my-app"
            aria-invalid={problem !== null}
            onChange={(e) => {
              setPath(e.target.value);
              setProblem(null);
            }}
          />
        </label>
        <label className="field" style={{ flex: '1 1 160px' }}>
          이름
          <input className="input" value={name} maxLength={60} placeholder={base || '폴더 이름'} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      {areas.length > 0 ? (
        <div className="chips" style={{ marginTop: -4 }}>
          <span className="dim" style={{ fontSize: 12, alignSelf: 'center' }}>
            {agent?.name} 영역
          </span>
          {areas.map((a) => (
            <button
              key={a.path}
              type="button"
              className="chip mono"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setPath(`${a.path}/`);
                setProblem(null);
              }}
            >
              {a.path}
              <span style={{ color: a.mode === 'write' ? 'var(--accent)' : 'var(--msg)', fontFamily: 'var(--font)' }}>{a.mode === 'write' ? '쓰기' : '읽기'}</span>
            </button>
          ))}
        </div>
      ) : null}
      <label className="field">
        메모
        <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
      </label>
      {problem ? (
        <span role="alert" className="err">
          {problem}
        </span>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={watch} onChange={(e) => setWatch(e.target.checked)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
          하트비트 점검에 포함
        </label>
        <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} disabled={busy || path.trim() === ''} onClick={() => void submit()}>
          {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
          등록
        </button>
      </div>
    </section>
  );
}
