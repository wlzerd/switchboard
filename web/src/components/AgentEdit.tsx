import { useEffect, useState } from 'react';
import { AGENT_COLORS, agentNameProblem, NAME_MAX } from '../lib/agent';
import { api, ApiError, errorText } from '../lib/api';
import { refreshOverview, toast, useApp } from '../lib/store';
import type { AgentView, Effort, ModelInfo } from '../lib/types';
import { Avatar, Modal } from './ui';
import { EffortPicker, ModelPicker } from './ModelPicker';

type Field = 'name' | 'color' | 'role' | 'model' | 'form';

function fieldOf(code: string): Field {
  if (code.startsWith('agent_name')) return 'name';
  if (code === 'agent_color') return 'color';
  if (code.startsWith('agent_role')) return 'role';
  if (code.startsWith('agent_model') || code.startsWith('agent_effort') || code.startsWith('key_') || code.startsWith('anthropic')) return 'model';
  return 'form';
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
  const [name, setName] = useState(agent.name);
  const [color, setColor] = useState(agent.color);
  const [role, setRole] = useState(agent.role);
  const [model, setModel] = useState(agent.model);
  const [effort, setEffort] = useState<Effort | null>(agent.effort);
  const [models, setModels] = useState<{ latest: ModelInfo[]; older: ModelInfo[] } | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [error, setError] = useState<{ field: Field; text: string } | null>(null);
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

  const save = async (): Promise<void> => {
    if (nameProblem) {
      setError({ field: 'name', text: nameProblem });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (name.trim() !== agent.name) patch['name'] = name.trim();
    if (color !== agent.color) patch['color'] = color;
    if (role.trim() !== agent.role) patch['role'] = role.trim();
    if (model !== agent.model) patch['model'] = model;
    if (effort !== agent.effort) patch['effort'] = effort;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/agents/${agent.id}`, { method: 'PATCH', body: patch });
      refreshOverview(0);
      toast(`${name.trim()} 설정을 저장했습니다`, 'ok');
      onClose();
    } catch (err) {
      setError({ field: err instanceof ApiError ? fieldOf(err.code) : 'form', text: errorText(err) });
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
        {error?.field === 'form' ? (
          <span className="err" role="alert">
            {error.text}
          </span>
        ) : null}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="btn primary" disabled={busy || nameProblem !== null}>
            {busy ? <span className="spinner" style={{ borderTopColor: 'var(--onAccent)' }} /> : null}
            저장
          </button>
        </div>
      </form>
    </Modal>
  );
}
