import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRow, ModuleOrigin, ModuleRow } from '../src/db/store.ts';
import { CONNECT_MODE_SETTING, connectApproval, parseConnectMode, readConnectMode, type ConnectMode } from '../src/modules/connect-mode.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import type { PermissionRule } from '../src/permissions/policy.ts';
import { lastUserText, startHarness, systemText, until, type Harness, type Params } from './helpers/harness.ts';

// 에이전트의 모듈 연결 요청 (module_connect): 설치된 모듈을 자신에게 연결해 달라고 요청합니다.
// 승인이 필요한지는 설정의 모듈 연결 방식(수동 · 반자동 · 자동)이 정하고, 에이전트의 '모듈 연결' 권한이 차단이면 요청할 수 없습니다.

let h: Harness;
const ASK: PermissionRule = { mode: 'ask', scope: [], always: [] };
const DENY: PermissionRule = { mode: 'deny', scope: [], always: [] };
const ALLOW: PermissionRule = { mode: 'allow', scope: [], always: [] };

function addModule(id: string, over: Record<string, unknown> = {}, row: Partial<ModuleRow> = {}): void {
  const manifest = parseManifest({ id, name: id, version: '1.0.0', license: 'MIT', description: `${id} 설명`, ...over }, 'test');
  h.app.store.upsertModule({ id, kind: 'module', origin: 'builtin', dir: h.root, manifest, enabled: true, status: 'idle', statusDetail: null, createdBy: null, report: null, ...row });
}
const tool = (name: string) => ({ name, description: `${name} 하기`, input_schema: { type: 'object' } });
const setMode = (mode: ConnectMode) => h.app.store.setSetting(CONNECT_MODE_SETTING, mode);

beforeAll(async () => {
  h = await startHarness();
  addModule('fake-tool', { name: '가짜 도구', description: '웹에서 무언가를 찾아 줍니다', tools: [tool('fake_find')] });
  addModule('fake-chan', { name: '가짜 채널', channel: { label: '가짜' } }, { status: 'stopped' });
  addModule('fake-screen', { name: '가짜 화면', computer: { label: '화면' }, tools: [tool('screen_peek')] });
  addModule('fake-wait', { name: '대기 모듈', tools: [tool('wait_tool')] }, { status: 'pending' });
  addModule('fake-off', { name: '꺼진 모듈', tools: [tool('off_tool')] }, { enabled: false });
  addModule('fake-made', { name: '만든 모듈', tools: [tool('made_find')] }, { origin: 'agent' });
  addModule('fake-git', { name: '받은 모듈', tools: [tool('git_find')] }, { origin: 'git' });
});
afterAll(async () => {
  await h.close();
});
// 테스트마다 기본 방식(반자동)에서 시작합니다.
beforeEach(() => {
  h.app.store.deleteSetting(CONNECT_MODE_SETTING);
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
function scriptOnce(a: AgentRow, input: Record<string, unknown>, name = 'module_connect'): void {
  h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: '끝' } : { tool: { name, input } }));
}
const calls = (a: AgentRow) => h.calls.get(a.keyId) ?? [];
const linkedIds = (a: AgentRow) => h.app.store.listAgentModules(a.id).map((l) => l.moduleId);
const pendingOf = (taskId: string) => h.app.store.listApprovals('pending').filter((x) => x.taskId === taskId);

describe('모듈 연결 방식', () => {
  it('세 가지 중 하나만 받고, 저장된 값이 없거나 알 수 없으면 반자동', () => {
    expect(['manual', 'semi', 'auto'].map(parseConnectMode)).toEqual(['manual', 'semi', 'auto']);
    expect(() => parseConnectMode('always')).toThrow('모듈 연결 방식은 manual(수동) · semi(반자동) · auto(자동) 중 하나여야 합니다. 받은 값: "always"');
    expect(() => parseConnectMode(undefined)).toThrow('받은 값: undefined');
    expect(readConnectMode({ getSetting: () => null })).toBe('semi');
    expect(readConnectMode({ getSetting: () => 'weird' as never })).toBe('semi');
    expect(readConnectMode({ getSetting: () => 'auto' as never })).toBe('auto');
  });

  it.each<[ConnectMode, ModuleOrigin, string | null]>([
    ['auto', 'git', null],
    ['auto', 'builtin', null],
    ['semi', 'agent', null],
    ['semi', 'git', "모듈 연결 방식이 '반자동'이라 에이전트가 만들지 않은 모듈(Git 설치)은 승인이 필요합니다."],
    ['semi', 'zip', "모듈 연결 방식이 '반자동'이라 에이전트가 만들지 않은 모듈(zip 설치)은 승인이 필요합니다."],
    ['semi', 'builtin', "모듈 연결 방식이 '반자동'이라 에이전트가 만들지 않은 모듈(기본 제공)은 승인이 필요합니다."],
    ['semi', 'template', "모듈 연결 방식이 '반자동'이라 에이전트가 만들지 않은 모듈(템플릿)은 승인이 필요합니다."],
    ['manual', 'agent', "모듈 연결 방식이 '수동'이라 연결할 때마다 승인이 필요합니다."],
    ['manual', 'builtin', "모듈 연결 방식이 '수동'이라 연결할 때마다 승인이 필요합니다."],
  ])('%s · %s → %j', (mode, origin, want) => {
    expect(connectApproval(mode, origin)).toBe(want);
  });
});

describe('모듈 연결 요청 (module_connect)', () => {
  it('프롬프트에 연결을 요청할 수 있는 모듈만 보이고 (화면 제어 · 승인 대기 · 꺼진 모듈 · 이미 연결한 모듈은 빼고), 반자동이면 바로 연결되는 모듈에 표시가 붙습니다', async () => {
    const a = h.addAgent('목록이');
    h.app.store.connectModule(a.id, 'fake-chan', { trigger: 'none' });
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    const t = ask(a, '안녕');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    const p = calls(a)[0]!;
    const sys = systemText(p);
    expect(toolsOf(p)).toContain('module_connect');
    expect(sys).toContain('## 연결을 요청할 수 있는 모듈');
    expect(sys).toContain('- 가짜 도구 (id: fake-tool): 웹에서 무언가를 찾아 줍니다 · 도구 fake_find\n');
    expect(sys).toContain('- 만든 모듈 (id: fake-made): fake-made 설명 · 도구 made_find · 바로 연결\n');
    expect(sys).toContain('- 받은 모듈 (id: fake-git): fake-git 설명 · 도구 git_find\n');
    for (const hidden of ['fake-screen', 'fake-wait', 'fake-off', 'fake-chan']) expect(sys).not.toContain(`(id: ${hidden})`);
    expect(sys).toContain("module_connect 로 연결을 요청한다. '바로 연결'이라 적힌 모듈은 승인 없이, 나머지는 사용자가 승인하면 연결되고 그 도구를 바로 쓸 수 있다.");
    expect(sys).toContain('- 모듈 연결: 에이전트가 만든 모듈은 바로, 나머지는 사용자 승인 (모듈 연결 방식: 반자동)');
  });

  it.each<[ConnectMode, string, string]>([
    ['manual', '- 모듈 연결: 연결할 때마다 사용자 승인 (모듈 연결 방식: 수동)', 'module_connect 로 연결을 요청한다. 사용자가 승인하면 연결되고 그 도구를 바로 쓸 수 있다.'],
    ['auto', '- 모듈 연결: 승인 없이 바로 연결 (모듈 연결 방식: 자동)', 'module_connect 로 연결한다. 승인 없이 바로 연결되고 그 도구를 바로 쓸 수 있다.'],
  ])('%s 방식은 프롬프트의 권한 줄과 안내가 그 방식대로이고 바로 연결 표시는 붙지 않습니다', async (mode, permLine, howLine) => {
    setMode(mode);
    const a = h.addAgent(`방식${mode}`);
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    const t = ask(a, '안녕');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    const sys = systemText(calls(a)[0]!);
    expect(sys).toContain(permLine);
    expect(sys).toContain(howLine);
    expect(sys).not.toContain('바로 연결\n');
  });

  it('승인이 필요하면 묻고(이유는 연결 방식, 항상 허용은 받지 않음), 허용하면 연결되어 같은 작업의 다음 단계부터 그 도구를 씁니다', async () => {
    const a = h.addAgent('요청이');
    scriptOnce(a, { module: 'fake-tool', reason: '웹에서 자료를 찾아야 합니다' });
    const t = ask(a, '자료 찾아 줘');
    const approval = await until(() => pendingOf(t.id)[0], '승인 요청');
    expect(approval.title).toBe('모듈 연결 · 가짜 도구 연결 · 웹에서 자료를 찾아야 합니다');
    expect(approval.detail).toMatchObject({ permission: 'module.connect', target: 'fake-tool', always: false, rule: "모듈 연결 방식이 '반자동'이라 에이전트가 만들지 않은 모듈(기본 제공)은 승인이 필요합니다." });
    const card = h.app.store.findTimelineByApproval(approval.id)!;
    expect(card.data).toMatchObject({ perm: 'module.connect', always: false });
    await expect(h.app.approvals.decide(approval.id, 'always')).rejects.toThrow("이 승인 요청은 '항상 허용'을 받지 않습니다. 이번만 허용하거나 거부하세요");
    expect(linkedIds(a)).toEqual([]);
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

  it('자동이면 묻지 않고 연결하며, 채널 모듈은 메시지를 받지 않는 도구만으로 연결합니다', async () => {
    setMode('auto');
    const a = h.addAgent('채널이', { permissions: { 'module.connect': ASK } });
    scriptOnce(a, { module: 'fake-chan', reason: '보고를 보내려고' });
    const t = ask(a, '보고 채널 연결해');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(pendingOf(t.id)).toEqual([]);
    expect(h.app.store.listAgentModules(a.id).map((l) => [l.moduleId, l.config])).toEqual([['fake-chan', { targets: [], trigger: 'none' }]]);
    expect(toolResultOf(calls(a)[1]!).content).toBe(
      "'가짜 채널'을(를) 연결했습니다. 이제 send_message 로 가짜 채널 에 보내기를 쓸 수 있습니다. 채널 메시지는 받지 않고 도구만 쓰도록 연결했습니다 (받기는 사용자가 에이전트 설정에서 바꿉니다).",
    );
  });

  it('자동이어도 규칙 훅(category module.connect)으로 고른 연결은 묻고, 훅에 맞지 않는 연결은 묻지 않습니다', async () => {
    setMode('auto');
    h.app.store.saveHook({
      id: 'hook_conn_git',
      name: 'Git 모듈 연결 확인',
      event: 'before_tool',
      enabled: true,
      action: 'ask',
      conditions: [
        { field: 'category', op: 'eq', value: 'module.connect' },
        { field: 'input.module', op: 'eq', value: 'fake-git' },
      ],
      reason: 'Git 으로 받은 모듈 연결은 확인합니다',
      modify: null,
    });
    try {
      const a = h.addAgent('훅이', { permissions: { 'module.connect': ASK } });
      scriptOnce(a, { module: 'fake-git', reason: '필요' });
      const t = ask(a, '연결해');
      const approval = await until(() => pendingOf(t.id)[0], '승인 요청');
      expect(approval.detail).toMatchObject({ permission: 'module.connect', target: 'fake-git', rule: 'Git 으로 받은 모듈 연결은 확인합니다', always: false });
      await h.app.approvals.decide(approval.id, 'once');
      await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
      expect(linkedIds(a)).toEqual(['fake-git']);

      const b = h.addAgent('훅밖이', { permissions: { 'module.connect': ASK } });
      scriptOnce(b, { module: 'fake-tool', reason: '필요' });
      const t2 = ask(b, '연결해');
      await until(() => h.app.store.getTask(t2.id).status === 'done', '작업 끝');
      expect(pendingOf(t2.id)).toEqual([]);
      expect(linkedIds(b)).toEqual(['fake-tool']);
    } finally {
      h.app.store.deleteHook('hook_conn_git');
    }
  });

  it('수동이면 권한이 허용이거나 항상 허용 목록에 있어도 묻고, 항상 허용 목록은 바뀌지 않습니다', async () => {
    setMode('manual');
    const a = h.addAgent('항상이', { permissions: { 'module.connect': { mode: 'allow', scope: [], always: ['=fake-tool'] } } });
    scriptOnce(a, { module: 'fake-tool', reason: '검색' });
    const t = ask(a, '찾아 줘');
    const approval = await until(() => pendingOf(t.id)[0], '승인 요청');
    expect(approval.detail).toMatchObject({ always: false, rule: "모듈 연결 방식이 '수동'이라 연결할 때마다 승인이 필요합니다." });
    await h.app.approvals.decide(approval.id, 'once');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(linkedIds(a)).toEqual(['fake-tool']);
    expect(h.app.store.getAgent(a.id).permissions['module.connect']!.always).toEqual(['=fake-tool']);
  });

  it('권한이 차단이면 자동이어도 도구와 목록을 주지 않습니다', async () => {
    setMode('auto');
    const denied = h.addAgent('차단이', { permissions: { 'module.connect': DENY } });
    h.scripts.set(denied.keyId, () => ({ text: '네' }));
    const t = ask(denied, '안녕');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(toolsOf(calls(denied)[0]!)).not.toContain('module_connect');
    expect(systemText(calls(denied)[0]!)).not.toContain('## 연결을 요청할 수 있는 모듈');
    expect(systemText(calls(denied)[0]!)).toContain('- 모듈 연결: 차단');

    // 목록에 없는 도구를 그래도 부르면 권한 검사가 막습니다 (자동이어도 연결하지 않음).
    scriptOnce(denied, { module: 'fake-tool', reason: '몰래' });
    const t2 = ask(denied, '연결해');
    await until(() => h.app.store.getTask(t2.id).status === 'done', '작업 끝');
    const out = toolResultOf(calls(denied).at(-1)!);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("실행하지 않았습니다. '모듈 연결' 권한이 차단으로 설정되어 있습니다.");
    expect(pendingOf(t2.id)).toEqual([]);
    expect(linkedIds(denied)).toEqual([]);
  });

  it.each<[ConnectMode, string, string | null]>([
    ['semi', 'fake-made', null],
    ['semi', 'fake-git', "모듈 연결 방식이 '반자동'이라 에이전트가 만들지 않은 모듈(Git 설치)은 승인이 필요합니다."],
    ['manual', 'fake-made', "모듈 연결 방식이 '수동'이라 연결할 때마다 승인이 필요합니다."],
    ['auto', 'fake-git', null],
  ])('%s 방식에서 %s 연결 → 승인 이유 %j', async (mode, moduleId, reason) => {
    setMode(mode);
    const a = h.addAgent(`조합${mode}${moduleId}`, { permissions: { 'module.connect': ALLOW } });
    scriptOnce(a, { module: moduleId, reason: '필요' });
    const t = ask(a, '연결해');
    if (reason === null) {
      await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
      expect(pendingOf(t.id)).toEqual([]);
      expect(linkedIds(a)).toEqual([moduleId]);
      return;
    }
    const approval = await until(() => pendingOf(t.id)[0], '승인 요청');
    expect(approval.detail.rule).toBe(reason);
    await h.app.approvals.decide(approval.id, 'deny');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(linkedIds(a)).toEqual([]);
    expect(toolResultOf(calls(a)[1]!)).toEqual({ isError: true, content: '실행하지 않았습니다. 사용자가 이 작업을 거부했습니다.' });
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
    expect(pendingOf(t.id)).toEqual([]);
    expect(toolResultOf(calls(a)[1]!)).toEqual({ isError: true, content: message });
    expect(h.app.store.listAgentModules(a.id)).toEqual([]);
  });

  it('이미 연결된 모듈은 묻지 않고 그렇다고 알리며, 꺼진 모듈은 연결하되 켜야 쓸 수 있다고 알립니다', async () => {
    const a = h.addAgent('중복이', { permissions: { 'module.connect': ASK } });
    h.app.store.connectModule(a.id, 'fake-tool', {});
    scriptOnce(a, { module: 'FAKE-TOOL', reason: '다시' });
    const t = ask(a, '연결해');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(pendingOf(t.id)).toEqual([]);
    expect(toolResultOf(calls(a)[1]!)).toEqual({ isError: false, content: "'가짜 도구'은(는) 이미 연결되어 있습니다." });

    setMode('auto');
    const b = h.addAgent('꺼짐이', { permissions: { 'module.connect': ASK } });
    scriptOnce(b, { module: 'fake-off', reason: '필요' });
    const t2 = ask(b, '연결해');
    await until(() => h.app.store.getTask(t2.id).status === 'done', '작업 끝');
    expect(toolResultOf(calls(b)[1]!).content).toBe("'꺼진 모듈'을(를) 연결했습니다. 이제 off_tool 도구를 쓸 수 있습니다. 다만 모듈이 꺼져 있어 사용자가 모듈 화면에서 켜야 쓸 수 있습니다.");
  });

  it('연결을 요청할 모듈이 하나도 없으면 도구를 주지 않습니다', async () => {
    const a = h.addAgent('다있음');
    // 하네스가 올린 기본 모듈 중 켜져 있고 쓸 것이 있는 모듈도 모두 연결합니다.
    for (const m of h.app.store.listModules()) if (m.enabled && !m.manifest.computer && m.status !== 'pending') h.app.store.connectModule(a.id, m.id, {});
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    const t = ask(a, '안녕');
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    expect(toolsOf(calls(a)[0]!)).not.toContain('module_connect');
  });
});

/* ───────── 에이전트가 만든 모듈 · 스킬: 만든 에이전트에게 붙는지도 연결 방식을 따릅니다 ───────── */

const NOT_LINKED = "모듈 연결 방식이 '수동'이라 연결하지 않았습니다. 쓰려면 module_connect 로 연결을 요청하세요 (사용자 승인).";

function skillInput(name: string) {
  return {
    name,
    title: `스킬 ${name}`,
    description: '인사를 돌려줍니다',
    input_schema: { type: 'object', properties: { who: { type: 'string' } } },
    code: 'export default async function run(input) { return `안녕 ${input.who ?? ""}`; }',
    net: [],
    tests: [{ input: { who: '나리' }, expectIncludes: '안녕 나리' }],
  };
}

function moduleFiles(id: string, toolName: string) {
  const manifest = {
    id,
    name: `만든 ${id}`,
    version: '1.0.0',
    description: '받은 글을 돌려줍니다',
    kind: 'module',
    entry: 'index.js',
    license: 'MIT',
    permissions: { net: [], fsWrite: false, childProcess: false },
    tools: [{ name: toolName, description: '받은 글을 돌려줍니다', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }],
  };
  return [
    { path: 'module.json', content: JSON.stringify(manifest, null, 2) },
    { path: 'index.js', content: `export default {\n  async activate() {},\n  tools: {\n    async ${toolName}(input) {\n      return String(input.text ?? '');\n    },\n  },\n};\n` },
  ];
}

async function runTool(a: AgentRow, name: string, input: Record<string, unknown>, onApproval?: (id: string) => Promise<void>): Promise<{ content: string; isError: boolean }> {
  scriptOnce(a, input, name);
  const t = ask(a, '만들어');
  if (onApproval) {
    const approval = await until(() => pendingOf(t.id)[0], '승인 요청', 20_000);
    await onApproval(approval.id);
  }
  await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝', 20_000);
  return toolResultOf(calls(a).at(-1)!);
}

describe('에이전트가 만든 모듈 · 스킬', () => {
  const maker = (name: string, install: PermissionRule = ALLOW) => h.addAgent(name, { permissions: { 'skill.create': ALLOW, 'module.create': ALLOW, 'module.install': install, 'module.connect': ASK } });

  it('스킬: 반자동이면 만든 에이전트에게 바로 붙고, 수동이면 만들기만 하고 연결은 따로 요청하라고 알립니다', async () => {
    const semi = maker('스킬반자동');
    const out = await runTool(semi, 'skill_create', skillInput('hello_semi'));
    expect(out).toEqual({ isError: false, content: "스킬 '스킬 hello_semi'(hello_semi) v1.0.0 을(를) 만들어 연결했습니다. 테스트 1/1. 다음 단계부터 도구로 쓸 수 있습니다." });
    expect(linkedIds(semi)).toEqual(['skill-hello-semi']);

    setMode('manual');
    const manual = maker('스킬수동');
    expect(await runTool(manual, 'skill_create', skillInput('hello_manual'))).toEqual({ isError: false, content: `스킬 '스킬 hello_manual'(hello_manual) v1.0.0 을(를) 만들었습니다. 테스트 1/1. ${NOT_LINKED}` });
    expect(linkedIds(manual)).toEqual([]);
    expect(h.app.store.listActivity(20).find((x) => x.type === 'skill.created' && x.agentId === manual.id)?.text).toBe('스킬수동가 스킬 hello_manual(hello_manual)을(를) 만들어 설치 (연결은 승인 뒤) · 테스트 1/1');

    // 이미 붙어 있던 스킬을 고칠 때는 수동이어도 연결을 그대로 둡니다.
    expect((await runTool(semi, 'skill_create', skillInput('hello_semi'))).content).toContain('v1.0.1 을(를) 만들어 연결했습니다');
    expect(linkedIds(semi)).toEqual(['skill-hello-semi']);
  });

  it('모듈(바로 설치): 반자동이면 설치하고 연결, 수동이면 설치만 합니다', async () => {
    const semi = maker('모듈반자동');
    expect((await runTool(semi, 'module_create', { files: moduleFiles('made-semi', 'made_semi_echo') })).content).toMatch(/^모듈 '만든 made-semi'\(made-semi\)을\(를\) 설치하고 연결했습니다\./);
    expect(linkedIds(semi)).toEqual(['made-semi']);

    setMode('manual');
    const manual = maker('모듈수동');
    const out = await runTool(manual, 'module_create', { files: moduleFiles('made-manual', 'made_manual_echo') });
    expect(out.content).toMatch(new RegExp(`^모듈 '만든 made-manual'\\(made-manual\\)을\\(를\\) 설치했습니다\\. ${NOT_LINKED.replace(/[().]/g, '\\$&')}`));
    expect(linkedIds(manual)).toEqual([]);
    expect(h.app.store.findModule('made-manual')).toMatchObject({ origin: 'agent', createdBy: manual.id, enabled: true });
    expect(h.app.store.listActivity(30).find((x) => x.type === 'module.installed' && x.moduleId === 'made-manual')?.text).toBe('모듈수동가 만들어 설치함 · 연결은 승인 뒤');
  });

  it('모듈(설치 승인 뒤): 반자동이면 승인하면 연결되고, 수동이면 설치만 하고 연결은 따로 요청하라고 알립니다', async () => {
    const semi = maker('승인반자동', ASK);
    const outSemi = await runTool(semi, 'module_create', { files: moduleFiles('wait-semi', 'wait_semi_echo') }, (id) => h.app.approvals.decide(id, 'once').then(() => undefined));
    expect(outSemi.content).toMatch(/^모듈 '만든 wait-semi' 설치를 승인받았습니다\. 현재 상태: /);
    expect(outSemi.content).not.toContain(NOT_LINKED);
    expect(linkedIds(semi)).toEqual(['wait-semi']);

    setMode('manual');
    const manual = maker('승인수동', ASK);
    const outManual = await runTool(manual, 'module_create', { files: moduleFiles('wait-manual', 'wait_manual_echo') }, (id) => h.app.approvals.decide(id, 'once').then(() => undefined));
    expect(outManual.content).toContain(` · ${NOT_LINKED}`);
    expect(linkedIds(manual)).toEqual([]);
    expect(h.app.store.listActivity(30).find((x) => x.type === 'module.installed' && x.moduleId === 'wait-manual')?.text).toBe('설치 승인됨 · 켜짐 · 연결은 승인 뒤');
  });
});

/* ───────── 설정 화면 ───────── */

describe('설정 화면의 모듈 연결 방식', () => {
  it('설정에 지금 방식(기본 반자동)이 보이고, 바꾸면 저장 · 활동 기록에 남으며, 틀린 값과 로그인 없는 요청은 거절합니다', async () => {
    const { buildServer } = await import('../src/http/server.ts');
    const server = await buildServer(h.app);
    try {
      const anon = await server.inject({ method: 'PUT', url: '/api/settings/module-connect', payload: { mode: 'auto' } });
      expect(anon.statusCode).toBe(401);
      const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'harness-test-password' } });
      const cookie = String(login.headers['set-cookie']).split(';')[0] ?? '';
      const get = async () => (await server.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json() as { moduleConnect: string };
      const put = (mode: unknown) => server.inject({ method: 'PUT', url: '/api/settings/module-connect', headers: { cookie }, payload: { mode } });

      expect((await get()).moduleConnect).toBe('semi');
      const ok = await put('auto');
      expect([ok.statusCode, ok.json()]).toEqual([200, { mode: 'auto' }]);
      expect((await get()).moduleConnect).toBe('auto');
      expect(readConnectMode(h.app.store)).toBe('auto');
      const changes = () => h.app.store.listActivity(50).filter((x) => x.type === 'settings.module_connect').map((x) => x.text);
      expect(changes()).toEqual(['모듈 연결 방식: 반자동 → 자동']);
      // 같은 값으로 다시 저장하면 기록을 늘리지 않습니다.
      await put('auto');
      expect(changes()).toHaveLength(1);

      const bad = await put('always');
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toMatchObject({ error: { message: '모듈 연결 방식은 manual(수동) · semi(반자동) · auto(자동) 중 하나여야 합니다. 받은 값: "always"' } });
      expect(readConnectMode(h.app.store)).toBe('auto');
    } finally {
      await server.close();
    }
  });
});
