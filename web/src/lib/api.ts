/** 서버 API 호출. 실패하면 서버가 준 정확한 문구를 그대로 담은 ApiError 를 던집니다. */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: Record<string, unknown> | null;
  constructor(code: string, message: string, status: number, detail: Record<string, unknown> | null) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** 로그인이 풀렸을 때 화면이 로그인 페이지로 돌아가도록 알립니다. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  return send<T>(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
}

/** 파일 하나 올리기: 본문은 파일 내용 그대로, 이름은 X-File-Name 머리글(encodeURIComponent) */
export async function upload<T>(path: string, file: Blob, name: string, signal?: AbortSignal): Promise<T> {
  return send<T>(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(name) }, body: file, signal });
}

async function send<T>(path: string, init: { method: string; headers: Record<string, string>; body: BodyInit | undefined; signal: AbortSignal | undefined }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: 'same-origin' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError('network', '서버에 연결하지 못했습니다. 서버가 켜져 있는지, 주소가 맞는지 확인하세요.', 0, null);
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError('bad_response', `서버 응답을 해석하지 못했습니다 (HTTP ${res.status}). 리버스 프록시가 다른 페이지를 돌려주고 있는지 확인하세요.`, res.status, null);
    }
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; detail?: Record<string, unknown> | null } } | null)?.error;
    if (res.status === 401 && onUnauthorized && (e?.code === 'login_required' || e?.code === 'session_expired')) onUnauthorized();
    throw new ApiError(e?.code ?? `http_${res.status}`, e?.message ?? `요청이 실패했습니다 (HTTP ${res.status}).`, res.status, e?.detail ?? null);
  }
  return data as T;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
