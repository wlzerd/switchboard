import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRow, ModuleRow } from '../src/db/store.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import type { PermissionRule } from '../src/permissions/policy.ts';
import { lastUserText, startHarness, systemText, until, type Harness, type Params } from './helpers/harness.ts';

// 에이전트의 모듈 연결 요청 (module_connect): 설치된 모듈을 자신에게 연결해 달라고 요청하고, 사용자가 승인하면 연결됩니다.

let h: Harness;
const ASK: PermissionRule = { mode: 'ask', scope: [], always: [] };
const DENY: PermissionRule = { mode: 'deny', scope: [], always: [] };

function addModule(id: string, over: Record<string, unknown> = {}, row: Partial<ModuleRow> = {}): void {
  const manifest = parseManifest({ id, name: id, version: '1.0.0', license: 'MIT', description: `${id} 설명`, ...over }, 'test');
  h.app.store.upsertModule({ id, kind: 'module', origin: 'builtin', dir: h.root, manifest, enabled: true, status: 'idle', statusDetail: null, createdBy: null, report: null, ...row });
}
const tool = (name: string) => ({ name, description: `${name} 하기`, input_schema: { type: 'object' } });

beforeAll(async () => {
  h = await startHarness();
  addModule('fake-tool', { name: '가짜 도구', description: '웹에서 무언가를 찾아 줍니다', tools: [tool('fake_find')] });
  addModule('fake-chan', { name: '가짜 채널', channel: { label: '가짜' } }, { status: 'stopped' });
  addModule('fake-screen', { name: '가짜 화면', computer: { label: '화면' }, tools: [tool('screen_peek')] });
  addModule('fake-wait', { name: '대기 모듈', tools: [tool('wait_tool')] }, { status: 'pending' });
  addModule('fake-off', { name: '꺼진 모듈', tools: [tool('off_tool')] }, { enabled: false });
});
afterAll(async () => {
  await h.close();
});

const toolsOf = (p: Params): string[] => p.tools.map((t) => t.name ?? '');
function toolResultOf(p: Params): { content: string; isError: boolean } {
  const last = [...p.messages].reverse().find((m) => m.role === 'user');
  const block = Array.isArray(last?.content) ? (last.content as Record<string, unknown>[]).find((b) => b['type'] === 'tool_result') : undefined;
  if (!block) throw new Error(`도구 결과가 없습니다: ${lastUserText(p).slice(0, 200)}`);
  return { content: String(block['content']), isError: block['is_error'] === true };
}
const ask = (a: AgentRow, text: string) => h.app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text, reply: null });

/** 한 번 도구를 부르고 그 결과를 받은 다음 끝내는 각본 */
function scriptOnce(a: AgentRow, input: Record<string, unknown>): void {
  h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: '끝' } : { tool: { name: 'module_connect', input } }));
}
const calls = (a: AgentRow) => h.calls.get(a.keyId) ?? [];

describe('모듈 연결 요청 (module_connect)', () => {
  it('프롬프트에 연결을 요청할 수 있는 모듈만 보이고 (화면 제어 · 승인 대기 · 꺼진 모듈 · 이미 연결한 모듈은 빼고) 도구가 열립니다', async () => {
    const a = h.addAgent('목록이');
    h.app.store.connectModule(a.id, 'fake-chan', { trigger: 'none' });
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    const t = ask(a, '안녕');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    const p = calls(a)[0]!;
    const sys = systemText(p);
    expect(toolsOf(p)).toContain('module_connect');
    expect(sys).toContain('## 연결을 요청할 수 있는 모듈');
    expect(sys).toContain('- 가짜 도구 (id: fake-tool): 웹에서 무언가를 찾아 줍니다 · 도구 fake_find');
    for (const hidden of ['fake-screen', 'fake-wait', 'fake-off', 'fake-chan']) expect(sys).not.toContain(`(id: ${hidden})`);
    expect(sys).toContain('module_connect 로 연결을 요청한다. 사용자가 승인하면 연결되고 그 도구를 바로 쓸 수 있다.');
  });

  it('승인을 받으면 연결되고, 같은 작업의 다음 단계부터 그 모듈의 도구를 씁니다', async () => {
    const a = h.addAgent('요청이');
    scriptOnce(a, { module: 'fake-tool', reason: '웹에서 자료를 찾아야 합니다' });
    const t = ask(a, '자료 찾아 줘');
    const approval = await until(() => h.app.store.listApprovals('pending').find((x) => x.taskId === t.id), '승인 요청');
    expect(approval.title).toBe('모듈 연결 · 가짜 도구 연결 · 웹에서 자료를 찾아야 합니다');
    expect(h.app.store.listAgentModules(a.id)).toEqual([]);
    await h.app.approvals.decide(approval.id, 'once');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');

    expect(h.app.store.listAgentModules(a.id).map((l) => [l.moduleId, l.config])).toEqual([['fake-tool', {}]]);
    const [first, second] = calls(a);
    expect(toolsOf(first!)).not.toContain('fake_find');
    expect(toolResultOf(second!)).toEqual({ isError: false, content: "'가짜 도구'을(를) 연결했습니다. 이제 fake_find 도구를 쓸 수 있습니다." });
    expect(toolsOf(second!)).toContain('fake_find');
    expect(h.app.store.listActivity(10).find((x) => x.type === 'module.connected' && x.agentId === a.id)?.text).toBe('가짜 도구 연결 (에이전트 요청 · 웹에서 자료를 찾아야 합니다)');
    // 연결한 모듈은 후보 목록에서 빠집니다.
    expect(systemText(second!)).not.toContain('(id: fake-tool)');
  });

  it('채널 모듈은 메시지를 받지 않는 도구만으로 연결합니다', async () => {
    const a = h.addAgent('채널이', { permissions: { 'module.connect': { mode: 'allow', scope: [], always: [] } } });
    scriptOnce(a, { module: 'fake-chan', reason: '보고를 보내려고' });
    const t = ask(a, '보고 채널 연결해');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(h.app.store.listAgentModules(a.id).map((l) => [l.moduleId, l.config])).toEqual([['fake-chan', { targets: [], trigger: 'none' }]]);
    expect(toolResultOf(calls(a)[1]!).content).toBe(
      "'가짜 채널'을(를) 연결했습니다. 이제 send_message 로 가짜 채널 에 보내기를 쓸 수 있습니다. 채널 메시지는 받지 않고 도구만 쓰도록 연결했습니다 (받기는 사용자가 에이전트 설정에서 바꿉니다).",
    );
  });

  it('모듈마다 항상 허용해 두면 묻지 않고 연결하고, 차단이면 도구와 목록을 주지 않습니다', async () => {
    const always = h.addAgent('항상이', { permissions: { 'module.connect': { mode: 'ask', scope: [], always: ['=fake-tool'] } } });
    scriptOnce(always, { module: 'fake-tool', reason: '검색' });
    const t = ask(always, '찾아 줘');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(h.app.store.listApprovals('pending').filter((x) => x.taskId === t.id)).toEqual([]);
    expect(h.app.store.listAgentModules(always.id).map((l) => l.moduleId)).toEqual(['fake-tool']);

    const denied = h.addAgent('차단이', { permissions: { 'module.connect': DENY } });
    h.scripts.set(denied.keyId, () => ({ text: '네' }));
    const t2 = ask(denied, '안녕');
    await until(() => h.app.store.getTask(t2.id).status === 'done', '작업 끝');
    expect(toolsOf(calls(denied)[0]!)).not.toContain('module_connect');
    expect(systemText(calls(denied)[0]!)).not.toContain('## 연결을 요청할 수 있는 모듈');
  });

  it('없는 모듈이면 연결을 요청할 수 있는 모듈을 알려 줍니다', async () => {
    const a = h.addAgent('없음이', { permissions: { 'module.connect': ASK } });
    scriptOnce(a, { module: 'nope', reason: 'x' });
    const t = ask(a, '연결해');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    const out = toolResultOf(calls(a)[1]!);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/^'nope' 모듈이 없습니다\. 연결을 요청할 수 있는 모듈: /);
    const listed = out.content.split(': ')[1]!.split(', ');
    expect(listed).toEqual(expect.arrayContaining(['fake-tool', 'fake-chan']));
    for (const hidden of ['fake-screen', 'fake-wait', 'fake-off']) expect(listed).not.toContain(hidden);
  });

  it.each([
    [{ module: 'fake-screen', reason: 'x' }, "'가짜 화면'은(는) 화면 제어 모듈이라 사용자가 에이전트 설정에서만 연결합니다."],
    [{ module: 'fake-wait', reason: 'x' }, "'대기 모듈'은(는) 설치 승인을 기다리는 중이라 연결할 수 없습니다."],
  ])('연결할 수 없는 모듈 %j 은 승인을 묻기 전에 이유를 알립니다', async (input, message) => {
    const a = h.addAgent(`불가${input.module}`, { permissions: { 'module.connect': ASK } });
    scriptOnce(a, input);
    const t = ask(a, '연결해');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(h.app.store.listApprovals('pending').filter((x) => x.taskId === t.id)).toEqual([]);
    expect(toolResultOf(calls(a)[1]!)).toEqual({ isError: true, content: message });
    expect(h.app.store.listAgentModules(a.id)).toEqual([]);
  });

  it('이미 연결된 모듈은 묻지 않고 그렇다고 알리며, 꺼진 모듈은 연결하되 켜야 쓸 수 있다고 알립니다', async () => {
    const a = h.addAgent('중복이', { permissions: { 'module.connect': ASK } });
    h.app.store.connectModule(a.id, 'fake-tool', {});
    scriptOnce(a, { module: 'FAKE-TOOL', reason: '다시' });
    const t = ask(a, '연결해');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(h.app.store.listApprovals('pending').filter((x) => x.taskId === t.id)).toEqual([]);
    expect(toolResultOf(calls(a)[1]!)).toEqual({ isError: false, content: "'가짜 도구'은(는) 이미 연결되어 있습니다." });

    const b = h.addAgent('꺼짐이', { permissions: { 'module.connect': { mode: 'allow', scope: [], always: [] } } });
    scriptOnce(b, { module: 'fake-off', reason: '필요' });
    const t2 = ask(b, '연결해');
    await until(() => h.app.store.getTask(t2.id).status === 'done', '작업 끝');
    expect(toolResultOf(calls(b)[1]!).content).toBe("'꺼진 모듈'을(를) 연결했습니다. 이제 off_tool 도구를 쓸 수 있습니다. 다만 모듈이 꺼져 있어 사용자가 모듈 화면에서 켜야 쓸 수 있습니다.");
  });

  it('연결을 요청할 모듈이 하나도 없으면 도구를 주지 않습니다', async () => {
    const a = h.addAgent('다있음');
    for (const id of ['fake-tool', 'fake-chan']) h.app.store.connectModule(a.id, id, {});
    // 하네스가 올린 기본 모듈 중 켜져 있고 쓸 것이 있는 모듈도 모두 연결합니다.
    for (const m of h.app.store.listModules()) if (m.enabled && !m.manifest.computer && m.status !== 'pending') h.app.store.connectModule(a.id, m.id, {});
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    const t = ask(a, '안녕');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(toolsOf(calls(a)[0]!)).not.toContain('module_connect');
  });
});
