import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOverview } from '../src/http/overview.ts';
import { dayKey } from '../src/limits/limits.ts';
import { startHarness, until, type Harness } from './helpers/harness.ts';

/**
 * 프롬프트 캐시는 앞에서부터 바이트가 같은 부분만 다시 읽습니다 (도구 → 시스템 → 대화 순).
 *  - 도구 + 시스템 프롬프트 고정 부분: 끝에 1시간 캐시 지점 → 같은 에이전트의 모든 대화가 함께 읽음
 *  - 대화: 마지막 블록에 자동 캐시 지점, 유지 시간은 PROMPT_CACHE_TTL
 */

type Req = { cache_control?: unknown; system: { text: string; cache_control?: unknown }[]; tools: unknown[] };

let h: Harness;
let long: Harness;
beforeAll(async () => {
  h = await startHarness();
  long = await startHarness({ PROMPT_CACHE_TTL: '1h' });
});
afterAll(async () => {
  await h.close();
  await long.close();
});

async function run(hh: Harness, agentId: string, source: string, text: string): Promise<void> {
  const t = hh.app.manager.enqueue({ agentId, source, sourceLabel: '웹 콘솔', origin: 'console', text, reply: null });
  await until(() => hh.app.store.getTask(t.id).status === 'done', `작업 끝: ${text}`);
}
const requests = (hh: Harness, keyId: string): Req[] => (hh.calls.get(keyId) ?? []) as unknown as Req[];

describe('캐시 지점', () => {
  it('도구 + 고정 부분 끝은 1시간, 대화 끝(자동)은 기본 5분 (긴 유지 시간이 앞)', async () => {
    const a = h.addAgent('캐시이');
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    await run(h, a.id, 'console', '안녕');
    const [p] = requests(h, a.keyId);
    expect(p!.system).toHaveLength(2);
    expect(p!.system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(p!.system[1]!.cache_control).toBeUndefined();
    expect(p!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('PROMPT_CACHE_TTL=1h 면 대화 부분도 1시간', async () => {
    const a = long.addAgent('긴캐시');
    long.scripts.set(a.keyId, () => ({ text: '네' }));
    await run(long, a.id, 'console', '안녕');
    const [p] = requests(long, a.keyId);
    expect(p!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(p!.system[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

describe('함께 읽는 앞부분', () => {
  it('같은 에이전트의 다른 대화(콘솔 · 채널)도 도구와 고정 부분이 바이트까지 같습니다', async () => {
    const a = h.addAgent('여러대화');
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    await run(h, a.id, 'console', '하나');
    await run(h, a.id, 'telegram:42', '둘');
    const [x, y] = requests(h, a.keyId);
    expect(y!.system[0]!.text).toBe(x!.system[0]!.text);
    expect(JSON.stringify(y!.tools)).toBe(JSON.stringify(x!.tools));
  });

  it('일하면서 바뀌는 것(관리 중인 프로젝트 · 위임 대상 · 하트비트 조건)은 뒤 덩어리에만 있어 고정 부분을 건드리지 않습니다', async () => {
    const a = h.addAgent('맡기는이', { delegation: { send: true } });
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    await run(h, a.id, 'console', '하나');
    h.addAgent('새동료', { delegation: { accept: true } });
    await run(h, a.id, 'console', '둘');
    const [x, y] = requests(h, a.keyId);
    for (const head of ['## 관리 중인 프로젝트', '## 위임 (다른 에이전트에게 맡기기)', '## 조용한 판단']) {
      expect(x!.system[0]!.text).not.toContain(head);
      expect(x!.system[1]!.text).toContain(head);
    }
    expect(x!.system[0]!.text).toContain("너는 '맡기는이'이라는 이름의 에이전트다");
    expect(y!.system[0]!.text).toBe(x!.system[0]!.text);
    expect(x!.system[1]!.text).not.toContain('새동료');
    expect(y!.system[1]!.text).toContain('새동료');
  });
});

describe('캔버스 패널의 오늘 캐시 사용량', () => {
  it('기록이 없으면 null, 있으면 읽기 · 쓰기 · 캐시 밖 입력', () => {
    const a = h.addAgent('사용량');
    const view = () => buildOverview(h.app).agents.find((x) => x.id === a.id)?.cacheToday;
    expect(view()).toBeNull();
    h.app.store.addUsage(a.id, dayKey(new Date(), process.env['TZ'] || 'UTC'), { input: 46, output: 10, cacheRead: 211_373, cacheWrite: 163_903 });
    expect(view()).toEqual({ read: 211_373, write: 163_903, uncached: 46 });
  });
});
