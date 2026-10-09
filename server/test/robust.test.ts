import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LimitError } from '../src/errors.ts';
import { buildServer } from '../src/http/server.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import { lastUserText, startHarness, until, type Harness } from './helpers/harness.ts';

// 무한 반복 · 쌓임을 고친 동작을 실제 실행기로 확인합니다. 모델 호출만 각본대로 답하는 가짜입니다.
let h: Harness;
beforeAll(async () => {
  h = await startHarness({ AGENT_QUEUE_MAX: '2' });
});
afterAll(async () => {
  await h.close();
});

const taskCount = (agentId: string): number => h.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE agent_id = :id', { id: agentId })?.n ?? -1;
const console_ = (agentId: string, text: string) => h.app.manager.enqueue({ agentId, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text, reply: null });

describe('⑧ 대기열 상한', () => {
  it('상한(2)까지는 받고, 넘으면 기록을 남기기 전에 이유와 함께 거절합니다', () => {
    const a = h.addAgent('줄이', { paused: true });
    console_(a.id, '하나');
    console_(a.id, '둘');
    let err: unknown;
    try {
      console_(a.id, '셋');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(LimitError);
    expect((err as LimitError).code).toBe('queue_full');
    expect((err as LimitError).message).toBe("'줄이'의 대기열이 가득 차(2건) 새 작업을 받지 않았습니다. 대기 중인 작업을 취소하거나 끝나기를 기다리세요.");
    expect(taskCount(a.id)).toBe(2);
    expect(h.app.manager.live(a.id)).toMatchObject({ queueLength: 2, queueMax: 2 });
  });

  it('채널 메시지가 가득 찬 대기열에 오면 오류 없이 버리고 활동에 남깁니다', () => {
    const a = h.addAgent('채널이', { paused: true });
    const manifest = parseManifest({ id: 'fakechan', name: '가짜 채널', version: '1.0.0', license: 'MIT', channel: { label: '가짜' } }, 'test');
    h.app.store.upsertModule({ id: manifest.id, kind: 'module', origin: 'builtin', dir: h.root, manifest, enabled: true, status: 'stopped', statusDetail: null, createdBy: null, report: null });
    h.app.store.connectModule(a.id, 'fakechan', { targets: [], trigger: 'all' });
    const msg = { target: '#ops', targetLabel: '#ops', userId: 'u1', userName: '사람', text: '안녕', direct: false };
    h.app.manager.route('fakechan', msg);
    h.app.manager.route('fakechan', msg);
    expect(() => h.app.manager.route('fakechan', msg)).not.toThrow();
    expect(taskCount(a.id)).toBe(2);
    expect(h.app.store.listActivity(5).find((x) => x.type === 'message.dropped')?.text).toBe('대기열이 가득 차(2건) 가짜 채널 #ops 메시지를 받지 않았습니다.');
  });
});

describe('⑦ 예약: 쌓지 않고 건너뜀', () => {
  const insert = (agentId: string) => h.app.store.insertSchedule({ agentId, spec: 'every 1m', prompt: '매출 보고', reply: null, enabled: true, nextRun: Date.now() - 1000, createdBy: 'user' });
  const due = (id: string) => h.app.db.run('UPDATE schedules SET next_run = :t WHERE id = :id', { id, t: Date.now() - 1000 });

  it('일시정지 중이면 넣지 않고 건너뜀 횟수와 이유를 남깁니다', () => {
    const a = h.addAgent('예약이', { paused: true });
    const s = insert(a.id);
    h.app.scheduler.tick();
    expect(taskCount(a.id)).toBe(0);
    expect(h.app.store.getSchedule(s.id)).toMatchObject({ skipped: 1 });
    expect(h.app.store.getSchedule(s.id).lastSkippedAt).not.toBeNull();
    expect(h.app.store.listActivity(3).find((x) => x.type === 'schedule.skipped')?.text).toBe('예약 건너뜀 · 1분마다 · 일시정지 중');
  });

  it('이전 실행이 아직 돌고 있으면 건너뛰고, 끝난 뒤에는 다시 넣습니다', async () => {
    const a = h.addAgent('바쁜이');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.scripts.set(a.keyId, (_p, call) => (call === 1 ? { text: '보고', wait: gate } : { text: '보고' }));
    const s = insert(a.id);
    h.app.scheduler.tick();
    await until(() => h.app.manager.live(a.id).running.length === 1, '첫 실행 시작');
    due(s.id);
    h.app.scheduler.tick();
    expect(taskCount(a.id)).toBe(1);
    expect(h.app.store.getSchedule(s.id).skipped).toBe(1);
    expect(h.app.store.listActivity(3).find((x) => x.type === 'schedule.skipped')?.text).toContain('이전 실행이 아직 끝나지 않음');
    release();
    await until(() => h.app.manager.live(a.id).running.length === 0 && h.app.store.latestTask(a.id)?.status === 'done', '첫 실행 끝');
    due(s.id);
    h.app.scheduler.tick();
    expect(taskCount(a.id)).toBe(2);
  });
});

describe('③ 승인 대기 중 작업 취소', () => {
  it('취소하면 승인을 기다리지 않고 바로 끝나며, 승인 요청은 작업 취소로 닫힙니다', async () => {
    const a = h.addAgent('승인이', { permissions: { 'shell.exec': { mode: 'ask', scope: [], always: [] } } });
    h.scripts.set(a.keyId, (_p, call) => (call === 1 ? { tool: { name: 'shell_exec', input: { command: 'echo hi' } } } : { text: '끝' }));
    const task = console_(a.id, '인사 출력');
    const approval = await until(() => h.app.store.listApprovals('pending').find((x) => x.taskId === task.id), '승인 요청');
    const t = Date.now();
    expect(h.app.manager.cancelTask(task.id)).toBe(true);
    await until(() => h.app.store.getTask(task.id).status === 'cancelled', '작업 취소');
    expect(Date.now() - t).toBeLessThan(2000);
    expect(h.app.store.getApproval(approval.id)).toMatchObject({ status: 'cancelled', decision: null, reason: '작업이 취소되어 승인 요청을 닫았습니다.' });
    const card = h.app.store.findTimelineByApproval(approval.id);
    expect(card?.data['status']).toBe('cancelled');
    expect(h.events.some((e) => e.type === 'approval.resolved' && e.approval.id === approval.id)).toBe(true);
    // 닫힌 요청은 나중에 결정할 수 없습니다.
    await expect(h.app.approvals.decide(approval.id, 'once')).rejects.toThrow('작업이 취소되어 닫힌 승인 요청입니다');
  });
});

describe('⑥ 위임 왕복 한도', () => {
  it('같은 요청에서 같은 에이전트에게는 3번까지 맡기고, 그다음은 이유와 함께 거절합니다', async () => {
    const boss = h.addAgent('총괄이', { delegation: { send: true } });
    const res = h.addAgent('조사원', { delegation: { accept: true } });
    h.scripts.set(res.keyId, () => ({ text: '조사 결과' }));
    h.scripts.set(boss.keyId, (p) => {
      const last = lastUserText(p);
      if (last.includes('이미 3번 맡겼습니다')) return { text: '직접 마무리합니다' };
      if (last.includes('맡겼습니다 (작업')) return { text: '맡겼어요' };
      return { tool: { name: 'delegate_task', input: { to: '조사원', task: '경쟁사 요금을 다시 조사해 주세요', reason: '권한 없음' } } };
    });
    console_(boss.id, '경쟁사 요금 조사');
    await until(() => (h.calls.get(boss.keyId) ?? []).some((p) => lastUserText(p).includes('이미 3번 맡겼습니다')), '네 번째 위임 거절', 10_000);
    expect(taskCount(res.id)).toBe(3);
    const cards = h.app.store.listThreads(boss.id).flatMap((t) => h.app.store.listTimeline(t.id, 100)).filter((i) => i.kind === 'delegate');
    expect(cards.map((c) => c.data['round'])).toEqual([1, 2, 3]);
    expect(cards.every((c) => c.data['maxRounds'] === 3)).toBe(true);
  });
});

describe('⑥ 서버 측 대화 압축이 되풀이될 때', () => {
  it('압축은 단계로 세지 않지만 4번 연달아 일어나면 이유와 함께 멈춥니다', async () => {
    const a = h.addAgent('압축이');
    h.scripts.set(a.keyId, () => ({ text: '요약', stop: 'compaction' }));
    const task = console_(a.id, '긴 일');
    await until(() => h.app.store.getTask(task.id).status === 'failed', '작업 실패');
    expect(h.app.store.getTask(task.id).error).toContain('서버 측 대화 압축이 3번 넘게 연달아 일어나 멈췄습니다');
    expect(h.calls.get(a.keyId)).toHaveLength(4);
  });
});

describe('관리 중인 프로젝트 (도구 · 프롬프트 · 하트비트)', () => {
  it('project_track 으로 등록하면 계기가 남고, 다음 요청의 시스템 프롬프트와 하트비트 점검에 들어갑니다', async () => {
    const a = h.addAgent('관리이');
    const ws = h.app.projects.areas(a)[0]!.root;
    fs.mkdirSync(path.join(ws, 'shop'));
    h.scripts.set(a.keyId, (_p, call) => (call === 1 ? { tool: { name: 'project_track', input: { path: 'shop', note: '주문 API 리팩터링', watch: true } } } : { text: 'NO_REPORT' }));
    const task = console_(a.id, 'shop 프로젝트 맡아 줘');
    await until(() => h.app.store.getTask(task.id).status === 'done', '등록 작업');
    const [p] = h.app.store.listProjects(a.id);
    expect(p).toMatchObject({ name: 'shop', note: '주문 API 리팩터링', watch: true, origin: 'instruction', auto: false });
    expect(p!.originDetail).toContain('웹 콘솔');
    const second = h.calls.get(a.keyId)![1]!;
    expect(second.system[0]!.text).toContain('## 관리 중인 프로젝트');
    expect(second.system[0]!.text).toContain(`- shop: ${path.join(ws, 'shop')} — 주문 API 리팩터링 (하트비트 점검)`);

    h.app.manager.setAutonomy(a.id, { enabled: true, everyMinutes: 30, activeHours: null, checklist: '테스트가 깨지면 알림' }, null);
    h.app.manager.runHeartbeat(a.id, true);
    await until(() => h.events.some((e) => e.type === 'heartbeat.done' && e.agentId === a.id), '하트비트');
    const hb = h.calls.get(a.keyId)!.at(-1)!;
    expect(lastUserText(hb)).toContain('점검할 프로젝트:');
    expect(lastUserText(hb)).toContain(`shop (${path.join(ws, 'shop')}): 주문 API 리팩터링`);
  });

  it('작업 폴더 밖 경로는 기본 금지 조항이 막고, 등록되지 않습니다', async () => {
    const a = h.addAgent('밖으로');
    h.scripts.set(a.keyId, (p, call) => (call === 1 ? { tool: { name: 'project_track', input: { path: '/etc' } } } : { text: lastUserText(p) }));
    const task = console_(a.id, '/etc 관리');
    await until(() => h.app.store.getTask(task.id).status === 'done', '작업');
    expect(h.app.store.listProjects(a.id)).toEqual([]);
    expect(lastUserText(h.calls.get(a.keyId)![1]!)).toContain('실행하지 않았습니다');
  });
});

describe('설정: 모듈 비밀값을 DB 에 두기', () => {
  it('저장한 값으로 모듈을 띄우고, 비밀값만 유출 검사에 넣습니다 (일반 값은 오탐 없음)', () => {
    const email = h.app.store.getModule('email');
    h.app.settings.saveModule(email, { EMAIL_IMAP_HOST: 'imap.example.com', EMAIL_USER: 'ops@example.com', EMAIL_PASSWORD: 'app-password-9876' });
    expect(h.app.registry.settings(email.manifest).values).toMatchObject({ EMAIL_IMAP_HOST: 'imap.example.com', EMAIL_PASSWORD: 'app-password-9876' });
    const send = (text: string) => h.app.hooks.run({ event: 'before_send', agentId: null, agentName: 't', taskId: null, now: new Date(), channel: 'discord', target: '#ops', text, perMinute: 1000 });
    expect(send('비밀번호는 app-password-9876 입니다').decision).toBe('deny');
    expect(send('메일 서버는 imap.example.com 입니다').decision).toBe('allow');
  });
});

describe('HTTP: 키 · 설정 · 프로젝트', () => {
  let server: FastifyInstance;
  let cookie = '';
  beforeAll(async () => {
    server = await buildServer(h.app);
    const r = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'harness-test-password' } });
    cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
  });
  afterAll(async () => {
    await server.close();
  });
  const req = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => server.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  it('쓰는 에이전트가 있는 키는 지울 수 없고, 쓰지 않는 키는 지우면서 메모리 연결도 비웁니다', async () => {
    const a = h.addAgent('키쓰는이');
    const used = await req('DELETE', `/api/keys/${a.keyId}`);
    expect(used.statusCode).toBe(409);
    expect(used.json().error.message).toBe(`키쓰는이이(가) 쓰는 중이라 'test 키쓰는이' 키를 지울 수 없습니다. 먼저 그 에이전트의 키를 바꾸세요.`);
    const spare = h.app.store.insertKey({ label: '남는 키', source: 'stored', cipher: 'x', last4: '1111' }, null);
    let forgot = '';
    const original = h.app.anthropic.forget.bind(h.app.anthropic);
    h.app.anthropic.forget = (id: string) => {
      forgot = id;
      original(id);
    };
    expect((await req('DELETE', `/api/keys/${spare.id}`)).statusCode).toBe(200);
    expect(forgot).toBe(spare.id);
    expect(h.app.store.listKeys().some((k) => k.id === spare.id)).toBe(false);
  });

  it('설정 화면 데이터: .env 값은 보이지 않고 설정됨만, 모듈 비밀값은 끝 4자리만', async () => {
    const r = await req('GET', '/api/settings');
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(JSON.stringify(body)).not.toContain('harness-test-password');
    expect(JSON.stringify(body)).not.toContain('app-password-9876');
    const email = body.modules.find((m: { id: string }) => m.id === 'email');
    expect(email.fields.find((f: { name: string }) => f.name === 'EMAIL_PASSWORD')).toMatchObject({ source: 'db', last4: '9876', value: null });
  });

  it('모듈 설정 저장 API: 모르는 이름은 400 과 정확한 이유', async () => {
    const r = await req('PUT', '/api/modules/email/settings', { values: { NOPE: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe("'이메일' 모듈에는 'NOPE' 설정이 없습니다. module.json 의 env 에 선언된 이름만 넣을 수 있습니다.");
  });

  it('프로젝트 API: 화면 등록 → 목록 → 점검 켜기 → 빼기', async () => {
    const a = h.addAgent('화면등록');
    const ws = h.app.projects.areas(a)[0]!.root;
    fs.mkdirSync(path.join(ws, 'blog'));
    const created = await req('POST', '/api/projects', { agentId: a.id, path: '작업 폴더/blog', note: '블로그 초안' });
    expect(created.statusCode).toBe(201);
    const id = created.json().project.id as string;
    expect(created.json().project).toMatchObject({ origin: 'manual', displayPath: '작업 폴더/blog', status: 'ok', mode: 'write' });
    expect((await req('GET', '/api/projects')).json().projects.some((p: { id: string }) => p.id === id)).toBe(true);
    expect((await req('PATCH', `/api/projects/${id}`, { watch: true })).json().project.watch).toBe(true);
    expect((await req('PATCH', `/api/projects/${id}`, { watch: 'yes' })).statusCode).toBe(400);
    const detail = (await req('GET', `/api/projects/${id}`)).json();
    expect(detail).toMatchObject({ git: null, events: [] });
    expect((await req('DELETE', `/api/projects/${id}`)).statusCode).toBe(200);
    expect(fs.existsSync(path.join(ws, 'blog'))).toBe(true);
  });

  it('대화 기록 나눠 읽기: more 는 limit 만큼 꽉 찼을 때만', async () => {
    const a = h.addAgent('기록이');
    const thread = h.app.store.getOrCreateThread(a.id, 'console', '웹 콘솔');
    for (let i = 0; i < 5; i += 1) h.app.store.addTimeline(thread.id, null, 'user', { text: `${i}` });
    const page = (await req('GET', `/api/agents/${a.id}/timeline?limit=3`)).json();
    expect(page.items.map((i: { data: { text: string } }) => i.data.text)).toEqual(['2', '3', '4']);
    expect(page.more).toBe(true);
    const older = (await req('GET', `/api/agents/${a.id}/timeline?limit=3&before=${page.items[0].id}`)).json();
    expect(older.items.map((i: { data: { text: string } }) => i.data.text)).toEqual(['0', '1']);
    expect(older.more).toBe(false);
  });
});

describe('⑥ 위임: 한 작업에서 서로 다른 일 여러 건', () => {
  // 맡은 쪽을 일시정지해 결과가 돌아오지 않게 하고, 대기열 상한(2)과 섞이지 않도록 따로 띄웁니다.
  let h2: Harness;
  beforeAll(async () => {
    h2 = await startHarness();
  });
  afterAll(async () => {
    await h2.close();
  });

  it('건마다 따로 세어 5건 모두 맡겨지고(카드마다 1번째), 왕복 한도에 걸리지 않습니다', async () => {
    const boss = h2.addAgent('분배이', { delegation: { send: true } });
    const res = h2.addAgent('쉬는이', { delegation: { accept: true }, paused: true });
    h2.scripts.set(boss.keyId, (_p, call) => (call <= 5 ? { tool: { name: 'delegate_task', input: { to: '쉬는이', task: `이슈 #${call} 의 버그를 고쳐 주세요`, reason: '코드 담당' } } } : { text: '5건 모두 맡겼습니다' }));
    const task = h2.app.manager.enqueue({ agentId: boss.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '새 이슈 5건 처리', reply: null });
    await until(() => h2.app.store.getTask(task.id).status === 'done', '작업 끝');
    expect(h2.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE agent_id = :id', { id: res.id })?.n).toBe(5);
    const results = h2.calls.get(boss.keyId)!.slice(1, 6).map((p) => lastUserText(p));
    expect(results.every((r) => r.includes("'쉬는이'에게 맡겼습니다"))).toBe(true);
    const cards = h2.app.store.listThreads(boss.id).flatMap((t) => h2.app.store.listTimeline(t.id, 100)).filter((i) => i.kind === 'delegate');
    expect(cards.map((c) => c.data['round'])).toEqual([1, 1, 1, 1, 1]);
  });
});
