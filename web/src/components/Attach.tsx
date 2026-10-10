import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, errorText, upload } from '../lib/api';
import { attachmentUrl, countError, formatBytes, isPastedName, pastedName, shrinkImage, sizeError } from '../lib/attachments';
import type { AttachmentLimits, AttachmentView } from '../lib/types';
import { Icon } from './Icon';
import { Modal } from './ui';

/** 보내기 전의 첨부 하나 */
export interface PendingFile {
  key: string;
  name: string;
  size: number;
  /** 그림 미리보기 (이 창에서 만든 blob 주소) */
  preview: string | null;
  state: 'working' | 'ready' | 'error';
  error: string | null;
  view: AttachmentView | null;
}

export type Attachments = ReturnType<typeof useAttachments>;

let seq = 0;

/** 끌어 온 것이 파일인지 (글 · 링크를 끌 때는 반응하지 않음) */
export function hasFiles(e: DragEvent | globalThis.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

/**
 * 콘솔 입력창의 첨부: 고르는 즉시 (그림은 줄여서) 서버에 올려 두고, 보낼 때 id 만 붙입니다.
 * 창을 떠나면 올리던 것은 멈추고, 올려 두고 보내지 않은 것은 서버가 하루 뒤 지웁니다.
 */
export function useAttachments(agentId: string, limits: AttachmentLimits) {
  const [items, setItems] = useState<PendingFile[]>([]);
  /** 개수 한도처럼 붙이지 못한 이유 */
  const [notice, setNotice] = useState<string | null>(null);
  // 같은 순간에 여러 번 붙여도 개수를 바로 셀 수 있게 최신 목록을 따로 둡니다.
  const live = useRef(items);
  const jobs = useRef(new Map<string, AbortController>());
  const urls = useRef(new Set<string>());

  useEffect(() => {
    const j = jobs.current;
    const u = urls.current;
    return () => {
      for (const c of j.values()) c.abort();
      for (const x of u) URL.revokeObjectURL(x);
    };
  }, []);

  const commit = (next: PendingFile[]): void => {
    live.current = next;
    setItems(next);
  };
  const patch = (key: string, p: Partial<PendingFile>): void => commit(live.current.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const drop = (x: PendingFile): void => {
    if (x.preview) {
      URL.revokeObjectURL(x.preview);
      urls.current.delete(x.preview);
    }
  };

  const run = async (key: string, original: File): Promise<void> => {
    const ac = new AbortController();
    jobs.current.set(key, ac);
    try {
      // 폴더나 읽을 수 없는 파일은 먼저 걸러 냅니다 (그대로 보내면 연결 오류처럼 보임).
      try {
        await original.slice(0, 1).arrayBuffer();
      } catch {
        patch(key, { state: 'error', error: `'${original.name}'을(를) 읽지 못했습니다. 폴더이거나 열 수 없는 파일입니다.` });
        return;
      }
      const file = await shrinkImage(original, limits);
      if (ac.signal.aborted) return;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      if (preview) urls.current.add(preview);
      const big = sizeError(file.name, file.size, limits);
      patch(key, { name: file.name, size: file.size, preview, ...(big ? { state: 'error' as const, error: big } : {}) });
      if (big) return;
      const r = await upload<{ attachment: AttachmentView }>(`/api/agents/${encodeURIComponent(agentId)}/attachments`, file, file.name, ac.signal);
      if (ac.signal.aborted) return;
      patch(key, { state: 'ready', view: r.attachment, name: r.attachment.name, size: r.attachment.size });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      patch(key, { state: 'error', error: errorText(err) });
    } finally {
      jobs.current.delete(key);
    }
  };

  /** 파일 추가. 개수 한도를 넘으면 하나도 붙이지 않고 이유를 notice 에 둡니다 */
  const add = (files: readonly File[], pasted = false): void => {
    if (files.length === 0) return;
    const err = countError(live.current.length, files.length, limits);
    setNotice(err);
    if (err) return;
    const now = new Date();
    const fresh = files.map((f, i) => {
      seq += 1;
      const file = pasted && isPastedName(f.name) ? new File([f], pastedName(f.name, now, i), { type: f.type, lastModified: f.lastModified }) : f;
      const item: PendingFile = { key: `att${seq}`, name: file.name, size: file.size, preview: null, state: 'working', error: null, view: null };
      return { file, item };
    });
    commit([...live.current, ...fresh.map((x) => x.item)]);
    for (const x of fresh) void run(x.item.key, x.file);
  };

  const remove = (key: string): void => {
    const it = live.current.find((x) => x.key === key);
    if (!it) return;
    jobs.current.get(key)?.abort();
    drop(it);
    commit(live.current.filter((x) => x.key !== key));
    setNotice(null);
    // 지우지 못해도 보내지 않은 첨부는 서버가 하루 뒤 지웁니다.
    if (it.view) void api(`/api/attachments/${encodeURIComponent(it.view.id)}`, { method: 'DELETE' }).catch(() => undefined);
  };

  /** 보낸 뒤: 목록만 비웁니다 (서버의 첨부는 대화 기록이 씀) */
  const clear = (): void => {
    for (const x of live.current) drop(x);
    commit([]);
    setNotice(null);
  };

  return { items, notice, add, remove, clear };
}

/** 입력창 위의 첨부 목록 */
export function PendingFiles({ items, onRemove }: { items: readonly PendingFile[]; onRemove: (key: string) => void }) {
  return (
    <div className="att-list">
      {items.map((x) => (
        <div key={x.key} className={`att-chip ${x.state}`} title={x.error ?? `${x.name} · ${formatBytes(x.size)}`}>
          <span className="att-thumb">
            <Icon name="doc" size={16} stroke={1.9} />
            {x.preview ? (
              <img
                src={x.preview}
                alt=""
                onError={(e) => {
                  // 브라우저가 그리지 못하는 형식(HEIC 등)이면 파일 아이콘만
                  e.currentTarget.hidden = true;
                }}
              />
            ) : null}
            {x.state === 'working' ? (
              <span className="att-veil">
                <span className="spinner" style={{ width: 14, height: 14 }} />
              </span>
            ) : null}
            {x.state === 'error' ? (
              <span className="att-veil bad">
                <Icon name="alert" size={15} stroke={2.2} />
              </span>
            ) : null}
          </span>
          <span className="att-meta">
            <span className="att-name">{x.name}</span>
            <span className="att-size">{x.state === 'error' ? '실패' : formatBytes(x.size)}</span>
          </span>
          <button type="button" className="att-x" aria-label={`${x.name} 빼기`} onClick={() => onRemove(x.key)}>
            <Icon name="x" size={12} stroke={2.6} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** 타임라인 사용자 메시지의 첨부: 그림은 미리보기(누르면 크게), 나머지는 내려받기 */
export function MessageFiles({ files }: { files: readonly AttachmentView[] }) {
  const [big, setBig] = useState<AttachmentView | null>(null);
  const images = files.filter((f) => f.kind === 'image');
  const others = files.filter((f) => f.kind !== 'image');
  return (
    <>
      {images.length > 0 ? (
        <div className={`msg-images${images.length === 1 ? ' one' : ''}`}>
          {images.map((f) => (
            <button key={f.id} type="button" className="msg-image" aria-label={`${f.name} 크게 보기`} onClick={() => setBig(f)}>
              <img src={attachmentUrl(f.id)} alt={f.name} loading="lazy" width={f.width ?? undefined} height={f.height ?? undefined} />
            </button>
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="msg-docs">
          {others.map((f) => (
            <a key={f.id} className="file-chip" href={attachmentUrl(f.id)} download={f.name} title={f.name}>
              <Icon name="doc" size={15} stroke={2} />
              <span className="att-name">{f.name}</span>
              <span className="att-size">{formatBytes(f.size)}</span>
              <Icon name="download" size={14} stroke={2} />
            </a>
          ))}
        </div>
      ) : null}
      {big ? (
        <Modal title={big.name} onClose={() => setBig(null)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <img src={attachmentUrl(big.id)} alt={big.name} style={{ width: '100%', borderRadius: 8, display: 'block' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="muted mono" style={{ fontSize: 12 }}>
                {big.width && big.height ? `${big.width}×${big.height} · ` : ''}
                {formatBytes(big.size)}
              </span>
              <a className="btn sm" style={{ marginLeft: 'auto' }} href={attachmentUrl(big.id)} download={big.name}>
                <Icon name="download" size={14} stroke={2.2} />
                내려받기
              </a>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
