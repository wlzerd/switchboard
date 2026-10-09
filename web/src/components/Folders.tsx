import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api';
import { FOLDERS_MAX, MODE_LABEL, folderInputProblem, normalizeFolderInput, type FolderMode, type FolderView } from '../lib/folders';
import { Icon } from './Icon';
import { Seg } from './ui';

const MODES: { value: FolderMode; label: string }[] = [
  { value: 'read', label: MODE_LABEL.read },
  { value: 'write', label: MODE_LABEL.write },
];

/**
 * 허용 폴더 목록 편집 (저장은 바깥의 저장 막대가 합니다).
 * 새 폴더는 읽기만으로 들어가고, 쓰기가 필요하면 사용자가 직접 읽기·쓰기로 바꿉니다.
 */
export function FoldersEditor({ value, onChange, error, errorIndex }: { value: readonly FolderView[]; onChange: (v: FolderView[]) => void; error?: string | null; errorIndex?: number | null }) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const listId = useId();

  // 입력하는 동안 서버 컴퓨터의 하위 폴더 이름을 제안합니다.
  useEffect(() => {
    const prefix = draft.trim();
    if (prefix === '' || (!prefix.startsWith('/') && !prefix.startsWith('~'))) {
      setSuggest([]);
      return undefined;
    }
    const ac = new AbortController();
    const t = setTimeout(() => {
      api<{ dirs: string[] }>(`/api/fs/dirs?prefix=${encodeURIComponent(prefix)}`, { signal: ac.signal })
        .then((r) => setSuggest(r.dirs))
        .catch(() => {
          // 제안은 편의 기능이라 실패해도 직접 입력하면 됩니다.
        });
    }, 180);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [draft]);

  const add = (): void => {
    const p = folderInputProblem(draft, value);
    if (p) {
      setProblem(p);
      return;
    }
    onChange([...value, { path: normalizeFolderInput(draft), mode: 'read' }]);
    setDraft('');
    setProblem(null);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.map((f, i) => (
        <div key={f.path} className={`opt-row${errorIndex === i ? ' bad' : ''}`} style={{ animationDelay: `${Math.min(i, 8) * 0.04}s` }}>
          <span className="opt-ico">
            <Icon name="folder" size={16} stroke={2} />
          </span>
          <span className="mono" style={{ fontSize: 13, flex: '1 1 160px', minWidth: 0, overflowWrap: 'anywhere' }}>
            {f.path}
          </span>
          <Seg value={f.mode} options={MODES} onChange={(mode) => onChange(value.map((x, j) => (j === i ? { ...x, mode } : x)))} label={`${f.path} 범위`} />
          <button type="button" className="icon-btn" style={{ width: 32, height: 32, border: 0 }} aria-label={`${f.path} 빼기`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <form
        className="opt-row"
        style={{ animationDelay: `${Math.min(value.length, 8) * 0.04}s` }}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <span className="opt-ico">
          <Icon name="plus" size={16} stroke={2.2} />
        </span>
        <input
          className={`input mono${problem ? ' bad' : ''}`}
          style={{ flex: '1 1 200px', minWidth: 0, height: 36, fontSize: 13 }}
          list={listId}
          value={draft}
          placeholder="~/Documents/보고서"
          aria-label="허용할 폴더 경로"
          autoComplete="off"
          spellCheck={false}
          disabled={value.length >= FOLDERS_MAX}
          onChange={(e) => {
            setDraft(e.target.value);
            setProblem(null);
          }}
        />
        <datalist id={listId}>
          {suggest.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
        <button type="submit" className="btn sm" disabled={draft.trim() === ''}>
          추가
        </button>
      </form>
      {problem || error ? (
        <span className="err" role="alert">
          {problem ?? error}
        </span>
      ) : null}
    </div>
  );
}
