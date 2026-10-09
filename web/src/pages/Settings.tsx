import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { Avatar, ModuleIcon } from '../components/ui';
import { api, errorText } from '../lib/api';
import { settingsPatch, sourceBadge, stillMissing } from '../lib/settings';
import { onServerEvent, refreshOverview, toast } from '../lib/store';
import type { HookVarView, KeyView, ModuleField, ModuleSettingsView, SettingsResponse } from '../lib/types';

/**
 * 설정: .env 와 DB(화면에서 관리)의 구분.
 *  - Anthropic 키 · 모듈 비밀값 · 모듈 설정 · 훅 값은 여기서 넣습니다 (비밀값은 SECRETS_KEY 로 암호화).
 *  - 서버가 켜질 때 읽는 .env 값은 읽기만 합니다.
 */
export function SettingsPage({ focus }: { focus: string | null }) {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let alive = true;
    api<SettingsResponse>('/api/settings')
      .then((r) => {
        if (!alive) return;
        setData(r);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(errorText(err));
      });
    return () => {
      alive = false;
    };
  }, [tick]);

  // /settings/<모듈 id> 로 들어오면 (설정 필요 카드 · 모듈 카드에서) 모듈 칸을 바로 보여 줍니다.
  const loaded = data !== null;
  useEffect(() => {
    if (loaded && focus) document.getElementById('modules')?.scrollIntoView({ block: 'start' });
  }, [loaded, focus]);

  // 모듈이 다시 시작하거나 상태가 바뀌면 설정 상태(연결됨 · 시작 안 됨)도 다시 읽습니다.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onServerEvent((e) => {
      if (e.type !== 'module.status' && e.type !== 'graph.changed') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(reload, 300);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [reload]);

  const moveAll = async (): Promise<void> => {
    try {
      const r = await api<{ moved: string[] }>('/api/settings/import-env', { body: {} });
      toast(r.moved.length > 0 ? `${r.moved.join(' · ')} 를 DB로 옮겼습니다. .env 에서 그 줄을 지워도 됩니다.` : '.env 에서 옮길 값이 없습니다.', 'ok');
      reload();
      refreshOverview();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  if (error) {
    return (
      <div className="card card-pad" role="alert">
        <b>설정을 불러오지 못했습니다</b>
        <p className="dim">{error}</p>
        <button type="button" className="btn sm" onClick={reload}>
          다시 불러오기
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="empty">
        <span className="spinner" />
      </div>
    );
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="page-head">
        <h1>설정</h1>
        <div className="chips">
          <a className="chip jump" href="#keys">
            Anthropic 키<span className="tone-ok">DB</span>
          </a>
          <a className="chip jump" href="#modules">
            모듈<span className="tone-ok">DB</span>
          </a>
          <a className="chip jump" href="#hookvars">
            훅 값<span className="tone-ok">DB</span>
          </a>
          <a className="chip jump" href="#env">
            .env<span className="dim">읽기 전용</span>
          </a>
        </div>
      </div>

      {data.envLeft.length > 0 ? (
        <div role="status" className="env-left rise">
          <Icon name="doc" size={18} stroke={2} />
          <span style={{ flex: '999 1 260px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            .env 에 남은 값
            {data.envLeft.map((e) => (
              <span key={`${e.moduleId ?? 'hook'}:${e.name}`} className="chip warn mono">
                {e.name}
              </span>
            ))}
          </span>
          <button type="button" className="btn sm warn-solid" onClick={() => void moveAll()}>
            <Icon name="arrowRight" size={15} stroke={2.2} />
            모두 DB로 옮기기
          </button>
        </div>
      ) : null}

      <KeysSection keys={data.keys} onChanged={reload} />
      <ModulesSection modules={data.modules} focus={focus} onChanged={reload} />
      <HookVarsSection vars={data.hookVars} onChanged={(v) => setData({ ...data, hookVars: v })} reload={reload} />
      <EnvSection groups={data.env} />
    </div>
  );
}

function SectionHead({ id, title, badges, children }: { id: string; title: string; badges: { text: string; tone: string; lock?: boolean }[]; children?: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 10px' }}>
      <h2 id={id} style={{ margin: 0, fontSize: 16, fontWeight: 700, scrollMarginTop: 80 }}>
        {title}
      </h2>
      {badges.map((b) => (
        <span key={b.text} className={`chip ${b.tone}`}>
          {b.lock ? <Icon name="lock" size={11} stroke={2.4} /> : null}
          {b.text}
        </span>
      ))}
      {children ? <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>{children}</span> : null}
    </div>
  );
}

/* ───────── Anthropic 키 ───────── */

function KeysSection({ keys, onChanged }: { keys: KeyView[]; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const r = await api<{ keyLabel: string; count: number }>('/api/keys/verify', { body: { source: 'manual', key, label } });
      toast(`'${r.keyLabel}' 키를 확인하고 암호화해 저장했습니다 · 모델 ${r.count}개`, 'ok');
      setAdding(false);
      setKey('');
      setLabel('');
      onChanged();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="keys" style={{ display: 'flex', flexDirection: 'column', gap: 10, scrollMarginTop: 80 }}>
      <SectionHead id="keys" title="Anthropic 키" badges={[{ text: 'DB · 암호화', tone: 'ok', lock: true }]}>
        <button type="button" className="btn sm" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          <Icon name="plus" size={14} stroke={2.4} />키 추가
        </button>
      </SectionHead>
      {adding ? (
        <div className="card card-pad rise" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}>
          <label className="field" style={{ flex: '1 1 160px' }}>
            이름
            <input className="input" value={label} maxLength={40} placeholder="예: 운영 키" onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label className="field" style={{ flex: '999 1 320px' }}>
            API 키
            <input
              className={`input mono ${problem ? 'bad' : ''}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              placeholder="sk-ant-…"
              onChange={(e) => {
                setKey(e.target.value);
                setProblem(null);
              }}
            />
          </label>
          <button type="button" className="btn primary" disabled={busy || key.trim().length < 8} onClick={() => void add()}>
            {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
            {busy ? '확인 중' : '확인하고 저장'}
          </button>
          {problem ? (
            <span role="alert" className="err" style={{ flexBasis: '100%' }}>
              {problem}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="card set-list">
        {keys.length === 0 ? <div className="empty">저장된 키 없음</div> : keys.map((k) => <KeyRow key={k.id} k={k} onChanged={onChanged} />)}
      </div>
    </section>
  );
}

function KeyRow({ k, onChanged }: { k: KeyView; onChanged: () => void }) {
  const [mode, setMode] = useState<'view' | 'rename' | 'replace' | 'confirm'>('view');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const env = k.source === 'env';

  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const msg = await fn();
      toast(msg, 'ok');
      setMode('view');
      setText('');
      onChanged();
      refreshOverview();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-row">
      <div className="set-line">
        <span className={`set-tile ${env ? '' : 'ok'}`}>
          <Icon name="key" size={17} stroke={1.9} />
        </span>
        <span style={{ flex: '1 1 180px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <b style={{ fontSize: 14 }}>{k.label}</b>
            <span className={`chip ${env ? '' : 'ok'}`}>{env ? 'env' : 'DB · 암호화'}</span>
          </span>
          <span className="mono dim" style={{ fontSize: 12.5 }}>
            •••• {k.last4}
          </span>
        </span>
        <span className="chips" style={{ flex: '1 1 200px' }}>
          {k.users.length === 0 ? (
            <span className="dim" style={{ fontSize: 12 }}>
              쓰는 에이전트 없음
            </span>
          ) : (
            k.users.map((u) => (
              <span key={u.id} className="chip agent-chip">
                <Avatar name={u.name} color={u.color} size={18} />
                {u.name}
              </span>
            ))
          )}
        </span>
        {env ? (
          <span className="icon-btn" role="img" aria-label="env 값이라 화면에서 바꿀 수 없음" style={{ border: 0 }}>
            <Icon name="lock" size={16} />
          </span>
        ) : (
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" className="btn xs" onClick={() => setMode(mode === 'rename' ? 'view' : 'rename')}>
              이름 바꾸기
            </button>
            <button type="button" className="btn xs" onClick={() => setMode(mode === 'replace' ? 'view' : 'replace')}>
              키 바꾸기
            </button>
            <button type="button" className="btn xs danger" onClick={() => setMode(mode === 'confirm' ? 'view' : 'confirm')}>
              지우기
            </button>
          </span>
        )}
      </div>
      {mode === 'rename' ? (
        <div className="set-sub rise">
          <input className="input" value={text} maxLength={40} placeholder={k.label} aria-label="새 이름" onChange={(e) => setText(e.target.value)} />
          <button type="button" className="btn sm primary" disabled={busy || text.trim() === ''} onClick={() => void run(async () => (await api(`/api/keys/${k.id}`, { method: 'PATCH', body: { label: text } }), `키 이름을 '${text.trim()}'(으)로 바꿨습니다.`))}>
            저장
          </button>
        </div>
      ) : null}
      {mode === 'replace' ? (
        <div className="set-sub rise">
          <input className="input mono" type="password" autoComplete="off" spellCheck={false} value={text} placeholder="새 키 sk-ant-…" aria-label="새 키" onChange={(e) => setText(e.target.value)} />
          <button
            type="button"
            className="btn sm primary"
            disabled={busy || text.trim().length < 8}
            onClick={() => void run(async () => {
              const r = await api<{ count: number }>(`/api/keys/${k.id}/secret`, { method: 'PUT', body: { key: text } });
              return `'${k.label}' 키를 바꿨습니다 · 모델 ${r.count}개`;
            })}
          >
            {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
            확인하고 바꾸기
          </button>
        </div>
      ) : null}
      {mode === 'confirm' ? (
        <div className="set-sub rise">
          <span style={{ fontSize: 12.5, color: 'var(--danger)' }}>'{k.label}' 키를 지웁니다. 되돌릴 수 없습니다.</span>
          <button type="button" className="btn sm danger" disabled={busy} onClick={() => void run(async () => (await api(`/api/keys/${k.id}`, { method: 'DELETE' }), `'${k.label}' 키를 지웠습니다. 서버 메모리의 연결도 함께 비웠습니다.`))}>
            지우기
          </button>
          <button type="button" className="btn sm" onClick={() => setMode('view')}>
            취소
          </button>
        </div>
      ) : null}
      {problem ? (
        <span role="alert" className="err set-err">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/* ───────── 모듈 ───────── */

function ModulesSection({ modules, focus, onChanged }: { modules: ModuleSettingsView[]; focus: string | null; onChanged: () => void }) {
  const [tab, setTab] = useState<string | null>(focus);
  useEffect(() => {
    if (focus) setTab(focus);
  }, [focus]);
  const current = modules.find((m) => m.id === tab) ?? modules.find((m) => m.enabled && m.missing.length > 0) ?? modules[0] ?? null;

  const dot = (m: ModuleSettingsView): string => {
    if (m.fields.some((f) => f.source === 'env')) return 'var(--warn)';
    if (!m.enabled) return 'var(--text3)';
    if (m.missing.length > 0) return 'var(--danger)';
    return 'var(--accent)';
  };

  return (
    <section aria-labelledby="modules" style={{ display: 'flex', flexDirection: 'column', gap: 10, scrollMarginTop: 80 }}>
      <SectionHead
        id="modules"
        title="모듈"
        badges={[
          { text: '비밀값 DB · 암호화', tone: 'ok', lock: true },
          { text: '설정 DB', tone: 'msg' },
        ]}
      />
      {modules.length === 0 || !current ? (
        <div className="card empty">설정이 필요한 모듈 없음</div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="tabs" role="tablist" aria-label="모듈">
            {modules.map((m) => (
              <button key={m.id} type="button" role="tab" aria-selected={m.id === current.id} onClick={() => setTab(m.id)}>
                <span className="status-dot" style={{ background: dot(m) }} />
                {m.name}
              </button>
            ))}
          </div>
          <ModuleForm key={current.id} m={current} onChanged={onChanged} />
        </div>
      )}
    </section>
  );
}

const STATUS_TEXT: Record<string, string> = { running: '연결됨', starting: '시작하는 중', stopped: '멈춤', idle: '대기', crashed: '비정상 종료', failed: '시작 안 됨', pending: '승인 대기', rejected: '거부됨' };

function ModuleForm({ m, onChanged }: { m: ModuleSettingsView; onChanged: () => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const patch = useMemo(() => settingsPatch(m.fields, drafts), [m.fields, drafts]);
  const missing = useMemo(() => stillMissing(m.fields, drafts), [m.fields, drafts]);
  const dirty = Object.keys(patch).length > 0;

  const save = async (values: Record<string, string | null>, what: string): Promise<void> => {
    setBusy(what);
    setProblem(null);
    try {
      const r = await api<{ changed: string[]; restarted: boolean; module: ModuleSettingsView }>(`/api/modules/${m.id}/settings`, { method: 'PUT', body: { values } });
      const failed = r.module.status === 'failed' || r.module.status === 'crashed';
      if (failed) toast(`${m.name} 설정을 저장했지만 시작하지 못했습니다: ${r.module.statusDetail ?? '이유를 모듈 화면에서 보세요'}`, 'error');
      else toast(`${m.name} 설정을 저장했습니다${r.restarted ? ' · 다시 시작함' : ''}`, 'ok');
      setDrafts({});
      setEditing({});
      onChanged();
      refreshOverview();
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const move = async (name: string): Promise<void> => {
    setBusy(name);
    try {
      const r = await api<{ moved: string[] }>('/api/settings/import-env', { body: { moduleId: m.id, names: [name] } });
      toast(r.moved.length > 0 ? `${name} 를 DB로 옮겼습니다. .env 에서 그 줄을 지워도 됩니다.` : `${name} 은(는) .env 에 없습니다.`, 'ok');
      onChanged();
      refreshOverview();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const statusOk = m.status === 'running' || m.status === 'idle';
  return (
    <div role="tabpanel" style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 12px', padding: '14px 16px 6px' }}>
        <ModuleIcon icon={m.icon} size={17} />
        <b>{m.name}</b>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: m.enabled ? (statusOk ? 'var(--accent)' : m.status === 'failed' || m.status === 'crashed' ? 'var(--danger)' : 'var(--text2)') : 'var(--text3)' }}>
          <span className="status-dot" style={{ background: 'currentColor' }} />
          {m.enabled ? (STATUS_TEXT[m.status] ?? m.status) : '꺼짐'}
        </span>
        {m.statusDetail && (m.status === 'failed' || m.status === 'crashed') ? (
          <span className="dim" style={{ fontSize: 12, flexBasis: '100%' }}>
            {m.statusDetail}
          </span>
        ) : null}
      </div>
      <ul className="set-fields">
        {m.fields.map((f) => (
          <FieldRow
            key={f.name}
            f={f}
            draft={drafts[f.name]}
            editing={editing[f.name] === true}
            busy={busy === f.name}
            onDraft={(v) => setDrafts({ ...drafts, [f.name]: v })}
            onEdit={(on) => {
              setEditing({ ...editing, [f.name]: on });
              if (!on) {
                const next = { ...drafts };
                delete next[f.name];
                setDrafts(next);
              }
            }}
            onMove={() => void move(f.name)}
            onClear={() => void save({ [f.name]: null }, f.name)}
          />
        ))}
      </ul>
      <div className="set-foot">
        <span style={{ fontSize: 12.5, color: missing.length > 0 ? 'var(--danger)' : 'var(--warn)' }}>
          {missing.length > 0 ? `필수 ${missing.length}개 비어 있음 · ${missing.join(', ')}` : dirty ? '저장하지 않은 변경 있음' : ''}
        </span>
        {problem ? (
          <span role="alert" className="err" style={{ flexBasis: '100%' }}>
            {problem}
          </span>
        ) : null}
        <button type="button" className="btn primary" style={{ marginLeft: 'auto' }} disabled={!dirty || busy !== null} onClick={() => void save(patch, 'save')}>
          {busy === 'save' ? <span className="spinner" style={{ width: 14, height: 14 }} /> : null}
          {m.enabled ? '저장하고 다시 시작' : '저장'}
        </button>
      </div>
    </div>
  );
}

function FieldRow({ f, draft, editing, busy, onDraft, onEdit, onMove, onClear }: { f: ModuleField; draft: string | undefined; editing: boolean; busy: boolean; onDraft: (v: string) => void; onEdit: (on: boolean) => void; onMove: () => void; onClear: () => void }) {
  const badge = sourceBadge(f);
  const id = `set-${f.name}`;
  const showSecretInput = f.secret && (f.source === 'empty' || f.source === 'locked' || editing);
  return (
    <li className="set-field">
      <span className="set-label">
        <label htmlFor={id}>
          {f.label}
          {f.required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
        </label>
        <span className="mono dim" style={{ fontSize: 11.5 }}>
          {f.name}
        </span>
        {f.url && f.url.startsWith('https://') ? (
          <a className="set-link" href={f.url} target="_blank" rel="noopener noreferrer">
            <Icon name="link" size={12} stroke={2.2} />
            만들기
          </a>
        ) : null}
      </span>
      <span className="set-control">
        {f.secret && !showSecretInput ? (
          <span id={id} className="set-masked mono">
            •••••••• {f.last4}
          </span>
        ) : f.secret ? (
          <input
            id={id}
            className={`input mono ${f.required && (f.source === 'empty' || f.source === 'locked') && !(draft ?? '').trim() ? 'warn-border' : ''}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft ?? ''}
            placeholder={f.description}
            onChange={(e) => onDraft(e.target.value)}
          />
        ) : (
          <input id={id} className="input mono" spellCheck={false} value={draft ?? f.value ?? ''} placeholder={f.description} onChange={(e) => onDraft(e.target.value)} />
        )}
      </span>
      <span className="set-actions">
        <span className={`chip ${badge.tone}`}>
          {f.source === 'db' && f.secret ? <Icon name="lock" size={11} stroke={2.4} /> : null}
          {badge.text}
        </span>
        {f.envAlso ? <span className="chip">.env에도 있음</span> : null}
        {f.source === 'env' ? (
          <button type="button" className="btn xs warn-solid" disabled={busy} onClick={onMove}>
            DB로 옮기기
          </button>
        ) : null}
        {f.secret && f.source === 'db' && !editing ? (
          <>
            <button type="button" className="btn xs" onClick={() => onEdit(true)}>
              바꾸기
            </button>
            <button type="button" className="btn xs danger" disabled={busy} onClick={onClear}>
              지우기
            </button>
          </>
        ) : null}
        {f.secret && editing ? (
          <button type="button" className="btn xs" onClick={() => onEdit(false)}>
            취소
          </button>
        ) : null}
      </span>
    </li>
  );
}

/* ───────── 훅 값 ───────── */

function HookVarsSection({ vars, onChanged, reload }: { vars: HookVarView[]; onChanged: (v: HookVarView[]) => void; reload: () => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const put = async (n: string, v: string): Promise<boolean> => {
    try {
      const r = await api<{ hookVars: HookVarView[] }>(`/api/hook-vars/${encodeURIComponent(n)}`, { method: 'PUT', body: { value: v } });
      onChanged(r.hookVars);
      return true;
    } catch (err) {
      toast(errorText(err), 'error');
      return false;
    }
  };

  return (
    <section aria-labelledby="hookvars" style={{ display: 'flex', flexDirection: 'column', gap: 10, scrollMarginTop: 80 }}>
      <SectionHead id="hookvars" title="훅 값" badges={[{ text: 'DB', tone: 'msg' }]}>
        <span className="mono dim" style={{ fontSize: 12, alignSelf: 'center' }}>
          $env:이름
        </span>
      </SectionHead>
      <div className="card set-list">
        {vars.map((v) => (
          <HookVarRow key={v.name} v={v} onSave={(val) => put(v.name, val)} onMoved={reload} onDeleted={onChanged} />
        ))}
        <div className="set-row">
          <div className="set-line">
            <input className="input mono" style={{ flex: '1 1 170px' }} value={name} placeholder="새 이름 (예: QUIET_HOURS)" aria-label="새 훅 값 이름" onChange={(e) => setName(e.target.value.toUpperCase())} />
            <input className="input mono" style={{ flex: '999 1 200px' }} value={value} placeholder="값" aria-label="새 훅 값" onChange={(e) => setValue(e.target.value)} />
            <button
              type="button"
              className="btn sm"
              disabled={name.trim() === '' || value.trim() === ''}
              onClick={() =>
                void put(name.trim(), value).then((ok) => {
                  if (ok) {
                    setName('');
                    setValue('');
                    setProblem(null);
                    toast('훅 값을 추가했습니다.', 'ok');
                  }
                })
              }
            >
              <Icon name="plus" size={14} stroke={2.4} />
              값 추가
            </button>
          </div>
          {problem ? <span className="err set-err">{problem}</span> : null}
        </div>
      </div>
    </section>
  );
}

function HookVarRow({ v, onSave, onMoved, onDeleted }: { v: HookVarView; onSave: (value: string) => Promise<boolean>; onMoved: () => void; onDeleted: (v: HookVarView[]) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? v.value ?? '';
  const dirty = draft !== null && draft.trim() !== (v.value ?? '');
  const tone = v.source === 'db' ? 'msg' : v.source === 'env' ? 'warn' : 'bad';
  const text = v.source === 'db' ? 'DB' : v.source === 'env' ? '.env에서 읽는 중' : '비어 있음';
  return (
    <div className="set-row">
      <div className="set-line">
        <label htmlFor={`hv-${v.name}`} className="mono" style={{ flex: '1 1 170px', fontSize: 13, fontWeight: 600 }}>
          {v.name}
        </label>
        <input id={`hv-${v.name}`} className="input mono" style={{ flex: '999 1 200px' }} value={value} onChange={(e) => setDraft(e.target.value)} />
        <span className="chips" style={{ flex: '1 1 260px', justifyContent: 'flex-end' }}>
          {v.usedBy.map((h) => (
            <span key={h} className="chip">
              훅 · {h}
            </span>
          ))}
          <span className={`chip ${tone}`}>{text}</span>
          {dirty ? (
            <button
              type="button"
              className="btn xs primary"
              onClick={() =>
                void onSave(value).then((ok) => {
                  if (ok) {
                    setDraft(null);
                    toast(`${v.name} 값을 저장했습니다.`, 'ok');
                  }
                })
              }
            >
              저장
            </button>
          ) : v.source === 'env' ? (
            <button
              type="button"
              className="btn xs warn-solid"
              onClick={() =>
                void onSave(v.value ?? '').then((ok) => {
                  if (ok) {
                    toast(`${v.name} 를 DB로 옮겼습니다. .env 에서 그 줄을 지워도 됩니다.`, 'ok');
                    onMoved();
                  }
                })
              }
            >
              DB로 옮기기
            </button>
          ) : v.source === 'db' ? (
            <button
              type="button"
              className="btn xs danger"
              aria-label={`${v.name} 지우기`}
              onClick={() =>
                void api<{ hookVars: HookVarView[] }>(`/api/hook-vars/${encodeURIComponent(v.name)}`, { method: 'DELETE' })
                  .then((r) => {
                    onDeleted(r.hookVars);
                    toast(`${v.name} 를 지웠습니다${v.usedBy.length > 0 ? ' · .env 값이 있으면 그 값을 씁니다' : ''}.`, 'ok');
                  })
                  .catch((err) => toast(errorText(err), 'error'))
              }
            >
              <Icon name="trash" size={13} />
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/* ───────── .env (읽기 전용) ───────── */

function EnvSection({ groups }: { groups: SettingsResponse['env'] }) {
  const [all, setAll] = useState(false);
  const shown = all ? groups : groups.slice(0, 3);
  return (
    <section aria-labelledby="env" style={{ display: 'flex', flexDirection: 'column', gap: 10, scrollMarginTop: 80 }}>
      <SectionHead id="env" title=".env" badges={[{ text: '읽기 전용 · 서버 시작 때 읽음', tone: '', lock: true }]}>
        <button type="button" className="btn sm" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? '접기' : '모두 보기'}
        </button>
      </SectionHead>
      <div className="env-grid">
        {shown.map((g, gi) => (
          <div key={g.title} className="card env-card rise" style={{ animationDelay: `${gi * 50}ms` }}>
            <span className="section-label" style={{ paddingBottom: 6 }}>
              {g.title}
            </span>
            {g.items.map((it) => (
              <span key={it.key} className="env-item">
                <span className="mono env-key">{it.key}</span>
                {it.isNew ? <span className="chip msg env-new">새로</span> : null}
                <span className={`mono env-val ${it.tone}`}>{it.value}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
