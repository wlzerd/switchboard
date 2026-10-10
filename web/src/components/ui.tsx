import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { hexA } from '../lib/theme';
import { initial } from '../lib/format';
import { atBottom } from '../lib/scrollFade';
import { useApp } from '../lib/store';
import type { AgentStatus, StepState, TaskStep } from '../lib/types';
import { Icon } from './Icon';

export function Avatar({ name, color, size = 28, status }: { name: string; color: string; size?: number; status?: AgentStatus }) {
  return (
    // 글자색은 에이전트 색을 테마 글자색과 섞어 밝은 테마 · 어두운 테마 모두에서 읽히게 합니다.
    <span className="avatar" style={{ width: size, height: size, background: hexA(color, 0.16), color: `color-mix(in srgb, ${color} 70%, var(--text))`, fontSize: Math.round(size * 0.43) }}>
      {initial(name)}
      {status ? <span className={`status-dot ${status}`} /> : null}
    </span>
  );
}

export const STATUS_LABEL: Record<AgentStatus, string> = { idle: '대기', working: '작업 중', waiting: '승인 대기', paused: '일시정지', error: '오류' };

export function StatusLine({ status, detail }: { status: AgentStatus; detail?: string | null }) {
  const color = status === 'working' ? 'var(--accent)' : status === 'waiting' ? 'var(--warn)' : status === 'error' ? 'var(--danger)' : 'var(--text2)';
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color, minWidth: 0 }}>
      <span className={`status-dot ${status}`} />
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {STATUS_LABEL[status]}
        {detail ? ` · ${detail}` : ''}
      </span>
    </span>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Seg<T extends string | number>({ value, options, onChange, label, role = 'radiogroup' }: { value: T; options: { value: T; label: string; className?: string; disabled?: boolean }[]; onChange: (v: T) => void; label: string; role?: string }) {
  return (
    <div className="seg" role={role} aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={value === o.value} className={o.className} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function StepIcon({ state }: { state: StepState }) {
  if (state === 'active') return <span className="spinner" style={{ width: 16, height: 16 }} />;
  if (state === 'done') return <span className="step-ico done"><Icon name="check" size={11} stroke={3} /></span>;
  if (state === 'wait') return <span className="step-ico wait"><Icon name="clock" size={12} stroke={2.4} /></span>;
  if (state === 'error') return <span className="step-ico error"><Icon name="x" size={11} stroke={3} /></span>;
  return <span className="step-ico todo" />;
}

/** 한 번에 보이는 단계 수. 넘으면 이 높이에서 스크롤합니다 */
export const STEPS_SHOWN = 5;

/**
 * 작업 단계. 5개가 넘으면 5개 높이에서 스크롤하고 맨 아래(최근 단계)를 보여 줍니다.
 * 새 단계가 붙으면 따라 내려가고, 위로 올려 보는 중이면 그 자리에 둡니다.
 */
export function Steps({ steps }: { steps: TaskStep[] }) {
  const color: Record<StepState, string> = { done: 'var(--text2)', active: 'var(--text)', wait: 'var(--warn)', todo: 'var(--text3)', error: 'var(--danger)' };
  const ref = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const scroll = steps.length > STEPS_SHOWN;
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && scroll && stick.current) el.scrollTop = el.scrollHeight;
  }, [steps, scroll]);
  return (
    <ol
      ref={ref}
      className={`steps${scroll ? ' steps-scroll scroll-fade' : ''}`}
      tabIndex={scroll ? 0 : undefined}
      aria-label={scroll ? '작업 단계' : undefined}
      onScroll={
        scroll
          ? (e) => {
              stick.current = atBottom(e.currentTarget);
            }
          : undefined
      }
    >
      {steps.map((s) => (
        <li key={s.id}>
          <StepIcon state={s.state} />
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.35 }}>
            <span style={{ fontSize: 13, color: color[s.state] }}>{s.label}</span>
            <span style={{ fontSize: 11.5, color: 'var(--text3)', overflowWrap: 'anywhere' }}>{s.meta}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ModuleIcon({ icon, size = 18 }: { icon: string; size?: number }) {
  const map: Record<string, string> = { chat: 'chat', plane: 'plane', git: 'git', rss: 'rss', doc: 'doc', link: 'link', cube: 'cube', globe: 'globe', clock: 'clock', bolt: 'bolt', mail: 'mail', screen: 'screen' };
  return <Icon name={map[icon] ?? 'cube'} size={size} />;
}

/** 칩으로 쌓는 목록 입력 (Enter·쉼표로 추가, 빈 칸에서 Backspace 로 마지막 칩 삭제) */
export function ChipInput({ value, onChange, label, placeholder, tone = 'msg', max = 50, validate }: { value: string[]; onChange: (v: string[]) => void; label: string; placeholder?: string; tone?: 'msg' | 'skill' | 'ok' | 'bad'; max?: number; validate?: (item: string) => string | null }) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const add = (): void => {
    const t = draft.trim();
    if (!t) return;
    const bad = validate?.(t) ?? (value.length >= max ? `최대 ${max}개까지 넣을 수 있습니다.` : null);
    if (bad) {
      setProblem(bad);
      return;
    }
    if (!value.includes(t)) onChange([...value, t]);
    setDraft('');
    setProblem(null);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 160px', minWidth: 0 }}>
      {/* 바깥이 세로 배치라 .scope-edit 의 flex 기준값(160px)이 높이로 잡히지 않도록 고정합니다. */}
      <div className="scope-edit" style={{ flex: '0 0 auto' }}>
        {value.map((t) => (
          <span key={t} className={`chip mono ${tone}`} style={{ animation: 'pop .25s ease' }}>
            {t}
            <button type="button" aria-label={`${t} 빼기`} onClick={() => onChange(value.filter((x) => x !== t))}>
              <Icon name="x" size={11} stroke={2.6} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          aria-label={label}
          aria-invalid={problem !== null}
          placeholder={value.length === 0 ? placeholder : '+'}
          style={{ flex: '1 1 120px', minWidth: 90, width: 'auto', ...(problem ? { borderColor: 'var(--danger)' } : {}) }}
          onChange={(e) => {
            setDraft(e.target.value);
            if (problem) setProblem(null);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && draft === '' && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={add}
        />
      </div>
      {problem ? (
        <span className="err" style={{ fontSize: 12 }}>
          {problem}
        </span>
      ) : null}
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.tone === 'ok' ? <Icon name="check" size={15} stroke={2.6} /> : t.tone === 'error' ? <Icon name="x" size={15} stroke={2.6} /> : null}
          {t.text}
        </div>
      ))}
    </div>
  );
}

/**
 * 대화 상자. 카드처럼 transform 애니메이션이 있는 요소 안에서 열면 position: fixed 가 그 요소 기준이 되므로
 * 항상 document.body 로 옮겨(portal) 화면 전체를 덮습니다. Esc 로 닫습니다.
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-back" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="닫기" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="card-pad modal-body scroll-fade">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
