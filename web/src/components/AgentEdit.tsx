import { useEffect, useMemo, useState } from 'react';
import { AGENT_COLORS, agentNameProblem, NAME_MAX } from '../lib/agent';
import { api, ApiError, errorText } from '../lib/api';
import { heartbeatFormOf, heartbeatFormProblem, heartbeatPayload, intervalChoices, intervalLabel, receivesNotices, sameHeartbeat, type HeartbeatForm, type HeartbeatLimits } from '../lib/autonomy';
import { relTime } from '../lib/format';
import { countLimitChanges, limitDraft, limitLabel, limitNumbers, limitProblem, type LimitDraft } from '../lib/limits';
import { refreshOverview, toast, useApp } from '../lib/store';
import type { AgentLimits, AgentView, Effort, Meta, ModelInfo, ModuleView } from '../lib/types';
import { Icon } from './Icon';
import { Avatar, Modal, Seg, Switch } from './ui';
import { EffortPicker, ModelPicker } from './ModelPicker';

type Field = 'name' | 'color' | 'role' | 'model' | 'limits' | 'heartbeat' | 'form';

function fieldOf(code: string): Field {
  if (code.startsWith('agent_name')) return 'name';
  if (code === 'agent_color') return 'color';
  if (code.startsWith('agent_role')) return 'role';
  if (code.startsWith('agent_model') || code.startsWith('agent_effort') || code.startsWith('key_') || code.startsWith('anthropic')) return 'model';
  if (code.startsWith('limit')) return 'limits';
  if (code.startsWith('heartbeat') || code.startsWith('report')) return 'heartbeat';
  return 'form';
}

/** 한도: 칸마다 입력하는 즉시 검사해 아래에 이유를 붉은 글씨로 보여 줍니다. server 는 서버가 거절한 칸과 이유 */
function LimitFields({ rules, draft, set, server }: { rules: Meta['limitRules']; draft: LimitDraft; set: (key: keyof AgentLimits, value: string) => void; server: { field: string | null; text: string } | null }) {
  const keys = Object.keys(rules) as (keyof AgentLimits)[];
  return (
    <div className="field">
      한도
      <div className="limit-grid">
        {keys.map((k) => {
          const rule = rules[k];
          const problem = limitProblem(draft[k], rule) ?? (server?.field === k ? server.text : null);
          return (
            <label key={k} className="field limit-field">
              {limitLabel(rule)}
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input className={`input mono${problem ? ' bad' : ''}`} style={{ flex: 1, minWidth: 0 }} inputMode="numeric" value={draft[k]} onChange={(e) => set(k, e.target.value)} aria-invalid={problem !== null} />
                <span className="muted" style={{ fontWeight: 500 }}>
                  {rule.unit}
                </span>
              </span>
              {problem ? <span className="err">{problem}</span> : null}
            </label>
          );
        })}
      </div>
      {server && !server.field ? <span className="err">{server.text}</span> : null}
    </div>
  );
}

/**
 * 하트비트: 스위치를 켜면 간격 · 활동 시간 · 점검 · 알릴 조건 · 보고 받을 곳이 펼쳐집니다.
 * 점검 · 알릴 조건과 보고 받을 곳은 모듈 자동 알림(새 메일 등)에도 쓰여서, 그런 알림을 받는 에이전트는 꺼져 있어도 보입니다.
 */
function HeartbeatFields({ form, set, limits, senders, notices, lastAt, error }: { form: HeartbeatForm; set: (patch: Partial<HeartbeatForm>) => void; limits: HeartbeatLimits; senders: readonly ModuleView[]; notices: boolean; lastAt: number | null; error: string | null }) {
  const choices = intervalChoices(limits, form.everyMinutes);
  return (
    <div className="hb-box">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {form.enabled ? (
            <span className="hb-mark">
              <Icon name="pulse" size={13} stroke={2.2} />
            </span>
          ) : null}
          하트비트
        </span>
        {lastAt ? (
          <span className="muted" style={{ fontSize: 11.5 }}>
            마지막 {relTime(lastAt)}
          </span>
        ) : null}
        <span style={{ marginLeft: 'auto' }}>
          <Switch checked={form.enabled} label="하트비트 켜기" onChange={(enabled) => set({ enabled })} />
        </span>
      </div>
      {form.enabled ? (
        <div className="hb-reveal">
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
            <div className="hb-reveal" style={{ flexDirection: 'row', alignItems: 'center' }}>
              <input className="input mono" type="time" style={{ height: 34, fontSize: 13, flex: 1, minWidth: 0 }} aria-label="활동 시작" value={form.start} onChange={(e) => set({ start: e.target.value })} />
              <span className="muted">–</span>
              <input className="input mono" type="time" style={{ height: 34, fontSize: 13, flex: 1, minWidth: 0 }} aria-label="활동 끝" value={form.end} onChange={(e) => set({ end: e.target.value })} />
            </div>
          ) : null}
        </div>
      ) : null}
      {form.enabled || notices ? (
        <div className="hb-reveal">
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
        </div>
      ) : null}
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div role="radiogroup" aria-label="색" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      {AGENT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toUpperCase() === c}
          aria-label={c}
          onClick={() => onChange(c)}
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            border: 0,
            background: c,
            boxShadow: value.toUpperCase() === c ? `0 0 0 2px var(--surface), 0 0 0 4px ${c}` : 'none',
            transform: value.toUpperCase() === c ? 'scale(1.08)' : 'none',
            transition: 'transform .18s, box-shadow .18s',
          }}
        />
      ))}
      <label style={{ position: 'relative', width: 28, height: 28 }} title="직접 고르기">
        <span className="sr-only">직접 고르기</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} style={{ position: 'absolute', inset: 0, width: 28, height: 28, opacity: 0, cursor: 'pointer' }} />
        <span aria-hidden="true" style={{ display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: '50%', border: '1.5px dashed var(--line2)', color: 'var(--text2)', fontSize: 15 }}>
          +
        </span>
      </label>
    </div>
  );
}

export function AgentEditModal({ agent, onClose }: { agent: AgentView; onClose: () => void }) {
  const agents = useApp((s) => s.overview?.agents);
  const meta = useApp((s) => s.meta) as Meta;
  const modules = useApp((s) => s.overview?.modules) ?? [];
  const limits = meta.heartbeat;
  const hbSaved = useMemo(() => heartbeatFormOf(agent, limits), [agent, limits]);
  const [hb, setHb] = useState<HeartbeatForm>(hbSaved);
  const hbDirty = !sameHeartbeat(hb, hbSaved);
  const [name, setName] = useState(agent.name);
  const [color, setColor] = useState(agent.color);
  const [role, setRole] = useState(agent.role);
  const [model, setModel] = useState(agent.model);
  const [effort, setEffort] = useState<Effort | null>(agent.effort);
  const [models, setModels] = useState<{ latest: ModelInfo[]; older: ModelInfo[] } | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const rules = meta.limitRules;
  const limitKeys = Object.keys(rules) as (keyof AgentLimits)[];
  const [limitsDraft, setLimitsDraft] = useState<LimitDraft>(() => limitDraft(agent.limits));
  const limitsDirty = countLimitChanges(agent.limits, limitsDraft) > 0;
  const limitsBad = limitKeys.some((k) => limitProblem(limitsDraft[k], rules[k]) !== null);
  // sub: 서버가 거절한 한도 칸 (detail.field)
  const [error, setError] = useState<{ field: Field; text: string; sub?: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    api<{ agent: { keyId: string } }>(`/api/agents/${agent.id}`, { signal: ac.signal })
      .then((r) => api<{ latest: ModelInfo[]; older: ModelInfo[] }>(`/api/models?keyId=${encodeURIComponent(r.agent.keyId)}`, { signal: ac.signal }))
      .then((r) => setModels({ latest: r.latest, older: r.older }))
      .catch((err: unknown) => {
        if ((err as Error).name !== 'AbortError') setModelsError(errorText(err));
      });
    return () => ac.abort();
  }, [agent.id]);

  const all = models ? [...models.latest, ...models.older] : [];
  const info = all.find((m) => m.id === model) ?? null;
  const nameProblem = agentNameProblem(name, agents ?? [], agent.id);

  const pickModel = (m: ModelInfo): void => {
    setModel(m.id);
    if (effort && !m.efforts.includes(effort)) setEffort(null);
  };

  const setLimit = (key: keyof AgentLimits, value: string): void => {
    setLimitsDraft((d) => ({ ...d, [key]: value }));
    if (error?.field === 'limits') setError(null);
  };

  const setHeartbeat = (patch: Partial<HeartbeatForm>): void => {
    setHb((f) => ({ ...f, ...patch }));
    if (error?.field === 'heartbeat') setError(null);
  };

  const save = async (): Promise<void> => {
    if (nameProblem) {
      setError({ field: 'name', text: nameProblem });
      return;
    }
    if (limitsBad) return;
    const hbProblem = hbDirty ? heartbeatFormProblem(hb, limits, modules) : null;
    if (hbProblem) {
      setError({ field: 'heartbeat', text: hbProblem });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== agent.name) patch['name'] = name.trim();
    if (color !== agent.color) patch['color'] = color;
    if (role.trim() !== agent.role) patch['role'] = role.trim();
    if (model !== agent.model) patch['model'] = model;
    if (effort !== agent.effort) patch['effort'] = effort;
    const newLimits = limitsDirty ? limitNumbers(limitsDraft, limitKeys) : null;
    if (newLimits) patch['limits'] = newLimits;
    if (Object.keys(patch).length === 0 && !hbDirty) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    // 에이전트 정보와 하트비트는 따로 저장합니다. 하트비트에서 실패하면 그 칸 아래에 이유를 보여 줍니다.
    let stage: 'agent' | 'heartbeat' = 'agent';
    try {
      if (Object.keys(patch).length > 0) await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: patch });
      stage = 'heartbeat';
      if (hbDirty) await api(`/api/agents/${agent.id}/heartbeat`, { method: 'PUT', body: heartbeatPayload(hb) });
      refreshOverview(0);
      const turned = hbDirty && hb.enabled !== hbSaved.enabled ? (hb.enabled ? ` · 하트비트 ${intervalLabel(hb.everyMinutes)}마다` : ' · 하트비트 끔') : '';
      const tokens = newLimits && newLimits.tokensPerDay !== agent.limits.tokensPerDay ? ` · 일일 토큰 ${newLimits.tokensPerDay === 0 ? '무제한' : newLimits.tokensPerDay.toLocaleString()}` : '';
      toast(`${name.trim()} 설정을 저장했습니다${tokens}${turned}`, 'ok');
      onClose();
    } catch (err) {
      if (stage === 'heartbeat') refreshOverview(0);
      const sub = err instanceof ApiError && typeof err.detail?.['field'] === 'string' ? err.detail['field'] : null;
      setError({ field: stage === 'heartbeat' ? 'heartbeat' : err instanceof ApiError ? fieldOf(err.code) : 'form', text: errorText(err), sub });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="에이전트 설정" onClose={onClose}>
      <form
        style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
          <Avatar name={name || '?'} color={color} size={44} />
          <label className="field" style={{ flex: 1 }}>
            이름
            <input className={`input${error?.field === 'name' ? ' bad' : ''}`} value={name} maxLength={NAME_MAX + 8} onChange={(e) => setName(e.target.value)} aria-invalid={nameProblem !== null} />
          </label>
        </div>
        {nameProblem && name !== agent.name ? <span className="err">{nameProblem}</span> : null}
        {error?.field === 'name' && error.text !== nameProblem ? <span className="err">{error.text}</span> : null}
        <div className="field">
          색
          <ColorPicker value={color} onChange={setColor} />
          {error?.field === 'color' ? <span className="err">{error.text}</span> : null}
        </div>
        <label className="field">
          역할
          <textarea className={`textarea${error?.field === 'role' ? ' bad' : ''}`} rows={3} value={role} maxLength={2000} onChange={(e) => setRole(e.target.value)} />
          {error?.field === 'role' ? <span className="err">{error.text}</span> : null}
        </label>
        <div className="field">
          모델
          {modelsError ? <span className="err">{modelsError}</span> : null}
          {!models && !modelsError ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }} className="muted">
              <span className="spinner" /> 모델 목록을 불러오는 중
            </span>
          ) : null}
          {models ? <ModelPicker latest={models.latest} older={models.older} value={model} onChange={pickModel} /> : null}
        </div>
        <div className="field">
          노력 수준
          <EffortPicker model={info} value={effort} onChange={setEffort} />
          {error?.field === 'model' ? <span className="err">{error.text}</span> : null}
        </div>
        <LimitFields rules={rules} draft={limitsDraft} set={setLimit} server={error?.field === 'limits' ? { field: error.sub ?? null, text: error.text } : null} />
        <HeartbeatFields form={hb} set={setHeartbeat} limits={limits} senders={modules.filter((m) => m.canSend)} notices={receivesNotices(agent, modules)} lastAt={agent.heartbeat?.lastAt ?? null} error={error?.field === 'heartbeat' ? error.text : null} />
        {error?.field === 'form' ? (
          <span className="err" role="alert">
            {error.text}
          </span>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn primary" disabled={busy || nameProblem !== null || limitsBad}>
            {busy ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
            저장
          </button>
        </div>
      </form>
    </Modal>
  );
}
