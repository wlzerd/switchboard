/**
 * 콘솔 첨부: 올리기 전 검사 · 그림 줄이기 · 타임라인 표시.
 * 서버가 다시 검사하므로 여기서는 미리 알 수 있는 것만 막고, 문구는 서버와 같게 둡니다.
 */
import type { AttachmentKind, AttachmentLimits, AttachmentView } from './types';

const MB = 1024 * 1024;

/** 서버가 meta 를 주지 않을 때(이전 버전 서버) 쓰는 한도 */
export const DEFAULT_LIMITS: AttachmentLimits = { maxBytes: 10 * MB, perMessage: 10, messageMaxBytes: 18 * MB, imageMaxBytes: 7 * MB, imageSendEdge: 2576 };

/** 모델이 그대로 받는 그림 형식 (GIF 는 움직이는 그림이 깨지므로 손대지 않음) */
const NATIVE = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** 모델이 받지 않는 형식이라 브라우저가 읽을 수 있으면 JPEG 로 바꿔 보내는 그림 (아이폰 HEIC 등) */
const CONVERT = new Set(['image/heic', 'image/heif', 'image/avif', 'image/bmp', 'image/tiff']);

export type ImageOut = 'image/png' | 'image/jpeg' | 'image/webp';

/** '1.2MB' 같은 크기 표시 (서버와 같은 형식) */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < MB) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}KB`;
  return `${(n / MB).toFixed(1)}MB`;
}

/** 긴 변이 maxEdge 를 넘으면 비율을 지켜 줄인 크기 */
export function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number; scaled: boolean } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height, scaled: false };
  const r = maxEdge / long;
  return { width: Math.max(1, Math.round(width * r)), height: Math.max(1, Math.round(height * r)), scaled: true };
}

/**
 * 올리기 전에 그림을 다시 만들지: 모델이 줄이지 않고 보는 크기보다 크거나, 모델이 받는 한도보다 무겁거나,
 * 모델이 받지 않는 형식(HEIC 등)이면. 다시 만들 필요가 없으면 null.
 */
export function shrinkPlan(type: string, size: number, dims: { width: number; height: number }, limits: AttachmentLimits): { width: number; height: number; type: ImageOut } | null {
  const native = NATIVE.has(type);
  if (!native && !CONVERT.has(type)) return null;
  const fit = fitSize(dims.width, dims.height, limits.imageSendEdge);
  if (native && !fit.scaled && size <= limits.imageMaxBytes) return null;
  return { width: fit.width, height: fit.height, type: native ? (type as ImageOut) : 'image/jpeg' };
}

/** 인코딩 시도 순서. 앞의 것이 한도를 넘으면 다음 것 (원래 형식 → JPEG 품질 0.9 · 0.8 · 0.7) */
export function encodeSteps(type: ImageOut): { type: ImageOut; quality: number }[] {
  const jpeg = [0.9, 0.8, 0.7].map((quality) => ({ type: 'image/jpeg' as const, quality }));
  return type === 'image/jpeg' ? jpeg : [{ type, quality: 0.9 }, ...jpeg];
}

/** 형식이 바뀌면 확장자도 바꿉니다 (IMG_0001.HEIC → IMG_0001.jpg) */
export function renameFor(name: string, type: ImageOut): string {
  const ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg';
  const dot = name.lastIndexOf('.');
  const cur = dot > 0 ? name.slice(dot).toLowerCase() : '';
  if (cur === ext || (ext === '.jpg' && cur === '.jpeg')) return name;
  return `${dot > 0 ? name.slice(0, dot) : name}${ext}`;
}

/** 브라우저가 붙여넣은 그림에 주는 이름 ('image.png') */
export function isPastedName(name: string): boolean {
  return /^image\.(png|jpe?g|gif|webp)$/i.test(name);
}

/** 붙여넣은 그림 이름: 붙여넣기 14-03-22.png (같은 순간에 여러 장이면 -2, -3) */
export function pastedName(name: string, now: Date, index: number): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
  return `붙여넣기 ${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}${index > 0 ? `-${index + 1}` : ''}${ext}`;
}

/** 더 붙일 수 있는지 (개수) */
export function countError(have: number, adding: number, limits: AttachmentLimits): string | null {
  const n = have + adding;
  return n > limits.perMessage ? `메시지 하나에 첨부는 ${limits.perMessage}개까지 붙일 수 있습니다. 지금 ${n}개입니다.` : null;
}

/** 파일 하나의 크기 (그림은 줄인 뒤에 봅니다) */
export function sizeError(name: string, size: number, limits: AttachmentLimits): string | null {
  return size > limits.maxBytes ? `'${name}'은(는) ${formatBytes(size)}로 첨부 한도(${Math.round(limits.maxBytes / MB)}MB)를 넘습니다.` : null;
}

/** 메시지 하나에 붙인 첨부의 합 */
export function totalError(sizes: readonly number[], limits: AttachmentLimits): string | null {
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > limits.messageMaxBytes ? `첨부를 모두 합쳐 ${formatBytes(total)}로 한 번에 보낼 수 있는 ${formatBytes(limits.messageMaxBytes)}를 넘습니다. 나눠서 보내세요.` : null;
}

const KINDS: ReadonlySet<string> = new Set<AttachmentKind>(['image', 'pdf', 'text', 'file']);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** 타임라인 user 항목에 붙은 첨부 (모양이 맞지 않는 것은 뺍니다) */
export function attachmentsOf(data: Record<string, unknown>): AttachmentView[] {
  const raw = data['attachments'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x): AttachmentView[] => {
    if (x === null || typeof x !== 'object') return [];
    const a = x as Record<string, unknown>;
    if (typeof a['id'] !== 'string' || typeof a['name'] !== 'string' || typeof a['kind'] !== 'string' || !KINDS.has(a['kind']) || typeof a['size'] !== 'number') return [];
    return [{ id: a['id'], name: a['name'], kind: a['kind'] as AttachmentKind, size: a['size'], width: numOrNull(a['width']), height: numOrNull(a['height']) }];
  });
}

export const attachmentUrl = (id: string): string => `/api/attachments/${encodeURIComponent(id)}`;

/* ───────── 브라우저에서만 (캔버스) ───────── */

/**
 * 그림을 모델이 그대로 보는 크기로 줄이고, 모델이 받지 않는 형식은 JPEG 로 바꿉니다.
 * 줄일 필요가 없거나 브라우저가 읽지 못하면 원본을 그대로 돌려줍니다 (서버가 다시 검사).
 * 다시 그리면 사진의 위치 정보 같은 메타데이터도 빠집니다.
 */
export async function shrinkImage(file: File, limits: AttachmentLimits): Promise<File> {
  if (!NATIVE.has(file.type) && !CONVERT.has(file.type)) return file;
  if (typeof createImageBitmap !== 'function') return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return file;
  }
  try {
    const plan = shrinkPlan(file.type, file.size, { width: bmp.width, height: bmp.height }, limits);
    if (!plan) return file;
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    let best: Blob | null = null;
    for (const step of encodeSteps(plan.type)) {
      ctx.clearRect(0, 0, plan.width, plan.height);
      // JPEG 는 투명을 담지 못하므로 흰 바탕에 그립니다.
      if (step.type === 'image/jpeg') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, plan.width, plan.height);
      }
      ctx.drawImage(bmp, 0, 0, plan.width, plan.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, step.type, step.quality));
      // 그 형식으로 만들지 못하는 브라우저면(예: WebP) 다음 단계로
      if (!blob || blob.type !== step.type) continue;
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= limits.imageMaxBytes) {
        best = blob;
        break;
      }
    }
    if (!best) return file;
    return new File([best], renameFor(file.name, best.type as ImageOut), { type: best.type, lastModified: file.lastModified });
  } finally {
    bmp.close();
  }
}
