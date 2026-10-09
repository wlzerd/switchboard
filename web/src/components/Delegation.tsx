import type { ReactNode } from 'react';
import { dependentsOf, supervisorChoices } from '../lib/autonomy';
import type { AgentView, DelegationSettings } from '../lib/types';
import { Icon } from './Icon';
import { Avatar, Seg } from './ui';

const YES_NO = [
  { value: 'yes' as const, label: '허용' },
  { value: 'no' as const, label: '미허용' },
];

/**
 * 위임 받기 · 위임 요청 보내기 · 상위 에이전트. 새 에이전트(selfId=null)와 기존 에이전트 모두 씁니다.
 * 상위 에이전트 후보는 서버 규칙과 같이 거릅니다 (받기를 허용했고, 자기 자신이 아니며, 순환하지 않음).
 */
export function DelegationEditor({ agents, selfId, value, onChange, error }: { agents: readonly AgentView[]; selfId: string | null; value: DelegationSettings; onChange: (v: DelegationSettings) => void; error?: string | null }) {
  const choices = supervisorChoices(agents, selfId);
  // 지금 상위로 정해 둔 에이전트가 후보에서 빠졌더라도(받기를 껐다든지) 선택은 보이게 둡니다.
  const current = value.supervisorId ? agents.find((a) => a.id === value.supervisorId) : undefined;
  const shown = current && !choices.includes(current) ? [...choices, current] : choices;
  const dependents = selfId ? dependentsOf(agents, selfId) : [];
  const rows: { icon: string; title: string; extra?: ReactNode; control: ReactNode }[] = [
    {
      icon: 'arrowLeft',
      title: '위임 받기',
      extra:
        dependents.length > 0 ? (
          <span className="chips">
            {dependents.map((a) => (
              <span key={a.id} className="chip" title={`${a.name}의 상위 에이전트`}>
                <Avatar name={a.name} color={a.color} size={16} />
                {a.name}
              </span>
            ))}
          </span>
        ) : null,
      control: <Seg value={value.accept ? 'yes' : 'no'} options={YES_NO} onChange={(v) => onChange({ ...value, accept: v === 'yes' })} label="위임 받기" />,
    },
    {
      icon: 'forward',
      title: '위임 요청 보내기',
      // 보내기를 끄면 상위 에이전트에게 넘길 수도 없으므로 함께 비웁니다.
      control: <Seg value={value.send ? 'yes' : 'no'} options={YES_NO} onChange={(v) => onChange({ ...value, send: v === 'yes', supervisorId: v === 'yes' ? value.supervisorId : null })} label="위임 요청 보내기" />,
    },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r, i) => (
        <div key={r.title} className="opt-row" style={{ animationDelay: `${i * 0.05}s` }}>
          <span className="opt-ico">
            <Icon name={r.icon} size={16} stroke={2} />
          </span>
          <b style={{ fontSize: 14 }}>{r.title}</b>
          {r.extra}
          <span style={{ marginLeft: 'auto' }}>{r.control}</span>
        </div>
      ))}
      <div className="opt-row" style={{ animationDelay: '.1s', opacity: value.send ? 1 : 0.5, transition: 'opacity .2s ease' }}>
        <span className="opt-ico">
          <Icon name="arrowUp" size={16} stroke={2} />
        </span>
        <b style={{ fontSize: 14 }}>상위 에이전트</b>
        <span className="chips" role="radiogroup" aria-label="상위 에이전트" style={{ marginLeft: 'auto', justifyContent: 'flex-end' }}>
          {[null, ...shown].map((a) => (
            <button key={a?.id ?? 'none'} type="button" role="radio" className="pill" aria-checked={value.supervisorId === (a?.id ?? null)} disabled={!value.send} onClick={() => onChange({ ...value, supervisorId: a?.id ?? null })}>
              {a ? <Avatar name={a.name} color={a.color} size={18} /> : null}
              {a ? a.name : '없음'}
            </button>
          ))}
        </span>
      </div>
      {error ? (
        <span className="err" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
