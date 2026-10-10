import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appLink } from '../src/config/env.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import { setupGuide } from '../src/modules/host.ts';
import { lastUserText, startHarness, systemText, until, type Harness } from './helpers/harness.ts';

// 이슈 관리 에이전트(A)가 코드 일을 코드 담당(B)에게 넘기는 흐름과, 모듈 설정이 비었을 때의 '설정 필요' 안내.
let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const fakeChannel = (id: string, name: string) => {
  const manifest = parseManifest({ id, name, version: '1.0.0', license: 'MIT', channel: { label: name, send: false } }, 'test');
  h.app.store.upsertModule({ id, kind: 'module', origin: 'builtin', dir: h.root, manifest, enabled: true, status: 'stopped', statusDetail: null, createdBy: null, report: null });
};

describe('역할 기준 위임', () => {
  it('시스템 프롬프트에 위임 받을 에이전트의 역할과, 역할이 맞으면 맡기라는 규칙이 들어갑니다', async () => {
    const a = h.addAgent('관리이', { delegation: { send: true } });
    h.app.store.updateAgent(a.id, { role: '이메일 확인과 GitHub 이슈 관리' });
    const b = h.addAgent('코딩이', { delegation: { accept: true } });
    h.app.store.updateAgent(b.id, { role: '코드 작성 및 유지보수\n테스트를 꼭 돌린다' });
    h.scripts.set(a.keyId, () => ({ text: '확인했습니다' }));
    const task = h.app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '안녕', reply: null });
    await until(() => h.app.store.getTask(task.id).status === 'done', '작업 끝');
    const system = systemText(h.calls.get(a.keyId)![0]!);
    expect(system).toContain('- 코딩이: 코드 작성 및 유지보수\n');
    expect(system).toContain('- 위 목록에 그 일을 역할로 맡은 에이전트가 있으면 직접 하지 말고 delegate_task 로 그 에이전트에게 맡긴다. 네 역할에 맞는 일은 직접 한다.');
    expect(system).toContain('- 서로 다른 일이 여러 건이면 건마다 따로 맡긴다.');
    const tool = h.calls.get(a.keyId)![0]!.tools.find((t) => t.name === 'delegate_task') as { description?: string } | undefined;
    expect(tool?.description).toContain('서로 다른 일이 여러 건이면 건마다 따로 맡기고');
  });

  it('수신 전용 채널을 "도구만"으로 연결한 에이전트는 자동 알림을 받지 않고, "알림 받기"로 연결한 에이전트만 받습니다', async () => {
    fakeChannel('ghwatch', '깃허브 감시');
    const a = h.addAgent('알림이');
    const b = h.addAgent('도구만이');
    h.app.manager.setModules(a.id, [{ moduleId: 'ghwatch', targets: [], trigger: 'direct' }]);
    h.app.manager.setModules(b.id, [{ moduleId: 'ghwatch', targets: [], trigger: 'none' }]);
    expect(h.app.store.listAgentModules(b.id).find((l) => l.moduleId === 'ghwatch')?.config.trigger).toBe('none');
    h.scripts.set(a.keyId, () => ({ text: 'NO_REPORT' }));
    h.scripts.set(b.keyId, () => ({ text: 'NO_REPORT' }));
    h.app.manager.route('ghwatch', { target: 'octo/shop', targetLabel: 'octo/shop', userId: 'github', userName: 'GitHub', text: '[새 이슈 1건 · octo/shop]\n1. #3 결제 버튼', direct: true, quiet: true });
    await until(() => h.calls.get(a.keyId)?.length === 1, '알림 받기 쪽 모델 호출');
    expect(lastUserText(h.calls.get(a.keyId)![0]!)).toContain('[새 이슈 1건 · octo/shop]');
    expect(h.calls.get(b.keyId)).toBeUndefined();
    expect(h.app.manager.live(b.id).queueLength + h.app.manager.live(b.id).running.length).toBe(0);
  });
});

describe('모듈 설정이 비었을 때 (GitHub 토큰)', () => {
  it('도구를 부르면 설정 화면 · 토큰 발급 주소를 담은 이유를 받고, 대화에는 "설정 필요" 카드가 작업마다 한 번 남습니다', async () => {
    await h.app.registry.setEnabled('github', true);
    const github = h.app.store.getModule('github');
    // 모듈 상태에는 짧은 문구만 (주소 없이)
    expect(github.status).toBe('failed');
    expect(github.statusDetail).toBe("필요한 설정 '토큰'(GITHUB_TOKEN)이(가) 비어 있어 'GitHub' 모듈을 시작하지 못했습니다. 설정 화면의 모듈 항목에서 값을 넣으세요.");

    const c = h.addAgent('이슈봇');
    h.app.manager.setModules(c.id, [{ moduleId: 'github', targets: [], trigger: 'direct' }]);
    h.scripts.set(c.keyId, (p, call) => (call <= 2 ? { tool: { name: 'github_issue_list', input: { repo: 'octo/shop' } } } : { text: lastUserText(p) }));
    const task = h.app.manager.enqueue({ agentId: c.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '이슈 보여줘', reply: null });
    await until(() => h.app.store.getTask(task.id).status === 'done', '작업 끝');

    const toolResult = lastUserText(h.calls.get(c.keyId)![1]!);
    expect(toolResult).toContain("필요한 설정 '토큰'(GITHUB_TOKEN)이(가) 비어 있어");
    expect(toolResult).toContain(`설정 화면: ${appLink(h.app.config, '/settings/github')}`);
    expect(toolResult).toContain('토큰 만드는 곳: https://github.com/settings/personal-access-tokens/new?name=Switchboard');
    expect(toolResult).toContain('issues=write&pull_requests=write&contents=write');

    const thread = h.app.store.listThreads(c.id).find((t) => t.source === 'console')!;
    const cards = h.app.store.listTimeline(thread.id, 100).filter((i) => i.kind === 'setup');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.data).toMatchObject({ moduleId: 'github', moduleName: 'GitHub', icon: 'git', fields: [{ name: 'GITHUB_TOKEN', label: '토큰', state: 'empty' }] });
    expect(String((cards[0]!.data['fields'] as { url: string }[])[0]!.url)).toMatch(/^https:\/\/github\.com\/settings\/personal-access-tokens\/new\?/);
  });
});

describe('설정 화면 주소 · 안내', () => {
  it('PUBLIC_URL 이 있으면 그 주소, 없으면 서버 컴퓨터에서 여는 주소', () => {
    expect(appLink({ publicUrl: 'https://agents.example.com/', host: '0.0.0.0', port: 8787 }, '/settings/github')).toBe('https://agents.example.com/settings/github');
    expect(appLink({ publicUrl: null, host: '0.0.0.0', port: 8788 }, 'settings')).toBe('http://localhost:8788/settings');
    expect(appLink({ publicUrl: null, host: '127.0.0.1', port: 80 }, '/')).toBe('http://127.0.0.1:80/');
    expect(appLink({ publicUrl: null, host: '::1', port: 9000 }, '/x')).toBe('http://[::1]:9000/x');
    expect(appLink({ publicUrl: null, host: '::', port: 9000 }, '/x')).toBe('http://localhost:9000/x');
  });

  it('안내에는 비어 있는 설정의 발급 페이지만 붙습니다', () => {
    const manifest = { id: 'm', env: [{ name: 'A_TOKEN', label: '토큰', url: 'https://example.com/new', required: true, description: '' }, { name: 'B', required: false, description: '' }] };
    const cfg = { publicUrl: null, host: '0.0.0.0', port: 8787 };
    expect(setupGuide(cfg, manifest, ['A_TOKEN'])).toBe(' (설정 화면: http://localhost:8787/settings/m · 토큰 만드는 곳: https://example.com/new)');
    expect(setupGuide(cfg, manifest, ['B'])).toBe(' (설정 화면: http://localhost:8787/settings/m)');
  });

  it('module.json env 의 url 은 https 주소만 받습니다', () => {
    const base = { id: 'mx', name: 'x', version: '1.0.0', license: 'MIT' };
    expect(() => parseManifest({ ...base, env: [{ name: 'X_TOKEN', url: 'http://example.com' }] }, 'test')).toThrow('https://');
    expect(() => parseManifest({ ...base, env: [{ name: 'X_TOKEN', url: 'javascript:alert(1)' }] }, 'test')).toThrow('https://');
    expect(() => parseManifest({ ...base, env: [{ name: 'X_TOKEN', url: `https://example.com/${'a'.repeat(500)}` }] }, 'test')).toThrow();
    expect(parseManifest({ ...base, env: [{ name: 'X_TOKEN', url: 'https://example.com/new' }] }, 'test').env[0]?.url).toBe('https://example.com/new');
  });
});

describe('협조 에이전트(우선 후보)와 할 수 있는 에이전트 찾기', () => {
  // 후보 목록을 정확히 보려고 에이전트를 새로 띄운 환경에서 시험합니다.
  let h2: Harness;
  beforeAll(async () => {
    h2 = await startHarness();
  });
  afterAll(async () => {
    await h2.close();
  });
  const allow = { mode: 'allow' as const, scope: [], always: [] };
  const ask = { mode: 'ask' as const, scope: [], always: [] };

  it('프롬프트에 역할과 할 수 있는 일을, 막히면 그 일을 할 수 있는 에이전트를 알려 주고, 못 하는 에이전트에게 맡기면 한 번 막습니다', async () => {
    const dev = h2.addAgent('개발이', { delegation: { accept: true }, permissions: { 'shell.exec': allow } });
    h2.app.store.updateAgent(dev.id, { role: '코드 작성 및 유지보수' });
    const partner = h2.addAgent('협조가', { delegation: { accept: true }, deny: ['shell.exec'], paused: true });
    h2.app.store.updateAgent(partner.id, { role: '메일 정리' });
    h2.addAgent('검토이', { delegation: { accept: true }, permissions: { 'shell.exec': ask } });
    h2.addAgent('손님이', { permissions: { 'shell.exec': allow } });
    const a = h2.addAgent('요청이', { delegation: { send: true, supervisorId: partner.id }, deny: ['shell.exec'] });
    h2.scripts.set(a.keyId, (_p, call) => {
      if (call === 1) return { tool: { name: 'shell_exec', input: { command: 'npm test' } } };
      if (call === 2 || call === 3) return { tool: { name: 'delegate_task', input: { to: '협조가', task: '저장소에서 npm test 를 돌려 결과를 알려 주세요', reason: '셸 권한 없음' } } };
      return { text: '맡겼습니다' };
    });
    const task = h2.app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '테스트 돌려줘', reply: null });
    await until(() => h2.app.store.getTask(task.id).status === 'done', '작업 끝');
    const calls = h2.calls.get(a.keyId)!;

    // 1) 위임 목록: 역할 + 할 수 있는 일, 협조 에이전트 표시와 우선 규칙. 위임을 받지 않는 에이전트는 없음.
    const system = systemText(calls[0]!);
    expect(system).toMatch(/- 개발이: 코드 작성 및 유지보수\n {2}할 수 있음: [^\n]*셸 명령 허용/);
    expect(system).toMatch(/- 협조가 \(협조 에이전트 · 우선 후보\): 메일 정리\n {2}할 수 있음: [^\n]* · 못 함: [^\n]*셸 명령/);
    expect(system).toContain("맡을 수 있는 에이전트가 여럿이면 협조 에이전트 '협조가'을(를) 먼저 고른다.");
    expect(system).not.toContain('- 손님이');

    // 2) 셸이 막히면: 할 수 없는 협조 에이전트는 빼고, 바로 가능 → 승인 필요 순.
    expect(lastUserText(calls[1]!)).toContain('이 일을 할 수 있는 에이전트: 개발이(바로 가능), 검토이(승인 필요).');

    // 3) 막힌 일을 못 하는 에이전트에게 맡기면 한 번 막고 후보를 알려 줌 → 같은 요청을 다시 보내면 맡김.
    const rejected = lastUserText(calls[2]!);
    expect(rejected).toContain("'협조가'은(는) 방금 막힌 일(셸 명령 · npm test)을 할 수 없습니다");
    expect(rejected).toContain('할 수 있는 에이전트: 개발이(바로 가능), 검토이(승인 필요).');
    expect(lastUserText(calls[3]!)).toContain("'협조가'에게 맡겼습니다");
    expect(h2.app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE agent_id = :id', { id: partner.id })?.n).toBe(1);
  });

  it('위임을 받는 에이전트가 모두 그 일을 못 하면, 맡기지 말고 사용자에게 권한 변경을 요청하라고 안내합니다', async () => {
    const h3 = await startHarness();
    try {
      h3.addAgent('메일이', { delegation: { accept: true }, deny: ['shell.exec'] });
      const a = h3.addAgent('혼자서', { delegation: { send: true }, deny: ['shell.exec'] });
      h3.scripts.set(a.keyId, (_p, call) => (call === 1 ? { tool: { name: 'shell_exec', input: { command: 'make' } } } : { text: '못 합니다' }));
      const task = h3.app.manager.enqueue({ agentId: a.id, source: 'console', sourceLabel: '웹 콘솔', origin: 'console', text: '빌드', reply: null });
      await until(() => h3.app.store.getTask(task.id).status === 'done', '작업 끝');
      expect(lastUserText(h3.calls.get(a.keyId)![1]!)).toContain("위임을 받는 에이전트 중에도 이 일을 할 수 있는 에이전트가 없습니다 (모두 '셸 명령'이(가) 차단이거나 그 경로에 접근할 수 없음). 꼭 필요하면 사용자에게 권한을 바꿔 달라고 하세요.");
    } finally {
      await h3.close();
    }
  });
});
