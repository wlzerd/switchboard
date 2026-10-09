import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ColorPicker } from '../components/AgentEdit';
import { DelegationEditor } from '../components/Delegation';
import { Icon } from '../components/Icon';
import { EffortPicker, ModelPicker } from '../components/ModelPicker';
import { Avatar, ChipInput, ModuleIcon, Seg, Switch } from '../components/ui';
import { AGENT_COLORS, agentNameProblem, EFFORT_LABEL, NAME_MAX, nextFreeName } from '../lib/agent';
import { api, ApiError, errorText } from '../lib/api';
import { DEFAULT_DELEGATION, delegationChips } from '../lib/autonomy';
import { compactTokens } from '../lib/format';
import { navigate } from '../lib/router';
import { refreshOverview, useApp } from '../lib/store';
import type { DelegationSettings, Effort, Meta, Mode, ModelInfo, ModuleView, Overview } from '../lib/types';

const STEPS = ['이름', 'API 키', '모델', '권한', '위임', '연결'] as const;
type StepIndex = 0 | 1 | 2 | 3 | 4 | 5;
const LAST: StepIndex = 5;

type Stage = 'format' | 'auth' | 'models';
const STAGES: Stage[] = ['format', 'auth', 'models'];
const STAGE_LABEL: Record<Stage, string> = { format: '형식', auth: '인증', models: '모델 목록' };

interface StoredKey {
  id: string;
  label: string;
  /** env: .env 의 ANTHROPIC_API_KEY · stored: 화면에서 입력해 암호화 저장한 키 */
  source: 'env' | 'stored';
  last4: string;
}

interface VerifiedKey {
  keyId: string;
  keyLabel: string;
  latest: ModelInfo[];
  older: ModelInfo[];
}

interface Link {
  targets: string[];
  trigger: 'direct' | 'all';
}

interface Created {
  id: string;
  name: string;
}

const MODE_VIEW: Record<Mode, { text: string; color: string; fill: string }> = {
  allow: { text: '허용', color: 'var(--accent)', fill: 'var(--accent)' },
  ask: { text: '확인', color: 'var(--warn)', fill: 'transparent' },
  deny: { text: '차단', color: 'var(--danger)', fill: 'transparent' },
};

const PRESET_ROWS: { key: string; label: string }[] = [
  { key: 'message', label: '메시지 전송' },
  { key: 'fs.write', label: '파일 쓰기' },
  { key: 'shell.exec', label: '셸 명령' },
  { key: 'net.fetch', label: 'HTTP 요청' },
  { key: 'skill.create', label: '스킬 만들기' },
];

/** 오류 코드가 어느 단계의 입력 때문인지 */
function stepOfError(code: string): StepIndex {
  if (code.startsWith('agent_name') || code === 'agent_color' || code.startsWith('agent_role')) return 0;
  if (code === 'agent_key' || code.startsWith('key_') || code === 'api_key_not_found' || code === 'env_key_missing') return 1;
  if (code.startsWith('agent_model') || code.startsWith('agent_effort')) return 2;
  if (code === 'agent_preset') return 3;
  if (code.startsWith('delegation_')) return 4;
  return LAST;
}

function Section({ index, open, done, title, summary, onEdit, children }: { index: number; open: boolean; done: boolean; title: string; summary: ReactNode; onEdit: () => void; children: ReactNode }) {
  return (
    <section className={`card sec${open ? ' open' : done ? '' : ' future'}`} aria-label={title}>
      <div className="sec-head">
        <h2>{title}</h2>
        {!open && done ? <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, flex: '1 1 200px', minWidth: 0, fontSize: 13, color: 'var(--text2)' }}>{summary}</span> : null}
        {!open && done ? (
          <button type="button" className="btn xs" style={{ marginLeft: 'auto' }} onClick={onEdit} aria-label={`${index + 1}단계 ${title} 수정`}>
            수정
          </button>
        ) : null}
      </div>
      {open ? <div className="sec-body">{children}</div> : null}
    </section>
  );
}

function Checks({ running, ok, error }: { running: boolean; ok: boolean; error: { stage: Stage | null } | null }) {
  const failed = error?.stage ? STAGES.indexOf(error.stage) : -1;
  return (
    <ul className="checks" aria-live="polite">
      {STAGES.map((s, i) => {
        const state = ok ? 'ok' : running ? 'run' : failed === -1 ? 'wait' : i < failed ? 'ok' : i === failed ? 'bad' : 'wait';
        return (
          <li key={s}>
            {state === 'ok' ? (
              <span className="ok-dot">
                <Icon name="check" size={11} stroke={3} />
              </span>
            ) : state === 'bad' ? (
              <span className="bad-dot">
                <Icon name="x" size={11} stroke={3} />
              </span>
            ) : state === 'run' ? (
              <span className="spinner" style={{ width: 16, height: 16 }} />
            ) : (
              <span className="wait-dot" />
            )}
            <span style={{ color: state === 'bad' ? 'var(--danger)' : state === 'wait' ? 'var(--text3)' : undefined }}>{STAGE_LABEL[s]}</span>
          </li>
        );
      })}
    </ul>
  );
}

function KeyStep({ meta, onVerified }: { meta: Meta; onVerified: (k: VerifiedKey) => void }) {
  const [stored, setStored] = useState<StoredKey[]>([]);
  const [mode, setMode] = useState<string>(meta.envKey ? 'env' : 'manual');
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<{ stage: Stage | null; text: string } | null>(null);

  useEffect(() => {
    api<{ keys: StoredKey[] }>('/api/keys')
      .then((r) => setStored(r.keys.filter((k) => k.source === 'stored')))
      .catch(() => {
        // 저장된 키 목록을 못 읽어도 .env 키나 직접 입력으로 계속할 수 있습니다.
      });
  }, []);

  const verify = async (which: string): Promise<void> => {
    setMode(which);
    setRunning(true);
    setError(null);
    try {
      let r: VerifiedKey;
      if (which === 'env') r = await api<VerifiedKey>('/api/keys/verify', { body: { source: 'env' } });
      else if (which === 'manual') r = await api<VerifiedKey>('/api/keys/verify', { body: { source: 'manual', key } });
      else r = await api<VerifiedKey>(`/api/models?keyId=${encodeURIComponent(which)}`);
      if (r.latest.length + r.older.length === 0) {
        setError({ stage: 'models', text: '이 키로 쓸 수 있는 모델이 하나도 없습니다. 콘솔에서 키의 워크스페이스 권한을 확인하세요.' });
        return;
      }
      setKey('');
      onVerified(r);
    } catch (err) {
      const stage = err instanceof ApiError && typeof err.detail?.['stage'] === 'string' && STAGES.includes(err.detail['stage'] as Stage) ? (err.detail['stage'] as Stage) : which.startsWith('key_') ? 'auth' : null;
      setError({ stage, text: errorText(err) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <div className="pick-grid" role="radiogroup" aria-label="API 키">
        {meta.envKey ? (
          <button type="button" role="radio" aria-checked={mode === 'env'} className="pick" disabled={running} onClick={() => void verify('env')}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <b>.env 기본 키</b>
              <span className="radio" />
            </span>
            <span className="mono muted" style={{ fontSize: 12 }}>
              ANTHROPIC_API_KEY
            </span>
          </button>
        ) : null}
        {stored.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={mode === k.id} className="pick" disabled={running} onClick={() => void verify(k.id)}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <b>{k.label}</b>
              <span className="radio" />
            </span>
            <span className="mono muted" style={{ fontSize: 12 }}>
              sk-ant-…{k.last4}
            </span>
          </button>
        ))}
        <button type="button" role="radio" aria-checked={mode === 'manual'} className="pick" disabled={running} onClick={() => setMode('manual')}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <b>직접 입력</b>
            <span className="radio" />
          </span>
          <span className="mono muted" style={{ fontSize: 12 }}>
            sk-ant-api03-…
          </span>
        </button>
      </div>
      {mode === 'manual' ? (
        <form
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void verify('manual');
          }}
        >
          <div style={{ position: 'relative', flex: '1 1 260px', display: 'flex' }}>
            <input
              className={`input mono${error && mode === 'manual' ? ' bad' : ''}`}
              style={{ flex: 1, paddingRight: 44, fontSize: 13 }}
              type={show ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              aria-label="Anthropic API 키"
              placeholder="sk-ant-api03-…"
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                if (error) setError(null);
              }}
            />
            <button type="button" className="icon-btn" style={{ position: 'absolute', right: 4, top: 2, width: 36, border: 0 }} aria-label={show ? '키 가리기' : '키 보기'} onClick={() => setShow(!show)}>
              <Icon name="eye" size={16} />
            </button>
          </div>
          <button type="submit" className="btn primary" disabled={running || key.trim() === ''}>
            {running ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
            확인
          </button>
        </form>
      ) : null}
      {running || error ? <Checks running={running} ok={false} error={error} /> : null}
      {error ? (
        <span className="err" role="alert">
          {error.text}
        </span>
      ) : null}
    </>
  );
}

function PresetStep({ meta, value, onChange }: { meta: Meta; value: string; onChange: (id: string) => void }) {
  return (
    <>
      <div className="pick-grid" role="radiogroup" aria-label="권한 프리셋">
        {meta.presets.map((p, i) => (
          <button key={p.id} type="button" role="radio" aria-checked={value === p.id} className="pick" style={{ animationDelay: `${i * 0.05}s` }} onClick={() => onChange(p.id)}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{p.name}</span>
              <span className="radio" />
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 5, width: '100%' }}>
              {PRESET_ROWS.map((r) => {
                const mode: Mode = r.key === 'message' ? p.message : (p.permissions[r.key]?.mode ?? 'ask');
                const v = MODE_VIEW[mode];
                return (
                  <span key={r.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                    <span className="dim">{r.label}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600, color: v.color }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: v.fill, border: `1.5px solid ${v.color}` }} />
                      {v.text}
                    </span>
                  </span>
                );
              })}
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12.5 }}>
                <span className="dim">하루 토큰</span>
                <span className="mono">{compactTokens(p.limits.tokensPerDay)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 14px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 12, fontSize: 13, color: 'var(--text2)' }}>
        <Icon name="lock" size={15} stroke={2} />
        <span>
          <b style={{ color: 'var(--text)' }}>기본 금지 조항 {meta.guards.length}개</b> · 항상 적용
        </span>
        <span className="chips" style={{ marginLeft: 'auto' }}>
          {meta.guards.slice(0, 4).map((g) => (
            <span key={g.id} className="chip">
              {g.name}
            </span>
          ))}
          {meta.guards.length > 4 ? <span className="chip">+{meta.guards.length - 4}</span> : null}
        </span>
      </div>
    </>
  );
}

function moduleSub(m: ModuleView): string {
  const missing = m.env.filter((e) => e.required && !e.present).map((e) => e.name);
  if (missing.length > 0) return `.env 에 ${missing.join(', ')} 필요`;
  if (!m.enabled) return '꺼짐 · 모듈 화면에서 켤 수 있음';
  if (m.status === 'failed' || m.status === 'crashed') return m.statusDetail ?? '오류';
  if (m.kind === 'skill') return m.tools.map((t) => t.name).join(', ');
  if (m.computer) return '화면 제어';
  return m.channel ? (m.canSend ? '채널' : '받기 전용') : m.description;
}

function LinkStep({ modules, links, onChange }: { modules: ModuleView[]; links: Record<string, Link>; onChange: (next: Record<string, Link>) => void }) {
  if (modules.length === 0) return <div className="empty">연결할 모듈이 없습니다</div>;
  const set = (id: string, link: Link | null): void => {
    const next = { ...links };
    if (link) next[id] = link;
    else delete next[id];
    onChange(next);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {modules.map((m, i) => {
        const link = links[m.id];
        const tone = m.kind === 'skill' ? 'skill' : m.channel ? 'msg' : 'text2';
        return (
          <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px', background: 'var(--panel)', border: `1px solid ${link ? `color-mix(in srgb, var(--${tone === 'text2' ? 'accent' : tone}) 45%, transparent)` : 'var(--line)'}`, borderRadius: 12, transition: 'border-color .2s ease', animation: `rise .35s ${Math.min(i, 8) * 0.04}s ease backwards` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 32, height: 32, flex: 'none', borderRadius: 9, display: 'grid', placeItems: 'center', background: tone === 'text2' ? 'var(--raised)' : `var(--${tone}-dim)`, color: `var(--${tone})` }}>
                {m.kind === 'skill' ? <Icon name="bolt" size={16} stroke={2} /> : <ModuleIcon icon={m.icon} />}
              </span>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{m.name}</span>
                <span className="muted" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {moduleSub(m)}
                </span>
              </span>
              <span style={{ marginLeft: 'auto' }}>
                <Switch checked={Boolean(link)} label={`${m.name} 연결`} onChange={(on) => set(m.id, on ? { targets: [], trigger: 'direct' } : null)} />
              </span>
            </div>
            {link && m.canSend ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, paddingLeft: 44, animation: 'rise .25s ease backwards' }}>
                <ChipInput value={link.targets} onChange={(targets) => set(m.id, { ...link, targets })} label={`${m.name} 대상`} placeholder="모든 대화 · #채널 또는 ID" />
                <Seg
                  value={link.trigger}
                  options={[
                    { value: 'direct', label: '부를 때만' },
                    { value: 'all', label: '모든 메시지' },
                  ]}
                  onChange={(trigger) => set(m.id, { ...link, trigger })}
                  label={`${m.name} 응답 방식`}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function HirePage() {
  const overview = useApp((s) => s.overview) as Overview;
  const meta = useApp((s) => s.meta) as Meta;
  const [step, setStep] = useState<StepIndex>(0);
  const [done, setDone] = useState<boolean[]>([false, false, false, false, false, false]);

  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(() => AGENT_COLORS[overview.agents.length % AGENT_COLORS.length] ?? AGENT_COLORS[0]);
  const [role, setRole] = useState('');
  const [nameTouched, setNameTouched] = useState(false);

  const [key, setKey] = useState<VerifiedKey | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [preset, setPreset] = useState<string>(() => meta.presets.find((p) => p.id === 'helper')?.id ?? meta.presets[0]?.id ?? 'helper');
  const [links, setLinks] = useState<Record<string, Link>>({});
  const [delegation, setDelegation] = useState<DelegationSettings>(DEFAULT_DELEGATION);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ step: StepIndex; text: string } | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const nameProblem = agentNameProblem(name, overview.agents);
  const models = key ? [...key.latest, ...key.older] : [];
  const info = models.find((m) => m.id === model) ?? null;
  const presetName = meta.presets.find((p) => p.id === preset)?.name ?? preset;
  const linkable = useMemo(() => [...overview.modules, ...overview.skills].filter((m) => m.status !== 'pending' && m.status !== 'rejected'), [overview.modules, overview.skills]);
  const linkedNames = linkable.filter((m) => links[m.id]).map((m) => (m.kind === 'skill' ? (m.tools[0]?.name ?? m.name) : m.name));
  const linkSummary = linkedNames.length === 0 ? '연결 없음' : linkedNames.join(' · ');

  const finish = (i: StepIndex): void => {
    setDone((d) => d.map((v, j) => (j === i ? true : v)));
    const next = done.findIndex((v, j) => j > i && !v);
    setStep((next === -1 ? LAST : next) as StepIndex);
    if (submitError?.step === i) setSubmitError(null);
  };

  const hire = async (): Promise<void> => {
    if (!key || !model) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const r = await api<{ agent: Created }>('/api/agents', {
        body: {
          name: name.trim(),
          color,
          role: role.trim(),
          keyId: key.keyId,
          model,
          effort,
          preset,
          modules: Object.entries(links).map(([moduleId, l]) => ({ moduleId, targets: l.targets, trigger: l.trigger })),
          delegation,
        },
      });
      setCreated({ id: r.agent.id, name: r.agent.name });
      refreshOverview(0);
    } catch (err) {
      const at = err instanceof ApiError ? stepOfError(err.code) : LAST;
      setSubmitError({ step: at, text: errorText(err) });
      setStep(at);
    } finally {
      setSubmitting(false);
    }
  };

  const another = (): void => {
    setCreated(null);
    setName(nextFreeName(name, [...overview.agents, { name: name.trim() }]));
    setRole('');
    setNameTouched(false);
    setColor(AGENT_COLORS[(overview.agents.length + 1) % AGENT_COLORS.length] ?? AGENT_COLORS[0]);
    setStep(0);
    setDone([false, true, true, true, true, true]);
  };

  const stepError = (i: StepIndex): ReactNode =>
    submitError?.step === i ? (
      <span className="err" role="alert">
        {submitError.text}
      </span>
    ) : null;

  if (created) {
    return (
      <div className="narrow">
        <section className="card success" aria-live="polite">
          <span className="burst">
            <span>
              <Icon name="check" size={30} stroke={3} />
            </span>
          </span>
          <h1 style={{ margin: 0, fontSize: 22 }}>{created.name} 가동 시작</h1>
          <div className="chips" style={{ justifyContent: 'center' }}>
            <span className="chip mono">{info?.name ?? model}</span>
            {effort ? <span className="chip">노력 {EFFORT_LABEL[effort]}</span> : null}
            <span className="chip">{presetName}</span>
            <span className="chip">위임 {delegationChips(delegation, overview.agents).join(' · ')}</span>
            <span className="chip msg">{linkSummary}</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 8 }}>
            <button type="button" className="btn" onClick={() => navigate('/')}>
              <Icon name="graph" size={15} />
              캔버스에서 보기
            </button>
            <button type="button" className="btn" onClick={another}>
              <Icon name="plus" size={15} stroke={2.2} />
              같은 설정으로 하나 더
            </button>
            <button type="button" className="btn primary" onClick={() => navigate(`/console/${created.id}`)}>
              <Icon name="terminal" size={15} stroke={2.1} />
              콘솔 열기
            </button>
          </div>
        </section>
      </div>
    );
  }

  const reached = done.lastIndexOf(true) + 1;
  return (
    <div className="narrow">
      <div className="page-head">
        <button type="button" className="icon-btn" aria-label="뒤로" onClick={() => (history.length > 1 ? history.back() : navigate('/'))}>
          <Icon name="arrowLeft" size={16} />
        </button>
        <h1>새 에이전트</h1>
      </div>
      <ol className="stepper" aria-label="단계" style={{ '--steps': STEPS.length } as CSSProperties}>
        <li className="rail" aria-hidden="true">
          <span style={{ width: `${(Math.min(reached, LAST) / LAST) * 100}%` }} />
        </li>
        {STEPS.map((title, i) => (
          <li key={title}>
            <button type="button" className={done[i] && step !== i ? 'done' : step === i ? 'cur' : ''} aria-current={step === i ? 'step' : undefined} disabled={!done[i] && step !== i && i > reached} onClick={() => setStep(i as StepIndex)} aria-label={`${i + 1}단계 ${title}`}>
              {done[i] && step !== i ? <Icon name="check" size={13} stroke={3} /> : i + 1}
            </button>
            <span style={{ color: step === i ? 'var(--text)' : 'var(--text3)' }}>{title}</span>
          </li>
        ))}
      </ol>

      <Section
        index={0}
        open={step === 0}
        done={done[0] ?? false}
        title="이름"
        onEdit={() => setStep(0)}
        summary={
          <>
            <Avatar name={name || '?'} color={color} size={24} />
            <b style={{ color: 'var(--text)' }}>{name.trim()}</b>
            {role ? <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>{role}</span> : null}
          </>
        }
      >
        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
          onSubmit={(e) => {
            e.preventDefault();
            setNameTouched(true);
            if (!nameProblem) finish(0);
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
            <Avatar name={name.trim() || '?'} color={color} size={44} />
            <label className="field" style={{ flex: 1 }}>
              이름
              <input className={`input${nameTouched && nameProblem ? ' bad' : ''}`} autoFocus value={name} maxLength={NAME_MAX + 8} onChange={(e) => setName(e.target.value)} onBlur={() => setNameTouched(name !== '')} aria-invalid={nameTouched && nameProblem !== null} />
            </label>
          </div>
          {nameTouched && nameProblem ? <span className="err">{nameProblem}</span> : null}
          <div className="field">
            색
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <label className="field">
            역할
            <textarea className="textarea" rows={3} maxLength={2000} value={role} onChange={(e) => setRole(e.target.value)} />
          </label>
          {stepError(0)}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn primary" disabled={name.trim() === ''}>
              다음
            </button>
          </div>
        </form>
      </Section>

      <Section
        index={1}
        open={step === 1}
        done={done[1] ?? false}
        title="API 키"
        onEdit={() => setStep(1)}
        summary={
          key ? (
            <>
              <b style={{ color: 'var(--text)' }}>{key.keyLabel}</b>
              <span className="chip ok">
                <Icon name="check" size={11} stroke={3} />
                확인됨
              </span>
              <span>모델 {models.length}개</span>
            </>
          ) : null
        }
      >
        <KeyStep
          meta={meta}
          onVerified={(k) => {
            setKey(k);
            const keep = [...k.latest, ...k.older].find((m) => m.id === model);
            const pick = keep ?? k.latest[0] ?? k.older[0] ?? null;
            setModel(pick?.id ?? null);
            if (effort && pick && !pick.efforts.includes(effort)) setEffort(null);
            finish(1);
          }}
        />
        {stepError(1)}
      </Section>

      <Section
        index={2}
        open={step === 2}
        done={done[2] ?? false}
        title="모델"
        onEdit={() => setStep(2)}
        summary={
          info ? (
            <>
              <b style={{ color: 'var(--text)' }}>{info.name}</b>
              <span className="mono">{info.id}</span>
              {effort ? <span>· 노력 {EFFORT_LABEL[effort]}</span> : null}
            </>
          ) : null
        }
      >
        {key ? (
          <>
            <ModelPicker
              latest={key.latest}
              older={key.older}
              value={model}
              onChange={(m) => {
                setModel(m.id);
                if (effort && !m.efforts.includes(effort)) setEffort(null);
              }}
            />
            <div className="field">
              노력
              <EffortPicker model={info} value={effort} onChange={setEffort} />
            </div>
            {stepError(2)}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn primary" disabled={!model} onClick={() => finish(2)}>
                다음
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setStep(1)}>
            API 키 확인하기
          </button>
        )}
      </Section>

      <Section
        index={3}
        open={step === 3}
        done={done[3] ?? false}
        title="권한"
        onEdit={() => setStep(3)}
        summary={
          <>
            <b style={{ color: 'var(--text)' }}>{presetName}</b>
            <span className="chip">
              <Icon name="lock" size={11} stroke={2.4} />
              기본 금지 조항 {meta.guards.length}개
            </span>
          </>
        }
      >
        <PresetStep meta={meta} value={preset} onChange={setPreset} />
        {stepError(3)}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary" onClick={() => finish(3)}>
            다음
          </button>
        </div>
      </Section>

      <Section
        index={4}
        open={step === 4}
        done={done[4] ?? false}
        title="위임"
        onEdit={() => setStep(4)}
        summary={
          <>
            {delegationChips(delegation, overview.agents).map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </>
        }
      >
        <DelegationEditor agents={overview.agents} selfId={null} value={delegation} onChange={setDelegation} />
        {stepError(4)}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button type="button" className="btn primary" onClick={() => finish(4)}>
            다음
          </button>
        </div>
      </Section>

      <Section index={LAST} open={step === LAST} done={done[LAST] ?? false} title="연결" onEdit={() => setStep(LAST)} summary={<span>{linkSummary}</span>}>
        <LinkStep modules={linkable} links={links} onChange={setLinks} />
        {stepError(LAST)}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end', gap: 10 }}>
          {!done.slice(0, LAST).every(Boolean) ? (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {STEPS.filter((_, i) => i < LAST && !done[i]).join(' · ')} 단계가 남았습니다
            </span>
          ) : null}
          <button type="button" className="btn primary" style={{ height: 44, padding: '0 22px', fontSize: 15 }} disabled={submitting || !done.slice(0, LAST).every(Boolean) || !key || !model || nameProblem !== null} onClick={() => void hire()}>
            {submitting ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
            고용하기
            <Icon name="arrowRight" size={16} stroke={2.4} />
          </button>
        </div>
      </Section>
    </div>
  );
}
