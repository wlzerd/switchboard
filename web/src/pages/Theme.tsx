import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BrandMark, Icon } from '../components/Icon';
import { Avatar, Modal, Seg } from '../components/ui';
import { api, errorText } from '../lib/api';
import { contrast, contrastIssues, defaultTheme, parseThemeJson, readableOn, themeVars, TOKEN_KEYS } from '../lib/theme';
import { toast, useApp } from '../lib/store';
import type { Meta, Overview, Theme, ThemeTokens } from '../lib/types';

const TOKEN_LABEL: Record<keyof ThemeTokens, string> = {
  bg: '배경',
  panel: '바',
  surface: '카드',
  raised: '올라온 면',
  line: '선',
  line2: '진한 선',
  text: '글자',
  text2: '보조 글자',
  text3: '흐린 글자',
  accent: '강조',
  onAccent: '강조 위 글자',
  msg: '메시지 선',
  skill: '스킬 선',
  warn: '경고',
  danger: '위험',
};

/** 대비를 보여 줄 토큰과 기준 배경 */
const CONTRAST_AGAINST: Partial<Record<keyof ThemeTokens, keyof ThemeTokens>> = {
  text: 'surface',
  text2: 'surface',
  text3: 'surface',
  onAccent: 'accent',
  accent: 'bg',
  msg: 'surface',
  skill: 'surface',
  warn: 'surface',
  danger: 'surface',
};

const CUSTOM_NAME = '사용자 지정';

function same(a: Theme, b: Theme): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function MiniPreview({ tokens }: { tokens: ThemeTokens }) {
  return (
    <span className="mini" style={{ background: tokens.bg, display: 'block' }} aria-hidden="true">
      <span style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 14, background: tokens.panel, borderBottom: `1px solid ${tokens.line}` }} />
      <span style={{ position: 'absolute', left: 6, top: 4, width: 6, height: 6, borderRadius: 2, background: tokens.accent }} />
      <span style={{ position: 'absolute', left: 0, top: 14, bottom: 0, width: 28, background: tokens.panel, borderRight: `1px solid ${tokens.line}` }} />
      <span style={{ position: 'absolute', left: 36, top: 22, right: 8, height: 22, borderRadius: 5, background: tokens.surface, border: `1px solid ${tokens.line}` }}>
        <span style={{ position: 'absolute', left: 6, top: 5, width: '45%', height: 4, borderRadius: 2, background: tokens.text }} />
        <span style={{ position: 'absolute', left: 6, top: 12, width: '30%', height: 3, borderRadius: 2, background: tokens.text3 }} />
      </span>
      <span style={{ position: 'absolute', left: 36, top: 52, width: 26, height: 10, borderRadius: 3, background: tokens.accent }} />
      <span style={{ position: 'absolute', left: 68, top: 56, width: 30, height: 2, background: tokens.msg }} />
      <span style={{ position: 'absolute', left: 102, top: 56, width: 22, height: 2, background: tokens.skill }} />
    </span>
  );
}

function Preview({ theme, agentName }: { theme: Theme; agentName: string }) {
  const style = { ...themeVars(theme), background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--font)', border: '1px solid var(--line)' } as CSSProperties;
  return (
    <div className="preview-pane" style={style} data-motion={theme.motion} aria-label="미리보기">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--panel)', borderBottom: '1px solid var(--line)' }}>
        <span className="brand-mark" style={{ width: 22, height: 22, borderRadius: 6 }}>
          <BrandMark size={13} />
        </span>
        <b style={{ fontSize: 13 }}>Switchboard</b>
        <span className="pill" style={{ marginLeft: 'auto', height: 24, fontSize: 11 }}>
          <span className="status-dot working" style={{ width: 6, height: 6 }} />
          가동 <b>23일</b>
        </span>
      </div>
      <div style={{ display: 'flex' }}>
        <div style={{ width: 42, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '12px 0', background: 'var(--panel)', borderRight: '1px solid var(--line)', color: 'var(--text2)' }}>
          <span style={{ color: 'var(--accent)' }}>
            <Icon name="graph" size={16} />
          </span>
          <Icon name="terminal" size={16} />
          <Icon name="cube" size={16} />
          <Icon name="shield" size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--gap)', padding: 'var(--pad)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="gnode" style={{ height: 40, padding: '0 10px', animation: 'none' }}>
              <span className="tile" style={{ width: 22, height: 22, background: 'var(--msg-dim)', color: 'var(--msg)' }}>
                <Icon name="chat" size={13} />
              </span>
              <span className="title" style={{ fontSize: 12 }}>
                Discord
              </span>
            </span>
            <svg width="30" height="10" aria-hidden="true">
              <path d="M1 5H29" className="edge-flow" style={{ stroke: 'var(--msg)', strokeWidth: 2 }} />
            </svg>
            <span className="gnode gnode-agent selected" style={{ height: 'auto', padding: '8px 10px', gap: 6, animation: 'none' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Avatar name={agentName} color={theme.tokens.accent} size={20} />
                <b style={{ fontSize: 12.5 }}>{agentName}</b>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>
                <span className="status-dot working" style={{ width: 6, height: 6 }} />
                작업 중
              </span>
            </span>
            <svg width="30" height="10" aria-hidden="true">
              <path d="M1 5H29" className="edge-flow" style={{ stroke: 'var(--skill)', strokeWidth: 2 }} />
            </svg>
            <span className="chips">
              <span className="chip mono skill">web_search</span>
              <span className="chip mono new">pdf_요약</span>
            </span>
          </div>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 'var(--pad)', borderRadius: 'var(--radius-lg)' }}>
            <div className="msg-user" style={{ animation: 'none' }}>
              <div className="bubble" style={{ fontSize: 12.5 }}>
                경쟁사 세 곳 가격 비교해 줘
              </div>
            </div>
            <div className="msg-agent" style={{ animation: 'none' }}>
              <Avatar name={agentName} color={theme.tokens.accent} size={22} />
              <div className="text" style={{ fontSize: 12.5 }}>
                공개 가격 페이지 기준으로 정리하겠습니다.
              </div>
            </div>
            <div className="approval-card pending" style={{ animation: 'none', padding: '8px 10px', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <b>승인 필요</b>
                <span className="chip mono">net.fetch</span>
              </span>
              <span style={{ display: 'flex', gap: 6 }}>
                <span className="btn primary xs" style={{ height: 24 }}>
                  허용
                </span>
                <span className="btn danger xs" style={{ height: 24 }}>
                  거부
                </span>
              </span>
            </div>
            <div className="composer-box" style={{ padding: '8px 10px' }}>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {agentName}에게 지시
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onImport, onClose }: { onImport: (t: Theme) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const take = (raw: string): void => {
    const r = parseThemeJson(raw);
    if (typeof r === 'string') setError(r);
    else {
      onImport(r);
      onClose();
    }
  };
  return (
    <Modal title="테마 가져오기" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <textarea className={`textarea mono${error ? ' bad' : ''}`} rows={10} style={{ fontSize: 12 }} value={text} placeholder='{ "name": "…", "tokens": { "bg": "#0B0D11", … }, "radius": 12, "font": "plex", "density": 1, "motion": 2 }' onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }} aria-label="테마 JSON" />
        {error ? (
          <span className="err" role="alert">
            {error}
          </span>
        ) : null}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => file.current?.click()}>
            <Icon name="upload" size={14} />
            파일에서
          </button>
          <input
            ref={file}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (f.size > 64 * 1024) {
                setError(`테마 파일이 너무 큽니다 (${Math.round(f.size / 1024)}KB). 64KB 이하만 읽습니다.`);
                return;
              }
              void f
                .text()
                .then((t) => {
                  setText(t);
                  take(t);
                })
                .catch((err: unknown) => setError(`파일을 읽지 못했습니다: ${errorText(err)}`));
            }}
          />
          <span style={{ marginLeft: 'auto' }} />
          <button type="button" className="btn sm" onClick={onClose}>
            취소
          </button>
          <button type="button" className="btn sm primary" disabled={text.trim() === ''} onClick={() => take(text)}>
            가져오기
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ThemePage() {
  const meta = useApp((s) => s.meta) as Meta;
  const stored = useApp((s) => s.theme);
  const overview = useApp((s) => s.overview) as Overview;
  const applied = useMemo(() => stored ?? (defaultTheme(meta) as Theme), [stored, meta]);
  const [draft, setDraft] = useState<Theme>(applied);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const lastApplied = useRef(applied);

  // 다른 기기에서 테마가 바뀌면, 이 화면에서 고치던 것이 없을 때만 따라갑니다.
  useEffect(() => {
    if (same(draft, lastApplied.current)) setDraft(applied);
    lastApplied.current = applied;
  }, [applied]); // draft 는 일부러 빼둡니다: 적용된 테마가 바뀔 때만 따라갑니다.

  const dirty = !same(draft, applied);
  const issues = contrastIssues(draft.tokens);
  const presetId = meta.themes.presets.find((p) => JSON.stringify(p.tokens) === JSON.stringify(draft.tokens))?.id ?? null;

  const setToken = (k: keyof ThemeTokens, v: string): void => {
    const tokens = { ...draft.tokens, [k]: v.toUpperCase() };
    if (k === 'accent' && contrast(draft.tokens.onAccent, v) < 4.5) tokens.onAccent = readableOn(v);
    setDraft({ ...draft, name: CUSTOM_NAME, tokens });
  };

  const apply = async (): Promise<void> => {
    setSaving(true);
    try {
      const r = await api<{ theme: Theme }>('/api/theme', { method: 'PUT', body: draft });
      setDraft(r.theme);
      toast(`${r.theme.name} 테마를 모든 접속 기기에 적용했습니다`, 'ok');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `switchboard-theme-${draft.name.replace(/[^\p{L}\p{N}_-]+/gu, '-') || 'custom'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <div className="page-head">
        <h1>테마</h1>
        <span className="chip">적용 중 · {applied.name}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => setImporting(true)}>
            <Icon name="upload" size={14} />
            가져오기
          </button>
          <button type="button" className="btn sm" onClick={exportJson}>
            <Icon name="download" size={14} />
            JSON 내보내기
          </button>
        </span>
      </div>

      <div className="preset-grid" role="radiogroup" aria-label="기본 테마">
        {meta.themes.presets.map((p, i) => (
          <button key={p.id} type="button" role="radio" aria-checked={presetId === p.id} className="preset" style={{ animationDelay: `${i * 0.05}s` }} onClick={() => setDraft({ ...draft, name: p.name, tokens: { ...p.tokens } })}>
            <MiniPreview tokens={p.tokens} />
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <b style={{ fontSize: 13.5 }}>{p.name}</b>
              <span className="radio" />
            </span>
          </button>
        ))}
      </div>

      <div className="row">
        <section className="card grow" style={{ flex: '1 1 340px' }} aria-label="색과 모양">
          <div className="card-head">
            <h2>색</h2>
            <span className="muted" style={{ fontSize: 12.5 }}>
              {draft.name}
            </span>
          </div>
          <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {TOKEN_KEYS.map((k) => {
              const against = CONTRAST_AGAINST[k];
              const ratio = against ? contrast(draft.tokens[k], draft.tokens[against]) : null;
              const low = ratio !== null && ratio < (k === 'text3' || k === 'accent' || k === 'msg' || k === 'skill' || k === 'warn' || k === 'danger' ? 3 : 4.5);
              return (
                <label key={k} className="token-row">
                  <input type="color" value={draft.tokens[k]} onChange={(e) => setToken(k, e.target.value)} aria-label={TOKEN_LABEL[k]} />
                  <span style={{ flex: 1 }}>{TOKEN_LABEL[k]}</span>
                  <span className="mono muted" style={{ fontSize: 12 }}>
                    {draft.tokens[k]}
                  </span>
                  {ratio !== null ? (
                    <span className={`chip mono ${low ? 'bad' : ''}`} style={{ minWidth: 56, justifyContent: 'center' }} title={`${TOKEN_LABEL[against as keyof ThemeTokens]} 대비`}>
                      {ratio.toFixed(1)}:1
                    </span>
                  ) : (
                    <span style={{ minWidth: 56 }} />
                  )}
                </label>
              );
            })}
            {issues.length > 0 ? (
              <div className="alert warn" style={{ marginTop: 8 }}>
                <Icon name="eye" size={14} />
                <span>{issues.join(' ')}</span>
              </div>
            ) : null}
          </div>
          <div className="card-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14, borderTop: '1px solid var(--line)' }}>
            <label className="field">
              <span style={{ display: 'flex', justifyContent: 'space-between' }}>
                모서리
                <span className="mono">{draft.radius}px</span>
              </span>
              <input type="range" min={0} max={20} step={1} value={draft.radius} onChange={(e) => setDraft({ ...draft, radius: Number(e.target.value) })} style={{ accentColor: 'var(--accent)' }} />
            </label>
            <div className="field">
              글꼴
              <Seg
                value={draft.font}
                options={[
                  { value: 'plex', label: 'IBM Plex Sans KR' },
                  { value: 'noto', label: 'Noto Sans KR' },
                  { value: 'system', label: '시스템' },
                ]}
                onChange={(font) => setDraft({ ...draft, font })}
                label="글꼴"
              />
            </div>
            <div className="field">
              밀도
              <Seg
                value={draft.density}
                options={[
                  { value: 0, label: '촘촘' },
                  { value: 1, label: '보통' },
                  { value: 2, label: '넉넉' },
                ]}
                onChange={(density) => setDraft({ ...draft, density })}
                label="밀도"
              />
            </div>
            <div className="field">
              움직임
              <Seg
                value={draft.motion}
                options={[
                  { value: 0, label: '끔' },
                  { value: 1, label: '줄임' },
                  { value: 2, label: '전부' },
                ]}
                onChange={(motion) => setDraft({ ...draft, motion })}
                label="움직임"
              />
            </div>
          </div>
        </section>
        <div className="side" style={{ flex: '2 1 420px', position: 'sticky', top: 76 }}>
          <Preview theme={draft} agentName={overview.agents[0]?.name ?? '에이전트'} />
        </div>
      </div>

      {dirty ? (
        <div className="save-bar" role="region" aria-label="적용">
          <span className="dim">미리보기 · 아직 적용 안 됨</span>
          <button type="button" className="btn sm" onClick={() => setDraft(applied)}>
            되돌리기
          </button>
          <button type="button" className="btn sm primary" disabled={saving} onClick={() => void apply()}>
            {saving ? <span className="spinner" style={{ width: 13, height: 13, borderTopColor: 'var(--onAccent)' }} /> : null}
            적용
          </button>
        </div>
      ) : null}
      {importing ? <ImportModal onImport={(t) => setDraft(t)} onClose={() => setImporting(false)} /> : null}
    </>
  );
}
