import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { describeHttpError, tokenKind } from '../../modules/github/lib.js';
import type { ModuleRow } from '../src/db/store.ts';
import type { ServerEvent } from '../src/events/bus.ts';
import { buildServer } from '../src/http/server.ts';
import { setupGuide } from '../src/modules/host.ts';
import { ModuleLoginService, NET_FAIL_MAX } from '../src/modules/login.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import { createLogger } from '../src/log.ts';
import { startHarness, until, type Harness } from './helpers/harness.ts';

// 모듈 로그인 (OAuth 기기 로그인 · RFC 8628): 받은 토큰을 모듈 설정에 암호화해 넣습니다.
// 로그인 서버는 가짜 fetch 로 바꾸고, 기다리는 시간은 가짜 시계로 셉니다.

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

const LOGIN = {
  kind: 'oauth-device',
  label: '서비스 로그인',
  deviceCodeUrl: 'https://example.com/login/device/code',
  tokenUrl: 'https://example.com/login/oauth/access_token',
  clientIdEnv: 'SVC_CLIENT_ID',
  tokenEnv: 'SVC_TOKEN',
  scopes: [
    { value: 'read write', label: '읽기·쓰기' },
    { value: 'read', label: '읽기만' },
  ],
  account: { url: 'https://api.example.com/user', field: 'login' },
  manageUrl: 'https://example.com/settings/connections/applications/{clientId}',
};
const manifestOf = (over: Record<string, unknown> = {}) => ({
  id: 'svc',
  name: '서비스',
  version: '1.0.0',
  license: 'MIT',
  env: [
    { name: 'SVC_TOKEN', label: '토큰', secret: true },
    { name: 'SVC_CLIENT_ID', label: 'Client ID', required: false, secret: false, url: 'https://example.com/settings/applications/new' },
  ],
  permissions: { net: ['api.example.com', 'example.com'] },
  login: LOGIN,
  ...over,
});

describe('module.json 의 login 선언', () => {
  const bad = (over: Record<string, unknown>) => () => parseManifest(manifestOf(over), 'svc');

  it('맞는 선언은 그대로 읽고, 없으면 null', () => {
    expect(parseManifest(manifestOf(), 'svc').login).toMatchObject({ kind: 'oauth-device', tokenEnv: 'SVC_TOKEN', scopes: LOGIN.scopes });
    expect(parseManifest(manifestOf({ login: undefined }), 'svc').login).toBeNull();
  });

  it.each([
    [{ login: { ...LOGIN, deviceCodeUrl: 'http://example.com/device' } }, 'login.deviceCodeUrl 는 https:// 로 시작하는 주소여야 합니다.'],
    [{ login: { ...LOGIN, kind: 'oauth-web' } }, "login.kind 는 'oauth-device' 여야 합니다"],
    [{ login: { ...LOGIN, scopes: [] } }, 'login.scopes 에 권한 범위를 하나 이상 적으세요.'],
    [{ login: { ...LOGIN, scopes: [{ value: 'repo;rm -rf', label: '이상함' }] } }, "login.scopes 의 value 는 'repo' 나 'read:user repo' 같은 권한 범위여야 합니다."],
    [{ login: { ...LOGIN, tokenUrl: 'https://evil.test/token' } }, 'svc: login.tokenUrl 의 evil.test 가 permissions.net 에 없습니다. 로그인도 선언한 도메인으로만 접속합니다.'],
    [{ login: { ...LOGIN, account: { url: 'https://other.test/me', field: 'login' } } }, 'login.account.url 의 other.test 가 permissions.net 에 없습니다'],
    [{ login: { ...LOGIN, tokenEnv: 'NOPE_TOKEN' } }, "svc: login.tokenEnv 의 'NOPE_TOKEN'이(가) env 에 선언되어 있지 않습니다."],
    [{ login: { ...LOGIN, clientIdEnv: 'SVC_TOKEN' } }, 'login.clientIdEnv 와 login.tokenEnv 는 서로 다른 env 여야 합니다.'],
    [{ login: { ...LOGIN, scopes: [LOGIN.scopes[0], { value: 'read write', label: '또' }] } }, 'login.scopes 에 같은 value 가 두 번 있습니다.'],
    [{ env: [{ name: 'SVC_TOKEN' }, { name: 'SVC_CLIENT_ID', required: false }] }, "svc: login.tokenEnv 'SVC_TOKEN'는 받은 토큰을 담으므로 env 에 secret: true 로 선언해야 합니다."],
  ])('틀린 선언 %# 은 이유와 함께 거절', (over, message) => {
    expect(bad(over)).toThrow(message);
  });

  it('스킬은 login 을 선언할 수 없습니다', () => {
    const tool = { name: 'svc_do', description: '한다', input_schema: { type: 'object' } };
    expect(bad({ kind: 'skill', tools: [tool] })).toThrow('svc: 스킬은 login 을 선언할 수 없습니다.');
  });
});

describe('GitHub 모듈의 로그인 선언과 문구', () => {
  it('GitHub 로그인: 비공개 포함 · 공개만, 토큰은 GITHUB_TOKEN (비밀값), github.com 도 허용 도메인', () => {
    const m = parseManifest(JSON.parse(fs.readFileSync(path.join(repoRoot, 'modules', 'github', 'module.json'), 'utf8')), 'github');
    expect(m.login).toMatchObject({ label: 'GitHub 로그인', clientIdEnv: 'GITHUB_OAUTH_CLIENT_ID', tokenEnv: 'GITHUB_TOKEN', deviceCodeUrl: 'https://github.com/login/device/code', tokenUrl: 'https://github.com/login/oauth/access_token' });
    expect(m.login?.scopes.map((s) => s.value)).toEqual(['repo', 'public_repo']);
    expect(m.permissions.net).toEqual(['api.github.com', 'github.com']);
    expect(m.env.find((e) => e.name === 'GITHUB_OAUTH_CLIENT_ID')).toMatchObject({ required: false, secret: false, url: 'https://github.com/settings/applications/new' });
  });

  it('로그인 토큰(gho_)이면 401 · 403 · 404 문구가 로그인 기준', () => {
    expect(tokenKind('gho_abc')).toBe('oauth');
    expect(tokenKind('github_pat_abc')).toBe('pat');
    expect(tokenKind('ghp_abc')).toBe('pat');
    const h = (scopes?: string) => new Headers(scopes === undefined ? {} : { 'x-oauth-scopes': scopes });
    expect(describeHttpError(401, { message: 'Bad credentials' }, h(), { auth: 'oauth' })).toBe('GitHub 로그인이 풀렸습니다 (401). 설정 화면의 GitHub 모듈에서 다시 로그인하세요.');
    expect(describeHttpError(404, { message: 'Not Found' }, h('public_repo'), { repo: 'o/secret', auth: 'oauth' })).toBe(
      "'o/secret'을(를) 찾을 수 없습니다 (404). 이름이 맞는지 확인하세요. 로그인할 때 '공개 저장소만' 허락해 비공개 저장소는 보이지 않습니다. 비공개 저장소를 쓰려면 '비공개 저장소 포함'으로 다시 로그인하세요.",
    );
    expect(describeHttpError(404, { message: 'Not Found' }, h('repo, gist'), { repo: 'o/r', auth: 'oauth' })).toBe("'o/r'을(를) 찾을 수 없습니다 (404). 이름이 맞는지 확인하세요.");
    expect(describeHttpError(403, { message: 'Must have admin rights' }, h('repo'), { repo: 'o/r', what: '#3', auth: 'oauth' })).toBe(
      "로그인한 계정에 이 작업 권한이 없습니다 (403 #3). 'o/r'에 쓰기 권한이 있는지, 조직이 OAuth 앱 접근을 막지 않았는지 확인하세요. 로그인 권한: repo GitHub: Must have admin rights",
    );
    // 붙여 넣은 토큰은 예전 문구 그대로
    expect(describeHttpError(401, {}, h(), {})).toBe('GitHub 토큰이 맞지 않거나 만료되었습니다 (401). 설정 화면의 GitHub 모듈에서 토큰을 새로 넣으세요.');
  });

  it("'설정 필요' 안내: 토큰이 비면 로그인으로도 받을 수 있다고 알림 (Client ID 처럼 다른 값은 아님)", () => {
    const m = parseManifest(JSON.parse(fs.readFileSync(path.join(repoRoot, 'modules', 'github', 'module.json'), 'utf8')), 'github');
    const cfg = { publicUrl: 'https://sb.example', host: '127.0.0.1', port: 8787 };
    expect(setupGuide(cfg, m, ['GITHUB_TOKEN'])).toContain(" · 또는 설정 화면의 'GitHub 로그인'(으)로 받기)");
    expect(setupGuide(cfg, m, ['GITHUB_REPOS'])).not.toContain('로그인');
  });
});

/* ───────── 로그인 진행 ───────── */

type Call = { url: string; method: string; form: Record<string, string>; headers: Record<string, string> };
type Answer = [number, unknown] | Error;

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  h.app.login.shutdown();
  await h.close();
});

let seq = 0;
function addModule(over: Partial<ModuleRow> = {}, manifestOver: Record<string, unknown> = {}): ModuleRow {
  seq += 1;
  const manifest = parseManifest(manifestOf({ id: `svc${seq}`, ...manifestOver }), 'test');
  h.app.store.upsertModule({ id: manifest.id, kind: 'module', origin: 'builtin', dir: h.root, manifest, enabled: true, status: 'stopped', statusDetail: null, createdBy: null, report: null, ...over });
  return h.app.store.getModule(manifest.id);
}

/** 가짜 로그인 서버: 주소마다 정해 둔 답을 차례로 돌려주고, 요청을 기록합니다. */
function fakeServer(answers: { device?: Answer; token?: Answer[]; account?: Answer }) {
  const calls: Call[] = [];
  const tokens = [...(answers.token ?? [])];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const form = typeof init?.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    calls.push({ url, method: init?.method ?? 'GET', form, headers });
    let a: Answer | undefined;
    if (url === LOGIN.deviceCodeUrl) a = answers.device;
    else if (url === LOGIN.tokenUrl) a = tokens.shift();
    else if (url === LOGIN.account.url) a = answers.account;
    if (a === undefined) throw new Error(`각본에 없는 요청: ${url}`);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a[1]), { status: a[0], headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchFn, tokenCalls: () => calls.filter((c) => c.url === LOGIN.tokenUrl) };
}

const DEVICE_OK: Answer = [200, { device_code: 'dc-secret-1', user_code: 'WDJB-MJHT', verification_uri: 'https://example.com/login/device', expires_in: 900, interval: 5 }];
const pendingA: Answer = [200, { error: 'authorization_pending', error_description: 'The authorization request is still pending.' }];
const TOKEN = 'gho_TestTokenValue1234567890';
const tokenOk = (scope = 'read write'): Answer => [200, { access_token: TOKEN, token_type: 'bearer', scope }];

/** 기다림은 가짜 시계만 앞으로 돌리고 바로 끝납니다. */
function service(server: ReturnType<typeof fakeServer>) {
  const restarted: string[] = [];
  const svc = new ModuleLoginService({ store: h.app.store, settings: h.app.settings, bus: h.app.bus, log: createLogger('error'), restart: async (id) => void restarted.push(id) });
  const clock = { t: 1_000_000 };
  const waits: number[] = [];
  svc.fetch = server.fetchFn;
  svc.now = () => clock.t;
  svc.sleep = async (ms) => {
    waits.push(ms);
    clock.t += ms;
  };
  return { svc, restarted, clock, waits };
}

const withClient = (row: ModuleRow, clientId = 'Ov23liExampleClient'): void => {
  h.app.settings.saveModule(row, { SVC_CLIENT_ID: clientId });
};
const loginEvents = (moduleId: string) => h.events.filter((e): e is Extract<ServerEvent, { type: 'module.login' }> => e.type === 'module.login' && e.moduleId === moduleId).map((e) => e.state);
const ended = (svc: ModuleLoginService, row: ModuleRow) => until(() => svc.view(h.app.store.getModule(row.id))?.pending === null, '로그인 끝');

describe('로그인 진행', () => {
  beforeEach(() => {
    h.events.length = 0;
  });

  it('코드를 보여 주고, 허락하면 토큰을 암호화해 넣고 계정 · 권한을 기록한 뒤 모듈을 다시 시작합니다', async () => {
    const row = addModule();
    withClient(row);
    const server = fakeServer({ device: DEVICE_OK, token: [pendingA, pendingA, tokenOk()], account: [200, { login: 'octo' }] });
    const { svc, restarted, waits } = service(server);

    const view = await svc.start(row.id, 'read write');
    expect(view.pending).toEqual({ userCode: 'WDJB-MJHT', verificationUri: 'https://example.com/login/device', expiresAt: 1_000_000 + 900_000, scope: 'read write' });
    // 기기 코드는 화면에 보내지 않습니다.
    expect(JSON.stringify(view)).not.toContain('dc-secret-1');
    expect(server.calls[0]).toMatchObject({ method: 'POST', form: { client_id: 'Ov23liExampleClient', scope: 'read write' }, headers: { accept: 'application/json' } });

    await ended(svc, row);
    expect(server.tokenCalls().map((c) => c.form)).toEqual(Array(3).fill({ client_id: 'Ov23liExampleClient', device_code: 'dc-secret-1', grant_type: DEVICE_GRANT }));
    expect(waits).toEqual([5000, 5000, 5000]);
    expect(server.calls.at(-1)).toMatchObject({ url: LOGIN.account.url, headers: { authorization: `Bearer ${TOKEN}` } });

    const after = h.app.store.getModule(row.id);
    expect(h.app.settings.resolveModule(after.manifest).values['SVC_TOKEN']).toBe(TOKEN);
    const saved = h.app.store.listModuleSettings(row.id).find((s) => s.name === 'SVC_TOKEN');
    expect(saved).toMatchObject({ value: null, last4: TOKEN.slice(-4) });
    expect(saved?.cipher).not.toContain(TOKEN);
    expect(svc.view(after)).toMatchObject({ ready: true, pending: null, last: null, current: { account: 'octo', scope: 'read write' }, manageUrl: 'https://example.com/settings/connections/applications/Ov23liExampleClient' });
    expect(restarted).toEqual([row.id]);
    expect(loginEvents(row.id)).toEqual(['pending', 'done']);
    expect(h.app.store.listActivity(5).find((a) => a.moduleId === row.id)?.text).toBe('서비스 로그인 · @octo · 권한 read write');
    // 비밀값 유출 금지 조항이 바로 이 토큰을 알아봅니다 (다시 켜지 않아도).
    expect(h.app.settings.secretValues([after])).toContain(TOKEN);
    // 토큰은 이벤트 · 활동 어디에도 없습니다.
    expect(JSON.stringify(h.events)).not.toContain(TOKEN);
    expect(JSON.stringify(h.app.store.listActivity(20))).not.toContain(TOKEN);
  });

  it('꺼진 모듈은 토큰만 넣고 다시 시작하지 않습니다', async () => {
    const row = addModule({ enabled: false });
    withClient(row);
    const { svc, restarted } = service(fakeServer({ device: DEVICE_OK, token: [tokenOk()], account: [200, { login: 'octo' }] }));
    await svc.start(row.id, undefined);
    await ended(svc, row);
    expect(svc.view(h.app.store.getModule(row.id))?.current?.scope).toBe('read write');
    expect(restarted).toEqual([]);
  });

  it('slow_down: 알려 준 간격을 따르고, 없으면 5초 늘립니다', async () => {
    const row = addModule();
    withClient(row);
    const { svc, waits } = service(fakeServer({ device: DEVICE_OK, token: [[200, { error: 'slow_down', interval: 12 }], [200, { error: 'slow_down' }], tokenOk()], account: [200, { login: 'octo' }] }));
    await svc.start(row.id, 'read');
    await ended(svc, row);
    expect(waits).toEqual([5000, 12000, 17000]);
  });

  it.each([
    [[200, { error: 'expired_token' }], 'expired', '로그인 코드가 만료되었습니다. 다시 로그인을 누르세요.'],
    [[200, { error: 'token_expired' }], 'expired', '로그인 코드가 만료되었습니다. 다시 로그인을 누르세요.'],
    [[200, { error: 'access_denied' }], 'denied', 'example.com 에서 로그인을 거부했습니다.'],
    [[200, { error: 'device_flow_disabled' }], 'failed', "example.com 의 OAuth 앱에서 기기 로그인(Device Flow)이 꺼져 있습니다. 앱 설정에서 'Enable Device Flow'를 켜고 다시 누르세요."],
    [[200, { error: 'incorrect_device_code' }], 'failed', 'example.com 가 로그인 코드를 알아보지 못했습니다 (incorrect_device_code). 다시 로그인을 누르세요.'],
    [[400, { error: 'weird', error_description: '알 수 없음' }], 'failed', 'example.com 가 토큰을 주지 않았습니다 (400 · weird): 알 수 없음'],
  ] as [Answer, string, string][])('기다리다 %j 를 받으면 %s 로 끝내고 토큰을 넣지 않습니다', async (answer, state, message) => {
    const row = addModule();
    withClient(row);
    const { svc } = service(fakeServer({ device: DEVICE_OK, token: [pendingA, answer] }));
    await svc.start(row.id, 'read');
    await ended(svc, row);
    const view = svc.view(h.app.store.getModule(row.id));
    expect(view?.last).toMatchObject({ state, message });
    expect(view?.current).toBeNull();
    expect(h.app.settings.resolveModule(row.manifest).values['SVC_TOKEN']).toBeUndefined();
    expect(loginEvents(row.id)).toEqual(['pending', state]);
  });

  it('코드 유효 시간이 지나면 더 묻지 않고 만료로 끝냅니다', async () => {
    const row = addModule();
    withClient(row);
    const server = fakeServer({ device: [200, { device_code: 'dc', user_code: 'ABCD-EFGH', verification_uri: 'https://example.com/login/device', expires_in: 12, interval: 5 }], token: [pendingA, pendingA, pendingA] });
    const { svc, waits } = service(server);
    await svc.start(row.id, 'read');
    await ended(svc, row);
    expect(waits).toEqual([5000, 5000, 2000]);
    expect(server.tokenCalls()).toHaveLength(2);
    expect(svc.view(h.app.store.getModule(row.id))?.last?.state).toBe('expired');
  });

  it(`네트워크 오류는 넘기다가 ${NET_FAIL_MAX}번 이어지면 멈추고, 중간에 한 번이면 계속합니다`, async () => {
    const row = addModule();
    withClient(row);
    const down = new Error('getaddrinfo ENOTFOUND example.com');
    const a = service(fakeServer({ device: DEVICE_OK, token: Array(NET_FAIL_MAX).fill(down) }));
    await a.svc.start(row.id, 'read');
    await ended(a.svc, row);
    expect(a.svc.view(h.app.store.getModule(row.id))?.last?.message).toBe(
      `example.com 에 ${NET_FAIL_MAX}번 연달아 연결하지 못해 로그인을 멈췄습니다: getaddrinfo ENOTFOUND example.com. 서버의 인터넷 연결을 확인하고 다시 누르세요.`,
    );

    // 이어지지 않으면 세지 않습니다: 한도 바로 아래까지 실패 → 답 → 다시 한도 바로 아래까지 실패 → 토큰
    const almost = Array(NET_FAIL_MAX - 1).fill(down);
    const b = service(fakeServer({ device: DEVICE_OK, token: [...almost, pendingA, ...almost, tokenOk()], account: [200, { login: 'octo' }] }));
    await b.svc.start(row.id, 'read');
    await ended(b.svc, row);
    expect(b.svc.view(h.app.store.getModule(row.id))?.current?.account).toBe('octo');
  });

  it('계정 확인에서 토큰이 거절되면 넣지 않고, 확인 자체가 안 되면 계정 이름 없이 넣습니다', async () => {
    const row = addModule();
    withClient(row);
    const a = service(fakeServer({ device: DEVICE_OK, token: [tokenOk()], account: [401, { message: 'Bad credentials' }] }));
    await a.svc.start(row.id, 'read');
    await ended(a.svc, row);
    expect(a.svc.view(h.app.store.getModule(row.id))?.last?.message).toBe('받은 토큰을 api.example.com 가 거절했습니다 (401). 다시 로그인을 누르세요.');
    expect(h.app.settings.resolveModule(row.manifest).values['SVC_TOKEN']).toBeUndefined();

    const b = service(fakeServer({ device: DEVICE_OK, token: [tokenOk('read')], account: new Error('timeout') }));
    await b.svc.start(row.id, 'read');
    await ended(b.svc, row);
    expect(b.svc.view(h.app.store.getModule(row.id))?.current).toMatchObject({ account: null, scope: 'read' });
    expect(h.app.store.listActivity(5).find((x) => x.moduleId === row.id)?.text).toBe('서비스 로그인 · 계정 이름 모름 · 권한 read');
  });

  it('취소하면 더 묻지 않고, 다시 시작하면 이전 시도는 조용히 멈춥니다', async () => {
    const row = addModule();
    withClient(row);
    const server = fakeServer({ device: DEVICE_OK, token: [tokenOk()] });
    const { svc } = service(server);
    // 기다림이 취소될 때까지 끝나지 않게 하고, 어느 시도의 기다림인지 기록합니다.
    const signals: AbortSignal[] = [];
    svc.sleep = (_ms, signal) => {
      signals.push(signal);
      return new Promise((r) => signal.addEventListener('abort', () => r(), { once: true }));
    };
    await svc.start(row.id, 'read');
    expect(svc.cancel(row.id)).toMatchObject({ pending: null, last: { state: 'cancelled', message: '로그인을 취소했습니다.' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(server.tokenCalls()).toHaveLength(0);

    const again = fakeServer({ device: [200, { device_code: 'dc-2', user_code: 'ZZZZ-2222', verification_uri: 'https://example.com/login/device' }] });
    svc.fetch = again.fetchFn;
    await svc.start(row.id, 'read');
    await until(() => signals.length === 2, '두 번째 시도의 기다림');
    const third = fakeServer({ device: [200, { device_code: 'dc-3', user_code: 'YYYY-3333', verification_uri: 'https://example.com/login/device' }] });
    svc.fetch = third.fetchFn;
    const view = await svc.start(row.id, 'read');
    expect(view).toMatchObject({ pending: { userCode: 'YYYY-3333' }, last: null });
    // 앞선 시도는 멈췄고 (뒤늦게 받은 토큰을 넣지 않게), 마지막 시도만 기다립니다.
    await until(() => signals.length === 3, '세 번째 시도의 기다림');
    expect(signals.map((x) => x.aborted)).toEqual([true, true, false]);
    // 다시 시작은 사용자가 한 일이라 '취소됨' 기록을 남기지 않습니다.
    expect(loginEvents(row.id)).toEqual(['pending', 'cancelled', 'pending', 'pending']);
    svc.shutdown();
    expect(signals[2]?.aborted).toBe(true);
  });

  it.each([
    [[200, { error: 'device_flow_disabled' }], "example.com 의 OAuth 앱에서 기기 로그인(Device Flow)이 꺼져 있습니다. 앱 설정에서 'Enable Device Flow'를 켜고 다시 누르세요."],
    [[404, { error: 'Not Found' }], "example.com 에서 Client ID 'Ov23liExampleClient'인 OAuth 앱을 찾지 못했습니다 (404). OAuth 앱 설정에서 Client ID 를 다시 복사해 넣으세요."],
    [[401, { error: 'incorrect_client_credentials' }], "example.com 가 Client ID 'Ov23liExampleClient'를 받지 않았습니다 (incorrect_client_credentials). OAuth 앱 설정에서 Client ID 를 다시 복사해 넣으세요."],
    [[429, {}], 'example.com 가 요청이 잦다며 잠시 막았습니다 (429). 잠시 뒤 다시 누르세요.'],
    [[503, {}], 'example.com 서버 오류입니다 (503). 잠시 뒤 다시 누르세요.'],
    [[200, { device_code: 'dc', user_code: 'AB-CD', verification_uri: 'https://evil.test/device' }], 'example.com 가 알려 준 확인 주소(https://evil.test/device)가 https 가 아니거나 module.json 의 permissions.net 밖이라 쓰지 않았습니다.'],
    [[200, { device_code: 'dc', user_code: 'AB-CD', verification_uri: 'http://example.com/device' }], 'example.com 가 알려 준 확인 주소(http://example.com/device)가 https 가 아니거나 module.json 의 permissions.net 밖이라 쓰지 않았습니다.'],
    [[200, { device_code: 'dc', user_code: 'AB CD <b>', verification_uri: 'https://example.com/login/device' }], 'example.com 가 보낸 로그인 코드의 형식이 맞지 않습니다.'],
    [new Error('connect ECONNREFUSED'), 'example.com 에 연결하지 못했습니다: connect ECONNREFUSED. 서버의 인터넷 연결을 확인하세요.'],
  ] as [Answer, string][])('코드를 받지 못하면 시작하지 않고 이유를 알립니다 (%#)', async (device, message) => {
    const row = addModule();
    withClient(row);
    const { svc } = service(fakeServer({ device }));
    await expect(svc.start(row.id, 'read')).rejects.toThrow(message);
    expect(svc.view(h.app.store.getModule(row.id))?.pending).toBeNull();
  });

  it('Client ID 가 없거나 · 권한 범위가 틀리거나 · 로그인이 없는 모듈 · 승인 전 모듈이면 시작하지 않습니다', async () => {
    const { svc } = service(fakeServer({}));
    const empty = addModule();
    await expect(svc.start(empty.id, 'read')).rejects.toThrow("'Client ID'(SVC_CLIENT_ID)이(가) 비어 있어 로그인할 수 없습니다. 값을 넣고 저장한 뒤 다시 누르세요. 만드는 곳: https://example.com/settings/applications/new");
    expect(svc.view(empty)).toMatchObject({ ready: false, manageUrl: null });

    const row = addModule();
    withClient(row);
    await expect(svc.start(row.id, 'admin')).rejects.toThrow("권한 범위는 'read write'(읽기·쓰기) · 'read'(읽기만) 중 하나여야 합니다. 받은 값: \"admin\"");
    const plain = addModule({}, { login: undefined });
    await expect(svc.start(plain.id, 'read')).rejects.toThrow("'서비스' 모듈은 로그인을 지원하지 않습니다.");
    expect(svc.view(plain)).toBeNull();
    const pending = addModule({ status: 'pending' });
    withClient(pending);
    await expect(svc.start(pending.id, 'read')).rejects.toThrow("'서비스' 모듈은 설치를 승인하기 전이라 로그인할 수 없습니다.");
  });

  it('토큰을 손으로 바꾸면 로그인으로 받은 토큰으로 보지 않고, 기록도 지웁니다', async () => {
    const row = addModule({ enabled: false });
    withClient(row);
    const { svc } = service(fakeServer({ device: DEVICE_OK, token: [tokenOk()], account: [200, { login: 'octo' }] }));
    await svc.start(row.id, 'read');
    await ended(svc, row);
    expect(svc.view(h.app.store.getModule(row.id))?.current).not.toBeNull();
    // 기록을 지우지 않고 값만 바꿔도 지문이 달라 로그인 토큰으로 보지 않습니다.
    h.app.settings.saveModule(row, { SVC_TOKEN: 'github_pat_manual_value' });
    expect(svc.view(h.app.store.getModule(row.id))?.current).toBeNull();
    svc.tokenChanged(row, ['SVC_TOKEN']);
    expect(h.app.store.getSetting(`module-login:${row.id}`)).toBeNull();
  });
});

describe('로그인 API', () => {
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

  it('시작 → 설정 화면에 코드 · 남은 시간 → 취소, 토큰을 손으로 넣으면 로그인 기록을 지움, 로그인하지 않으면 401', async () => {
    const row = addModule({ enabled: false });
    withClient(row);
    const fake = fakeServer({ device: DEVICE_OK, token: [] });
    const realFetch = h.app.login.fetch;
    const realSleep = h.app.login.sleep;
    h.app.login.fetch = fake.fetchFn;
    h.app.login.sleep = (_ms, signal) => new Promise((r) => signal.addEventListener('abort', () => r(), { once: true }));
    try {
      expect((await server.inject({ method: 'POST', url: `/api/modules/${row.id}/login`, payload: { scope: 'read' } })).statusCode).toBe(401);
      const started = await server.inject({ method: 'POST', url: `/api/modules/${row.id}/login`, headers: { cookie }, payload: { scope: 'read' } });
      expect(started.statusCode).toBe(200);
      expect(started.body).not.toContain('dc-secret-1');
      expect(started.json().login.pending).toMatchObject({ userCode: 'WDJB-MJHT', verificationUri: 'https://example.com/login/device', scope: 'read' });

      const settings = (await server.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json() as { modules: { id: string; login: { pending: unknown; ready: boolean; scopes: unknown } | null }[] };
      const mine = settings.modules.find((m) => m.id === row.id);
      expect(mine?.login).toMatchObject({ ready: true, scopes: LOGIN.scopes, pending: { userCode: 'WDJB-MJHT' } });
      expect(settings.modules.find((m) => m.id === 'github')?.login).toMatchObject({ label: 'GitHub 로그인', ready: false, current: null });

      const cancelled = await server.inject({ method: 'DELETE', url: `/api/modules/${row.id}/login`, headers: { cookie } });
      expect(cancelled.json().login).toMatchObject({ pending: null, last: { state: 'cancelled' } });

      h.app.store.setSetting(`module-login:${row.id}`, { account: 'octo', scope: 'read', at: 1, fp: 'x' });
      const put = await server.inject({ method: 'PUT', url: `/api/modules/${row.id}/settings`, headers: { cookie }, payload: { values: { SVC_TOKEN: 'github_pat_by_hand' } } });
      expect(put.statusCode).toBe(200);
      expect(h.app.store.getSetting(`module-login:${row.id}`)).toBeNull();
    } finally {
      h.app.login.fetch = realFetch;
      h.app.login.sleep = realSleep;
    }
  });
});
