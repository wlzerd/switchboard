import Anthropic from '@anthropic-ai/sdk';
import { AnthropicCallError } from '../errors.ts';

export interface CallContext {
  /** verify: 키 확인 · models: 모델 목록 · message: 에이전트 대화 호출 */
  op: 'verify' | 'models' | 'message';
  agentName?: string;
  model?: string;
  timeoutMs?: number;
  host?: string;
}

/** API 응답 본문에 들어 있는 원래 메시지를 꺼냅니다 ({ error: { message } }). */
export function apiMessage(err: InstanceType<typeof Anthropic.APIError>): string {
  const body = err.error as { error?: { message?: unknown }; message?: unknown } | undefined;
  const inner = body?.error?.message ?? body?.message;
  if (typeof inner === 'string' && inner.length > 0) return inner;
  return err.message;
}

function who(ctx: CallContext): string {
  return ctx.agentName ? `에이전트 '${ctx.agentName}': ` : '';
}

/** retry-after(초) 또는 retry-after-ms 헤더를 밀리초로. 없거나 잘못된 값이면 null. */
export function retryAfterMs(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const ms = headers.get('retry-after-ms');
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms)) return Math.ceil(Number(ms));
  const s = headers.get('retry-after');
  if (s !== null && /^\d+(\.\d+)?$/.test(s)) return Math.ceil(Number(s) * 1000);
  if (s !== null) {
    const at = Date.parse(s);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return null;
}

function connectionCause(err: unknown): { code: string | null; message: string } {
  const cause = (err as { cause?: unknown }).cause as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  // undici 는 실제 원인을 cause.cause 에 담는 경우가 있어 두 단계까지 확인합니다.
  const deep = cause?.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof deep?.code === 'string' ? deep.code : typeof cause?.code === 'string' ? cause.code : null;
  const message =
    typeof deep?.message === 'string' ? deep.message : typeof cause?.message === 'string' ? cause.message : String(err);
  return { code, message };
}

/**
 * SDK 오류를 상황별 문구가 담긴 AnthropicCallError 로 바꿉니다.
 * 가장 구체적인 클래스부터 확인합니다 (APIConnectionTimeoutError 는 APIConnectionError 의 하위 클래스).
 */
export function describeAnthropicError(err: unknown, ctx: CallContext): AnthropicCallError {
  const host = ctx.host ?? 'api.anthropic.com';
  const p = who(ctx);

  if (err instanceof Anthropic.APIUserAbortError) {
    return new AnthropicCallError('anthropic_aborted', `${p}요청을 중단했습니다.`, 499, false, null);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    const sec = ctx.timeoutMs ? Math.round(ctx.timeoutMs / 1000) : null;
    return new AnthropicCallError(
      'anthropic_timeout',
      `${p}${sec !== null ? `${sec}초 안에 ` : ''}응답이 없었습니다. 서버와 ${host} 사이 연결이 느리거나 막혀 있습니다.`,
      504,
      true,
      null,
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    const { code, message } = connectionCause(err);
    switch (code) {
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return new AnthropicCallError('anthropic_dns', `${p}서버가 ${host} 주소를 찾지 못했습니다(${code}). 서버의 DNS 설정이나 아웃바운드 방화벽을 확인하세요.`, 502, true, null);
      case 'ECONNREFUSED':
        return new AnthropicCallError('anthropic_refused', `${p}${host} 연결이 거부되었습니다(ECONNREFUSED). ANTHROPIC_BASE_URL 이나 프록시 설정을 확인하세요.`, 502, true, null);
      case 'ECONNRESET':
      case 'UND_ERR_SOCKET':
        return new AnthropicCallError('anthropic_reset', `${p}${host} 연결이 응답 도중 끊겼습니다(${code}). 다시 시도합니다.`, 502, true, null);
      case 'ETIMEDOUT':
      case 'UND_ERR_CONNECT_TIMEOUT':
        return new AnthropicCallError('anthropic_connect_timeout', `${p}${host} 에 연결하는 데 시간이 너무 오래 걸렸습니다(${code}).`, 504, true, null);
      case 'CERT_HAS_EXPIRED':
      case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      case 'SELF_SIGNED_CERT_IN_CHAIN':
      case 'DEPTH_ZERO_SELF_SIGNED_CERT':
        return new AnthropicCallError('anthropic_tls', `${p}${host} 의 TLS 인증서를 검증하지 못했습니다(${code}). 중간 프록시가 인증서를 바꾸고 있는지 확인하세요.`, 502, false, null);
      default:
        return new AnthropicCallError('anthropic_connection', `${p}${host} 에 연결하지 못했습니다${code ? `(${code})` : ''}: ${message}`, 502, true, null);
    }
  }

  if (err instanceof Anthropic.AuthenticationError) {
    return new AnthropicCallError('anthropic_401', `${p}인증에 실패했습니다(401 authentication_error). 키가 폐기되었거나 다른 조직의 키입니다. Anthropic Console에서 키 상태를 확인하세요.`, 401, false, null);
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AnthropicCallError('anthropic_403', `${p}권한이 없습니다(403 permission_error): ${apiMessage(err)}`, 403, false, null);
  }
  if (err instanceof Anthropic.NotFoundError) {
    if (ctx.op === 'message' && ctx.model) {
      return new AnthropicCallError('anthropic_404_model', `${p}모델 '${ctx.model}'을(를) 이 키로 쓸 수 없습니다(404). 모델이 없거나 조직에 열려 있지 않습니다. 에이전트 설정에서 다른 모델을 고르세요.`, 404, false, null);
    }
    return new AnthropicCallError('anthropic_404', `${p}요청한 주소를 찾지 못했습니다(404): ${apiMessage(err)}. ANTHROPIC_BASE_URL 을 설정했다면 값을 확인하세요.`, 404, false, null);
  }
  if (err instanceof Anthropic.RateLimitError) {
    const wait = retryAfterMs(err.headers);
    const sec = wait !== null ? Math.max(1, Math.ceil(wait / 1000)) : null;
    return new AnthropicCallError('anthropic_429', `${p}요청 한도를 넘었습니다(429 rate_limit_error).${sec !== null ? ` ${sec}초 뒤 다시 시도합니다.` : ' 잠시 뒤 다시 시도합니다.'}`, 429, true, wait);
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AnthropicCallError('anthropic_400', `${p}요청이 거부되었습니다(400 invalid_request_error): ${apiMessage(err)}`, 400, false, null);
  }
  if (err instanceof Anthropic.UnprocessableEntityError) {
    return new AnthropicCallError('anthropic_422', `${p}요청 내용을 처리할 수 없습니다(422): ${apiMessage(err)}`, 422, false, null);
  }
  if (err instanceof Anthropic.InternalServerError) {
    if (err.status === 529) {
      return new AnthropicCallError('anthropic_529', `${p}Anthropic API가 일시적으로 과부하 상태입니다(529 overloaded_error). 키 문제는 아니며 잠시 뒤 다시 시도합니다.`, 503, true, retryAfterMs(err.headers));
    }
    return new AnthropicCallError('anthropic_5xx', `${p}Anthropic API 내부 오류입니다(${err.status} ${err.type ?? 'api_error'}). 잠시 뒤 다시 시도합니다.`, 502, true, retryAfterMs(err.headers));
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) {
      return new AnthropicCallError('anthropic_402', `${p}결제 문제로 요청이 거부되었습니다(402 billing_error). Anthropic Console의 결제 정보를 확인하세요.`, 402, false, null);
    }
    if (err.status === 413) {
      return new AnthropicCallError('anthropic_413', `${p}요청이 너무 큽니다(413 request_too_large). 대화나 첨부 파일이 크기 한도를 넘었습니다.`, 413, false, null);
    }
    return new AnthropicCallError('anthropic_status', `${p}Anthropic API 오류(${String(err.status)} ${err.type ?? ''}): ${apiMessage(err)}`, 502, false, null);
  }

  const message = err instanceof Error ? err.message : String(err);
  return new AnthropicCallError('anthropic_unknown', `${p}Anthropic SDK에서 예상하지 못한 오류가 났습니다: ${message}`, 500, false, null);
}
