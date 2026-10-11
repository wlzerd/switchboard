import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_CAPABILITIES_URL,
  SERVER_TOOL_RECHECK_MS,
  ServerToolState,
  classifyServerToolError,
  serverToolDroppedNotice,
  serverToolOffNotice,
  type SentServerTool,
} from '../src/agents/server-tools.ts';
import type { PermissionRule } from '../src/permissions/policy.ts';
import { startHarness, until, type Harness, type Params } from './helpers/harness.ts';

// 서버 도구(웹 검색 · 웹 가져오기)를 실은 요청이 400 으로 거절됐을 때:
// 조직 설정에서 꺼졌으면 그 키로 그 도구만 잠시 빼고, 모델이 버전을 받지 않으면 그 도구만 낮추며, 서버 도구 탓이 아니면 바로 원래 오류를 알립니다.

const SENT: SentServerTool[] = [
  { name: 'web_search', type: 'web_search_20260209', index: 12 },
  { name: 'web_fetch', type: 'web_fetch_20260209', index: 13 },
];

describe('400 오류 가르기', () => {
  it.each([
    ['Web search is not enabled for this organization', { kind: 'off', tool: 'web_search' }],
    ['Web fetch is not enabled for this organization', { kind: 'off', tool: 'web_fetch' }],
    ["'web_fetch_20260209' is not supported for this model", { kind: 'version', tools: ['web_fetch'] }],
    ['tools.12.type: not supported for this model', { kind: 'version', tools: ['web_search'] }],
    ['Web search is not supported on this model', { kind: 'version', tools: ['web_search'] }],
    ['tools.12.allowed_callers: set ["direct"] for this model', { kind: 'version', tools: ['web_search'] }],
    ['This model does not support code execution, which dynamic filtering needs', { kind: 'version', tools: ['web_search', 'web_fetch'] }],
    ['messages.0.content.1.image.source.base64: image exceeds 5 MB maximum', null],
    ['tools.3.input_schema: JSON schema is invalid', null],
    ['tools.120: unknown tool', null],
    ['prompt is too long: 210000 tokens > 200000 maximum', null],
  ])('%s → %j', (message, want) => {
    expect(classifyServerToolError(message, SENT)).toEqual(want);
  });

  it('보내지 않은 도구 탓은 서버 도구 오류로 보지 않습니다', () => {
    const onlyFetch = [SENT[1]!];
    expect(classifyServerToolError('Web search is not enabled for this organization', onlyFetch)).toBeNull();
    expect(classifyServerToolError("tools.12: 'web_search_20260209' is not supported", onlyFetch)).toBeNull();
    expect(classifyServerToolError('code execution is not supported', [])).toBeNull();
  });

  it('안내 문구: 조직 설정은 켜는 곳 · 다시 확인하는 시간을, 웹 검색은 권한으로 끄는 법까지 알립니다', () => {
    expect(serverToolOffNotice('web_search')).toBe(
      `웹 검색(web_search): Anthropic 조직 설정에서 꺼져 있어 이 도구 없이 진행합니다. 쓰려면 조직 관리자가 Claude Console 기능 설정(${CONSOLE_CAPABILITIES_URL})에서 켜세요. 켜면 60분 안에 다시 씁니다. 쓰지 않을 거면 이 에이전트의 '웹 검색' 권한을 차단하세요.`,
    );
    // 웹 가져오기의 권한(HTTP 요청)은 http_request 도구와 함께 쓰므로 차단하라고 하지 않습니다.
    expect(serverToolOffNotice('web_fetch')).not.toContain('권한');
    expect(serverToolDroppedNotice('web_fetch', 'claude-haiku-5-5')).toBe("웹 가져오기(web_fetch): 'claude-haiku-5-5' 모델이 이 도구를 받지 않아 빼고 진행합니다.");
  });
});

describe('키 · 모델마다 기억', () => {
  it('버전 단계는 키 · 모델 · 도구마다 따로, 더 낮출 버전이 없으면 뺍니다', () => {
    const s = new ServerToolState();
    expect(s.version('k1', 'm', 'web_search')).toBe('web_search_20260209');
    expect(s.lower('k1', 'm', 'web_search')).toBe('web_search_20250305');
    expect(s.version('k1', 'm', 'web_search')).toBe('web_search_20250305');
    expect([s.version('k1', 'm', 'web_fetch'), s.version('k2', 'm', 'web_search'), s.version('k1', 'other', 'web_search')]).toEqual(['web_fetch_20260209', 'web_search_20260209', 'web_search_20260209']);
    expect(s.lower('k1', 'm', 'web_search')).toBeNull();
    expect(s.version('k1', 'm', 'web_search')).toBeNull();
    expect(s.lower('k1', 'm', 'web_search')).toBeNull();
    expect(s.version('k1', 'm', 'web_search')).toBeNull();
  });

  it('조직 설정에서 꺼진 도구는 그 키에서만, 정해진 시간 동안 빼고 그 뒤에 다시 보내 봅니다', () => {
    let t = 1_000;
    const s = new ServerToolState(() => t);
    s.turnOff('k1', 'web_search');
    expect([s.version('k1', 'm', 'web_search'), s.version('k1', 'other', 'web_search')]).toEqual([null, null]);
    expect([s.version('k1', 'm', 'web_fetch'), s.version('k2', 'm', 'web_search')]).toEqual(['web_fetch_20260209', 'web_search_20260209']);
    t += SERVER_TOOL_RECHECK_MS - 1;
    expect(s.isOff('k1', 'web_search')).toBe(true);
    t += 1;
    expect(s.isOff('k1', 'web_search')).toBe(false);
    expect(s.version('k1', 'm', 'web_search')).toBe('web_search_20260209');

    s.turnOff('k1', 'web_fetch');
    expect([s.version('k1', 'm', 'web_search'), s.version('k1', 'm', 'web_fetch')]).toEqual(['web_search_20260209', null]);
  });
});

/* ───────── 에이전트 작업에서 (가짜 API) ───────── */

const bad = (message: string) => Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message } }, undefined, new Headers());
const denied = (message: string) => Anthropic.APIError.generate(403, { type: 'error', error: { type: 'permission_error', message } }, undefined, new Headers());
const serverTypes = (p: Params) => p.tools.flatMap((t) => (typeof t.type === 'string' ? [t.type] : []));
const allow: PermissionRule = { mode: 'allow', scope: [], always: [] };
const web = { 'web.search': allow, 'net.fetch': allow };

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

async function runTask(agentId: string) {
  const t = h.app.manager.enqueue({ agentId, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '찾아줘', reply: null });
  await until(() => !['queued', 'running'].includes(h.app.store.getTask(t.id).status), '작업 끝');
  return h.app.store.getTask(t.id);
}

function notes(agentId: string): string[] {
  const thread = h.app.store.listThreads(agentId).find((x) => x.source === 'console');
  if (!thread) return [];
  return h.app.store.listTimeline(thread.id, 100).flatMap((i) => (i.kind === 'system' ? [(i.data as { text: string }).text] : []));
}

describe('에이전트 작업에서', () => {
  it('조직에서 웹 검색이 꺼져 있으면 웹 검색만 빼고 바로 다시 보내고, 대화에 이유를 한 번 남기며, 다른 키는 그대로 둡니다', async () => {
    const a = h.addAgent('가', { permissions: web });
    const b = h.addAgent('나', { permissions: web });
    h.scripts.set(a.keyId, (p) => (p.tools.some((t) => t.name === 'web_search') ? { error: bad('Web search is not enabled for this organization') } : { text: 'ok' }));
    h.scripts.set(b.keyId, () => ({ text: 'ok' }));

    expect((await runTask(a.id)).status).toBe('done');
    expect(h.calls.get(a.keyId)!.map(serverTypes)).toEqual([['web_search_20260209', 'web_fetch_20260209'], ['web_fetch_20260209']]);
    expect(notes(a.id)).toEqual([serverToolOffNotice('web_search')]);

    // 같은 키의 다음 작업은 묻지 않고 웹 검색 없이 보내고, 안내도 다시 남기지 않습니다.
    expect((await runTask(a.id)).status).toBe('done');
    expect(h.calls.get(a.keyId)!.slice(2).map(serverTypes)).toEqual([['web_fetch_20260209']]);
    expect(notes(a.id)).toHaveLength(1);

    // 다른 키(다른 조직일 수 있음)를 쓰는 에이전트는 같은 모델이어도 그대로입니다.
    await runTask(b.id);
    expect(h.calls.get(b.keyId)!.map(serverTypes)).toEqual([['web_search_20260209', 'web_fetch_20260209']]);
  });

  it('모델이 받지 않는 버전은 오류가 가리킨 도구만 낮추고, 더 낮출 수 없으면 그 도구만 빼며 기억합니다', async () => {
    const a = h.addAgent('가', { permissions: web });
    // 이름 없이 'tools.N' 위치로만 가리키는 오류: 보낸 서버 도구의 위치를 맞게 셌는지까지 봅니다.
    h.scripts.set(a.keyId, (p) => {
      const i = p.tools.findIndex((t) => t.name === 'web_search');
      return i >= 0 ? { error: bad(`tools.${i}.type: not supported for this model`) } : { text: 'ok' };
    });
    expect((await runTask(a.id)).status).toBe('done');
    await runTask(a.id);
    expect(h.calls.get(a.keyId)!.map(serverTypes)).toEqual([
      ['web_search_20260209', 'web_fetch_20260209'],
      ['web_search_20250305', 'web_fetch_20260209'],
      ['web_fetch_20260209'],
      ['web_fetch_20260209'],
    ]);
    expect(notes(a.id)).toEqual([serverToolDroppedNotice('web_search', a.model)]);
  });

  it('서버 도구와 상관없는 400 은 다시 보내지 않고 바로 알리며, 서버 도구는 그대로 둡니다', async () => {
    const a = h.addAgent('가', { permissions: web });
    let call = 0;
    h.scripts.set(a.keyId, () => {
      call += 1;
      return call === 1 ? { error: bad('messages.0.content.1.image.source.base64: image exceeds 5 MB maximum') } : { text: 'ok' };
    });
    const first = await runTask(a.id);
    expect(first.status).toBe('failed');
    expect(first.error).toContain('image exceeds 5 MB maximum');
    expect((await runTask(a.id)).status).toBe('done');
    expect(h.calls.get(a.keyId)!.map(serverTypes)).toEqual([
      ['web_search_20260209', 'web_fetch_20260209'],
      ['web_search_20260209', 'web_fetch_20260209'],
    ]);
    expect(notes(a.id)).toEqual([]);
  });

  it('400 이 아닌 오류(권한 · 한도 · 서버)는 서버 도구를 바꾸지 않고 원래대로 다룹니다', async () => {
    const a = h.addAgent('가', { permissions: web });
    let call = 0;
    h.scripts.set(a.keyId, () => {
      call += 1;
      return call === 1 ? { error: denied('This API key does not have permission to use web_search') } : { text: 'ok' };
    });
    const first = await runTask(a.id);
    expect(first.status).toBe('failed');
    expect(first.error).toContain('does not have permission to use web_search');
    await runTask(a.id);
    expect(h.calls.get(a.keyId)!.map(serverTypes)).toEqual([
      ['web_search_20260209', 'web_fetch_20260209'],
      ['web_search_20260209', 'web_fetch_20260209'],
    ]);
  });

  it('도구를 뺀 뒤에도 같은 오류가 오면 되풀이하지 않고 원래 오류로 멈춥니다', async () => {
    const a = h.addAgent('가', { permissions: web });
    h.scripts.set(a.keyId, () => ({ error: bad('Web search is not enabled for this organization') }));
    const task = await runTask(a.id);
    expect(task.status).toBe('failed');
    expect(task.error).toContain('Web search is not enabled for this organization');
    expect(h.calls.get(a.keyId)!.map(serverTypes)).toEqual([['web_search_20260209', 'web_fetch_20260209'], ['web_fetch_20260209']]);
  });

  it('권한이 허용이 아니면 서버 도구를 보내지 않습니다', async () => {
    const a = h.addAgent('가', { permissions: { 'web.search': { ...allow, mode: 'ask' }, 'net.fetch': allow } });
    h.scripts.set(a.keyId, () => ({ text: 'ok' }));
    await runTask(a.id);
    expect(h.calls.get(a.keyId)!.map(serverTypes)).toEqual([['web_fetch_20260209']]);
  });
});
