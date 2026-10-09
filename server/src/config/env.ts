import path from 'node:path';
import { ConfigError } from '../errors.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Config {
  rootDir: string;
  host: string;
  port: number;
  publicUrl: string | null;
  trustProxy: boolean;
  logLevel: LogLevel;

  adminPassword: string;
  sessionSecret: string;
  sessionTtlHours: number;
  loginMaxAttempts: number;
  loginLockMinutes: number;

  dataDir: string;
  secretsKey: Buffer;

  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
  anthropicTimeoutMs: number;
  anthropicMaxRetries: number;
  modelsTimeoutMs: number;
  modelsCacheMinutes: number;
  refusalFallback: 'default' | 'off';
  agentMaxTokens: number;
  compaction: 'auto' | 'off';

  agentMaxConcurrency: number;
  approvalTimeoutMinutes: number;
  historyMaxMessages: number;
  shellTimeoutMs: number;
  shellOutputMaxBytes: number;
  httpToolTimeoutMs: number;
  httpToolMaxBytes: number;

  modulesDir: string;
  templatesDir: string;
  moduleCallTimeoutMs: number;
  moduleIdleTimeoutMs: number;
  moduleRestartMax: number;
  moduleRestartWindowMinutes: number;
  moduleSandbox: 'permission' | 'none';
  gitBin: string;

  guardFloodPerMinute: number;
  guardLoopRepeat: number;
}

type Env = Record<string, string | undefined>;

/** 값이 없거나 공백뿐이면 undefined. */
function raw(env: Env, name: string): string | undefined {
  const v = env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

class Reader {
  readonly issues: string[] = [];
  private readonly env: Env;
  constructor(env: Env) {
    this.env = env;
  }

  int(name: string, def: number, min: number, max: number): number {
    const v = raw(this.env, name);
    if (v === undefined) return def;
    if (!/^-?\d+$/.test(v)) {
      this.issues.push(`${name}: 정수여야 합니다. 현재 값 '${v}'`);
      return def;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      this.issues.push(`${name}: ${min} 이상 ${max} 이하여야 합니다. 현재 값 ${v}`);
      return def;
    }
    return n;
  }

  bool(name: string, def: boolean): boolean {
    const v = raw(this.env, name);
    if (v === undefined) return def;
    const lower = v.toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0') return false;
    this.issues.push(`${name}: true 또는 false 여야 합니다. 현재 값 '${v}'`);
    return def;
  }

  oneOf<T extends string>(name: string, def: T, allowed: readonly T[]): T {
    const v = raw(this.env, name);
    if (v === undefined) return def;
    if ((allowed as readonly string[]).includes(v)) return v as T;
    this.issues.push(`${name}: ${allowed.join(' | ')} 중 하나여야 합니다. 현재 값 '${v}'`);
    return def;
  }

  str(name: string, def: string): string {
    return raw(this.env, name) ?? def;
  }

  optional(name: string): string | null {
    return raw(this.env, name) ?? null;
  }

  requiredMin(name: string, minLength: number, hint: string): string {
    const v = raw(this.env, name);
    if (v === undefined) {
      this.issues.push(`${name}: 필수 값이 비어 있습니다. ${hint}`);
      return '';
    }
    if (v.length < minLength) {
      this.issues.push(`${name}: ${minLength}자 이상이어야 합니다. 현재 ${v.length}자입니다. ${hint}`);
      return v;
    }
    return v;
  }

  url(name: string): string | null {
    const v = raw(this.env, name);
    if (v === undefined) return null;
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      this.issues.push(`${name}: URL 형식이 아닙니다. 현재 값 '${v}' (예: https://agents.example.com)`);
      return null;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      this.issues.push(`${name}: http:// 또는 https:// 로 시작해야 합니다. 현재 프로토콜 '${u.protocol}'`);
      return null;
    }
    return v.replace(/\/+$/, '');
  }

  secretKey(name: string): Buffer {
    const v = raw(this.env, name);
    const hint = "'openssl rand -base64 32' 로 만든 값을 넣으세요.";
    if (v === undefined) {
      this.issues.push(`${name}: 필수 값이 비어 있습니다. ${hint}`);
      return Buffer.alloc(32);
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v) || v.length % 4 !== 0) {
      this.issues.push(`${name}: base64 형식이 아닙니다. ${hint}`);
      return Buffer.alloc(32);
    }
    const buf = Buffer.from(v, 'base64');
    if (buf.length !== 32) {
      this.issues.push(`${name}: base64로 풀었을 때 32바이트여야 합니다. 현재 ${buf.length}바이트입니다. ${hint}`);
      return Buffer.alloc(32);
    }
    return buf;
  }
}

/**
 * 환경 변수를 읽어 설정을 만듭니다. 잘못된 항목은 하나도 빠뜨리지 않고 모아서 ConfigError 로 던집니다.
 * 상대 경로는 저장소 루트(rootDir) 기준으로 풉니다.
 */
export function parseConfig(env: Env, rootDir: string): Config {
  const r = new Reader(env);
  const resolve = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(rootDir, p));

  const config: Config = {
    rootDir,
    host: r.str('HOST', '0.0.0.0'),
    port: r.int('PORT', 8787, 1, 65535),
    publicUrl: r.url('PUBLIC_URL'),
    trustProxy: r.bool('TRUST_PROXY', false),
    logLevel: r.oneOf('LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error'] as const),

    adminPassword: r.requiredMin('ADMIN_PASSWORD', 12, '관리자 로그인에 쓰는 비밀번호입니다.'),
    sessionSecret: r.requiredMin('SESSION_SECRET', 32, "'openssl rand -hex 32' 로 만든 값을 넣으세요."),
    sessionTtlHours: r.int('SESSION_TTL_HOURS', 168, 1, 8760),
    loginMaxAttempts: r.int('LOGIN_MAX_ATTEMPTS', 5, 1, 100),
    loginLockMinutes: r.int('LOGIN_LOCK_MINUTES', 15, 1, 1440),

    dataDir: resolve(r.str('DATA_DIR', './data')),
    secretsKey: r.secretKey('SECRETS_KEY'),

    anthropicApiKey: r.optional('ANTHROPIC_API_KEY'),
    anthropicBaseUrl: r.url('ANTHROPIC_BASE_URL'),
    anthropicTimeoutMs: r.int('ANTHROPIC_TIMEOUT_MS', 600000, 1000, 3600000),
    anthropicMaxRetries: r.int('ANTHROPIC_MAX_RETRIES', 2, 0, 10),
    modelsTimeoutMs: r.int('MODELS_TIMEOUT_MS', 10000, 1000, 120000),
    modelsCacheMinutes: r.int('MODELS_CACHE_MINUTES', 60, 1, 1440),
    refusalFallback: r.oneOf('ANTHROPIC_REFUSAL_FALLBACK', 'default', ['default', 'off'] as const),
    agentMaxTokens: r.int('AGENT_MAX_TOKENS', 64000, 256, 128000),
    compaction: r.oneOf('AGENT_COMPACTION', 'auto', ['auto', 'off'] as const),

    agentMaxConcurrency: r.int('AGENT_MAX_CONCURRENCY', 4, 1, 64),
    approvalTimeoutMinutes: r.int('APPROVAL_TIMEOUT_MINUTES', 30, 1, 10080),
    historyMaxMessages: r.int('HISTORY_MAX_MESSAGES', 200, 10, 10000),
    shellTimeoutMs: r.int('SHELL_TIMEOUT_MS', 60000, 1000, 3600000),
    shellOutputMaxBytes: r.int('SHELL_OUTPUT_MAX_BYTES', 65536, 1024, 10485760),
    httpToolTimeoutMs: r.int('HTTP_TOOL_TIMEOUT_MS', 20000, 1000, 300000),
    httpToolMaxBytes: r.int('HTTP_TOOL_MAX_BYTES', 262144, 1024, 10485760),

    modulesDir: resolve(r.str('MODULES_DIR', './modules')),
    templatesDir: resolve(r.str('TEMPLATES_DIR', './templates')),
    moduleCallTimeoutMs: r.int('MODULE_CALL_TIMEOUT_MS', 30000, 1000, 600000),
    moduleIdleTimeoutMs: r.int('MODULE_IDLE_TIMEOUT_MS', 600000, 10000, 86400000),
    moduleRestartMax: r.int('MODULE_RESTART_MAX', 5, 0, 100),
    moduleRestartWindowMinutes: r.int('MODULE_RESTART_WINDOW_MINUTES', 10, 1, 1440),
    moduleSandbox: r.oneOf('MODULE_SANDBOX', 'permission', ['permission', 'none'] as const),
    gitBin: r.str('GIT_BIN', 'git'),

    guardFloodPerMinute: r.int('GUARD_FLOOD_PER_MINUTE', 20, 1, 1000),
    guardLoopRepeat: r.int('GUARD_LOOP_REPEAT', 5, 2, 100),
  };

  if (r.issues.length > 0) throw new ConfigError(r.issues);
  return config;
}
