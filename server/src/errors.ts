/**
 * 오류 체계.
 * 모든 실패 지점은 상황을 정확히 설명하는 메시지를 가진 전용 오류를 던집니다.
 * HTTP 계층은 오류가 가진 status·code·message 를 그대로 전달할 뿐, 메시지를 뭉뚱그리지 않습니다.
 */

export type ErrorDetail = Record<string, unknown>;

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: ErrorDetail | undefined;

  constructor(code: string, message: string, status: number, detail?: ErrorDetail) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

/** .env 값이 잘못되었을 때. 잘못된 항목을 모두 모아 한 번에 알려줍니다. */
export class ConfigError extends AppError {
  readonly issues: string[];
  constructor(issues: string[]) {
    super('config_invalid', `환경 변수 ${issues.length}개가 잘못되었습니다.\n- ${issues.join('\n- ')}`, 500, { issues });
    this.issues = issues;
  }
}

/** 요청 본문·입력값이 형식에 맞지 않을 때 (400). */
export class ValidationError extends AppError {
  constructor(code: string, message: string, detail?: ErrorDetail) {
    super(code, message, 400, detail);
  }
}

/** 대상이 없을 때 (404). 무엇을 어떤 id로 찾았는지 메시지에 넣습니다. */
export class NotFoundError extends AppError {
  constructor(entity: string, id: string) {
    super(`${entityCode(entity)}_not_found`, `${entity} '${id}'을(를) 찾을 수 없습니다.`, 404, { entity, id });
  }
}

/** 이미 있는 것과 부딪힐 때 (409). */
export class ConflictError extends AppError {
  constructor(code: string, message: string, detail?: ErrorDetail) {
    super(code, message, 409, detail);
  }
}

/** 로그인·세션 문제 (401, 잠금은 429). */
export class AuthError extends AppError {
  constructor(code: string, message: string, status = 401, detail?: ErrorDetail) {
    super(code, message, status, detail);
  }
}

/** API 키 형식·확인 실패. */
export class KeyError extends AppError {
  constructor(code: string, message: string, status = 400, detail?: ErrorDetail) {
    super(code, message, status, detail);
  }
}

/** 에이전트 실행 중 Anthropic API 호출 실패. retryable 이면 런타임이 다시 시도합니다. */
export class AnthropicCallError extends AppError {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(code: string, message: string, status: number, retryable: boolean, retryAfterMs: number | null, detail?: ErrorDetail) {
    super(code, message, status, detail);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 모듈 매니페스트·실행·설치 문제. */
export class ModuleError extends AppError {
  constructor(code: string, message: string, status = 400, detail?: ErrorDetail) {
    super(code, message, status, detail);
  }
}

/** 에이전트 도구 호출이 권한 정책에 막혔을 때 (403). */
export class PermissionDeniedError extends AppError {
  constructor(code: string, message: string, detail?: ErrorDetail) {
    super(code, message, 403, detail);
  }
}

/** 한도(토큰·단계·동시 작업)에 걸렸을 때 (429). */
export class LimitError extends AppError {
  constructor(code: string, message: string, detail?: ErrorDetail) {
    super(code, message, 429, detail);
  }
}

function entityCode(entity: string): string {
  const map: Record<string, string> = {
    에이전트: 'agent',
    모듈: 'module',
    스킬: 'skill',
    훅: 'hook',
    '승인 요청': 'approval',
    'API 키': 'api_key',
    대화: 'thread',
    작업: 'task',
    예약: 'schedule',
    템플릿: 'template',
  };
  return map[entity] ?? 'entity';
}
