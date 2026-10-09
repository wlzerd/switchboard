import { describe, expect, it } from 'vitest';
import { checkKeyFormat, KEY_MAX_LENGTH, KEY_MIN_LENGTH, last4 } from '../src/anthropic/key-format.ts';

const key = (len: number): string => 'sk-ant-api03-' + 'a'.repeat(len - 'sk-ant-api03-'.length);

describe('API 키 형식', () => {
  it('빈 값과 공백뿐인 값은 key_empty', () => {
    expect(checkKeyFormat('')?.code).toBe('key_empty');
    expect(checkKeyFormat('   \n')?.code).toBe('key_empty');
  });

  it('앞뒤 공백·줄바꿈은 붙여넣기 실수로 보고 통과시킨다', () => {
    expect(checkKeyFormat(`  ${key(60)}\n`)).toBeNull();
  });

  it('중간 공백은 정확한 위치(1부터)를 알려준다', () => {
    const k = 'sk-ant-api03 ' + 'a'.repeat(40);
    const r = checkKeyFormat(k);
    expect(r?.code).toBe('key_whitespace');
    expect(r?.message).toContain('13번째 글자');
  });

  it("'sk-ant'(하이픈 없음)은 접두어 오류", () => {
    expect(checkKeyFormat('sk-ant' + 'a'.repeat(50))?.code).toBe('key_prefix');
  });

  it('다른 서비스 키는 앞 7자만 보여준다', () => {
    const r = checkKeyFormat('sk-proj-' + 'x'.repeat(60));
    expect(r?.code).toBe('key_prefix');
    expect(r?.message).toContain("'sk-proj'");
    expect(r?.message).not.toContain('xxxx');
  });

  it('관리자 키는 별도 문구', () => {
    expect(checkKeyFormat('sk-ant-admin01-' + 'a'.repeat(60))?.code).toBe('key_admin');
  });

  it(`길이 경계: ${KEY_MIN_LENGTH - 1}자 거부, ${KEY_MIN_LENGTH}자 통과`, () => {
    expect(checkKeyFormat(key(KEY_MIN_LENGTH - 1))?.code).toBe('key_too_short');
    expect(checkKeyFormat(key(KEY_MIN_LENGTH))).toBeNull();
  });

  it(`길이 경계: ${KEY_MAX_LENGTH}자 통과, ${KEY_MAX_LENGTH + 1}자 거부`, () => {
    expect(checkKeyFormat(key(KEY_MAX_LENGTH))).toBeNull();
    expect(checkKeyFormat(key(KEY_MAX_LENGTH + 1))?.code).toBe('key_too_long');
  });

  it('허용되지 않는 문자는 위치와 문자를 알려준다', () => {
    const k = key(50).slice(0, 20) + '+' + key(50).slice(21);
    const r = checkKeyFormat(k);
    expect(r?.code).toBe('key_invalid_char');
    expect(r?.message).toContain("21번째 글자 '+'");
  });

  it('last4 는 다듬은 값의 끝 4자리', () => {
    expect(last4('  sk-ant-abcd1234\n')).toBe('1234');
    expect(last4('ab')).toBe('ab');
  });
});
