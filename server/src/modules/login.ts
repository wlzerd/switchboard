/**
 * 모듈 로그인: 비밀값을 붙여 넣는 대신 로그인으로 받습니다. module.json 의 login 선언대로 두 길이 있습니다.
 *  - OAuth 기기 로그인(RFC 8628): 서버가 로그인 코드를 받아 화면에 보여 주고, 사용자가 그 서비스에서 허락할 때까지 기다립니다.
 *  - 서버 CLI 로그인 가져오기(login.cli): 사용자가 서버 터미널에서 로그인해 둔 CLI(예: gh)에게서 토큰을 받습니다. 기본 제공 모듈만.
 * 받은 토큰은 모듈 설정(tokenEnv)에 암호화해 넣고 모듈을 다시 시작합니다. 토큰을 붙여 넣는 방식은 그대로 쓸 수 있습니다.
 * 기기 코드(device_code)와 토큰은 서버 밖(화면 · 로그 · 활동)으로 내보내지 않습니다. 기다리는 동안의 확인은 재귀 없이 반복문으로 합니다.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import type { ModuleRow, Store } from '../db/store.ts';
import { ConflictError, ModuleError, ValidationError } from '../errors.ts';
import type { EventBus } from '../events/bus.ts';
import type { Logger } from '../log.ts';
import { matchHost } from '../permissions/match.ts';
import type { SettingsService } from '../settings/service.ts';
import type { ManifestLogin } from './manifest.ts';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const USER_AGENT = 'Switchboard';
const REQUEST_TIMEOUT_MS = 15_000;
/** 로그인 코드 유효 시간이 오지 않았을 때 (GitHub 기본 15분) · 받아 줄 최대 */
const DEFAULT_EXPIRES_S = 900;
const MAX_EXPIRES_S = 1800;
/** 확인 간격이 오지 않았을 때 (RFC 8628 기본 5초) · 늘어나도 넘지 않을 값 */
const DEFAULT_INTERVAL_S = 5;
const MAX_INTERVAL_S = 60;
/** slow_down 이 새 간격을 알려 주지 않으면 늘릴 초 (RFC 8628) */
const SLOW_DOWN_S = 5;
/** 네트워크 오류가 이만큼 이어지면 기다리기를 그만둡니다 */
export const NET_FAIL_MAX = 5;
/** CLI 가 토큰을 알려 주기를 기다릴 시간 (키체인 확인 등) */
export const CLI_TIMEOUT_MS = 15_000;
/**
 * CLI 에 넘길 환경 변수: 자기 설정 · 키체인을 찾는 데 필요한 것만. 서버의 비밀값(.env)은 넘기지 않습니다.
 * GH_TOKEN 같은 토큰 변수도 넘기지 않아, 사용자가 터미널에서 로그인해 둔 계정의 토큰만 받습니다.
 */
export const CLI_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;

/** CLI 실행: 셸을 거치지 않고 정해 둔 인자만, 최소 환경으로 돌립니다. 표준 출력을 돌려줍니다. */
export function runCliDefault(command: string, args: readonly string[]): Promise<string> {
  const env: Record<string, string> = {};
  for (const k of CLI_ENV_KEYS) {
    const v = process.env[k];
    if (v !== undefined && v !== '') env[k] = v;
  }
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { env, timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr: String(stderr) }));
        return;
      }
      resolve(String(stdout));
    });
  });
}

export type LoginOutcome = 'expired' | 'denied' | 'failed' | 'cancelled';
export type LoginVia = 'device' | 'cli';

export interface LoginView {
  label: string;
  scopes: { value: string; label: string }[];
  clientIdEnv: string;
  tokenEnv: string;
  /** Client ID 가 설정되어 있어 로그인할 수 있는지 */
  ready: boolean;
  /** 이 앱의 권한을 거둘 수 있는 페이지 (Client ID 가 있을 때) */
  manageUrl: string | null;
  /** 지금 토큰이 로그인으로 받은 것일 때 (via: 기기 로그인 · 서버 CLI) */
  current: { account: string | null; scope: string; at: number; via: LoginVia } | null;
  /** 서버 CLI 로그인 가져오기 (기본 제공 모듈에서만) */
  cli: { label: string; command: string; loginCommand: string; installUrl: string | null } | null;
  /** 사용자가 허락하기를 기다리는 중 */
  pending: { userCode: string; verificationUri: string; expiresAt: number; scope: string } | null;
  /** 마지막으로 끝난 로그인 시도 (성공은 current 로 보임) */
  last: { state: LoginOutcome; message: string; at: number } | null;
}

/** 로그인으로 받은 토큰의 기록 (토큰 대신 지문만 둡니다. 지문이 지금 토큰과 다르면 손으로 바꾼 것) */
interface Saved {
  account: string | null;
  scope: string;
  at: number;
  fp: string;
  /** 없으면 기기 로그인 (예전 기록) */
  via?: LoginVia;
}

interface Session {
  moduleId: string;
  spec: ManifestLogin;
  clientId: string;
  scope: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
  abort: AbortController;
}

type Reply = { status: number; data: Record<string, unknown> | null };

export interface LoginDeps {
  store: Store;
  settings: SettingsService;
  bus: EventBus;
  log: Logger;
  /** 로그인한 뒤 모듈을 다시 시작합니다 (켜져 있을 때만 부름) */
  restart: (moduleId: string) => Promise<void>;
}

const metaKey = (moduleId: string): string => `module-login:${moduleId}`;
type CliError = NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: string };
const fingerprint = (token: string): string => crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

/** 로그인 코드를 받을 때의 오류 문구 */
function startError(r: Reply, host: string, clientId: string, scope: string): string {
  const code = str(r.data?.['error']);
  const desc = str(r.data?.['error_description']);
  if (code === 'device_flow_disabled') return `${host} 의 OAuth 앱에서 기기 로그인(Device Flow)이 꺼져 있습니다. 앱 설정에서 'Enable Device Flow'를 켜고 다시 누르세요.`;
  if (code === 'incorrect_client_credentials' || code === 'invalid_client' || code === 'unauthorized_client') {
    return `${host} 가 Client ID '${clientId}'를 받지 않았습니다 (${code}). OAuth 앱 설정에서 Client ID 를 다시 복사해 넣으세요.`;
  }
  if (code === 'invalid_scope') return `${host} 가 권한 범위 '${scope}'를 받지 않았습니다 (invalid_scope).`;
  if (r.status === 404) return `${host} 에서 Client ID '${clientId}'인 OAuth 앱을 찾지 못했습니다 (404). OAuth 앱 설정에서 Client ID 를 다시 복사해 넣으세요.`;
  if (r.status === 429 || code === 'slow_down') return `${host} 가 요청이 잦다며 잠시 막았습니다 (${r.status}). 잠시 뒤 다시 누르세요.`;
  if (r.status >= 500) return `${host} 서버 오류입니다 (${r.status}). 잠시 뒤 다시 누르세요.`;
  return `${host} 가 로그인 코드를 주지 않았습니다 (${r.status}${code ? ` · ${code}` : ''})${desc ? `: ${desc}` : '.'}`;
}

/** CLI 에게서 토큰을 받지 못한 이유 */
function cliError(err: CliError, cli: NonNullable<ManifestLogin['cli']>): ModuleError {
  const again = `서버를 실행하는 계정으로 '${cli.loginCommand}' 을 한 뒤 다시 누르세요.`;
  if (err.code === 'ENOENT') {
    return new ModuleError('module_login_cli_missing', `서버에 ${cli.command} 가 설치되어 있지 않습니다${cli.installUrl ? ` (설치: ${cli.installUrl})` : ''}. 설치하고 ${again}`, 409);
  }
  if (err.killed || err.signal === 'SIGTERM') return new ModuleError('module_login_cli_timeout', `${cli.command} 가 ${CLI_TIMEOUT_MS / 1000}초 안에 답하지 않았습니다 (키체인 잠금 등). ${again}`, 504);
  const line = (err.stderr ?? '').trim().split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 200) ?? '';
  return new ModuleError('module_login_cli_failed', `${cli.command} 에서 로그인 정보를 받지 못했습니다${line ? `: ${line}` : ` (${err.message.slice(0, 200)})`}. ${again}`, 409);
}

/** 토큰을 기다리다 끝난 이유 */
function pollEnd(r: Reply, host: string, clientId: string): [LoginOutcome, string] {
  const code = str(r.data?.['error']);
  const desc = str(r.data?.['error_description']);
  if (code === 'expired_token' || code === 'token_expired') return ['expired', '로그인 코드가 만료되었습니다. 다시 로그인을 누르세요.'];
  if (code === 'access_denied') return ['denied', `${host} 에서 로그인을 거부했습니다.`];
  if (code === 'device_flow_disabled') return ['failed', `${host} 의 OAuth 앱에서 기기 로그인(Device Flow)이 꺼져 있습니다. 앱 설정에서 'Enable Device Flow'를 켜고 다시 누르세요.`];
  if (code === 'incorrect_client_credentials' || code === 'invalid_client' || code === 'unauthorized_client') {
    return ['failed', `${host} 가 Client ID '${clientId}'를 받지 않았습니다 (${code}). OAuth 앱 설정에서 Client ID 를 다시 복사해 넣으세요.`];
  }
  if (code === 'incorrect_device_code' || code === 'invalid_grant') return ['failed', `${host} 가 로그인 코드를 알아보지 못했습니다 (${code}). 다시 로그인을 누르세요.`];
  if (code === 'unsupported_grant_type') return ['failed', `${host} 가 기기 로그인 방식을 받지 않았습니다 (unsupported_grant_type).`];
  return ['failed', `${host} 가 토큰을 주지 않았습니다 (${r.status}${code ? ` · ${code}` : ''})${desc ? `: ${desc}` : '.'}`];
}

export class ModuleLoginService {
  private readonly d: LoginDeps;
  private readonly sessions = new Map<string, Session>();
  private readonly last = new Map<string, NonNullable<LoginView['last']>>();
  /** 시험에서 바꿔 넣습니다 */
  fetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = abortableSleep;
  now: () => number = () => Date.now();
  runCli: (command: string, args: readonly string[]) => Promise<string> = runCliDefault;

  constructor(deps: LoginDeps) {
    this.d = deps;
  }

  view(row: ModuleRow): LoginView | null {
    const spec = row.manifest.login ?? null;
    if (!spec) return null;
    const values = this.d.settings.resolveModule(row.manifest).values;
    const clientId = values[spec.clientIdEnv]?.trim() ?? '';
    const saved = this.d.store.getSetting<Saved>(metaKey(row.id));
    const token = values[spec.tokenEnv];
    const s = this.sessions.get(row.id);
    return {
      label: spec.label,
      scopes: spec.scopes,
      clientIdEnv: spec.clientIdEnv,
      tokenEnv: spec.tokenEnv,
      ready: clientId !== '',
      manageUrl: spec.manageUrl && clientId ? spec.manageUrl.replace('{clientId}', encodeURIComponent(clientId)) : null,
      current: saved && token && fingerprint(token) === saved.fp ? { account: saved.account, scope: saved.scope, at: saved.at, via: saved.via ?? 'device' } : null,
      cli: spec.cli && row.origin === 'builtin' ? { label: spec.cli.label, command: spec.cli.command, loginCommand: spec.cli.loginCommand, installUrl: spec.cli.installUrl ?? null } : null,
      pending: s ? { userCode: s.userCode, verificationUri: s.verificationUri, expiresAt: s.expiresAt, scope: s.scope } : null,
      last: this.last.get(row.id) ?? null,
    };
  }

  /**
   * 서버 CLI 의 로그인 가져오기 (예: gh auth token). 기본 제공 모듈만, module.json 에 정해 둔 명령만 셸 없이 실행합니다.
   * 받은 토큰은 그 서비스에 확인한 뒤 넣습니다 (거절되면 넣지 않음).
   */
  async importCli(moduleId: string): Promise<LoginView> {
    const row = this.d.store.getModule(moduleId);
    const spec = row.manifest.login ?? null;
    const cli = spec?.cli;
    if (!spec || !cli) throw new ValidationError('module_login_cli_none', `'${row.manifest.name}' 모듈은 서버 로그인 가져오기를 지원하지 않습니다.`);
    if (row.origin !== 'builtin') throw new ValidationError('module_login_cli_origin', `서버 로그인 가져오기는 기본 제공 모듈만 쓸 수 있습니다. '${row.manifest.name}'은(는) 직접 설치한 모듈입니다.`);
    if (row.status === 'pending' || row.status === 'rejected') throw new ConflictError('module_login_state', `'${row.manifest.name}' 모듈은 설치를 승인하기 전이라 로그인할 수 없습니다.`);
    let out: string;
    try {
      out = await this.runCli(cli.command, cli.args);
    } catch (err) {
      throw cliError(err as CliError, cli);
    }
    const token = out.trim();
    if (token === '' || /\s/.test(token) || token.length > 500) {
      throw new ModuleError('module_login_cli_output', `${cli.command} 가 토큰을 알려 주지 않았습니다. 서버를 실행하는 계정으로 '${cli.loginCommand}' 을 한 뒤 다시 누르세요.`, 409);
    }
    const who = await this.lookupAccount(spec, token, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    if (who.rejected) {
      throw new ModuleError('module_login_cli_rejected', `${cli.command} 의 토큰을 ${who.host} 가 거절했습니다 (401). 서버를 실행하는 계정으로 '${cli.loginCommand}' 을 다시 한 뒤 누르세요.`, 409);
    }
    // 기다리던 기기 로그인은 조용히 멈춥니다.
    const s = this.sessions.get(moduleId);
    if (s) {
      this.sessions.delete(moduleId);
      s.abort.abort();
    }
    this.last.delete(moduleId);
    await this.keep(row, spec, token, who.account, who.scopes ?? '', 'cli', `${cli.command} 로그인 가져옴`);
    return this.view(this.d.store.getModule(moduleId)) as LoginView;
  }

  /** 로그인 시작: 로그인 코드를 받아 두고, 허락을 기다리는 일은 뒤에서 합니다. */
  async start(moduleId: string, rawScope: unknown): Promise<LoginView> {
    const row = this.d.store.getModule(moduleId);
    const spec = row.manifest.login ?? null;
    if (!spec) throw new ValidationError('module_login_none', `'${row.manifest.name}' 모듈은 로그인을 지원하지 않습니다.`);
    if (row.status === 'pending' || row.status === 'rejected') throw new ConflictError('module_login_state', `'${row.manifest.name}' 모듈은 설치를 승인하기 전이라 로그인할 수 없습니다.`);
    const scope = rawScope === undefined || rawScope === null || rawScope === '' ? spec.scopes[0]!.value : rawScope;
    if (typeof scope !== 'string' || !spec.scopes.some((x) => x.value === scope)) {
      throw new ValidationError('module_login_scope', `권한 범위는 ${spec.scopes.map((x) => `'${x.value}'(${x.label})`).join(' · ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(rawScope)}`);
    }
    const values = this.d.settings.resolveModule(row.manifest).values;
    const clientId = values[spec.clientIdEnv]?.trim() ?? '';
    if (clientId === '') {
      const e = row.manifest.env.find((x) => x.name === spec.clientIdEnv);
      throw new ValidationError(
        'module_login_client',
        `'${e?.label ?? spec.clientIdEnv}'(${spec.clientIdEnv})이(가) 비어 있어 로그인할 수 없습니다. 값을 넣고 저장한 뒤 다시 누르세요.${e?.url ? ` 만드는 곳: ${e.url}` : ''}`,
      );
    }

    // 이전 시도는 조용히 멈추고 새로 시작합니다.
    const old = this.sessions.get(moduleId);
    if (old) {
      this.sessions.delete(moduleId);
      old.abort.abort();
    }
    this.last.delete(moduleId);

    const host = new URL(spec.deviceCodeUrl).hostname;
    let r: Reply;
    try {
      r = await this.post(spec.deviceCodeUrl, { client_id: clientId, scope }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
    } catch (err) {
      throw new ModuleError('module_login_network', `${host} 에 연결하지 못했습니다: ${(err as Error).message}. 서버의 인터넷 연결을 확인하세요.`, 502);
    }
    const d = r.data;
    const deviceCode = str(d?.['device_code']);
    const userCode = str(d?.['user_code']);
    const verificationUri = str(d?.['verification_uri']);
    if (r.status < 200 || r.status >= 300 || str(d?.['error']) !== '' || deviceCode === '') {
      throw new ModuleError('module_login_start', startError(r, host, clientId, scope), 502);
    }
    if (!/^[\x21-\x7e]{1,32}$/.test(userCode) || deviceCode.length > 512) throw new ModuleError('module_login_start', `${host} 가 보낸 로그인 코드의 형식이 맞지 않습니다.`, 502);
    // 사용자를 보낼 주소도 선언한 도메인 안이어야 합니다 (다른 곳으로 이끄는 응답은 쓰지 않음).
    let verifyHost = '';
    try {
      const u = new URL(verificationUri);
      if (u.protocol === 'https:') verifyHost = u.hostname;
    } catch {
      // 아래에서 알립니다.
    }
    if (verifyHost === '' || !row.manifest.permissions.net.some((p) => matchHost(p, verifyHost))) {
      throw new ModuleError('module_login_verify_url', `${host} 가 알려 준 확인 주소(${verificationUri.slice(0, 120) || '없음'})가 https 가 아니거나 module.json 의 permissions.net 밖이라 쓰지 않았습니다.`, 502);
    }
    const num = (v: unknown, def: number, max: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(max, Math.round(v)) : def);
    const session: Session = {
      moduleId,
      spec,
      clientId,
      scope,
      deviceCode,
      userCode,
      verificationUri,
      expiresAt: this.now() + num(d?.['expires_in'], DEFAULT_EXPIRES_S, MAX_EXPIRES_S) * 1000,
      interval: num(d?.['interval'], DEFAULT_INTERVAL_S, MAX_INTERVAL_S),
      abort: new AbortController(),
    };
    this.sessions.set(moduleId, session);
    this.d.bus.emit({ type: 'module.login', moduleId, state: 'pending' });
    void this.wait(session);
    return this.view(this.d.store.getModule(moduleId)) as LoginView;
  }

  /** 기다리던 로그인을 그만둡니다. */
  cancel(moduleId: string): LoginView | null {
    const row = this.d.store.getModule(moduleId);
    const s = this.sessions.get(moduleId);
    if (s) this.end(s, 'cancelled', '로그인을 취소했습니다.');
    return this.view(row);
  }

  /** 설정 화면에서 토큰을 바꾸거나 지웠으면 로그인 기록도 지웁니다. */
  tokenChanged(row: ModuleRow, changed: readonly string[]): void {
    const spec = row.manifest.login ?? null;
    if (spec && changed.includes(spec.tokenEnv)) this.d.store.deleteSetting(metaKey(row.id));
  }

  /** 모듈을 지울 때 */
  forget(moduleId: string): void {
    const s = this.sessions.get(moduleId);
    if (s) {
      this.sessions.delete(moduleId);
      s.abort.abort();
    }
    this.last.delete(moduleId);
    this.d.store.deleteSetting(metaKey(moduleId));
  }

  shutdown(): void {
    for (const s of this.sessions.values()) s.abort.abort();
    this.sessions.clear();
  }

  /** 사용자가 허락할 때까지 정해진 간격으로 토큰을 물어봅니다. */
  private async wait(s: Session): Promise<void> {
    const host = new URL(s.spec.tokenUrl).hostname;
    let interval = s.interval;
    let netFails = 0;
    try {
      for (;;) {
        if (s.abort.signal.aborted) return;
        const left = s.expiresAt - this.now();
        if (left <= 0) return this.end(s, 'expired', '로그인 코드가 만료되었습니다. 다시 로그인을 누르세요.');
        await this.sleep(Math.min(interval * 1000, left), s.abort.signal);
        if (s.abort.signal.aborted) return;
        if (this.now() >= s.expiresAt) return this.end(s, 'expired', '로그인 코드가 만료되었습니다. 다시 로그인을 누르세요.');
        let r: Reply;
        try {
          r = await this.post(s.spec.tokenUrl, { client_id: s.clientId, device_code: s.deviceCode, grant_type: DEVICE_GRANT }, s.abort.signal);
        } catch (err) {
          if (s.abort.signal.aborted) return;
          netFails += 1;
          if (netFails >= NET_FAIL_MAX) {
            return this.end(s, 'failed', `${host} 에 ${NET_FAIL_MAX}번 연달아 연결하지 못해 로그인을 멈췄습니다: ${(err as Error).message}. 서버의 인터넷 연결을 확인하고 다시 누르세요.`);
          }
          continue;
        }
        netFails = 0;
        const token = str(r.data?.['access_token']);
        if (token !== '' && r.status >= 200 && r.status < 300) {
          await this.succeed(s, token, typeof r.data?.['scope'] === 'string' ? (r.data['scope'] as string) : s.scope);
          return;
        }
        const code = str(r.data?.['error']);
        if (code === 'authorization_pending') continue;
        if (code === 'slow_down') {
          const asked = r.data?.['interval'];
          const next = typeof asked === 'number' && Number.isFinite(asked) ? Math.round(asked) : interval + SLOW_DOWN_S;
          interval = Math.min(MAX_INTERVAL_S, Math.max(interval + 1, next));
          continue;
        }
        const [state, message] = pollEnd(r, host, s.clientId);
        return this.end(s, state, message);
      }
    } catch (err) {
      if (s.abort.signal.aborted) return;
      this.d.log.error('모듈 로그인을 마치지 못했습니다', { module: s.moduleId, error: (err as Error).message });
      this.end(s, 'failed', `로그인을 마치지 못했습니다: ${(err as Error).message}`);
    }
  }

  /** 기기 로그인으로 받은 토큰: 그 서비스에 확인한 뒤 넣습니다. */
  private async succeed(s: Session, token: string, granted: string): Promise<void> {
    const who = await this.lookupAccount(s.spec, token, AbortSignal.any([s.abort.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]));
    if (s.abort.signal.aborted) return;
    if (who.rejected) return this.end(s, 'failed', `받은 토큰을 ${who.host} 가 거절했습니다 (401). 다시 로그인을 누르세요.`);
    let row: ModuleRow;
    try {
      row = this.d.store.getModule(s.moduleId);
    } catch {
      return this.end(s, 'failed', '그 사이 모듈이 지워져 받은 토큰을 넣지 못했습니다.');
    }
    if (row.manifest.login?.tokenEnv !== s.spec.tokenEnv) return this.end(s, 'failed', '그 사이 모듈이 바뀌어 받은 토큰을 넣지 못했습니다. 다시 로그인을 누르세요.');
    if (this.sessions.get(s.moduleId) === s) this.sessions.delete(s.moduleId);
    await this.keep(row, s.spec, token, who.account, granted, 'device', `권한 ${granted || '(없음)'}`);
  }

  /**
   * 토큰으로 계정 이름 · 권한 범위를 알아봅니다 (login.account 가 있을 때).
   * 401 이면 rejected. 확인 자체가 안 되면(네트워크 등) 계정 이름 없이 넘어갑니다 — 모듈이 시작할 때 다시 확인합니다.
   */
  private async lookupAccount(spec: ManifestLogin, token: string, signal: AbortSignal): Promise<{ account: string | null; scopes: string | null; rejected: boolean; host: string }> {
    const acc = spec.account;
    if (!acc) return { account: null, scopes: null, rejected: false, host: '' };
    const host = new URL(acc.url).hostname;
    try {
      const res = await this.fetch(acc.url, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT }, signal });
      if (res.status === 401) return { account: null, scopes: null, rejected: true, host };
      if (!res.ok) return { account: null, scopes: null, rejected: false, host };
      const j = (await res.json()) as Record<string, unknown> | null;
      const v = j?.[acc.field];
      const scopes = acc.scopesHeader ? res.headers.get(acc.scopesHeader) : null;
      return { account: typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, 100) : null, scopes: scopes === null ? null : scopes.slice(0, 300), rejected: false, host };
    } catch {
      return { account: null, scopes: null, rejected: false, host };
    }
  }

  /** 토큰을 설정에 암호화해 넣고, 기록을 남기고, 켜져 있으면 모듈을 다시 시작합니다. */
  private async keep(row: ModuleRow, spec: ManifestLogin, token: string, account: string | null, scope: string, via: LoginVia, detail: string): Promise<void> {
    this.d.settings.saveModule(row, { [spec.tokenEnv]: token });
    this.d.store.setSetting(metaKey(row.id), { account, scope, at: this.now(), fp: fingerprint(token), via } satisfies Saved);
    this.d.bus.activity({ type: 'module.login', category: 'module', tone: 'pass', who: row.manifest.name, text: `${spec.label} · ${account ? `@${account}` : '계정 이름 모름'} · ${detail}`, moduleId: row.id });
    if (row.enabled && row.status !== 'pending' && row.status !== 'rejected') {
      await this.d.restart(row.id).catch(() => {
        // 시작하지 못한 이유는 모듈 상태에 남아 설정 화면에 보입니다.
      });
    }
    this.d.bus.emit({ type: 'module.login', moduleId: row.id, state: 'done' });
    this.d.bus.emit({ type: 'graph.changed' });
  }

  private end(s: Session, state: LoginOutcome, message: string): void {
    if (this.sessions.get(s.moduleId) === s) this.sessions.delete(s.moduleId);
    s.abort.abort();
    this.last.set(s.moduleId, { state, message, at: this.now() });
    this.d.bus.emit({ type: 'module.login', moduleId: s.moduleId, state });
  }

  private async post(url: string, form: Record<string, string>, signal: AbortSignal): Promise<Reply> {
    const res = await this.fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    const text = await res.text();
    let data: Record<string, unknown> | null = null;
    try {
      const j: unknown = JSON.parse(text);
      if (j && typeof j === 'object' && !Array.isArray(j)) data = j as Record<string, unknown>;
    } catch {
      // JSON 이 아니면 상태 코드로만 판단합니다.
    }
    return { status: res.status, data };
  }
}
