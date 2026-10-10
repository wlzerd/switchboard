import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseReportChoice, reportLabel, sameReportTarget } from '../src/agents/autonomy.ts';
import type { AgentRow } from '../src/db/store.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import type { PermissionRule } from '../src/permissions/policy.ts';
import { nextRun, parseSpec, type ScheduleSpec } from '../src/scheduler/spec.ts';
import type { DelegationOrigin, ToolEnv } from '../src/tools/types.ts';
import { lastUserText, startHarness, systemText, until, type Harness, type Params } from './helpers/harness.ts';

// 에이전트가 스스로 하트비트 보고 받을 곳을 고르고(report_to), 예약을 고치거나 잠시 끄는(schedule_update) 도구.
// 모델 호출만 각본대로 답하는 가짜로 바꾸고 실제 실행기 · 권한 · 저장소로 돌립니다.

describe('report_to 해석', () => {
  it.each([
    ['here', { kind: 'here' }],
    [' HERE ', { kind: 'here' }],
    ['web', { kind: 'web' }],
    ['discord:#alerts', { kind: 'channel', moduleId: 'discord', target: '#alerts' }],
    // 채널 id 는 소문자로, 앞뒤 공백은 지웁니다.
    [' Telegram : 123456789 ', { kind: 'channel', moduleId: 'telegram', target: '123456789' }],
    // 첫 ':' 에서만 나눠 대상에 ':' 가 들어가도 됩니다.
    ['matrix:!room:example.org', { kind: 'channel', moduleId: 'matrix', target: '!room:example.org' }],
    [`x:${'a'.repeat(200)}`, { kind: 'channel', moduleId: 'x', target: 'a'.repeat(200) }],
  ])('%j → %j', (raw, want) => {
    expect(parseReportChoice(raw)).toEqual(want);
  });

  it.each([
    ['#alerts', 'report_to_format', "보고 받을 곳은 'here'(지금 대화한 곳) · 'web'(채널로 보내지 않고 웹 화면에만) · '<channel id>:<대상>'(예: discord:#alerts) 중 하나로 적습니다. 받은 값: '#alerts'"],
    ['   ', 'report_to_format', "보고 받을 곳은 'here'(지금 대화한 곳) · 'web'(채널로 보내지 않고 웹 화면에만) · '<channel id>:<대상>'(예: discord:#alerts) 중 하나로 적습니다. 받은 값: ''"],
    // 'here:' 같은 낱말 뒤 ':' 는 채널 id 로 봅니다 (대상이 비어 있음).
    ['here:', 'report_to_target', "'here:' 뒤에 보낼 대상(채널 이름이나 대화 id)을 적으세요 (예: here:#alerts)."],
    [':#alerts', 'report_to_channel', "':' 앞에 채널 id 를 적으세요 (예: discord:#alerts). 받은 값: ':#alerts'"],
    ['discord:   ', 'report_to_target', "'discord:' 뒤에 보낼 대상(채널 이름이나 대화 id)을 적으세요 (예: discord:#alerts)."],
    [`x:${'a'.repeat(201)}`, 'report_target_long', '대상은 200자까지 쓸 수 있습니다. 지금 201자입니다.'],
  ])('%j 는 거절: %s', (raw, code, message) => {
    expect(() => parseReportChoice(raw)).toThrow(expect.objectContaining({ code, message }));
  });

  it('사람이 읽는 이름과 같은 곳 비교', () => {
    const names = (id: string): string | undefined => ({ telegram: 'Telegram' })[id];
    expect(reportLabel(null, names)).toBe('웹 화면');
    expect(reportLabel({ moduleId: 'telegram', target: '42' }, names)).toBe('Telegram 42');
    expect(reportLabel({ moduleId: 'gone', target: '#x' }, names)).toBe('gone #x');
    expect(sameReportTarget(null, null)).toBe(true);
    expect(sameReportTarget(null, { moduleId: 'a', target: 'b' })).toBe(false);
    expect(sameReportTarget({ moduleId: 'a', target: 'b' }, { moduleId: 'a', target: 'b' })).toBe(true);
    expect(sameReportTarget({ moduleId: 'a', target: 'b' }, { moduleId: 'a', target: 'B' })).toBe(false);
  });
});

let h: Harness;
const ALLOW: PermissionRule = { mode: 'allow', scope: [], always: [] };
const ASK: PermissionRule = { mode: 'ask', scope: [], always: [] };
const CHAT = { moduleId: 'fakechan', target: '#ops' };

beforeAll(async () => {
  h = await startHarness();
  // 보낼 수 있는 채널 · 받기만 하는 채널 · 연결하지 않을 채널
  for (const m of [
    { id: 'fakechan', name: '가짜 채널', channel: { label: '가짜' } },
    { id: 'fakein', name: '가짜 수신', channel: { label: '수신', send: false } },
    { id: 'otherchan', name: '다른 채널', channel: { label: '다른' } },
  ]) {
    const manifest = parseManifest({ ...m, version: '1.0.0', license: 'MIT' }, 'test');
    h.app.store.upsertModule({ id: manifest.id, kind: 'module', origin: 'builtin', dir: h.root, manifest, enabled: true, status: 'stopped', statusDetail: null, createdBy: null, report: null });
  }
});
afterAll(async () => {
  await h.close();
});

let seq = 0;
/** 가짜 채널(보내기) · 가짜 수신(받기만)에 연결된 에이전트. 이름은 겹치지 않게 번호를 붙입니다. */
function agent(name: string, permissions: Record<string, PermissionRule> = {}, deny: string[] = []): AgentRow {
  seq += 1;
  const a = h.addAgent(`${name}${seq}`, { permissions: { 'msg.fakechan': ALLOW, ...permissions }, deny });
  h.app.store.connectModule(a.id, 'fakechan', { targets: [], trigger: 'all' });
  h.app.store.connectModule(a.id, 'fakein', { targets: [], trigger: 'all' });
  return a;
}

type ToolOut = { content: string; isError: boolean };

function toolResultOf(p: Params): ToolOut {
  const last = [...p.messages].reverse().find((m) => m.role === 'user');
  const block = Array.isArray(last?.content) ? (last.content as Record<string, unknown>[]).find((b) => b['type'] === 'tool_result') : undefined;
  if (!block) throw new Error(`도구 결과가 없습니다: ${lastUserText(p).slice(0, 200)}`);
  return { content: String(block['content']), isError: block['is_error'] === true };
}

function ask(a: AgentRow, text: string, from: { moduleId: string; target: string } | null) {
  return h.app.manager.enqueue({
    agentId: a.id,
    source: from ? `${from.moduleId}:${from.target}` : 'console',
    sourceLabel: from ? '가짜 채널 · #ops · 사람' : '웹 콘솔',
    origin: from ? 'channel' : 'console',
    text,
    reply: from,
  });
}

/** 에이전트가 도구 하나를 부르게 하고 그 결과를 돌려줍니다. from 을 주면 그 채널 대화에서 부탁받은 것으로 합니다. */
async function callTool(a: AgentRow, name: string, input: Record<string, unknown>, from: { moduleId: string; target: string } | null = null): Promise<ToolOut> {
  h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: '끝' } : { tool: { name, input } }));
  const task = ask(a, '해 줘', from);
  await until(() => ['done', 'failed'].includes(h.app.store.getTask(task.id).status), '작업 끝');
  const list = h.calls.get(a.keyId)!;
  return toolResultOf(list[list.length - 1]!);
}

const activities = (agentId: string, type: string): string[] =>
  h.app.store
    .listActivity(500)
    .filter((x) => x.agentId === agentId && x.type === type)
    .map((x) => x.text);

const HB = { enabled: true, every_minutes: 30, checklist: '배포가 실패하면 알린다' };

describe('heartbeat_set · 보고 받을 곳 고르기 (report_to)', () => {
  it('연결된 채널의 다른 대상을 고르면 그곳으로 정하고, 활동 · 시스템 프롬프트에 보입니다', async () => {
    const a = agent('보고이');
    const out = await callTool(a, 'heartbeat_set', { ...HB, report_to: 'fakechan:#alerts' }, CHAT);
    expect(out).toEqual({ isError: false, content: '하트비트를 켰습니다: 30분마다 점검 · 보고 받을 곳: 가짜 채널 #alerts. 알릴 것이 없으면 조용히 있고, 알릴 것이 있을 때만 보고합니다.' });
    expect(h.app.store.getAgent(a.id).report).toEqual({ moduleId: 'fakechan', target: '#alerts' });
    expect(activities(a.id, 'agent.report_to')).toEqual(['보고 받을 곳 · 가짜 채널 #alerts']);

    // 다음 요청의 시스템 프롬프트(바뀌는 부분)에 지금 보고 받을 곳이 report_to 형식과 함께 들어갑니다.
    h.scripts.set(a.keyId, () => ({ text: '네' }));
    const t = ask(a, '보고 어디로 가?', null);
    await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    const calls = h.calls.get(a.keyId)!;
    expect(systemText(calls[calls.length - 1]!)).toContain('- 보고 받을 곳: 가짜 채널 #alerts (report_to: fakechan:#alerts)');
  });

  it("'here' 는 지금 대화한 채널, 웹 콘솔에서는 웹 화면, 'web' 은 채널로 보내지 않음", async () => {
    const a = agent('여기이');
    await callTool(a, 'heartbeat_set', { ...HB, report_to: 'here' }, CHAT);
    expect(h.app.store.getAgent(a.id).report).toEqual(CHAT);

    const fromConsole = await callTool(a, 'heartbeat_set', { enabled: true, report_to: 'here' });
    expect(fromConsole.content).toContain('보고 받을 곳: 웹 화면.');
    expect(h.app.store.getAgent(a.id).report).toBeNull();

    await callTool(a, 'heartbeat_set', { enabled: true, report_to: 'fakechan:#x' });
    await callTool(a, 'heartbeat_set', { enabled: true, report_to: 'WEB' }, CHAT);
    expect(h.app.store.getAgent(a.id).report).toBeNull();
    expect(activities(a.id, 'agent.report_to')).toEqual(['보고 받을 곳 · 웹 화면', '보고 받을 곳 · 가짜 채널 #x', '보고 받을 곳 · 웹 화면', '보고 받을 곳 · 가짜 채널 #ops']);
  });

  it('고르지 않으면 정해 둔 곳을 그대로 두고, 정해 둔 곳이 없으면 지금 대화한 채널로 정합니다 (예전 동작)', async () => {
    const a = agent('그대로이');
    await callTool(a, 'heartbeat_set', HB, CHAT);
    expect(h.app.store.getAgent(a.id).report).toEqual(CHAT);
    // 다른 대화에서 간격만 바꿔도 보고 받을 곳은 그대로입니다.
    const out = await callTool(a, 'heartbeat_set', { enabled: true, every_minutes: 60 }, { moduleId: 'fakechan', target: '#other' });
    expect(out.content).toContain('60분마다 점검 · 보고 받을 곳: 가짜 채널 #ops.');
    expect(h.app.store.getAgent(a.id).report).toEqual(CHAT);
    // 바뀌지 않았으니 활동에는 처음 정한 한 번만 남습니다.
    expect(activities(a.id, 'agent.report_to')).toEqual(['보고 받을 곳 · 가짜 채널 #ops']);
  });

  it.each([
    ['otherchan:#x', "'otherchan'은(는) 이 에이전트에 연결된 채널이 아닙니다. 보낼 수 있는 채널: fakechan."],
    ['fakein:inbox', "'가짜 수신'은(는) 받기만 하는 채널이라 그리로는 보낼 수 없습니다. 보낼 수 있는 채널: fakechan."],
    ['nope:#x', "'nope'은(는) 이 에이전트에 연결된 채널이 아닙니다. 보낼 수 있는 채널: fakechan."],
    ['#alerts', "보고 받을 곳은 'here'(지금 대화한 곳) · 'web'(채널로 보내지 않고 웹 화면에만) · '<channel id>:<대상>'(예: discord:#alerts) 중 하나로 적습니다. 받은 값: '#alerts'"],
  ])('고를 수 없는 곳(%s)이면 이유를 알리고 아무것도 바꾸지 않습니다', async (reportTo, message) => {
    const a = agent('못고름');
    h.app.manager.setAutonomy(a.id, { enabled: false, everyMinutes: 30, activeHours: null, checklist: '그대로' }, CHAT);
    const out = await callTool(a, 'heartbeat_set', { ...HB, report_to: reportTo });
    expect(out).toEqual({ isError: true, content: message });
    expect(h.app.store.getAgent(a.id)).toMatchObject({ report: CHAT, heartbeat: { enabled: false, checklist: '그대로' } });
  });

  it('받기만 하는 채널에서 부탁받고 here 를 고르면 그 이유를 알립니다', async () => {
    const a = agent('수신이');
    const out = await callTool(a, 'heartbeat_set', { ...HB, report_to: 'here' }, { moduleId: 'fakein', target: 'inbox' });
    expect(out).toEqual({ isError: true, content: "'가짜 수신'은(는) 받기만 하는 채널이라 그리로는 보낼 수 없습니다. 보낼 수 있는 채널: fakechan." });
    expect(h.app.store.getAgent(a.id).report).toBeNull();
  });

  it('그 채널로 보내는 권한이 차단이면 고를 수 없고, 확인이면 보낼 때마다 승인이 필요하다고 알립니다', async () => {
    const denied = agent('차단이', { 'msg.fakechan': { mode: 'deny', scope: [], always: [] } });
    const out = await callTool(denied, 'heartbeat_set', { ...HB, report_to: 'fakechan:#alerts' });
    expect(out).toEqual({ isError: true, content: "'가짜 채널 전송' 권한이 차단으로 설정되어 있습니다. 그곳으로는 보낼 수 없습니다." });
    expect(h.app.store.getAgent(denied.id).report).toBeNull();

    // 허용 범위(#ops) 밖의 대상은 보낼 때 확인이 필요합니다.
    const scoped = agent('범위이', { 'msg.fakechan': { mode: 'allow', scope: ['#ops'], always: [] } });
    const inScope = await callTool(scoped, 'heartbeat_set', { ...HB, report_to: 'fakechan:#ops' });
    expect(inScope.content).not.toContain('주의');
    const outScope = await callTool(scoped, 'heartbeat_set', { ...HB, report_to: 'fakechan:#alerts' });
    expect(outScope.isError).toBe(false);
    expect(outScope.content).toContain("\n주의: 그곳으로 보낼 때마다 사용자의 승인이 필요합니다 ('#alerts'은(는) '가짜 채널 전송' 허용 범위(#ops) 밖이라 확인이 필요합니다.)");
    expect(h.app.store.getAgent(scoped.id).report).toEqual({ moduleId: 'fakechan', target: '#alerts' });
  });

  it('하트비트 설정이 확인(승인)이면 승인 카드에 보고 받을 곳이 보이고, 고를 수 없는 곳은 승인을 묻기 전에 막습니다', async () => {
    const a = agent('승인이', { 'heartbeat.manage': ASK });
    const bad = await callTool(a, 'heartbeat_set', { ...HB, report_to: 'otherchan:#x' });
    expect(bad.isError).toBe(true);
    expect(h.app.store.listApprovals('pending').filter((x) => x.agentId === a.id)).toEqual([]);

    h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: '끝' } : { tool: { name: 'heartbeat_set', input: { ...HB, report_to: 'fakechan:#alerts' } } }));
    const task = ask(a, '배포 지켜봐 줘', null);
    const approval = await until(() => h.app.store.listApprovals('pending').find((x) => x.taskId === task.id), '승인 요청');
    expect(approval.title).toBe('하트비트 설정 · 켜기 · 30분마다 · 보고 → 가짜 채널 #alerts');
    expect(h.app.store.getAgent(a.id).report).toBeNull();
    await h.app.approvals.decide(approval.id, 'once');
    await until(() => h.app.store.getTask(task.id).status === 'done', '작업 끝');
    expect(h.app.store.getAgent(a.id).report).toEqual({ moduleId: 'fakechan', target: '#alerts' });
  });

  it("조용한 작업(하트비트)과 다른 에이전트가 맡긴 일에는 'here' 가 없어 이유를 알립니다", async () => {
    const a = agent('조용이');
    h.app.manager.setAutonomy(a.id, { enabled: true, everyMinutes: 30, activeHours: null, checklist: '서버 상태 확인' }, CHAT);
    h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: 'NO_REPORT' } : { tool: { name: 'heartbeat_set', input: { enabled: true, report_to: 'here' } } }));
    const before = h.calls.get(a.keyId)?.length ?? 0;
    h.app.manager.runHeartbeat(a.id, true);
    await until(() => (h.calls.get(a.keyId)?.length ?? 0) === before + 2 && h.app.manager.live(a.id).running.length === 0, '점검 끝');
    expect(toolResultOf(h.calls.get(a.keyId)![before + 1]!)).toEqual({
      isError: true,
      content: "조용한 판단(하트비트 · 자동 알림) 중에는 지금 대화한 곳(here)이 없습니다. '<channel id>:<대상>'이나 'web'으로 적으세요.",
    });
    expect(h.app.store.getAgent(a.id).report).toEqual(CHAT);

    const env = (over: Partial<ToolEnv>): ToolEnv => ({ quiet: false, delegation: null, reply: null, ...over }) as ToolEnv;
    const fresh = h.app.store.getAgent(a.id);
    expect(() => h.app.manager.resolveReport(fresh, env({ delegation: { fromAgentId: 'x' } as DelegationOrigin }), 'here')).toThrow(
      "다른 에이전트가 맡긴 일이라 지금 대화한 곳(here)으로는 보낼 수 없습니다. '<channel id>:<대상>'이나 'web'으로 적으세요.",
    );
    // 'web' 과 채널은 맡은 일 · 조용한 작업에서도 고를 수 있습니다.
    expect(h.app.manager.resolveReport(fresh, env({ quiet: true }), 'web')).toEqual({ to: null, ask: null });
    expect(h.app.manager.resolveReport(fresh, env({ delegation: { fromAgentId: 'x' } as DelegationOrigin }), 'fakechan:#b')).toEqual({ to: { moduleId: 'fakechan', target: '#b' }, ask: null });
  });

  it('연결된 채널 중 보낼 수 있는 것이 없으면 web 만 고를 수 있다고 알립니다', async () => {
    const a = h.addAgent('채널없음');
    const out = await callTool(a, 'heartbeat_set', { ...HB, report_to: 'fakechan:#x' });
    expect(out.content).toBe("'fakechan'은(는) 이 에이전트에 연결된 채널이 아닙니다. 이 에이전트에 연결된 채널 중 보낼 수 있는 것이 없어 'web'만 고를 수 있습니다.");
    expect(systemText(h.calls.get(a.keyId)![0]!)).toContain('- 보고 받을 곳: 웹 화면만 (채널로 보내지 않음)');
  });
});

describe('예약 고치기 (schedule_update) · 결과 받을 곳', () => {
  const tz = (): string => process.env['TZ'] || 'UTC';
  const spec = (s: string): ScheduleSpec => parseSpec(s) as ScheduleSpec;
  const insert = (agentId: string, over: Partial<{ spec: string; prompt: string; enabled: boolean; nextRun: number | null; reply: { moduleId: string; target: string } | null }> = {}) =>
    h.app.store.insertSchedule({ agentId, spec: 'daily 09:00', prompt: '매출 정리', reply: null, enabled: true, nextRun: Date.now() + 3_600_000, createdBy: agentId, ...over });

  it('schedule_create 에 report_to 를 주면 그곳으로, 안 주면 지금 대화한 곳으로 결과를 보냅니다', async () => {
    const a = agent('예약이');
    const out = await callTool(a, 'schedule_create', { spec: 'daily 09:00', prompt: '어제 매출 정리', report_to: 'fakechan:#daily' });
    expect(out.isError).toBe(false);
    expect(out.content).toMatch(/^예약했습니다: 매일 09:00 · 다음 실행 .+ · 결과 받을 곳 가짜 채널 #daily · id sch_/);
    await callTool(a, 'schedule_create', { spec: 'every 2h', prompt: '서버 확인' }, CHAT);
    expect(h.app.store.listSchedules(a.id).map((s) => s.reply)).toEqual([{ moduleId: 'fakechan', target: '#daily' }, CHAT]);
  });

  it('끄면 지우지 않고 다음 실행만 없애고, 다시 켜면 지금부터 다음 시각을 셉니다', async () => {
    const a = agent('끄기이');
    const s = insert(a.id, { spec: 'every 30m' });
    const off = await callTool(a, 'schedule_update', { id: s.id, enabled: false });
    expect(off).toEqual({ isError: false, content: `예약 ${s.id} 를 고쳤습니다 (끔): 30분마다 · 꺼짐 (지우지 않았으니 enabled=true 로 다시 켤 수 있습니다) · 결과 받을 곳 웹 화면` });
    expect(h.app.store.getSchedule(s.id)).toMatchObject({ enabled: false, nextRun: null, spec: 'every 30m', prompt: '매출 정리' });
    expect(activities(a.id, 'schedule.updated')).toEqual(['예약 고침 · 30분마다 · 끔 · 꺼짐']);
    // 꺼진 예약은 시각이 지나도 실행 대상에 들지 않습니다.
    expect(h.app.store.dueSchedules(Date.now() + 86_400_000).map((x) => x.id)).not.toContain(s.id);

    const t0 = Date.now();
    const on = await callTool(a, 'schedule_update', { id: s.id, enabled: true });
    const t1 = Date.now();
    expect(on.content).toMatch(new RegExp(`^예약 ${s.id} 를 고쳤습니다 \\(켬\\): 30분마다 · 다음 실행 .+ · 결과 받을 곳 웹 화면$`));
    const next = h.app.store.getSchedule(s.id).nextRun!;
    expect(next).toBeGreaterThanOrEqual(t0 + 1_800_000);
    expect(next).toBeLessThanOrEqual(t1 + 1_800_000);
  });

  it('규칙을 바꾸면 다음 시각을 다시 세고, 할 일 · 결과 받을 곳만 바꾸면 다음 시각은 그대로입니다', async () => {
    const a = agent('고침이');
    const fixedNext = Date.now() + 123_456_789;
    const s = insert(a.id, { nextRun: fixedNext });

    const p = await callTool(a, 'schedule_update', { id: s.id, prompt: '  매출과 환불 정리  ', report_to: 'fakechan:#daily' });
    expect(p.content).toMatch(new RegExp(`^예약 ${s.id} 를 고쳤습니다 \\(할 일 · 결과 받을 곳\\): 매일 09:00 · 다음 실행 .+ · 결과 받을 곳 가짜 채널 #daily$`));
    expect(h.app.store.getSchedule(s.id)).toMatchObject({ prompt: '매출과 환불 정리', reply: { moduleId: 'fakechan', target: '#daily' }, nextRun: fixedNext, enabled: true });

    const t0 = Date.now();
    const r = await callTool(a, 'schedule_update', { id: s.id, spec: '  Weekdays   10:30 ' });
    const t1 = Date.now();
    expect(r.content).toContain('(규칙): 평일 10:30 · 다음 실행');
    const row = h.app.store.getSchedule(s.id);
    expect(row.spec).toBe('weekdays 10:30');
    expect([nextRun(spec('weekdays 10:30'), t0, tz()), nextRun(spec('weekdays 10:30'), t1, tz())]).toContain(row.nextRun);
    // 활동은 최근 것부터
    expect(activities(a.id, 'schedule.updated')).toHaveLength(2);
    expect(activities(a.id, 'schedule.updated')[0]).toMatch(/^예약 고침 · 평일 10:30 · 규칙 · 다음 /);
    expect(activities(a.id, 'schedule.updated')[1]).toMatch(/^예약 고침 · 매일 09:00 · 할 일, 결과 받을 곳 · 다음 /);

    // 꺼 둔 예약의 할 일만 고치면 꺼진 채로 둡니다.
    await callTool(a, 'schedule_update', { id: s.id, enabled: false });
    await callTool(a, 'schedule_update', { id: s.id, prompt: '환불만 정리' });
    expect(h.app.store.getSchedule(s.id)).toMatchObject({ enabled: false, nextRun: null, prompt: '환불만 정리' });
  });

  it("결과 받을 곳을 'web' 으로 돌리고, 같은 값만 주면 바꾼 것이 없다고 알립니다", async () => {
    const a = agent('웹이');
    const s = insert(a.id, { reply: CHAT });
    await callTool(a, 'schedule_update', { id: s.id, report_to: 'web' });
    expect(h.app.store.getSchedule(s.id).reply).toBeNull();
    const before = h.app.store.getSchedule(s.id);
    const same = await callTool(a, 'schedule_update', { id: s.id, spec: 'DAILY 09:00', prompt: '매출 정리', enabled: true, report_to: 'web' });
    expect(same.isError).toBe(false);
    expect(same.content).toMatch(new RegExp(`^예약 ${s.id} 는 이미 그대로라 바꾼 것이 없습니다: 매일 09:00 · 다음 .+ · 결과 받을 곳 웹 화면$`));
    expect(h.app.store.getSchedule(s.id)).toEqual(before);
    expect(activities(a.id, 'schedule.updated')).toHaveLength(1);
  });

  it.each([
    [{}, '바꿀 항목(spec · prompt · enabled · report_to)을 하나 이상 적으세요.'],
    [{ spec: 'hourly' }, "예약 형식을 알 수 없습니다: 'hourly'. 가능한 형식: every 30m · daily 09:00 · weekdays 09:00 · weekly mon 09:00"],
    [{ spec: 'daily 24:00' }, "시(hour)는 00~23 이어야 합니다. 받은 값: '24:00'"],
    [{ prompt: '   ' }, '예약해서 할 일(prompt)이 비어 있습니다.'],
    [{ report_to: 'otherchan:#x' }, "'otherchan'은(는) 이 에이전트에 연결된 채널이 아닙니다. 보낼 수 있는 채널: fakechan."],
  ])('잘못된 입력 %j 은 이유를 알리고 예약을 그대로 둡니다', async (change, message) => {
    const a = agent('틀림이');
    const s = insert(a.id);
    const before = h.app.store.getSchedule(s.id);
    const out = await callTool(a, 'schedule_update', { id: s.id, ...change });
    expect(out).toEqual({ isError: true, content: message });
    expect(h.app.store.getSchedule(s.id)).toEqual(before);
  });

  it('없는 예약 · 다른 에이전트의 예약은 고치지 않습니다', async () => {
    const a = agent('남의것');
    const other = agent('주인');
    const theirs = insert(other.id);
    expect(await callTool(a, 'schedule_update', { id: 'sch_none', enabled: false })).toEqual({ isError: true, content: "예약 'sch_none'이(가) 없습니다. schedule_list 로 id 를 확인하세요." });
    expect(await callTool(a, 'schedule_update', { id: theirs.id, enabled: false })).toEqual({ isError: true, content: `예약 '${theirs.id}'은(는) 다른 에이전트의 예약이라 고칠 수 없습니다.` });
    expect(await callTool(a, 'schedule_cancel', { id: theirs.id })).toEqual({ isError: true, content: `예약 '${theirs.id}'은(는) 다른 에이전트의 예약이라 지울 수 없습니다.` });
    expect(await callTool(a, 'schedule_list', { id: theirs.id })).toEqual({ isError: true, content: `예약 '${theirs.id}'은(는) 다른 에이전트의 예약이라 볼 수 없습니다.` });
    expect(h.app.store.getSchedule(theirs.id).enabled).toBe(true);
  });

  it('저장된 규칙이 잘못된 예약은 규칙을 함께 고쳐야 켤 수 있습니다', async () => {
    const a = agent('망가짐');
    const s = insert(a.id, { spec: 'hourly', enabled: false, nextRun: null });
    const out = await callTool(a, 'schedule_update', { id: s.id, enabled: true });
    expect(out).toEqual({
      isError: true,
      content: "저장된 규칙 'hourly'이(가) 잘못되어 켤 수 없습니다 (예약 형식을 알 수 없습니다: 'hourly'. 가능한 형식: every 30m · daily 09:00 · weekdays 09:00 · weekly mon 09:00). spec 을 함께 고치세요.",
    });
    const fixed = await callTool(a, 'schedule_update', { id: s.id, enabled: true, spec: 'every 1h' });
    expect(fixed.content).toContain('(규칙 · 켬): 1시간마다 · 다음 실행');
    expect(h.app.store.getSchedule(s.id)).toMatchObject({ enabled: true, spec: 'every 1h' });
  });

  it('목록은 할 일을 줄여 보여 주고, id 를 넣으면 전체를 보여 줍니다', async () => {
    const a = agent('목록이');
    const long = `${'가'.repeat(80)}끝까지 보여야 할 부분`;
    const s = insert(a.id, { prompt: long, reply: CHAT });
    const list = await callTool(a, 'schedule_list', {});
    expect(list.content).toMatch(new RegExp(`^- ${s.id} · 매일 09:00 · 다음 .+ · 결과 받을 곳 가짜 채널 #ops · ${'가'.repeat(80)}…\\(전체 ${long.length}자\\)$`));
    const one = await callTool(a, 'schedule_list', { id: s.id });
    expect(one.content).toMatch(new RegExp(`^${s.id} · 매일 09:00 \\(daily 09:00\\) · 다음 .+ · 결과 받을 곳 가짜 채널 #ops\\n할 일:\\n${long}$`));
  });

  it('예약 권한이 확인이면 고치기 전에 승인을 묻고, 차단이면 예약 도구를 주지 않습니다', async () => {
    const a = agent('확인이', { 'schedule.create': ASK });
    const s = insert(a.id);
    // 바꿀 것이 없는 호출은 승인을 묻기 전에 막습니다.
    h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: '끝' } : { tool: { name: 'schedule_update', input: { id: s.id } } }));
    const empty = ask(a, '예약 고쳐 줘', null);
    await until(() => h.app.store.getTask(empty.id).status === 'done' || h.app.store.listApprovals('pending').some((x) => x.taskId === empty.id), '작업 끝 또는 승인 요청');
    expect(h.app.store.listApprovals('pending').filter((x) => x.taskId === empty.id)).toEqual([]);
    const emptyCalls = h.calls.get(a.keyId)!;
    expect(toolResultOf(emptyCalls[emptyCalls.length - 1]!)).toEqual({ isError: true, content: '바꿀 항목(spec · prompt · enabled · report_to)을 하나 이상 적으세요.' });

    h.scripts.set(a.keyId, (p) => (lastUserText(p).includes('"tool_result"') ? { text: '끝' } : { tool: { name: 'schedule_update', input: { id: s.id, enabled: false, report_to: 'fakechan:#daily' } } }));
    const task = ask(a, '예약 잠깐 꺼 줘', null);
    const approval = await until(() => h.app.store.listApprovals('pending').find((x) => x.taskId === task.id), '승인 요청');
    expect(approval.title).toBe(`예약 실행 만들기 · 예약 ${s.id} · 끄기 · 결과 → 가짜 채널 #daily`);
    expect(h.app.store.getSchedule(s.id).enabled).toBe(true);
    await h.app.approvals.decide(approval.id, 'deny');
    await until(() => h.app.store.getTask(task.id).status === 'done', '작업 끝');
    expect(h.app.store.getSchedule(s.id).enabled).toBe(true);

    const allowed = agent('운영이');
    const denied = agent('관찰이', {}, ['schedule.create']);
    for (const x of [allowed, denied]) {
      h.scripts.set(x.keyId, () => ({ text: '네' }));
      const t = ask(x, '안녕', null);
      await until(() => h.app.store.getTask(t.id).status === 'done', '작업 끝');
    }
    const names = (x: AgentRow): string[] => h.calls.get(x.keyId)![0]!.tools.map((t) => t.name ?? '');
    expect(names(allowed)).toEqual(expect.arrayContaining(['schedule_create', 'schedule_list', 'schedule_update', 'schedule_cancel']));
    expect(names(denied).filter((n) => n.startsWith('schedule_'))).toEqual([]);
    expect(systemText(h.calls.get(allowed.keyId)![0]!)).toContain('예약을 바꾸거나 잠시 멈출 때는 지우지 말고 schedule_update 로 고친다.');
  });
});
