import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/db/store.ts';
import { BASE_PERMISSIONS, type PermissionRule } from '../src/permissions/policy.ts';
import { lastUserText, startHarness, until, type Harness, type Params } from './helpers/harness.ts';

// 모듈 만들기 · 수정: 에이전트가 자신이 만든 모듈을 같은 id 로 module_create 를 다시 불러 고칩니다.
// 고친 판도 같은 점검 · 설치 훅 · '모듈 설치' 권한을 거치고, 승인 전까지는 지금 판이 그대로 돕니다.

let h: Harness;
const ASK: PermissionRule = { mode: 'ask', scope: [], always: [] };
const ALLOW: PermissionRule = { mode: 'allow', scope: [], always: [] };

beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const maker = (name: string, install: PermissionRule = ALLOW) => h.addAgent(name, { permissions: { 'module.create': ALLOW, 'module.install': install, 'module.connect': ASK } });
const pendingOf = (taskId: string) => h.app.store.listApprovals('pending').filter((x) => x.taskId === taskId);
const calls = (a: AgentRow) => h.calls.get(a.keyId) ?? [];

function toolResultOf(p: Params): { content: string; isError: boolean } {
  const last = [...p.messages].reverse().find((m) => m.role === 'user');
  const block = Array.isArray(last?.content) ? (last.content as Record<string, unknown>[]).find((b) => b['type'] === 'tool_result') : undefined;
  if (!block) throw new Error(`도구 결과가 없습니다: ${lastUserText(p).slice(0, 200)}`);
  return { content: String(block['content']), isError: block['is_error'] === true };
}

/** 도구 이름마다 '<태그>:<받은 글>' 을 돌려주는 모듈 파일 */
function moduleFiles(id: string, version: string, tag: string, tools: string[]) {
  const manifest = {
    id,
    name: `모듈 ${id}`,
    version,
    description: '받은 글에 표시를 붙여 돌려줍니다',
    kind: 'module',
    entry: 'index.js',
    license: 'MIT',
    permissions: { net: [], fsWrite: false, childProcess: false },
    tools: tools.map((name) => ({ name, description: `${name} 하기`, input_schema: { type: 'object', properties: { text: { type: 'string' } } } })),
  };
  const handlers = tools.map((name) => `    async ${name}(input) {\n      return '${tag}:' + String(input.text ?? '');\n    },`).join('\n');
  return [
    { path: 'module.json', content: JSON.stringify(manifest, null, 2) },
    { path: 'index.js', content: `export default {\n  async activate() {},\n  tools: {\n${handlers}\n  },\n};\n` },
  ];
}

async function create(a: AgentRow, files: ReturnType<typeof moduleFiles>, onApproval?: (approvalId: string) => Promise<void>): Promise<{ content: string; isError: boolean }> {
  h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: '끝' } : { tool: { name: 'module_create', input: { files } } }));
  const t = h.app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '만들어', reply: null });
  if (onApproval) await onApproval((await until(() => pendingOf(t.id)[0], '승인 요청', 20_000)).id);
  await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝', 20_000);
  return toolResultOf(calls(a).at(-1)!);
}

const call = (id: string, tool: string, text: string) => h.app.registry.callTool(id, tool, { text }, { agentId: null, agentName: '시험', taskId: null });

describe('모듈 만들기 · 수정', () => {
  it('권한 이름이 수정까지 담습니다', () => {
    expect(BASE_PERMISSIONS.find((d) => d.key === 'module.create')?.label).toBe('모듈 만들기 · 수정');
  });

  it('자신이 만든 모듈을 버전을 올려 다시 부르면 새 코드 · 새 도구로 바뀌고, 연결과 기록이 남습니다', async () => {
    const a = maker('고침이');
    expect((await create(a, moduleFiles('upd-one', '1.0.0', 'v1', ['upd_one_echo']))).content).toMatch(/설치하고 연결했습니다/);
    expect(await call('upd-one', 'upd_one_echo', '안녕')).toBe('v1:안녕');

    const out = await create(a, moduleFiles('upd-one', '1.1.0', 'v2', ['upd_one_echo', 'upd_one_shout']));
    expect(out).toEqual({ isError: false, content: "모듈 '모듈 upd-one'(upd-one) v1.0.0 → v1.1.0 로 고쳤습니다." });
    const row = h.app.store.getModule('upd-one');
    expect(row).toMatchObject({ origin: 'agent', createdBy: a.id, enabled: true });
    expect(row.manifest.version).toBe('1.1.0');
    expect(row.manifest.tools.map((t) => t.name)).toEqual(['upd_one_echo', 'upd_one_shout']);
    expect(fs.readFileSync(path.join(row.dir, 'index.js'), 'utf8')).toContain("'v2:'");
    // 돌던 프로세스가 새 코드로 다시 뜹니다.
    expect(await call('upd-one', 'upd_one_echo', '안녕')).toBe('v2:안녕');
    expect(await call('upd-one', 'upd_one_shout', '야')).toBe('v2:야');
    expect(h.app.store.listAgentModules(a.id).map((l) => l.moduleId)).toEqual(['upd-one']);
    expect(h.app.store.listActivity(20).find((x) => x.type === 'module.updated' && x.moduleId === 'upd-one')?.text).toBe('고침이가 고침 · v1.0.0 → v1.1.0');
  });

  it('버전을 올리지 않았으면 고치지 않고 올릴 버전을 알려 줍니다', async () => {
    const a = maker('버전이');
    await create(a, moduleFiles('upd-ver', '1.2.3', 'v1', ['upd_ver_echo']));
    for (const v of ['1.2.3', '1.2.2', '1.2.3-beta']) {
      const out = await create(a, moduleFiles('upd-ver', v, 'v2', ['upd_ver_echo']));
      expect(out).toEqual({ isError: true, content: `고친 판은 버전을 올려야 합니다. 지금 v1.2.3, 받은 v${v} 입니다. module.json 의 version 을 1.2.4 처럼 올려 다시 부르세요.` });
    }
    expect(h.app.store.getModule('upd-ver').manifest.version).toBe('1.2.3');
    // 끝자리 말고 앞자리를 올려도 됩니다.
    expect((await create(a, moduleFiles('upd-ver', '2.0.0', 'v2', ['upd_ver_echo']))).content).toContain('v1.2.3 → v2.0.0 로 고쳤습니다.');
  });

  it("'모듈 설치'가 확인이면 승인 뒤에 바뀌고 (그 전에는 지금 판), 거부하면 지금 판이 그대로 남습니다", async () => {
    const a = maker('승인이', ASK);
    await create(a, moduleFiles('upd-ask', '1.0.0', 'v1', ['upd_ask_echo']), (id) => h.app.approvals.decide(id, 'once').then(() => undefined));
    expect(h.app.store.getModule('upd-ask').manifest.version).toBe('1.0.0');

    const approved = await create(a, moduleFiles('upd-ask', '1.0.1', 'v2', ['upd_ask_echo']), async (id) => {
      const approval = h.app.store.getApproval(id);
      expect(approval).toMatchObject({ kind: 'module.update', title: '모듈 수정 · 모듈 upd-ask v1.0.0 → v1.0.1' });
      expect(approval.detail).toMatchObject({ permission: 'module.install', target: 'upd-ask', always: false, input: '권한 없음 · env 없음 · 도구 upd_ask_echo' });
      // 승인 전에는 지금 판이 그대로 돕니다.
      expect(h.app.store.getModule('upd-ask').manifest.version).toBe('1.0.0');
      expect(await call('upd-ask', 'upd_ask_echo', 'x')).toBe('v1:x');
      await expect(h.app.approvals.decide(id, 'always')).rejects.toThrow("'항상 허용'을 받지 않습니다");
      await h.app.approvals.decide(id, 'once');
    });
    expect(approved.content).toBe("모듈 '모듈 upd-ask'(upd-ask) v1.0.0 → v1.0.1 로 고쳤습니다.");
    expect(await call('upd-ask', 'upd_ask_echo', 'x')).toBe('v2:x');

    const denied = await create(a, moduleFiles('upd-ask', '1.0.2', 'v3', ['upd_ask_echo']), (id) => h.app.approvals.decide(id, 'deny').then(() => undefined));
    expect(denied.content).toBe("사용자가 모듈 '모듈 upd-ask'(upd-ask) v1.0.1 → v1.0.2 수정을 거부했습니다. 고친 파일은 지웠고 지금 판이 그대로 돕니다.");
    expect(h.app.store.getModule('upd-ask').manifest.version).toBe('1.0.1');
    expect(await call('upd-ask', 'upd_ask_echo', 'x')).toBe('v2:x');
  });

  it('다른 에이전트가 만든 모듈과 사용자가 설치한 모듈(기본 제공)은 고칠 수 없습니다', async () => {
    const owner = maker('주인이');
    await create(owner, moduleFiles('upd-own', '1.0.0', 'v1', ['upd_own_echo']));
    const other = maker('남이');
    expect(await create(other, moduleFiles('upd-own', '1.0.1', 'evil', ['upd_own_echo']))).toEqual({
      isError: true,
      content: "id 'upd-own' 모듈(모듈 upd-own v1.0.0)이 이미 있습니다. 다른 에이전트가 만든 모듈이라 고칠 수 없습니다. 다른 id 를 쓰거나, 사용자에게 기존 모듈을 모듈 화면에서 지워 달라고 요청하세요.",
    });
    expect(await call('upd-own', 'upd_own_echo', 'x')).toBe('v1:x');

    const builtin = h.app.store.getModule('tavily-search');
    expect(await create(other, moduleFiles('tavily-search', '9.0.0', 'evil', ['upd_tavily_echo']))).toEqual({
      isError: true,
      content: `id 'tavily-search' 모듈(Tavily 검색 v${builtin.manifest.version})이 이미 있습니다. 다른 id 를 쓰거나, 사용자에게 기존 모듈을 모듈 화면에서 지워 달라고 요청하세요.`,
    });
    expect(h.app.store.getModule('tavily-search').manifest.version).toBe(builtin.manifest.version);

    // 만든 에이전트가 적혀 있어도 에이전트가 만든 모듈(origin agent)이 아니면 고치지 않습니다.
    const zipped = h.app.store.getModule('upd-own');
    h.app.store.upsertModule({ ...zipped, id: 'upd-zip', origin: 'zip', createdBy: other.id, manifest: { ...zipped.manifest, id: 'upd-zip', name: '받은 모듈', tools: [] } });
    expect(await create(other, moduleFiles('upd-zip', '1.0.1', 'evil', ['upd_zip_echo']))).toEqual({
      isError: true,
      content: "id 'upd-zip' 모듈(받은 모듈 v1.0.0)이 이미 있습니다. 다른 id 를 쓰거나, 사용자에게 기존 모듈을 모듈 화면에서 지워 달라고 요청하세요.",
    });
  });

  it('설치 승인을 기다리는 모듈은 고치지 않고, 꺼 둔 모듈은 고쳐도 꺼진 채로 둡니다', async () => {
    const a = maker('대기이');
    await create(a, moduleFiles('upd-wait', '1.0.0', 'v1', ['upd_wait_echo']));
    const row = h.app.store.getModule('upd-wait');
    h.app.store.upsertModule({ ...row, status: 'pending', statusDetail: '설치 승인 대기' });
    expect(await create(a, moduleFiles('upd-wait', '1.0.1', 'v2', ['upd_wait_echo']))).toEqual({ isError: true, content: "'모듈 upd-wait'은(는) 설치 승인을 기다리는 중이라 고칠 수 없습니다. 승인되거나 거부된 뒤 다시 하세요." });

    const b = maker('꺼둠이');
    await create(b, moduleFiles('upd-off', '1.0.0', 'v1', ['upd_off_echo']));
    await h.app.registry.setEnabled('upd-off', false);
    h.app.store.disconnectModule(b.id, 'upd-off');
    const out = await create(b, moduleFiles('upd-off', '1.0.1', 'v2', ['upd_off_echo']));
    expect(out.content).toBe("모듈 '모듈 upd-off'(upd-off) v1.0.0 → v1.0.1 로 고쳤습니다. 모듈이 꺼져 있어 사용자가 모듈 화면에서 켜야 쓸 수 있습니다. 이 에이전트에는 연결되어 있지 않습니다 (쓰려면 module_connect 로 연결을 요청하세요).");
    expect(h.app.store.getModule('upd-off')).toMatchObject({ enabled: false });
    expect(h.app.store.listAgentModules(b.id)).toEqual([]);
  });

  it('고친 판의 도구 이름이 다른 모듈과 겹치면 점검에서 막고 지금 판을 둡니다', async () => {
    const a = maker('겹침이');
    await create(a, moduleFiles('upd-clash', '1.0.0', 'v1', ['upd_clash_echo']));
    const out = await create(a, moduleFiles('upd-clash', '1.0.1', 'v2', ['upd_clash_echo', 'tavily_search']));
    expect(out.isError).toBe(true);
    expect(out.content).toContain("도구 이름: 도구 'tavily_search'은(는) 이미 모듈 'tavily-search'이(가) 쓰고 있습니다.");
    expect(h.app.store.getModule('upd-clash').manifest.version).toBe('1.0.0');
  });
});
