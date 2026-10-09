/**
 * API 키 형식 검사. 네트워크 요청 전에 흔한 실수를 정확한 문구로 알려줍니다.
 * 키 원문은 메시지에 넣지 않고 앞 7자까지만 보여줍니다.
 */

export const KEY_PREFIX = 'sk-ant-';
export const ADMIN_KEY_PREFIX = 'sk-ant-admin';
export const KEY_MIN_LENGTH = 40;
export const KEY_MAX_LENGTH = 512;

export interface KeyFormatIssue {
  code: 'key_empty' | 'key_whitespace' | 'key_prefix' | 'key_admin' | 'key_too_short' | 'key_too_long' | 'key_invalid_char';
  message: string;
}

/** 앞뒤 공백·줄바꿈은 붙여 넣기에서 흔히 생기므로 제거한 값을 돌려줍니다. */
export function normalizeKey(input: string): string {
  return input.trim();
}

export function checkKeyFormat(input: string): KeyFormatIssue | null {
  const key = normalizeKey(input);
  if (key.length === 0) return { code: 'key_empty', message: 'API 키를 입력하세요.' };

  const ws = key.search(/\s/);
  if (ws !== -1) {
    return {
      code: 'key_whitespace',
      message: `${ws + 1}번째 글자에 공백이나 줄바꿈이 있습니다. 키를 다시 복사해 붙여 넣으세요.`,
    };
  }

  if (!key.startsWith(KEY_PREFIX)) {
    return {
      code: 'key_prefix',
      message: `Anthropic API 키는 ${KEY_PREFIX} 로 시작합니다. 입력한 값은 '${key.slice(0, 7)}'로 시작합니다.`,
    };
  }

  if (key.startsWith(ADMIN_KEY_PREFIX)) {
    return {
      code: 'key_admin',
      message: '관리자(Admin) 키입니다. 에이전트에는 메시지 API용 일반 키(sk-ant-api…)를 넣으세요.',
    };
  }

  if (key.length < KEY_MIN_LENGTH) {
    return {
      code: 'key_too_short',
      message: `키 길이가 ${key.length}자로 짧습니다. 복사하면서 일부가 잘렸을 수 있습니다.`,
    };
  }

  if (key.length > KEY_MAX_LENGTH) {
    return {
      code: 'key_too_long',
      message: `키가 ${key.length}자로 너무 깁니다. 다른 값이 함께 붙여 넣어졌는지 확인하세요.`,
    };
  }

  const bad = key.search(/[^A-Za-z0-9_-]/);
  if (bad !== -1) {
    return {
      code: 'key_invalid_char',
      message: `${bad + 1}번째 글자 '${key[bad]}'는 API 키에 쓰이지 않는 문자입니다.`,
    };
  }

  return null;
}

/** 화면에 보여줄 마지막 4자리. */
export function last4(key: string): string {
  const k = normalizeKey(key);
  return k.length >= 4 ? k.slice(-4) : k;
}
