import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/http/server.ts';
import { dayKey } from '../src/limits/limits.ts';
import { startHarness, until, type Harness } from './helpers/harness.ts';

/** 한도는 에이전트 설정 창(PATCH /api/agents/:id)에서 바꿉니다. 일일 토큰 0 은 무제한. */

let h: Harness;
let server: FastifyInstance;
let cookie = '';
beforeAll(async () => {
  h = await startHarness();
  server = await buildServer(h.app);
  const r = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'harness-test-password' } });
  cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
});
afterAll(async () => {
  await server.close();
  await h.close();
});
const req = (method: 'GET' | 'PATCH' | 'PUT', url: string, payload?: Record<string, unknown>) => server.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
const today = (): string => dayKey(new Date(), process.env['TZ'] || 'UTC');

describe('에이전트 설정 창의 한도', () => {
  it('일일 토큰 0 은 무제한으로 저장하고, 바뀐 내용을 활동에 남깁니다 (권한 프리셋 표시는 그대로)', async () => {
    const a = h.addAgent('한도이');
    const before = h.app.store.getAgent(a.id);
    const r = await req('PATCH', `/api/agents/${a.id}`, { limits: { ...before.limits, tokensPerDay: 0 } });
    expect(r.statusCode).toBe(200);
    expect(r.json().agent.limits.tokensPerDay).toBe(0);
    expect(h.app.store.getAgent(a.id)).toMatchObject({ limits: { ...before.limits, tokensPerDay: 0 }, preset: before.preset });
    expect(h.app.store.listActivity(5).find((x) => x.agentId === a.id)?.text).toBe(`한도를 바꿨습니다 · 일일 토큰 ${before.limits.tokensPerDay.toLocaleString('ko-KR')} → 무제한`);
    const ov = (await req('GET', '/api/overview')).json() as { agents: { id: string; tokenLimit: number }[] };
    expect(ov.agents.find((x) => x.id === a.id)?.tokenLimit).toBe(0);
  });

  it('같은 값으로 저장하면 활동을 남기지 않습니다', async () => {
    const a = h.addAgent('그대로');
    const before = h.app.store.getAgent(a.id);
    const n = h.app.store.listActivity(50).filter((x) => x.agentId === a.id).length;
    expect((await req('PATCH', `/api/agents/${a.id}`, { limits: before.limits })).statusCode).toBe(200);
    expect(h.app.store.listActivity(50).filter((x) => x.agentId === a.id)).toHaveLength(n);
  });

  it('1,000 미만은 칸 이름과 함께 거절하고, 위쪽 제한은 없습니다 (다른 한도는 위쪽 제한 그대로)', async () => {
    const a = h.addAgent('경계이');
    const limits = h.app.store.getAgent(a.id).limits;
    const low = await req('PATCH', `/api/agents/${a.id}`, { limits: { ...limits, tokensPerDay: 999 } });
    expect(low.statusCode).toBe(400);
    expect(low.json().error).toMatchObject({ code: 'limit_range', message: '일일 토큰 한도는 0(한도 무제한) 또는 1,000 이상이어야 합니다. 받은 값: 999', detail: { field: 'tokensPerDay' } });
    expect(h.app.store.getAgent(a.id).limits).toEqual(limits);
    const big = await req('PATCH', `/api/agents/${a.id}`, { limits: { ...limits, tokensPerDay: 50_000_000_000 } });
    expect(big.statusCode).toBe(200);
    expect(h.app.store.getAgent(a.id).limits.tokensPerDay).toBe(50_000_000_000);
    const conc = await req('PATCH', `/api/agents/${a.id}`, { limits: { ...limits, concurrency: 9 } });
    expect(conc.json().error.message).toBe('동시 작업 한도는 1 이상 8 이하여야 합니다. 받은 값: 9');
  });

  it('권한 화면 저장(PUT permissions)은 한도를 받지 않고 어디로 보낼지 알려 줍니다', async () => {
    const a = h.addAgent('권한이');
    const row = h.app.store.getAgent(a.id);
    const r = await req('PUT', `/api/agents/${a.id}/permissions`, { permissions: row.permissions, limits: { ...row.limits, tokensPerDay: 0 } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'limits_moved', message: '한도는 PATCH /api/agents/:id 에 limits 로 보내세요 (에이전트 설정 창).' });
    expect((await req('PUT', `/api/agents/${a.id}/permissions`, { permissions: row.permissions })).statusCode).toBe(200);
    expect(h.app.store.getAgent(a.id).limits).toEqual(row.limits);
  });
});

describe('일일 토큰 0 = 무제한 (실행)', () => {
  it('오늘 한도를 다 쓴 에이전트는 모델을 부르지 않고 멈추고, 0 으로 바꾸면 바로 다시 일합니다', async () => {
    const a = h.addAgent('많이쓴이');
    h.scripts.set(a.keyId, () => ({ text: '했습니다' }));
    const limits = h.app.store.getAgent(a.id).limits;
    await req('PATCH', `/api/agents/${a.id}`, { limits: { ...limits, tokensPerDay: 1000 } });
    h.app.store.addUsage(a.id, today(), { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 });
    const send = (text: string) => h.app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text, reply: null });

    const blocked = send('하나');
    await until(() => h.app.store.getTask(blocked.id).status === 'failed', '한도에 막힘');
    expect(h.app.store.getTask(blocked.id).error).toContain('에이전트 설정 창의 한도에서 일일 토큰을 올리세요 (0 은 무제한)');
    expect(h.calls.get(a.keyId)).toBeUndefined();

    await req('PATCH', `/api/agents/${a.id}`, { limits: { ...limits, tokensPerDay: 0 } });
    const free = send('둘');
    await until(() => h.app.store.getTask(free.id).status === 'done', '무제한으로 끝');
    expect(h.calls.get(a.keyId)).toHaveLength(1);
  });
});
