import path from 'node:path';
import { z } from 'zod';
import { ModuleError } from '../errors.ts';
import { matchHost } from '../permissions/match.ts';

export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

const ICONS = ['chat', 'plane', 'git', 'rss', 'doc', 'link', 'cube', 'globe', 'clock', 'bolt', 'mail', 'screen'] as const;

const jsonSchemaObject = z
  .object({
    type: z.literal('object', { error: "input_schema.type 은 'object' 여야 합니다." }),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

const toolSchema = z.object({
  name: z.string().regex(TOOL_NAME_RE, { error: '도구 이름은 영문 소문자로 시작하고 소문자·숫자·밑줄만, 64자 이하여야 합니다 (예: weather_now).' }),
  title: z.string().min(1).max(40).optional(),
  /** 코드에서 내보내는 함수 이름이 name 과 다를 때 (템플릿으로 만든 모듈 등) */
  handler: z.string().regex(/^[A-Za-z_$][\w$]*$/, { error: 'handler 는 자바스크립트 함수 이름이어야 합니다.' }).optional(),
  description: z.string().min(1, { error: '도구 설명(description)이 비어 있습니다. 모델이 언제 이 도구를 쓸지 판단하는 근거입니다.' }).max(1024),
  input_schema: jsonSchemaObject,
});

const isHttps = (v: string): boolean => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};
const httpsUrl = (what: string) => z.string().max(500).refine(isHttps, { error: `${what} 는 https:// 로 시작하는 주소여야 합니다.` });

/** OAuth 권한 범위 값 (예: repo, read:user, 'repo read:org' 처럼 공백으로 여러 개) */
const SCOPE_RE = /^[A-Za-z0-9_:./-]+(?: [A-Za-z0-9_:./-]+)*$/;
/** 서버에서 실행할 CLI 이름 (경로 없이 PATH 에서 찾음) 과 인자: 셸을 거치지 않고 그대로 넘깁니다 */
const CLI_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CLI_ARG_RE = /^[A-Za-z0-9._:/=-]{1,100}$/;

/**
 * 로그인으로 비밀값 받기: OAuth 기기 로그인(RFC 8628). 서버가 코드를 받아 화면에 보여 주고,
 * 사용자가 그 서비스에서 허락하면 받은 토큰을 tokenEnv 설정에 암호화해 넣습니다. 주소는 permissions.net 안이어야 합니다.
 */
const loginSchema = z.object({
  kind: z.literal('oauth-device', { error: "login.kind 는 'oauth-device' 여야 합니다 (OAuth 기기 로그인)." }),
  /** 설정 화면에 보일 이름 (예: GitHub 로그인) */
  label: z.string().min(1).max(40),
  deviceCodeUrl: httpsUrl('login.deviceCodeUrl'),
  tokenUrl: httpsUrl('login.tokenUrl'),
  /** OAuth 앱의 Client ID 를 담는 env 이름 (사용자가 설정에 넣음) */
  clientIdEnv: z.string().regex(ENV_NAME_RE, { error: 'login.clientIdEnv 는 env 이름 형식이어야 합니다.' }),
  /** 받은 토큰을 넣을 env 이름 (secret: true 로 선언한 항목) */
  tokenEnv: z.string().regex(ENV_NAME_RE, { error: 'login.tokenEnv 는 env 이름 형식이어야 합니다.' }),
  /** 고를 수 있는 권한 범위 (첫 번째가 기본) */
  scopes: z
    .array(z.object({ value: z.string().max(200).regex(SCOPE_RE, { error: "login.scopes 의 value 는 'repo' 나 'read:user repo' 같은 권한 범위여야 합니다." }), label: z.string().min(1).max(40) }))
    .min(1, { error: 'login.scopes 에 권한 범위를 하나 이상 적으세요.' })
    .max(5),
  /** 로그인한 계정 이름을 알아낼 곳 (GET · Bearer 토큰) 과 응답 JSON 의 필드 · 권한 범위를 알려 주는 응답 머리글 */
  account: z
    .object({
      url: httpsUrl('login.account.url'),
      field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/),
      scopesHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
    })
    .optional(),
  /** 사용자가 이 앱의 권한을 거둘 수 있는 페이지. {clientId} 는 Client ID 로 바뀝니다. */
  manageUrl: httpsUrl('login.manageUrl').optional(),
  /**
   * 서버에 설치된 CLI 의 로그인 가져오기 (예: gh auth token). 사용자가 서버 터미널에서 loginCommand 로 로그인해 두면
   * 그 토큰을 받아 tokenEnv 에 넣습니다. 기본 제공 모듈만 쓸 수 있습니다 (명령을 실행하므로).
   */
  cli: z
    .object({
      label: z.string().min(1).max(40),
      command: z.string().regex(CLI_NAME_RE, { error: 'login.cli.command 는 경로 없이 프로그램 이름만 적습니다 (예: gh).' }),
      args: z.array(z.string().regex(CLI_ARG_RE, { error: 'login.cli.args 에는 공백 · 따옴표 · 셸 기호 없이 낱말만 적습니다.' })).max(10),
      /** 사용자가 서버 터미널에서 먼저 할 로그인 명령 (안내 문구용) */
      loginCommand: z.string().min(1).max(100),
      installUrl: httpsUrl('login.cli.installUrl').optional(),
    })
    .optional(),
});

const envSchema = z.object({
  name: z.string().regex(ENV_NAME_RE, { error: '환경 변수 이름은 대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있습니다 (예: NOTION_TOKEN).' }),
  required: z.boolean().default(true),
  description: z.string().max(200).default(''),
  /** 설정 화면에 보일 짧은 이름 (없으면 name) */
  label: z.string().min(1).max(40).optional(),
  /** 비밀값(토큰 · 비밀번호)인지. 비밀값은 SECRETS_KEY 로 암호화해 저장하고 화면에는 끝 4자리만 보입니다. 없으면 이름으로 짐작합니다. */
  secret: z.boolean().optional(),
  /** 값을 만드는 곳(토큰 발급 페이지 등). 설정 화면과 '설정 필요' 안내에 링크로 보입니다. https 만 */
  url: z
    .string()
    .max(500)
    .refine(isHttps, { error: 'env 의 url 은 https:// 로 시작하는 주소여야 합니다 (값을 만드는 페이지).' })
    .optional(),
});

export const manifestSchema = z.object({
  id: z.string().regex(MODULE_ID_RE, { error: 'id 는 영문 소문자로 시작하고 소문자·숫자·하이픈만, 2~32자여야 합니다 (예: notion-sync).' }),
  name: z.string().min(1, { error: 'name 이 비어 있습니다.' }).max(40),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, { error: 'version 은 1.0.0 같은 형식이어야 합니다.' }),
  description: z.string().max(300).default(''),
  kind: z.enum(['module', 'skill']).default('module'),
  entry: z.string().default('index.js'),
  license: z.string().min(1, { error: 'license 가 비어 있습니다. MIT 같은 SPDX 식별자를 적으세요.' }),
  author: z.string().max(80).default(''),
  icon: z.enum(ICONS).default('cube'),
  channel: z
    .object({
      label: z.string().min(1).max(40),
      /** false 면 받기만 하는 채널 (예: 이메일). 전송 권한 · send_message · 보고 채널에서 빠집니다. */
      send: z.boolean().default(true),
    })
    .nullable()
    .default(null),
  /** 화면 제어 모듈: 연결된 에이전트에게 Claude 컴퓨터 사용 도구 묶음을 열어 주고, 그 동작을 export default 의 computer.run 으로 처리합니다. */
  computer: z
    .object({ label: z.string().min(1).max(40) })
    .nullable()
    .default(null),
  /** 기본 제공 모듈이 처음 등록될 때 켤지 (화면 제어처럼 위험한 모듈은 false) */
  defaultEnabled: z.boolean().default(true),
  env: z.array(envSchema).max(20).default([]),
  /** 비밀값을 붙여 넣는 대신 로그인으로 받을 수 있게 할 때 */
  login: loginSchema.nullable().default(null),
  permissions: z
    .object({
      net: z.array(z.string().min(1).max(200)).max(50).default([]),
      fsWrite: z.boolean().default(false),
      childProcess: z.boolean().default(false),
    })
    .default({ net: [], fsWrite: false, childProcess: false }),
  tools: z.array(toolSchema).max(30).default([]),
  tests: z
    .array(
      z.object({
        tool: z.string(),
        input: z.record(z.string(), z.unknown()),
        expectIncludes: z.string().optional(),
      }),
    )
    .max(10)
    .default([]),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestTool = Manifest['tools'][number];
export type ManifestLogin = NonNullable<Manifest['login']>;

function issuePath(p: readonly PropertyKey[]): string {
  return p.length === 0 ? '(최상위)' : p.map((x) => (typeof x === 'number' ? `[${x}]` : String(x))).join('.').replace(/\.\[/g, '[');
}

/** module.json 검증. 실패하면 어느 항목이 왜 틀렸는지 전부 담아 던집니다. */
export function parseManifest(raw: unknown, source: string): Manifest {
  const r = manifestSchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${issuePath(i.path)}: ${i.message}`);
    throw new ModuleError('manifest_invalid', `${source} 의 module.json 이 올바르지 않습니다.\n- ${lines.join('\n- ')}`, 400, { issues: lines });
  }
  const m = r.data;
  const entry = path.posix.normalize(m.entry);
  if (entry.startsWith('..') || path.posix.isAbsolute(entry) || !/\.(m?js)$/.test(entry)) {
    throw new ModuleError('manifest_entry', `${source}: entry '${m.entry}'는 모듈 폴더 안의 .js 또는 .mjs 파일이어야 합니다.`);
  }
  const names = new Set<string>();
  for (const t of m.tools) {
    if (names.has(t.name)) throw new ModuleError('manifest_tool_dup', `${source}: 도구 이름 '${t.name}'이(가) 두 번 선언되어 있습니다.`);
    names.add(t.name);
  }
  for (const t of m.tests) {
    if (!names.has(t.tool)) throw new ModuleError('manifest_test_tool', `${source}: 테스트가 선언되지 않은 도구 '${t.tool}'을(를) 부릅니다.`);
  }
  if (m.channel && m.computer) {
    throw new ModuleError('manifest_channel_computer', `${source}: channel 과 computer 는 함께 선언할 수 없습니다. 메시지 채널과 화면 제어는 서로 다른 모듈로 만드세요.`);
  }
  if (m.kind === 'skill' && m.computer) throw new ModuleError('manifest_skill_computer', `${source}: 스킬은 화면 제어(computer)를 선언할 수 없습니다.`);
  if (m.kind === 'skill' && m.tools.length !== 1) {
    throw new ModuleError('manifest_skill_tools', `${source}: 스킬은 도구를 정확히 하나 선언해야 합니다. 지금 ${m.tools.length}개입니다.`);
  }
  if (m.login) checkLogin(m, m.login, source);
  return { ...m, entry };
}

/** 로그인 선언 검사: 쓰는 env 가 선언되어 있고, 토큰 칸은 비밀값이며, 접속 주소는 permissions.net 안이어야 합니다. */
function checkLogin(m: Manifest, login: ManifestLogin, source: string): void {
  if (m.kind === 'skill') throw new ModuleError('manifest_login_skill', `${source}: 스킬은 login 을 선언할 수 없습니다.`);
  const env = (name: string) => m.env.find((e) => e.name === name);
  for (const [key, name] of [['clientIdEnv', login.clientIdEnv], ['tokenEnv', login.tokenEnv]] as const) {
    if (!env(name)) throw new ModuleError('manifest_login_env', `${source}: login.${key} 의 '${name}'이(가) env 에 선언되어 있지 않습니다.`);
  }
  if (login.clientIdEnv === login.tokenEnv) throw new ModuleError('manifest_login_env', `${source}: login.clientIdEnv 와 login.tokenEnv 는 서로 다른 env 여야 합니다.`);
  if (env(login.tokenEnv)?.secret !== true) {
    throw new ModuleError('manifest_login_secret', `${source}: login.tokenEnv '${login.tokenEnv}'는 받은 토큰을 담으므로 env 에 secret: true 로 선언해야 합니다.`);
  }
  const values = login.scopes.map((x) => x.value);
  if (new Set(values).size !== values.length) throw new ModuleError('manifest_login_scope', `${source}: login.scopes 에 같은 value 가 두 번 있습니다.`);
  const urls: [string, string][] = [['login.deviceCodeUrl', login.deviceCodeUrl], ['login.tokenUrl', login.tokenUrl], ...(login.account ? [['login.account.url', login.account.url] as [string, string]] : [])];
  for (const [what, url] of urls) {
    const host = new URL(url).hostname;
    if (!m.permissions.net.some((p) => matchHost(p, host))) {
      throw new ModuleError('manifest_login_host', `${source}: ${what} 의 ${host} 가 permissions.net 에 없습니다. 로그인도 선언한 도메인으로만 접속합니다.`);
    }
  }
}
