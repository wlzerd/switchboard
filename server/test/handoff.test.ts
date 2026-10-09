import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appLink } from '../src/config/env.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import { setupGuide } from '../src/modules/host.ts';
import { lastUserText, startHarness, until, type Harness } from './helpers/harness.ts';

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
    const system = h.calls.get(a.keyId)![0]!.system[0]!.text;
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
