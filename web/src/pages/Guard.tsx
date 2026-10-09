import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DelegationEditor } from '../components/Delegation';
import { FoldersEditor } from '../components/Folders';
import { Icon } from '../components/Icon';
import { Avatar, ChipInput, Seg, Switch } from '../components/ui';
import { api, ApiError, errorText } from '../lib/api';
import { delegationProblem } from '../lib/autonomy';
import { folderChanges, type FolderView } from '../lib/folders';
import {
  ACTION_LABEL,
  countLimitChanges,
  countPermissionChanges,
  EVENT_LABEL,
  HOOK_CONDITIONS_MAX,
  HOOK_NAME_MAX,
  HOOK_REASON_MAX,
  hookDraftProblems,
  limitProblem,
  MODE_LABEL,
  OP_LABEL,
  patternProblem,
  type HookDraft,
  type HookProblem,
} from '../lib/guard';
import { navigate } from '../lib/router';
import { refreshOverview, toast, useApp } from '../lib/store';
import type { AgentLimits, AgentView, DelegationSettings, GuardDef, HookOutcome, HooksResponse, Meta, Mode, Overview, PermissionDef, PermissionRule, RuleHook } from '../lib/types';

/* ───────── 권한 ───────── */

const SCOPE_HINT: Record<PermissionDef['scope'], string> = {
  path: '모든 경로 · 예: src/**',
  command: '모든 명령 · 예: git *',
  host: '모든 주소 · 예: api.github.com',
  target: '모든 대상 · 예: #general',
  manager: '모든 관리자 · 예: npm',
  none: '',
};

type LimitDraft = Record<keyof AgentLimits, string>;

function limitDraft(l: AgentLimits): LimitDraft {
  return { tokensPerDay: String(l.tokensPerDay), stepsPerTask: String(l.stepsPerTask), concurrency: String(l.concurrency), messagesPerMinute: String(l.messagesPerMinute) };
}

function PermRow({ def, rule, error, onChange }: { def: PermissionDef; rule: PermissionRule; error: string | null; onChange: (r: PermissionRule) => void }) {
  if (def.locked) {
    return (
      <div className="perm-row">
        <span className="perm-label">
          {def.label}
          <Icon name="lock" size={13} stroke={2.2} />
        </span>
        <span className="chip bad" style={{ marginLeft: 'auto' }}>
          기본 금지
        </span>
      </div>
    );
  }
  const showScope = def.scope !== 'none' && rule.mode === 'allow';
  return (
    <div className={`perm-row${error ? ' flash' : ''}`} id={`perm-${def.key}`}>
      <span className="perm-label">{def.label}</span>
      {showScope ? (
        <ChipInput value={rule.scope} onChange={(scope) => onChange({ ...rule, scope })} label={`${def.label} 허용 범위`} placeholder={SCOPE_HINT[def.scope]} tone="ok" validate={(item) => patternProblem(item, rule.scope)} />
      ) : (
        <span className="scope-edit" />
      )}
      <Seg
        value={rule.mode}
        options={(['allow', 'ask', 'deny'] as Mode[]).map((m) => ({ value: m, label: MODE_LABEL[m], className: m }))}
        onChange={(mode) => onChange({ ...rule, mode })}
        label={`${def.label} 권한`}
      />
      {rule.always.length > 0 && rule.mode !== 'deny' ? (
        <div style={{ flexBasis: '100%', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, paddingLeft: 158 }}>
          <span className="muted" style={{ fontSize: 11.5 }}>
            항상 허용
          </span>
          {rule.always.map((t) => {
            // 승인 카드에서 넣은 값('=' 로 시작)은 글자 그대로만 맞고, 직접 넣은 값은 '*' 가 와일드카드인 패턴입니다.
            const exact = t.startsWith('=');
            const shown = exact ? t.slice(1) : t;
            return (
              <span key={t} className="chip mono ok always-chip" title={exact ? '이 값 그대로만 허용' : '패턴 (* 는 아무 문자열)'}>
                <span className={`always-kind ${exact ? 'exact' : ''}`}>{exact ? '그대로' : '패턴'}</span>
                <span className="always-text">{shown}</span>
                <button type="button" aria-label={`${shown} 항상 허용에서 빼기`} onClick={() => onChange({ ...rule, always: rule.always.filter((x) => x !== t) })}>
                  <Icon name="x" size={11} stroke={2.6} />
                </button>
              </span>
            );
          })}
        </div>
      ) : null}
      {error ? (
        <span className="err" style={{ flexBasis: '100%' }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

function PermissionsEditor({ agent, meta }: { agent: AgentView; meta: Meta }) {
  const [base, setBase] = useState<{ permissions: Record<string, PermissionRule>; limits: AgentLimits } | null>(null);
  const [perms, setPerms] = useState<Record<string, PermissionRule>>({});
  const [limits, setLimits] = useState<LimitDraft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<{ key: string | null; field: string | null; text: string; index?: number | null } | null>(null);
  const agents = useApp((s) => s.overview?.agents) ?? [];
  const [delegation, setDelegation] = useState<DelegationSettings>(agent.delegation);
  // null 이면 저장된 값을 그대로 보여 줍니다 (저장 뒤 서버가 경로를 정리한 값으로 바뀜).
  const [folders, setFolders] = useState<FolderView[] | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api<{ agent: { permissions: Record<string, PermissionRule>; limits: AgentLimits } }>(`/api/agents/${agent.id}`)
      .then((r) => {
        setBase({ permissions: r.agent.permissions, limits: r.agent.limits });
        setPerms(r.agent.permissions);
        setLimits(limitDraft(r.agent.limits));
      })
      .catch((err: unknown) => setLoadError(errorText(err)));
  }, [agent.id]);
  useEffect(load, [load]);

  const groups = useMemo(() => {
    const out: { title: string; defs: PermissionDef[] }[] = [];
    for (const d of meta.permissionDefs) {
      const g = out.find((x) => x.title === d.group);
      if (g) g.defs.push(d);
      else out.push({ title: d.group, defs: [d] });
    }
    return out;
  }, [meta.permissionDefs]);

  if (loadError) {
    return (
      <div className="card card-pad" role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <b>권한 설정을 불러오지 못했습니다</b>
        <span className="err">{loadError}</span>
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={load}>
          다시 시도
        </button>
      </div>
    );
  }
  if (!base || !limits) {
    return (
      <div className="card empty">
        <span className="spinner" />
      </div>
    );
  }

  const limitKeys = Object.keys(meta.limitRules) as (keyof AgentLimits)[];
  const limitProblems = limitKeys.map((k) => [k, limitProblem(limits[k], meta.limitRules[k])] as const).filter(([, p]) => p !== null);
  const permChanges = countPermissionChanges(base.permissions, perms) + countLimitChanges(base.limits, limits);
  const delegationChanges = (['accept', 'send', 'supervisorId'] as const).filter((k) => delegation[k] !== agent.delegation[k]).length;
  const shownFolders = folders ?? agent.folders;
  const foldersChanged = folders ? folderChanges(agent.folders, folders) : 0;
  const changes = permChanges + delegationChanges + foldersChanged;
  const dlgProblem = delegationChanges > 0 ? delegationProblem(delegation, agents, agent.id) : null;
  const problems = limitProblems.length + (dlgProblem ? 1 : 0);
  const ruleOf = (d: PermissionDef): PermissionRule => perms[d.key] ?? { mode: d.locked ? 'deny' : 'ask', scope: [], always: [] };

  const save = async (): Promise<void> => {
    if (problems > 0) return;
    setSaving(true);
    setServerError(null);
    const numbers = Object.fromEntries(limitKeys.map((k) => [k, Number(limits[k].trim())])) as unknown as AgentLimits;
    const full: Record<string, PermissionRule> = {};
    for (const d of meta.permissionDefs) full[d.key] = ruleOf(d);
    try {
      if (delegationChanges > 0) {
        try {
          const r = await api<{ agent: { delegation: DelegationSettings } }>(`/api/agents/${agent.id}/delegation`, { method: 'PUT', body: delegation });
          setDelegation(r.agent.delegation);
        } catch (err) {
          setServerError({ key: null, field: 'delegation', text: errorText(err) });
          return;
        }
      }
      if (foldersChanged > 0) {
        try {
          await api(`/api/agents/${agent.id}/folders`, { method: 'PUT', body: { folders: shownFolders } });
          setFolders(null);
        } catch (err) {
          const index = err instanceof ApiError && typeof err.detail?.['index'] === 'number' ? err.detail['index'] : null;
          setServerError({ key: null, field: 'folders', text: errorText(err), index });
          return;
        }
      }
      if (permChanges > 0) {
        const r = await api<{ agent: { permissions: Record<string, PermissionRule>; limits: AgentLimits } }>(`/api/agents/${agent.id}/permissions`, { method: 'PUT', body: { permissions: full, limits: numbers } });
        setBase({ permissions: r.agent.permissions, limits: r.agent.limits });
        setPerms(r.agent.permissions);
        setLimits(limitDraft(r.agent.limits));
      }
      toast('저장됨 · 다음 도구 호출부터 적용', 'ok');
      refreshOverview(0);
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : null;
      const key = typeof detail?.['key'] === 'string' ? detail['key'] : null;
      const field = typeof detail?.['field'] === 'string' ? detail['field'] : null;
      setServerError({ key, field: key ? null : field, text: errorText(err) });
      if (key) document.getElementById(`perm-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } finally {
      setSaving(false);
    }
  };

  const revert = (): void => {
    setPerms(base.permissions);
    setLimits(limitDraft(base.limits));
    setDelegation(agent.delegation);
    setFolders(null);
    setServerError(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="card" aria-label="권한">
        <div className="card-head">
          <h2>권한</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            {agent.name}
          </span>
          <span className="chips" style={{ marginLeft: 'auto' }}>
            {(['allow', 'ask', 'deny'] as Mode[]).map((m) => (
              <span key={m} className={`chip ${m === 'allow' ? 'ok' : m === 'ask' ? 'warn' : 'bad'}`}>
                {MODE_LABEL[m]} {meta.permissionDefs.filter((d) => ruleOf(d).mode === m).length}
              </span>
            ))}
          </span>
        </div>
        {groups.map((g) => (
          <div key={g.title} className="perm-group">
            <span className="section-label" style={{ padding: '8px 0 4px' }}>
              {g.title}
            </span>
            {g.defs.map((d) => (
              <PermRow key={d.key} def={d} rule={ruleOf(d)} error={serverError?.key === d.key ? serverError.text : null} onChange={(r) => setPerms((p) => ({ ...p, [d.key]: r }))} />
            ))}
          </div>
        ))}
      </section>

      <section className="card" aria-label="위임">
        <div className="card-head">
          <h2>위임</h2>
        </div>
        <div className="card-pad">
          <DelegationEditor agents={agents} selfId={agent.id} value={delegation} onChange={setDelegation} error={dlgProblem ?? (serverError?.field === 'delegation' ? serverError.text : null)} />
        </div>
      </section>

      <section className="card" aria-label="허용 폴더">
        <div className="card-head">
          <h2>허용 폴더</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            작업 폴더 밖
          </span>
        </div>
        <div className="card-pad">
          <FoldersEditor
            value={shownFolders}
            onChange={(v) => {
              setFolders(v);
              if (serverError?.field === 'folders') setServerError(null);
            }}
            error={serverError?.field === 'folders' ? serverError.text : null}
            errorIndex={serverError?.field === 'folders' ? (serverError.index ?? null) : null}
          />
        </div>
      </section>

      <section className="card" aria-label="한도">
        <div className="card-head">
          <h2>한도</h2>
        </div>
        <div className="card-pad" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(200px, 100%), 1fr))', gap: 14 }}>
          {limitKeys.map((k) => {
            const rule = meta.limitRules[k];
            const problem = limitProblem(limits[k], rule) ?? (serverError?.field === k ? serverError.text : null);
            return (
              <label key={k} className="field">
                {rule.label}
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input className={`input mono${problem ? ' bad' : ''}`} style={{ flex: 1, minWidth: 0 }} inputMode="numeric" value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} aria-invalid={problem !== null} />
                  <span className="muted" style={{ fontWeight: 500 }}>
                    {rule.unit}
                  </span>
                </span>
                {problem ? <span className="err">{problem}</span> : null}
              </label>
            );
          })}
        </div>
      </section>

      {serverError && !serverError.key && !serverError.field ? (
        <span className="err" role="alert">
          {serverError.text}
        </span>
      ) : null}

      {changes > 0 ? (
        <div className="save-bar" role="region" aria-label="저장">
          <b>변경 {changes}개</b>
          {problems > 0 ? <span style={{ color: 'var(--danger)', fontSize: 13 }}>입력 오류 {problems}개를 고쳐야 저장됩니다</span> : null}
          <button type="button" className="btn sm" onClick={revert}>
            되돌리기
          </button>
          <button type="button" className="btn sm primary" disabled={saving || problems > 0} onClick={() => void save()}>
            {saving ? <span className="spinner" style={{ width: 13, height: 13, borderTopColor: 'var(--onAccent)' }} /> : null}
            저장
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ───────── 훅 ───────── */

type Selected = { type: 'guard'; id: string } | { type: 'rule'; id: string } | { type: 'file'; id: string } | { type: 'new' } | null;

const SAMPLE_FIELDS: Record<string, string[]> = {
  before_tool: ['tool', 'category', 'command', 'path', 'url', 'method', 'text', 'agent', 'now'],
  after_tool: ['tool', 'category', 'output', 'agent', 'now'],
  before_send: ['channel', 'target', 'text', 'agent', 'now'],
  on_message: ['channel', 'target', 'user', 'text', 'agent', 'now'],
  before_install: ['kind', 'id', 'agent', 'now'],
};

const SAMPLE_HINT: Record<string, string> = {
  tool: 'shell_exec',
  category: 'shell.exec',
  command: 'git push',
  path: '/work/notes.md',
  url: 'https://api.example.com/v1',
  method: 'POST',
  text: '보낼 내용',
  output: '도구 결과',
  channel: 'discord',
  target: '#general',
  user: '사용자',
  kind: 'module',
  id: 'my-module',
  agent: '에이전트 이름',
  now: '23:30',
};

function OutcomeView({ outcome }: { outcome: HookOutcome }) {
  const tag = outcome.decision === 'deny' ? { text: '차단', cls: 'bad' } : outcome.decision === 'ask' ? { text: '확인', cls: 'warn' } : { text: '통과', cls: 'ok' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '10px 12px', borderRadius: 10, background: 'var(--panel)', border: '1px solid var(--line)', animation: 'rise .25s ease backwards' }} aria-live="polite">
      <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span className={`chip ${tag.cls}`}>{tag.text}</span>
        {outcome.by.map((b) => (
          <span key={b} className="chip mono">
            {b}
          </span>
        ))}
      </span>
      {outcome.reasons.map((r, i) => (
        <span key={i} style={{ fontSize: 13 }}>
          {r}
        </span>
      ))}
      {outcome.decision === 'allow' && outcome.reasons.length === 0 ? <span className="dim" style={{ fontSize: 13 }}>조건에 맞는 훅이 없어 그대로 진행됩니다.</span> : null}
      {outcome.text !== undefined ? (
        <pre className="codebox" style={{ fontSize: 11.5 }}>
          {outcome.text}
        </pre>
      ) : null}
      {outcome.logs.map((l, i) => (
        <span key={`log-${i}`} className="muted" style={{ fontSize: 12 }}>
          {l}
        </span>
      ))}
    </div>
  );
}

function HookTest({ event, run }: { event: string; run: (sample: Record<string, string>) => Promise<HookOutcome> }) {
  const [sample, setSample] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<HookOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fields = SAMPLE_FIELDS[event] ?? [];
  const go = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setOutcome(await run(Object.fromEntries(Object.entries(sample).filter(([k, v]) => fields.includes(k) && v.trim() !== ''))));
    } catch (err) {
      setOutcome(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="section-label">테스트</span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 6 }}>
        {fields.map((f) => (
          <label key={f} className="field" style={{ gap: 3, fontSize: 11.5 }}>
            <span className="mono">{f}</span>
            <input className="input mono" style={{ height: 32, fontSize: 12 }} placeholder={SAMPLE_HINT[f] ?? ''} value={sample[f] ?? ''} onChange={(e) => setSample({ ...sample, [f]: e.target.value })} />
          </label>
        ))}
      </div>
      <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={busy} onClick={() => void go()}>
        {busy ? <span className="spinner" style={{ width: 13, height: 13 }} /> : <Icon name="play" size={13} stroke={2.2} />}
        {busy ? '평가 중' : '실행'}
      </button>
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
      {outcome ? <OutcomeView outcome={outcome} /> : null}
    </div>
  );
}

function GuardView({ guard }: { guard: GuardDef }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 15 }}>{guard.name}</b>
        <span className="chip">
          <Icon name="lock" size={11} stroke={2.4} />
          잠김
        </span>
        {guard.hits24h ? <span className="chip bad" style={{ marginLeft: 'auto' }}>24시간 {guard.hits24h}회 차단</span> : null}
      </div>
      <div className="kv" style={{ gridTemplateColumns: '64px minmax(0,1fr)' }}>
        <span>이벤트</span>
        <span className="chips">
          {guard.events.map((e) => (
            <span key={e} className="chip mono">
              {e}
            </span>
          ))}
        </span>
        <span>조건</span>
        <span className="chips">
          {guard.conditions.map((c) => (
            <span key={c} className="chip mono">
              {c}
            </span>
          ))}
        </span>
        <span>문구</span>
        <span className="dim">{guard.reasonTemplate}</span>
      </div>
      <HookTest key={guard.id} event={guard.events[0] ?? 'before_tool'} run={(sample) => api<{ outcome: HookOutcome }>('/api/hooks/test', { body: { guard: guard.id, sample } }).then((r) => r.outcome)} />
    </div>
  );
}

function toDraft(h: RuleHook | null): HookDraft {
  if (!h) return { name: '', event: 'before_tool', enabled: true, action: 'deny', conditions: [{ field: 'host', op: 'eq', value: '' }], reason: '', modify: null };
  return { name: h.name, event: h.event, enabled: h.enabled, action: h.action, conditions: h.conditions.map((c) => ({ ...c })), reason: h.reason, modify: h.modify ? { ...h.modify } : null };
}

function RuleEditor({ hook, meta, onSaved, onDeleted }: { hook: RuleHook | null; meta: Meta; onSaved: (h: RuleHook) => void; onDeleted: () => void }) {
  const [draft, setDraft] = useState<HookDraft>(() => toDraft(hook));
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const problems = hookDraftProblems(draft, meta);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(hook));
  const shown = (where: HookProblem['where']): ReactNode => {
    if (!attempted && (where === 'name' || where === 'reason') && (where === 'name' ? draft.name : draft.reason) === '') return null;
    const p = problems.find((x) => x.where === where);
    return p ? <span className="err">{p.text}</span> : null;
  };
  const set = (patch: Partial<HookDraft>): void => {
    setDraft((d) => ({ ...d, ...patch }));
    setServerError(null);
  };
  const setEvent = (event: string): void => {
    const actions = meta.hookActions[event] ?? [];
    set({ event, action: actions.includes(draft.action) ? draft.action : (actions[0] ?? 'deny'), conditions: draft.conditions.map((c) => ((meta.hookFields[event] ?? []).includes(c.field) || c.op.endsWith('window') ? c : { ...c, field: meta.hookFields[event]?.[0] ?? '' })) });
  };
  const setCond = (i: number, patch: Partial<HookDraft['conditions'][number]>): void => set({ conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const fields = meta.hookFields[draft.event] ?? [];
  const toolEvent = draft.event === 'before_tool' || draft.event === 'after_tool';

  const save = async (): Promise<void> => {
    setAttempted(true);
    if (problems.length > 0) return;
    setBusy(true);
    setServerError(null);
    const body = { ...draft, name: draft.name.trim(), reason: draft.reason.trim(), modify: draft.action === 'modify' ? draft.modify : null };
    try {
      const r = hook ? await api<{ hook: RuleHook }>(`/api/hooks/${hook.id}`, { method: 'PUT', body }) : await api<{ hook: RuleHook }>('/api/hooks', { body });
      toast(hook ? `'${r.hook.name}' 저장됨 · 다음 호출부터 적용` : `'${r.hook.name}' 추가됨 · 다음 호출부터 적용`, 'ok');
      onSaved(r.hook);
    } catch (err) {
      setServerError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (!hook) return;
    setBusy(true);
    try {
      await api(`/api/hooks/${hook.id}`, { method: 'DELETE' });
      toast(`'${hook.name}' 훅을 지웠습니다`, 'ok');
      onDeleted();
    } catch (err) {
      setServerError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form
      style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10 }}>
        <label className="field" style={{ flex: 1 }}>
          이름
          <input className={`input${shown('name') ? ' bad' : ''}`} maxLength={HOOK_NAME_MAX + 10} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <span style={{ paddingBottom: 8 }}>
          <Switch checked={draft.enabled} label="훅 켜기" onChange={(enabled) => set({ enabled })} />
        </span>
      </div>
      {shown('name')}
      <div className="field">
        이벤트
        <Seg value={draft.event} options={meta.hookEvents.map((e) => ({ value: e, label: EVENT_LABEL[e] ?? e }))} onChange={setEvent} label="이벤트" />
      </div>
      <div className="field">
        조건
        {draft.conditions.map((c, i) => {
          const timeOp = c.op === 'in_window' || c.op === 'not_in_window';
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div className="cond-row">
                <input className="input mono" list={`hook-fields-${draft.event}`} aria-label={`${i + 1}번째 조건 필드`} value={timeOp ? 'now' : c.field} disabled={timeOp} onChange={(e) => setCond(i, { field: e.target.value.trim() })} />
                <select className="select" aria-label={`${i + 1}번째 조건 연산자`} value={c.op} onChange={(e) => setCond(i, { op: e.target.value })}>
                  {meta.conditionOps.map((op) => (
                    <option key={op} value={op}>
                      {OP_LABEL[op] ?? op}
                    </option>
                  ))}
                </select>
                <input
                  className={`input mono${problems.some((p) => p.where === `condition:${i}`) && (attempted || c.value !== '') ? ' bad' : ''}`}
                  aria-label={`${i + 1}번째 조건 값`}
                  placeholder={timeOp ? '22:00-08:00' : c.op.includes('matches') ? '/패턴/i' : '값 · $env:이름'}
                  value={c.value}
                  onChange={(e) => setCond(i, { value: e.target.value })}
                />
                <button type="button" className="icon-btn" style={{ width: 32, height: 32 }} aria-label={`${i + 1}번째 조건 지우기`} disabled={draft.conditions.length === 1} onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}>
                  <Icon name="x" size={13} stroke={2.4} />
                </button>
              </div>
              {attempted || c.value !== '' ? shown(`condition:${i}`) : null}
            </div>
          );
        })}
        <datalist id={`hook-fields-${draft.event}`}>
          {fields.map((f) => (
            <option key={f} value={f} />
          ))}
          {toolEvent ? <option value="input." /> : null}
        </datalist>
        {shown('conditions')}
        <button type="button" className="btn xs" style={{ alignSelf: 'flex-start' }} disabled={draft.conditions.length >= HOOK_CONDITIONS_MAX} onClick={() => set({ conditions: [...draft.conditions, { field: fields[0] ?? '', op: 'eq', value: '' }] })}>
          <Icon name="plus" size={13} stroke={2.4} />
          조건
        </button>
      </div>
      <div className="field">
        동작
        <Seg value={draft.action} options={(meta.hookActions[draft.event] ?? []).map((a) => ({ value: a, label: ACTION_LABEL[a], className: a === 'deny' ? 'deny' : a === 'ask' ? 'ask' : a === 'log' ? '' : 'allow' }))} onChange={(action) => set({ action, modify: action === 'modify' ? (draft.modify ?? { find: '', replace: '' }) : draft.modify })} label="동작" />
        {shown('action')}
      </div>
      {draft.action === 'modify' ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <label className="field" style={{ flex: '1 1 160px' }}>
            찾기
            <input className="input mono" placeholder="/\b\d{6}-\d{7}\b/g" value={draft.modify?.find ?? ''} onChange={(e) => set({ modify: { find: e.target.value, replace: draft.modify?.replace ?? '' } })} />
          </label>
          <label className="field" style={{ flex: '1 1 160px' }}>
            바꾸기
            <input className="input mono" placeholder="[가림]" value={draft.modify?.replace ?? ''} onChange={(e) => set({ modify: { find: draft.modify?.find ?? '', replace: e.target.value } })} />
          </label>
          <span style={{ flexBasis: '100%' }}>{shown('modify')}</span>
        </div>
      ) : null}
      <label className="field">
        문구
        <input className={`input${shown('reason') ? ' bad' : ''}`} maxLength={HOOK_REASON_MAX + 20} placeholder="{host} 로 보내는 요청은 막습니다" value={draft.reason} onChange={(e) => set({ reason: e.target.value })} />
        {shown('reason')}
      </label>
      {hook?.code && !dirty ? (
        <pre className="codebox" style={{ fontSize: 11.5 }}>
          {hook.code}
        </pre>
      ) : null}
      {serverError ? (
        <span className="err" role="alert">
          {serverError}
        </span>
      ) : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        {hook ? (
          <button type="button" className="btn sm danger" disabled={busy} onClick={() => void remove()}>
            <Icon name="trash" size={13} />
            삭제
          </button>
        ) : null}
        {attempted && problems.length > 0 ? <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>입력 오류 {problems.length}개를 고쳐야 저장됩니다</span> : null}
        <span style={{ marginLeft: 'auto' }} />
        {dirty && hook ? (
          <button type="button" className="btn sm" onClick={() => setDraft(toDraft(hook))}>
            되돌리기
          </button>
        ) : null}
        <button type="submit" className="btn sm primary" disabled={busy || (!dirty && hook !== null)}>
          {busy ? <span className="spinner" style={{ width: 13, height: 13, borderTopColor: 'var(--onAccent)' }} /> : null}
          저장
        </button>
      </div>
      <HookTest
        key={draft.event}
        event={draft.event}
        run={(sample) => {
          if (hook && !dirty) return api<{ outcome: HookOutcome }>('/api/hooks/test', { body: { id: hook.id, sample } }).then((r) => r.outcome);
          if (problems.length > 0) return Promise.reject(new Error(`입력 오류를 먼저 고치세요: ${problems[0]?.text ?? ''}`));
          return api<{ outcome: HookOutcome }>('/api/hooks/test', { body: { hook: { ...draft, modify: draft.action === 'modify' ? draft.modify : null }, sample } }).then((r) => r.outcome);
        }}
      />
    </form>
  );
}

function FileHookView({ file }: { file: HooksResponse['files'][number] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <b style={{ fontSize: 15 }}>{file.name}</b>
        <span className="chip mono">{file.file}</span>
        <span className={`chip ${file.enabled ? 'ok' : ''}`}>{file.enabled ? '켜짐' : '꺼짐'}</span>
      </div>
      <div className="kv" style={{ gridTemplateColumns: '64px minmax(0,1fr)' }}>
        <span>이벤트</span>
        <span className="mono">{file.event}</span>
        <span>동작</span>
        <span>{ACTION_LABEL[file.action as RuleHook['action']] ?? file.action}</span>
      </div>
      <pre className="codebox" style={{ fontSize: 11.5, maxHeight: 360, overflow: 'auto' }}>
        {file.source}
      </pre>
    </div>
  );
}

function HooksPanel({ meta }: { meta: Meta }) {
  const [data, setData] = useState<HooksResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [reloading, setReloading] = useState(false);

  const load = useCallback(() => {
    api<HooksResponse>('/api/hooks')
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);
  useEffect(load, [load]);

  const reloadFiles = async (): Promise<void> => {
    setReloading(true);
    try {
      const r = await api<{ files: number; errors: { file: string; message: string }[] }>('/api/hooks/reload', { body: {} });
      toast(r.errors.length > 0 ? `코드 훅 ${r.files}개 · 오류 ${r.errors.length}개` : `코드 훅 ${r.files}개를 다시 읽었습니다`, r.errors.length > 0 ? 'error' : 'ok');
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setReloading(false);
    }
  };

  const toggleRule = async (h: RuleHook, enabled: boolean): Promise<void> => {
    try {
      await api(`/api/hooks/${h.id}`, { method: 'PUT', body: { ...h, enabled } });
      load();
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };

  if (error) {
    return (
      <section className="card card-pad" role="alert" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <b>훅 목록을 불러오지 못했습니다</b>
        <span className="err">{error}</span>
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={load}>
          다시 시도
        </button>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="card empty">
        <span className="spinner" />
      </section>
    );
  }

  const guard = selected?.type === 'guard' ? data.guards.find((g) => g.id === selected.id) : undefined;
  const rule = selected?.type === 'rule' ? data.rules.find((r) => r.id === selected.id) : undefined;
  const file = selected?.type === 'file' ? data.files.find((f) => f.id === selected.id) : undefined;
  const isSel = (type: string, id: string): boolean => selected !== null && selected.type === type && 'id' in selected && selected.id === id;

  let editor: ReactNode = null;
  if (guard) editor = <GuardView guard={guard} />;
  else if (selected?.type === 'new') {
    editor = (
      <RuleEditor
        key="new"
        hook={null}
        meta={meta}
        onSaved={(h) => {
          load();
          setSelected({ type: 'rule', id: h.id });
        }}
        onDeleted={() => setSelected(null)}
      />
    );
  } else if (rule) {
    editor = (
      <RuleEditor
        key={rule.id + (rule.code ?? '')}
        hook={rule}
        meta={meta}
        onSaved={load}
        onDeleted={() => {
          load();
          setSelected(null);
        }}
      />
    );
  }
  if (file) editor = <FileHookView file={file} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="card" aria-label="훅">
        <div className="card-head">
          <h2>훅</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>
            모든 에이전트 공통
          </span>
          <button type="button" className="btn sm primary" style={{ marginLeft: 'auto' }} onClick={() => setSelected({ type: 'new' })}>
            <Icon name="plus" size={14} stroke={2.4} />훅 추가
          </button>
        </div>
        <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6, paddingBottom: 4 }}>
              <Icon name="lock" size={12} stroke={2.4} />
              기본 금지 조항 {data.guards.length} · 항상 켜짐
            </span>
            {data.guards.map((g) => (
              <button key={g.id} type="button" className="hook-item" aria-pressed={isSel('guard', g.id)} onClick={() => setSelected({ type: 'guard', id: g.id })}>
                <Icon name="shield" size={15} stroke={2} />
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>{g.name}</span>
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {g.events[0]}
                </span>
                {g.hits24h ? (
                  <span className="chip bad" style={{ marginLeft: 'auto', height: 20 }}>
                    {g.hits24h}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="section-label" style={{ paddingBottom: 4 }}>
              사용자 훅 {data.rules.length + data.files.length}
            </span>
            {data.rules.length + data.files.length === 0 ? <span className="muted" style={{ fontSize: 13, padding: '4px 8px' }}>없음</span> : null}
            {data.rules.map((h) => (
              <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button type="button" className="hook-item" aria-pressed={isSel('rule', h.id)} onClick={() => setSelected({ type: 'rule', id: h.id })} style={{ opacity: h.enabled ? 1 : 0.55 }}>
                  <Icon name="bolt" size={15} stroke={2} />
                  <span style={{ fontSize: 13.5, fontWeight: 500, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
                  <span className="mono muted" style={{ fontSize: 11 }}>
                    {h.event}
                  </span>
                  <span className={`chip ${h.action === 'deny' ? 'bad' : h.action === 'ask' ? 'warn' : ''}`} style={{ marginLeft: 'auto', height: 20 }}>
                    {ACTION_LABEL[h.action]}
                  </span>
                </button>
                <Switch checked={h.enabled} label={`${h.name} 켜기`} onChange={(v) => void toggleRule(h, v)} />
              </div>
            ))}
            {data.files.map((f) => (
              <button key={f.id} type="button" className="hook-item" aria-pressed={isSel('file', f.id)} onClick={() => setSelected({ type: 'file', id: f.id })} style={{ opacity: f.enabled ? 1 : 0.55 }}>
                <Icon name="code" size={15} stroke={2} />
                <span style={{ fontSize: 13.5, fontWeight: 500 }}>{f.name}</span>
                <span className="mono muted" style={{ fontSize: 11 }}>
                  {f.file}
                </span>
                <span className="chip" style={{ marginLeft: 'auto', height: 20 }}>
                  {ACTION_LABEL[f.action as RuleHook['action']] ?? f.action}
                </span>
              </button>
            ))}
            {data.fileErrors.map((e) => (
              <div key={e.file} className="alert">
                <Icon name="x" size={13} stroke={2.6} />
                <span style={{ overflowWrap: 'anywhere' }}>
                  <b className="mono">{e.file}</b> {e.message}
                </span>
              </div>
            ))}
            <button type="button" className="btn xs" style={{ alignSelf: 'flex-start', marginTop: 6 }} disabled={reloading} onClick={() => void reloadFiles()}>
              {reloading ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="refresh" size={12} stroke={2.4} />}
              코드 훅 다시 읽기
            </button>
          </div>
        </div>
      </section>
      {editor ? (
        <section className="card card-pad" style={{ animation: 'slidein .3s ease both' }} aria-label="훅 편집">
          {editor}
        </section>
      ) : null}
    </div>
  );
}

/* ───────── 페이지 ───────── */

export function GuardPage({ agentId }: { agentId: string | null }) {
  const overview = useApp((s) => s.overview) as Overview;
  const meta = useApp((s) => s.meta) as Meta;
  const agent = agentId ? overview.agents.find((a) => a.id === agentId) : undefined;
  const first = overview.agents[0];

  useEffect(() => {
    if (!agentId && first) navigate(`/guard/${first.id}`, { replace: true });
  }, [agentId, first]);

  return (
    <>
      <div className="page-head">
        <h1>권한 · 훅</h1>
        {overview.agents.length > 0 ? (
          <div role="tablist" aria-label="에이전트" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {overview.agents.map((a) => (
              <button key={a.id} type="button" role="tab" aria-selected={a.id === agentId} className="hook-item" aria-pressed={a.id === agentId} style={{ width: 'auto', padding: '5px 10px 5px 6px' }} onClick={() => navigate(`/guard/${a.id}`, { replace: true })}>
                <Avatar name={a.name} color={a.color} size={24} />
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{a.name}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="row">
        <div className="grow">
          {agent ? (
            <PermissionsEditor key={agent.id} agent={agent} meta={meta} />
          ) : overview.agents.length === 0 ? (
            <div className="card empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <span>에이전트가 없습니다</span>
              <button type="button" className="btn sm primary" onClick={() => navigate('/hire')}>
                새 에이전트
              </button>
            </div>
          ) : agentId ? (
            <div className="card empty" role="alert">
              에이전트 '{agentId}'를 찾을 수 없습니다
            </div>
          ) : null}
        </div>
        <div className="side" style={{ flex: '1 1 380px' }}>
          <HooksPanel meta={meta} />
        </div>
      </div>
    </>
  );
}
