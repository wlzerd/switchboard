import { useState } from 'react';
import { EFFORT_LABEL } from '../lib/agent';
import { compactTokens } from '../lib/format';
import type { Effort, ModelInfo } from '../lib/types';
import { Icon } from './Icon';
import { Seg } from './ui';

/** 키로 받아 온 모델 목록. 계열별 최신 모델을 카드로 먼저 보여 주고, 이전 버전은 접어 둡니다. */
export function ModelPicker({ latest, older, value, onChange }: { latest: ModelInfo[]; older: ModelInfo[]; value: string | null; onChange: (m: ModelInfo) => void }) {
  const [showOlder, setShowOlder] = useState(() => older.some((m) => m.id === value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="pick-grid" role="radiogroup" aria-label="모델">
        {latest.map((m, i) => (
          <button key={m.id} type="button" role="radio" aria-checked={value === m.id} className="pick" style={{ animationDelay: `${Math.min(i, 8) * 0.05}s` }} onClick={() => onChange(m)}>
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text3)', letterSpacing: '.03em' }}>{m.line ?? '모델'}</span>
              {m.lifecycle === 'deprecated' ? <span className="chip warn">지원 종료 예정</span> : null}
              <span className="radio" />
            </span>
            <span style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.25 }}>{m.name}</span>
            <span className="mono muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>
              {m.id}
            </span>
            <span className="chips">
              {m.contextTokens ? <span className="chip">{compactTokens(m.contextTokens)} 컨텍스트</span> : null}
              {m.maxOutputTokens ? <span className="chip">출력 {compactTokens(m.maxOutputTokens)}</span> : null}
            </span>
            <span style={{ fontSize: 12, color: m.agents ? 'var(--msg)' : 'var(--text3)' }}>{m.agents ? `에이전트 ${m.agents}명 사용 중` : '사용 중인 에이전트 없음'}</span>
          </button>
        ))}
      </div>
      {older.length > 0 ? (
        <>
          <button type="button" className="btn sm" style={{ alignSelf: 'flex-start', borderColor: 'transparent', color: 'var(--text2)' }} aria-expanded={showOlder} onClick={() => setShowOlder(!showOlder)}>
            이전 버전 {older.length}개
            <Icon name="chevronDown" size={14} stroke={2.2} className={showOlder ? 'rot180' : undefined} />
          </button>
          {showOlder ? (
            <div role="radiogroup" aria-label="이전 모델" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 6, marginTop: -6, animation: 'rise .3s ease backwards' }}>
              {older.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={value === m.id} className="pick" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 10, animation: 'none' }} onClick={() => onChange(m)}>
                  <span className="radio" style={{ width: 16, height: 16 }} />
                  <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.3 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                      {m.name}
                      {m.lifecycle === 'deprecated' ? <span style={{ color: 'var(--warn)', fontWeight: 500, fontSize: 12 }}> · 지원 종료 예정</span> : null}
                    </span>
                    <span className="mono muted" style={{ fontSize: 11.5, overflowWrap: 'anywhere' }}>
                      {m.id}
                    </span>
                  </span>
                  {m.contextTokens ? (
                    <span className="mono muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
                      {compactTokens(m.contextTokens)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 모델이 지원하는 노력 수준만 보여 줍니다. '기본'은 모델 기본값(설정 안 함)입니다. */
export function EffortPicker({ model, value, onChange }: { model: ModelInfo | null; value: Effort | null; onChange: (e: Effort | null) => void }) {
  const efforts = model?.efforts ?? [];
  if (efforts.length === 0) return <span className="chip">모델 기본값</span>;
  const options: { value: Effort | 'default'; label: string }[] = [{ value: 'default', label: '기본' }, ...efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] }))];
  return <Seg value={value ?? 'default'} options={options} onChange={(v) => onChange(v === 'default' ? null : v)} label="노력 수준" />;
}
