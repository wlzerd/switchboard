import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.ts';
import { ConfigError } from '../src/errors.ts';

const KEY32 = Buffer.alloc(32, 7).toString('base64');
const base = {
  ADMIN_PASSWORD: 'a'.repeat(12),
  SESSION_SECRET: 's'.repeat(32),
  SECRETS_KEY: KEY32,
};

function issues(env: Record<string, string | undefined>): string[] {
  try {
    parseConfig({ ...base, ...env }, '/repo');
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.issues;
    throw err;
  }
}

describe('PORT 경계값', () => {
  it.each([
    ['0', true],
    ['1', false],
    ['65535', false],
    ['65536', true],
    ['-1', true],
    ['80.5', true],
    ['abc', true],
  ])('PORT=%s → 오류 %s', (port, bad) => {
    const list = issues({ PORT: port });
    expect(list.some((m) => m.startsWith('PORT:'))).toBe(bad);
  });

  it('비어 있거나 공백뿐이면 기본값을 쓴다', () => {
    expect(parseConfig({ ...base, PORT: '   ' }, '/repo').port).toBe(8787);
  });

  it('앞뒤 공백은 무시한다', () => {
    expect(parseConfig({ ...base, PORT: ' 80 ' }, '/repo').port).toBe(80);
  });
});

describe('필수 비밀값 길이 경계', () => {
  it('ADMIN_PASSWORD 11자는 거부, 12자는 통과', () => {
    expect(issues({ ADMIN_PASSWORD: 'a'.repeat(11) }).join()).toContain('ADMIN_PASSWORD: 12자 이상이어야 합니다. 현재 11자');
    expect(issues({ ADMIN_PASSWORD: 'a'.repeat(12) })).toEqual([]);
  });

  it('SESSION_SECRET 31자는 거부, 32자는 통과', () => {
    expect(issues({ SESSION_SECRET: 's'.repeat(31) }).join()).toContain('SESSION_SECRET: 32자 이상');
    expect(issues({ SESSION_SECRET: 's'.repeat(32) })).toEqual([]);
  });

  it('비어 있으면 필수 값 문구', () => {
    expect(issues({ ADMIN_PASSWORD: '' }).join()).toContain('ADMIN_PASSWORD: 필수 값이 비어 있습니다');
  });
});

describe('SECRETS_KEY', () => {
  it.each([
    [31, true],
    [32, false],
    [33, true],
  ])('%i바이트 → 오류 %s', (len, bad) => {
    const list = issues({ SECRETS_KEY: Buffer.alloc(len, 1).toString('base64') });
    expect(list.some((m) => m.includes(`현재 ${len}바이트`))).toBe(bad);
  });

  it('base64 가 아니면 형식 오류', () => {
    expect(issues({ SECRETS_KEY: 'not base64!!' }).join()).toContain('SECRETS_KEY: base64 형식이 아닙니다');
  });
});

describe('기타 형식', () => {
  it('TRUST_PROXY 는 true/false/1/0 과 프록시 IP 목록을 받는다 (대소문자 무시)', () => {
    expect(parseConfig({ ...base, TRUST_PROXY: 'TRUE' }, '/repo').trustProxy).toBe(true);
    expect(parseConfig({ ...base, TRUST_PROXY: '1' }, '/repo').trustProxy).toBe(true);
    expect(parseConfig({ ...base, TRUST_PROXY: '0' }, '/repo').trustProxy).toBe(false);
    expect(parseConfig({ ...base, TRUST_PROXY: 'loopback' }, '/repo').trustProxy).toEqual(['loopback']);
    expect(parseConfig({ ...base, TRUST_PROXY: ' 10.0.0.1 , 10.0.0.0/8,::1 ' }, '/repo').trustProxy).toEqual(['10.0.0.1', '10.0.0.0/8', '::1']);
    expect(issues({ TRUST_PROXY: 'yes' }).join()).toContain("TRUST_PROXY: true · false · 프록시 IP 목록(쉼표로 구분, 같은 컴퓨터의 프록시는 loopback) 중 하나여야 합니다. 현재 값 'yes'");
    // 단계 수(숫자)는 Fastify 가 받지 않으므로 오류로 알립니다 (1 은 예전처럼 true).
    expect(issues({ TRUST_PROXY: '2' }).join()).toContain('TRUST_PROXY:');
    expect(issues({ TRUST_PROXY: '10.0.0.1, evil' }).join()).toContain('TRUST_PROXY:');
    expect(issues({ TRUST_PROXY: ',' }).join()).toContain('TRUST_PROXY:');
  });

  it('새 한도: AGENT_QUEUE_MAX · DELEGATION_MAX_ROUNDS · ACTIVITY_KEEP 의 경계', () => {
    const c = parseConfig(base, '/repo');
    expect([c.agentQueueMax, c.delegationMaxRounds, c.activityKeep]).toEqual([50, 3, 5000]);
    expect(parseConfig({ ...base, AGENT_QUEUE_MAX: '1', DELEGATION_MAX_ROUNDS: '1', ACTIVITY_KEEP: '100' }, '/repo').agentQueueMax).toBe(1);
    expect(issues({ AGENT_QUEUE_MAX: '0' }).join()).toContain('AGENT_QUEUE_MAX: 1 이상 10000 이하여야 합니다');
    expect(issues({ DELEGATION_MAX_ROUNDS: '21' }).join()).toContain('DELEGATION_MAX_ROUNDS: 1 이상 20 이하여야 합니다');
    expect(issues({ ACTIVITY_KEEP: '99' }).join()).toContain('ACTIVITY_KEEP: 100 이상 1000000 이하여야 합니다');
  });

  it('PUBLIC_URL 은 http(s)만, 끝 슬래시는 뗀다', () => {
    expect(issues({ PUBLIC_URL: 'ftp://a.com' }).join()).toContain('http:// 또는 https://');
    expect(parseConfig({ ...base, PUBLIC_URL: 'https://a.com/' }, '/repo').publicUrl).toBe('https://a.com');
  });

  it('여러 오류를 한 번에 모두 알려준다', () => {
    const list = issues({ PORT: '0', LOG_LEVEL: 'verbose', AGENT_MAX_CONCURRENCY: '65', ADMIN_PASSWORD: 'short' });
    expect(list).toHaveLength(4);
  });

  it('상대 경로는 루트 기준, 절대 경로는 그대로', () => {
    expect(parseConfig({ ...base, DATA_DIR: './data' }, '/repo').dataDir).toBe('/repo/data');
    expect(parseConfig({ ...base, DATA_DIR: '/var/sb' }, '/repo').dataDir).toBe('/var/sb');
  });

  it('PROMPT_CACHE_TTL: 5m(기본) 또는 1h', () => {
    expect(parseConfig(base, '/repo').promptCacheTtl).toBe('5m');
    expect(parseConfig({ ...base, PROMPT_CACHE_TTL: '1h' }, '/repo').promptCacheTtl).toBe('1h');
    expect(issues({ PROMPT_CACHE_TTL: '60m' }).join()).toContain("PROMPT_CACHE_TTL: 5m | 1h 중 하나여야 합니다. 현재 값 '60m'");
  });

  it('GUARD_LOOP_REPEAT 하한 2 (1이면 같은 호출을 한 번도 반복 못 함)', () => {
    expect(issues({ GUARD_LOOP_REPEAT: '1' }).join()).toContain('GUARD_LOOP_REPEAT: 2 이상 100 이하');
    expect(issues({ GUARD_LOOP_REPEAT: '2' })).toEqual([]);
  });
});
