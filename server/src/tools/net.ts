import dns from 'node:dns';
import net from 'node:net';

/** 내부망·루프백·링크 로컬·메타데이터 주소인지 (SSRF 방지). */
export function isPrivateAddress(input: string): boolean {
  // IPv4 가 섞인 IPv6(::ffff:10.0.0.1)는 IPv4 로 바꿔서 판단합니다.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(input);
  const ip = mapped ? (mapped[1] as string) : input;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v.startsWith('ff')) return true;
    return false;
  }
  return true;
}

export class NetError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 호스트가 내부망 주소로 풀리면 막습니다. allowPrivate 가 true 면(관리자가 명시한 호스트) 통과. */
export async function assertPublicHost(host: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;
  const bare = host.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (net.isIP(bare)) addrs = [bare];
  else {
    try {
      addrs = (await dns.promises.lookup(bare, { all: true })).map((a) => a.address);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new NetError('dns', `도메인 ${host} 를 찾을 수 없습니다${code ? `(${code})` : ''}.`);
    }
  }
  const bad = addrs.find((a) => isPrivateAddress(a));
  if (bad) {
    throw new NetError('private', `${host}(${bad})는 내부 네트워크 주소라 요청하지 않았습니다. 꼭 필요하면 이 에이전트의 HTTP 요청 권한 허용 범위에 ${host} 를 정확히 적으세요.`);
  }
}

export interface FetchOptions {
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  maxBytes: number;
  signal: AbortSignal;
  /** 리다이렉트로 바뀐 호스트도 허용되는지 확인합니다 (권한 범위). */
  hostAllowed: (host: string) => Promise<boolean> | boolean;
  /** 관리자가 명시한(내부망 허용) 호스트인지 */
  privateAllowed: (host: string) => boolean;
}

export interface FetchResult {
  status: number;
  statusText: string;
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
  binaryBytes: number | null;
}

const MAX_REDIRECTS = 5;

/** 크기 제한·시간 제한·리다이렉트 검사를 하는 fetch. 리다이렉트는 반복문으로 따라갑니다. */
export async function safeFetch(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  let url = new URL(rawUrl);
  let method = opts.method;
  let body = opts.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetError('protocol', `http(s) 주소만 요청할 수 있습니다. 받은 주소: ${url.protocol}`);
    if (hop > 0 && !(await opts.hostAllowed(url.hostname))) {
      throw new NetError('redirect_denied', `리다이렉트 대상 ${url.hostname} 는 허용 범위 밖이라 따라가지 않았습니다.`);
    }
    await assertPublicHost(url.hostname, opts.privateAllowed(url.hostname));
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)]);
    let res: Response;
    try {
      res = await fetch(url, { method, headers: opts.headers, body: method === 'GET' || method === 'HEAD' ? undefined : body, redirect: 'manual', signal });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      if (e.name === 'TimeoutError') throw new NetError('timeout', `${url.hostname} 응답이 ${Math.round(opts.timeoutMs / 1000)}초 안에 오지 않았습니다.`);
      if (e.name === 'AbortError') throw new NetError('aborted', '작업이 취소되어 요청을 멈췄습니다.');
      const code = e.cause?.code;
      if (code === 'ECONNREFUSED') throw new NetError('refused', `${url.host} 가 연결을 거부했습니다(ECONNREFUSED).`);
      if ((code !== undefined && code.startsWith('ERR_TLS')) || code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') throw new NetError('tls', `${url.host} 의 TLS 인증서를 검증하지 못했습니다(${code}).`);
      throw new NetError('network', `${url.host} 요청 실패${code ? `(${code})` : ''}: ${e.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = new URL(res.headers.get('location') as string, url);
      await res.body?.cancel();
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next;
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const textual = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json|rss\+xml|atom\+xml))/i.test(contentType) || contentType === '';
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > opts.maxBytes) {
          truncated = true;
          chunks.push(value.subarray(0, value.length - (size - opts.maxBytes)));
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks);
    return {
      status: res.status,
      statusText: res.statusText,
      url: url.href,
      contentType,
      body: textual ? buf.toString('utf8') : '',
      truncated,
      binaryBytes: textual ? null : size,
    };
  }
  throw new NetError('redirects', `리다이렉트가 ${MAX_REDIRECTS}번을 넘어 멈췄습니다.`);
}
