import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.ts';
import { parseConfig } from '../src/config/env.ts';
import type { AgentRow, DelegationSettings } from '../src/db/store.ts';
import type { ServerEvent } from '../src/events/bus.ts';
import { createLogger } from '../src/log.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import type { PermissionRule } from '../src/permissions/policy.ts';

// 조용한 판단(하트비트 · 자동 알림)과 위임을 실제 실행기로 돌려 봅니다. 모델 호출만 각본대로 답하는 가짜로 바꿉니다.
const repoRoot = path.resolve(import.meta.dirname, '..', '..');

type ToolCall = { name: string; input: Record<string, unknown>; toolset?: string };
type Reply = { text?: string; tool?: ToolCall; tools?: ToolCall[]; error?: Error };
type Params = { system: { text: string }[]; messages: { role: string; content: unknown }[]; tools: { name?: string; type?: string }[] };
type Script = (p: Params, call: number) => Reply;

let root: string;
let app: App;
let events: ServerEvent[] = [];
const scripts = new Map<string, Script>();
const calls = new Map<string, Params[]>();
let toolSeq = 0;

function fakeClient(keyId: string) {
  return {
    beta: {
      messages: {
        stream(params: Params) {
          const list = calls.get(keyId) ?? [];
          list.push(structuredClone(params));
          calls.set(keyId, list);
          const script = scripts.get(keyId);
          if (!script) throw new Error(`키 ${keyId} 의 각본이 없습니다`);
          const r = script(params, list.length);
          const onText: ((t: string) => void)[] = [];
          return {
            on(ev: string, cb: (t: string) => void) {
              if (ev === 'text') onText.push(cb);
              return this;
            },
            async finalMessage() {
              if (r.error) throw r.error;
              const content: Record<string, unknown>[] = [];
              if (r.text) {
                for (const cb of onText) cb(r.text);
                content.push({ type: 'text', text: r.text });
              }
              const tools = r.tools ?? (r.tool ? [r.tool] : []);
              for (const t of tools) {
                toolSeq += 1;
                content.push({ type: 'tool_use', id: `toolu_${toolSeq}`, name: t.name, input: t.input, ...(t.toolset ? { toolset_name: t.toolset } : {}) });
              }
              return { content, stop_reason: tools.length > 0 ? 'tool_use' : 'end_turn', stop_details: null, usage: { input_tokens: 10, output_tokens: 5 } };
            },
          };
        },
      },
    },
  };
}

/** 마지막 user 메시지의 글자 (도구 결과면 그 내용) */
function lastUserText(p: Params): string {
  const last = [...p.messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return JSON.stringify(last.content);
}

async function until<T>(fn: () => T | null | undefined | false, label: string, ms = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`기다리다 시간 초과: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

let seq = 0;
function addAgent(name: string, opts: { delegation?: Partial<DelegationSettings>; deny?: string[]; tokensPerDay?: number } = {}): AgentRow {
  seq += 1;
  const key = app.store.insertKey({ label: `test ${name}`, source: 'stored', cipher: 'x', last4: '0000' }, null);
  const preset = app.presets.get('operator');
  if (!preset) throw new Error('operator 프리셋이 없습니다');
  const permissions: Record<string, PermissionRule> = { ...preset.permissions };
  for (const k of opts.deny ?? []) permissions[k] = { mode: 'deny', scope: [], always: [] };
  return app.store.insertAgent({
    id: `agt_t${seq}`,
    name,
    color: '#C6F35B',
    role: '',
    model: 'claude-opus-5-5',
    effort: null,
    keyId: key.id,
    preset: 'custom',
    permissions,
    limits: { ...preset.limits, ...(opts.tokensPerDay ? { tokensPerDay: opts.tokensPerDay } : {}) },
    paused: false,
    delegation: { accept: false, send: false, supervisorId: null, ...opts.delegation },
  });
}

const visibleTypes = (list: ServerEvent[]): string[] => list.map((e) => e.type);

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-quiet-'));
  fs.mkdirSync(path.join(root, 'config'));
  for (const f of ['presets.json', 'guards.json', 'themes.json']) fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(root, 'config', f));
  fs.mkdirSync(path.join(root, 'templates'));
  const config = parseConfig(
    {
      ADMIN_PASSWORD: 'quiet-test-password',
      SESSION_SECRET: 's'.repeat(40),
      SECRETS_KEY: Buffer.alloc(32, 9).toString('base64'),
      DATA_DIR: path.join(root, 'data'),
      MODULES_DIR: path.join(repoRoot, 'modules'),
      TEMPLATES_DIR: path.join(root, 'templates'),
      LOG_LEVEL: 'error',
      HEARTBEAT_MIN_MINUTES: '5',
    },
    root,
  );
  app = await createApp(config, createLogger('error'));
  app.anthropic.client = ((keyId: string) => fakeClient(keyId)) as unknown as typeof app.anthropic.client;
  app.anthropic.modelInfo = async () => null;
  app.bus.subscribe((e) => events.push(e));
});

afterAll(async () => {
  app.manager.shutdown();
  app.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  events = [];
});

describe('하트비트 · 조용한 판단', () => {
  it('보고할 것이 없으면(NO_REPORT) 작업 · 대화 · 타임라인 · 활동 · 실시간 이벤트 어디에도 흔적이 없습니다', async () => {
    const a = addAgent('조용이');
    scripts.set(a.keyId, () => ({ text: 'NO_REPORT' }));
    app.manager.setAutonomy(a.id, { enabled: true, everyMinutes: 30, activeHours: null, checklist: '새 메일 확인' }, null);
    events = [];
    const activityBefore = app.store.listActivity(500).length;

    app.manager.runHeartbeat(a.id, true);
    const done = await until(() => events.find((e): e is Extract<ServerEvent, { type: 'heartbeat.done' }> => e.type === 'heartbeat.done' && e.agentId === a.id), 'heartbeat.done');

    expect(done).toMatchObject({ reported: false, error: null });
    // 사용자가 직접 누른 점검의 끝 알림 말고는 아무 이벤트도 나가지 않습니다.
    expect(visibleTypes(events)).toEqual(['heartbeat.done']);
    expect(app.store.latestTask(a.id)).toBeNull();
    // 화면 목록에서 빠지는 것만이 아니라 숨은 작업 행도 남지 않습니다.
    expect(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE agent_id = :id', { id: a.id })?.n).toBe(0);
    expect(app.store.listActivity(500).length).toBe(activityBefore);
    const thread = app.store.listThreads(a.id).find((t) => t.source === 'heartbeat');
    expect(thread).toBeDefined();
    expect(app.store.listTimeline(thread!.id, 100)).toEqual([]);
    expect(app.store.listMessages(thread!.id)).toEqual([]);
    // 빈 대화방은 콘솔 목록에 보이지 않습니다.
    expect(app.store.listVisibleThreads(a.id).map((t) => t.source)).not.toContain('heartbeat');
    // 모델은 점검 목록과 NO_REPORT 규칙을 받았습니다.
    expect(lastUserText(calls.get(a.keyId)![0]!)).toContain('새 메일 확인');
    expect(lastUserText(calls.get(a.keyId)![0]!)).toContain('NO_REPORT');
  });

  it('NO_REPORT 앞에 꾸밈 기호가 붙어도 조용히 끝납니다', async () => {
    const a = addAgent('꾸밈이');
    scripts.set(a.keyId, () => ({ text: '**NO_REPORT** — 변화 없음' }));
    app.manager.setAutonomy(a.id, { enabled: true, everyMinutes: 30, activeHours: null, checklist: '확인' }, null);
    events = [];
    app.manager.runHeartbeat(a.id, true);
    const done = await until(() => events.find((e) => e.type === 'heartbeat.done' && e.agentId === a.id), 'heartbeat.done');
    expect(done).toMatchObject({ reported: false });
    expect(app.store.latestTask(a.id)).toBeNull();
  });

  it('보고할 것이 있으면 기록을 드러내고, 보고 이벤트 · 활동 · 보고 채널 전송이 한 번씩 일어납니다', async () => {
    const a = addAgent('보고이');
    scripts.set(a.keyId, () => ({ text: '중요: 결제 실패 메일이 3통 왔습니다. 카드 정보를 확인하세요.' }));
    const delivered: { moduleId: string; target: string; text: string }[] = [];
    const realDeliver = app.manager.deliver.bind(app.manager);
    app.manager.deliver = async (_agent, _env, moduleId, target, text) => {
      delivered.push({ moduleId, target, text });
      return '보냄';
    };
    try {
      // 보고 채널 검사는 실제 모듈 목록을 보므로 보낼 수 있는 기본 모듈(telegram)을 씁니다.
      app.manager.setAutonomy(a.id, { enabled: true, everyMinutes: 30, activeHours: null, checklist: '결제 메일 확인' }, { moduleId: 'telegram', target: '12345' });
      events = [];
      app.manager.runHeartbeat(a.id, true);
      const done = await until(() => events.find((e) => e.type === 'heartbeat.done' && e.agentId === a.id), 'heartbeat.done');
      expect(done).toMatchObject({ reported: true, error: null });
    } finally {
      app.manager.deliver = realDeliver;
    }

    const reports = events.filter((e) => e.type === 'report');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ agentId: a.id, source: '하트비트' });
    expect(delivered).toEqual([{ moduleId: 'telegram', target: '12345', text: '중요: 결제 실패 메일이 3통 왔습니다. 카드 정보를 확인하세요.' }]);

    const task = app.store.latestTask(a.id);
    expect(task).toMatchObject({ status: 'done', origin: 'heartbeat' });
    const thread = app.store.listVisibleThreads(a.id).find((t) => t.source === 'heartbeat');
    expect(thread).toBeDefined();
    const kinds = app.store.listTimeline(thread!.id, 100).map((i) => i.kind);
    // 사용자 말풍선 대신 무엇이 이 보고를 일으켰는지(점검), 그 다음 보고 하나. 같은 글이 agent 말풍선으로 또 나오지 않습니다.
    expect(kinds).toEqual(['user', 'report']);
    expect(app.store.listActivity(50).some((x) => x.type === 'agent.report' && x.agentId === a.id)).toBe(true);
  });

  it('같은 오류가 되풀이되면 처음 한 번만 드러내고 다음부터는 조용히 넘깁니다', async () => {
    // 하루 토큰 한도를 이미 넘긴 상태로 만들어 모델을 부르기 전에 같은 오류가 나게 합니다.
    const a = addAgent('한도이', { tokensPerDay: 1000 });
    scripts.set(a.keyId, () => ({ text: '불리면 안 됩니다' }));
    app.manager.setAutonomy(a.id, { enabled: true, everyMinutes: 30, activeHours: null, checklist: '확인' }, null);
    const tz = process.env['TZ'] || 'UTC';
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    app.store.addUsage(a.id, day, { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0 });

    events = [];
    app.manager.runHeartbeat(a.id, true);
    const first = await until(() => events.find((e): e is Extract<ServerEvent, { type: 'heartbeat.done' }> => e.type === 'heartbeat.done' && e.agentId === a.id), '첫 점검');
    expect(first.error).toContain('한도');
    expect(app.store.latestTask(a.id)?.status).toBe('failed');
    const failedId = app.store.latestTask(a.id)?.id;

    events = [];
    app.manager.runHeartbeat(a.id, true);
    const second = await until(() => events.find((e): e is Extract<ServerEvent, { type: 'heartbeat.done' }> => e.type === 'heartbeat.done' && e.agentId === a.id), '두 번째 점검');
    expect(second.error).toContain('한도');
    // 두 번째는 작업 기록이 새로 생기지 않습니다 (첫 실패 기록만 남음).
    expect(app.store.latestTask(a.id)?.id).toBe(failedId);
    expect(visibleTypes(events)).toEqual(['heartbeat.done']);
    expect(calls.get(a.keyId)).toBeUndefined();
  });
});

describe('모듈 자동 알림 (새 메일)', () => {
  it('조용한 메시지는 연결된 에이전트에게 조용히 넘어가고, 알릴 것이 없으면 흔적이 없으며 원래 채널로 답하지 않습니다', async () => {
    const a = addAgent('메일이');
    app.store.connectModule(a.id, 'email', { targets: [], trigger: 'direct' });
    // 하트비트(주기 점검)는 끈 채 알릴 조건만 적어 둔 경우: 메일 알림을 판단할 때 이 조건이 보여야 합니다.
    app.manager.setAutonomy(a.id, { enabled: false, everyMinutes: 30, activeHours: null, checklist: '결제 · 계약 메일만 알린다' }, null);
    scripts.set(a.keyId, () => ({ text: 'NO_REPORT' }));
    events = [];
    app.manager.route('email', { target: 'INBOX', targetLabel: '받은편지함', userId: 'email', userName: '이메일', text: '[새 메일 1통 · 받은편지함]\n1. uid 7 · 광고', direct: true, quiet: true });
    await until(() => calls.get(a.keyId)?.length === 1, '모델 호출');
    await until(() => !app.manager.live(a.id).running.length && app.store.listMessages(app.store.listThreads(a.id)[0]!.id).length === 0, '정리');

    const sent = lastUserText(calls.get(a.keyId)![0]!);
    expect(calls.get(a.keyId)![0]!.system[0]!.text).toContain('결제 · 계약 메일만 알린다');
    expect(sent).toContain('[조용히 판단 · 자동 알림]');
    expect(sent).toContain('[새 메일 1통 · 받은편지함]');
    // 수신 알림 · 메시지 펄스 같은 보이는 이벤트가 없습니다.
    expect(events.filter((e) => e.type !== 'agent.status' || e.agentId !== a.id).map((e) => e.type)).toEqual([]);
    expect(app.store.latestTask(a.id)).toBeNull();
  });
});

describe('에이전트 간 위임', () => {
  it('위임 요청 보내기가 꺼진 에이전트에게는 delegate_task 도구를 주지 않습니다', async () => {
    const a = addAgent('혼자이');
    scripts.set(a.keyId, () => ({ text: '알겠습니다' }));
    app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '안녕', reply: null });
    await until(() => app.store.latestTask(a.id)?.status === 'done', '작업 끝');
    expect(calls.get(a.keyId)![0]!.tools.map((t) => t.name)).not.toContain('delegate_task');
  });

  it('권한이 없어 막히면 상위 에이전트를 알려 주고, 맡긴 일의 결과가 같은 대화로 돌아옵니다', async () => {
    const boss = addAgent('상위이', { delegation: { accept: true } });
    const worker = addAgent('하위이', { delegation: { send: true, supervisorId: boss.id }, deny: ['shell.exec'] });
    scripts.set(worker.keyId, (p, n) => {
      if (n === 1) return { tool: { name: 'shell_exec', input: { command: 'ls' } } };
      if (n === 2) return { tool: { name: 'delegate_task', input: { to: '상위이', task: '작업 폴더에서 ls 를 실행해 파일 목록을 알려 주세요.', reason: '셸 권한 없음' } } };
      if (n === 3) return { text: '상위이에게 맡겼습니다.' };
      return { text: `정리: ${lastUserText(p).includes('a.txt') ? 'a.txt 가 있습니다' : '결과 없음'}` };
    });
    scripts.set(boss.keyId, () => ({ text: '파일 목록: a.txt' }));

    app.manager.enqueue({ agentId: worker.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '파일 목록 알려줘', reply: null });
    await until(() => calls.get(worker.keyId)?.length === 4 && app.store.latestTask(worker.id)?.status === 'done', '위임 결과까지', 6000);

    const workerCalls = calls.get(worker.keyId)!;
    // 1) 셸이 막힌 결과에 상위 에이전트로 넘기는 길이 적혀 있습니다.
    expect(lastUserText(workerCalls[1]!)).toContain("상위 에이전트 '상위이'에게 delegate_task 로 맡길 수 있습니다");
    // 2) 상위 에이전트는 위임 요청을 받았습니다.
    expect(lastUserText(calls.get(boss.keyId)![0]!)).toContain('[위임 요청 · 하위이]');
    // 3) 결과는 원래 대화(웹 콘솔)로 돌아와 이어서 처리됩니다.
    expect(lastUserText(workerCalls[3]!)).toContain('[위임 결과 · 상위이 · 완료]');
    const consoleThread = app.store.listThreads(worker.id).find((t) => t.source === 'console')!;
    const items = app.store.listTimeline(consoleThread.id, 100);
    const card = items.find((i) => i.kind === 'delegate');
    expect(card?.data).toMatchObject({ to: boss.id, status: 'done', result: '파일 목록: a.txt' });
    expect(items[items.length - 1]).toMatchObject({ kind: 'agent', data: { text: '정리: a.txt 가 있습니다' } });
    expect(app.store.activeDelegations()).toEqual([]);
    const bossTask = app.store.listTasks(boss.id, 10)[0];
    expect(bossTask).toMatchObject({ origin: 'delegation', delegatedBy: worker.id, status: 'done' });
  });

  it('잠긴 권한(기본 금지 조항)에 막힌 경우에는 상위로 넘기라는 안내를 붙이지 않습니다', async () => {
    const boss = addAgent('상위둘', { delegation: { accept: true } });
    const worker = addAgent('하위둘', { delegation: { send: true, supervisorId: boss.id } });
    scripts.set(worker.keyId, (_p, n) => (n === 1 ? { tool: { name: 'fs_read', input: { path: '.env' } } } : { text: '못 읽었습니다' }));
    app.manager.enqueue({ agentId: worker.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '.env 읽어줘', reply: null });
    await until(() => app.store.latestTask(worker.id)?.status === 'done', '작업 끝');
    const result = lastUserText(calls.get(worker.keyId)![1]!);
    expect(result).toContain('비밀 파일');
    expect(result).not.toContain('delegate_task');
  });
});

describe('허용 폴더', () => {
  it('읽기·쓰기 폴더에는 쓰고, 읽기만 폴더 쓰기는 이유와 함께 막으며, 프롬프트에 절대 경로로 알려 줍니다', async () => {
    const D = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-allowed-')));
    fs.mkdirSync(path.join(D, 'w'));
    fs.mkdirSync(path.join(D, 'r'));
    try {
      const a = addAgent('정리이');
      app.manager.setFolders(a.id, [
        { path: path.join(D, 'w'), mode: 'write' },
        { path: path.join(D, 'r'), mode: 'read' },
      ]);
      scripts.set(a.keyId, (_p, n) => {
        if (n === 1) return { tool: { name: 'fs_write', input: { path: path.join(D, 'w', 'report.md'), content: '보고서' } } };
        if (n === 2) return { tool: { name: 'fs_write', input: { path: path.join(D, 'r', 'x.md'), content: '안 됨' } } };
        return { text: '끝' };
      });
      app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '정리해줘', reply: null });
      await until(() => app.store.latestTask(a.id)?.status === 'done', '작업 끝');

      expect(fs.readFileSync(path.join(D, 'w', 'report.md'), 'utf8')).toBe('보고서');
      expect(fs.existsSync(path.join(D, 'r', 'x.md'))).toBe(false);
      const c = calls.get(a.keyId)!;
      expect(lastUserText(c[2]!)).toContain('읽기만 허용된 폴더');
      expect(c[0]!.system[0]!.text).toContain(`- ${path.join(D, 'w')} (읽기·쓰기)`);
      expect(c[0]!.system[0]!.text).toContain(`- ${path.join(D, 'r')} (읽기만)`);
    } finally {
      fs.rmSync(D, { recursive: true, force: true });
    }
  });

  it('없는 폴더 · Switchboard 데이터 폴더는 저장하지 않습니다', () => {
    const a = addAgent('폴더이');
    expect(() => app.manager.setFolders(a.id, [{ path: path.join(os.tmpdir(), 'sb-no-such-dir-xyz'), mode: 'read' }])).toThrow('폴더가 없습니다');
    // 시험 환경은 데이터 폴더가 설치 폴더 안이라 설치 폴더 문구로 걸립니다. 어느 쪽이든 겹치면 거절합니다.
    expect(() => app.manager.setFolders(a.id, [{ path: app.config.dataDir, mode: 'read' }])).toThrow(/Switchboard (설치|데이터) 폴더.*와 겹쳐 허용할 수 없습니다/);
    expect(app.store.getAgent(a.id).folders).toEqual([]);
  });
});

describe('화면 제어', () => {
  // 실제 모듈 프로세스(권한 모델 안)로 도는 가짜 화면 모듈: 받은 동작을 기록하고, 스크린샷으로 1×1 PNG 를 돌려줍니다.
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  let modDir: string;
  const log = (): { action: string; input: Record<string, unknown> }[] => {
    const f = path.join(app.config.dataDir, 'module-data', 'fakescreen', 'actions.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  beforeAll(() => {
    modDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-fakescreen-')));
    const manifest = { id: 'fakescreen', name: '가짜 화면', version: '1.0.0', kind: 'module', entry: 'index.js', license: 'MIT', icon: 'screen', computer: { label: '시험 화면' }, permissions: { net: [], fsWrite: true, childProcess: false }, tools: [] };
    fs.writeFileSync(path.join(modDir, 'module.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name: 'fakescreen', private: true, type: 'module' }));
    fs.writeFileSync(
      path.join(modDir, 'index.js'),
      `import fs from 'node:fs';
import path from 'node:path';
let ctx;
export default {
  async activate(c) { ctx = c; },
  computer: {
    async run(action, input) {
      fs.appendFileSync(path.join(ctx.dataDir, 'actions.log'), JSON.stringify({ action, input }) + '\\n');
      if (action === 'screenshot') return { image: { data: '${PNG}', mediaType: 'image/png' } };
      if (action === 'left_click' && input.coordinate && input.coordinate[0] > 5000) throw new Error('coordinate (99999, 0)가 스크린샷 범위 밖입니다.');
      if (action === 'key' && input.text === 'stop') { const e = new Error('사용자가 마우스를 화면 왼쪽 위 모서리로 옮겨 화면 제어를 멈췄습니다.'); e.name = 'ComputerStopped'; throw e; }
      return { text: 'OK' };
    },
  },
  tools: {},
};
`,
    );
    app.registry.register(modDir, parseManifest(manifest, '시험 화면 모듈'), 'zip', null, { kind: 'module', createdBy: null, enabled: true });
  });

  afterAll(() => fs.rmSync(modDir, { recursive: true, force: true }));

  /** 화면 제어 승인 요청을 이번만 허용으로 바로 답합니다. 몇 번 물었는지 셉니다. */
  function autoApprove(): { count: () => number; off: () => void } {
    let n = 0;
    const off = app.bus.subscribe((e) => {
      if (e.type === 'approval.created' && e.approval.detail.permission === 'screen.control') {
        n += 1;
        void app.approvals.decide(e.approval.id, 'once');
      }
    });
    return { count: () => n, off };
  }

  const screenAgent = (name: string) => {
    const a = addAgent(name);
    app.store.connectModule(a.id, 'fakescreen', { targets: [], trigger: 'direct' });
    return a;
  };

  it('한 차례의 화면 동작을 순서대로 실행하고, 작업마다 한 번만 묻고, 결과에 도구 묶음 이름과 이미지를 붙입니다', async () => {
    fs.rmSync(path.join(app.config.dataDir, 'module-data', 'fakescreen', 'actions.log'), { force: true });
    const a = screenAgent('화면이');
    const approve = autoApprove();
    try {
      scripts.set(a.keyId, (_p, n) =>
        n === 1
          ? { tools: [{ name: 'screenshot', input: {}, toolset: 'computer' }, { name: 'left_click', input: { coordinate: [5, 5] }, toolset: 'computer' }, { name: 'key', input: { text: 'Return' }, toolset: 'computer' }] }
          : { text: '끝' },
      );
      app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '설정 창 열어줘', reply: null });
      await until(() => app.store.latestTask(a.id)?.status === 'done', '작업 끝', 8000);
      expect(approve.count()).toBe(1);
    } finally {
      approve.off();
    }

    const c = calls.get(a.keyId)!;
    expect(c[0]!.tools).toContainEqual({ type: 'computer_toolset_20260801' });
    expect(c[0]!.system[0]!.text).toContain('## 화면 제어');
    const results = [...c[1]!.messages].reverse().find((m) => m.role === 'user')!.content as Record<string, unknown>[];
    expect(results.map((r) => r['toolset_name'])).toEqual(['computer', 'computer', 'computer']);
    expect((results[0]!['content'] as Record<string, unknown>[])[0]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(results[1]!['content']).toEqual([{ type: 'text', text: 'OK' }]);
    expect(log().map((l) => l.action)).toEqual(['screenshot', 'left_click', 'key']);

    const thread = app.store.listThreads(a.id).find((t) => t.source === 'console')!;
    const card = app.store.listTimeline(thread.id, 50).find((i) => i.kind === 'screen');
    expect(card?.data).toMatchObject({ count: 3, ok: true });
    const image = String(card?.data['image']);
    expect(fs.existsSync(path.join(app.config.dataDir, 'screens', image))).toBe(true);
    // 작업이 끝나면 화면 잠금이 풀립니다.
    expect(app.manager.screenLocks.holder('fakescreen')).toBeNull();
  });

  it('앞선 동작이 실패하면 그 차례의 나머지는 실행하지 않고 정해진 문구로 답합니다', async () => {
    fs.rmSync(path.join(app.config.dataDir, 'module-data', 'fakescreen', 'actions.log'), { force: true });
    const a = screenAgent('실패이');
    const approve = autoApprove();
    try {
      scripts.set(a.keyId, (_p, n) =>
        n === 1 ? { tools: [{ name: 'left_click', input: { coordinate: [99999, 0] }, toolset: 'computer' }, { name: 'key', input: { text: 'Return' }, toolset: 'computer' }] } : { text: '좌표를 다시 보겠습니다' },
      );
      app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '눌러줘', reply: null });
      await until(() => app.store.latestTask(a.id)?.status === 'done', '작업 끝', 8000);
    } finally {
      approve.off();
    }
    const results = [...calls.get(a.keyId)![1]!.messages].reverse().find((m) => m.role === 'user')!.content as Record<string, unknown>[];
    expect(results[0]).toMatchObject({ toolset_name: 'computer', is_error: true });
    expect(String(results[0]!['content'])).toContain('스크린샷 범위 밖');
    expect(results[1]).toMatchObject({ toolset_name: 'computer', is_error: true, content: 'Not executed: an earlier computer action in this turn failed.' });
    expect(log().map((l) => l.action)).toEqual(['left_click']);
  });

  it('비상 정지(마우스를 왼쪽 위 모서리로)가 오면 작업을 멈추고 이유를 남깁니다', async () => {
    const a = screenAgent('정지이');
    const approve = autoApprove();
    try {
      scripts.set(a.keyId, () => ({ tools: [{ name: 'key', input: { text: 'stop' }, toolset: 'computer' }] }));
      app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '계속 눌러', reply: null });
      await until(() => app.store.latestTask(a.id)?.status === 'cancelled', '취소됨', 8000);
    } finally {
      approve.off();
    }
    expect(calls.get(a.keyId)).toHaveLength(1);
    const thread = app.store.listThreads(a.id).find((t) => t.source === 'console')!;
    expect(app.store.listTimeline(thread.id, 50).some((i) => i.kind === 'system' && String(i.data['text']).includes('왼쪽 위 모서리'))).toBe(true);
  });

  it('조용한 작업(하트비트)에는 화면 제어 도구를 열지 않습니다', async () => {
    const a = screenAgent('조용화면이');
    scripts.set(a.keyId, () => ({ text: 'NO_REPORT' }));
    app.manager.setAutonomy(a.id, { enabled: true, everyMinutes: 30, activeHours: null, checklist: '확인' }, null);
    app.manager.runHeartbeat(a.id, true);
    await until(() => events.some((e) => e.type === 'heartbeat.done' && e.agentId === a.id), 'heartbeat.done');
    expect(calls.get(a.keyId)![0]!.tools).not.toContainEqual({ type: 'computer_toolset_20260801' });
  });

  it('모델이 도구 묶음을 받지 않으면(400) 빼고 다시 보내고, 그 사실을 대화에 남깁니다', async () => {
    const a = screenAgent('옛모델이');
    const rejected = Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: "'claude-opus-4-6' does not support tool types: computer_toolset_20260801." } }, undefined, new Headers());
    scripts.set(a.keyId, (_p, n) => (n === 1 ? { error: rejected } : { text: '화면 없이 처리했습니다' }));
    app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '해줘', reply: null });
    await until(() => app.store.latestTask(a.id)?.status === 'done', '작업 끝', 8000);
    const c = calls.get(a.keyId)!;
    expect(c[0]!.tools).toContainEqual({ type: 'computer_toolset_20260801' });
    expect(c[1]!.tools).not.toContainEqual({ type: 'computer_toolset_20260801' });
    const thread = app.store.listThreads(a.id).find((t) => t.source === 'console')!;
    expect(app.store.listTimeline(thread.id, 50).some((i) => i.kind === 'system' && String(i.data['text']).includes('화면 제어 도구'))).toBe(true);
  });
});
