/**
 * env 와 DB 의 구분.
 *  - .env: 서버가 켜지기 전에 필요하거나 DB 를 지키는 값 (로그인 · 암호화 키 · 주소 · 경로 · 서버 전체 한도). 화면에서는 읽기만 합니다.
 *  - DB(화면에서 관리): 모듈 비밀값 · 설정, 훅 값, Anthropic 키. 비밀값은 .env 의 SECRETS_KEY 로 암호화해 둡니다
 *    (DB 파일만 새어 나가서는 풀 수 없음). 예전처럼 .env 에 넣은 값도 계속 읽고, DB 에 값이 있으면 DB 가 먼저입니다.
 */
import crypto from 'node:crypto';
import type { Config } from '../config/env.ts';
import { decryptSecret, encryptSecret } from '../crypto/secrets.ts';
import type { AgentRow, ApiKeyRow, ModuleRow, Store } from '../db/store.ts';
import { ValidationError } from '../errors.ts';
import { envRefName } from '../hooks/rules.ts';
import type { Manifest } from '../modules/manifest.ts';

type EnvEntry = Manifest['env'][number];

/** 토큰 · 비밀번호처럼 보이는 이름 (module.json 에 secret 이 없을 때 짐작) */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS$|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

export function isSecretField(e: Pick<EnvEntry, 'name' | 'secret'>): boolean {
  return e.secret ?? SECRET_NAME.test(e.name);
}

/** 값 한 개의 최대 길이 */
export const SETTING_VALUE_MAX = 4000;
/** 훅 값 이름: $env:이름 으로 참조 */
export const HOOK_VAR_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

/** db: 화면에서 넣은 값 · env: .env 에서 읽는 값 · empty: 없음 · locked: 저장돼 있지만 SECRETS_KEY 로 풀 수 없음 */
export type FieldSource = 'db' | 'env' | 'empty' | 'locked';

export interface ModuleFieldView {
  name: string;
  label: string;
  description: string;
  required: boolean;
  secret: boolean;
  source: FieldSource;
  /** 비밀이 아닌 값 (비밀값은 보내지 않음) */
  value: string | null;
  /** 비밀값 끝 4자리 */
  last4: string | null;
  /** DB 에 값이 있는데 .env 에도 남아 있음 (지워도 됨) */
  envAlso: boolean;
  /** 값을 만드는 곳 (module.json env 의 url) */
  url: string | null;
}

/** '설정 필요' 안내 한 줄: 필수인데 비었거나 풀 수 없는 설정 */
export interface SetupNeed {
  name: string;
  label: string;
  state: 'empty' | 'locked';
  url: string | null;
}

export interface HookVarView {
  name: string;
  value: string | null;
  source: 'db' | 'env' | 'empty';
  /** 이 값을 쓰는 규칙 훅 이름 */
  usedBy: string[];
}

export interface EnvItemView {
  key: string;
  value: string;
  tone: 'ok' | 'muted' | 'plain';
  /** 이번에 새로 생긴 항목 */
  isNew: boolean;
}

const NEW_ENV = new Set(['AGENT_QUEUE_MAX', 'DELEGATION_MAX_ROUNDS', 'ACTIVITY_KEEP', 'ATTACHMENT_MAX_MB', 'ATTACHMENTS_PER_MESSAGE']);

export interface SettingsDeps {
  config: Config;
  store: Store;
  /** 지금 프로세스의 환경 변수 (.env 를 읽은 값). 시험에서는 바꿔 넣습니다. */
  env: () => Record<string, string | undefined>;
}

export class SettingsService {
  private readonly d: SettingsDeps;

  constructor(deps: SettingsDeps) {
    this.d = deps;
  }

  private envValue(name: string): string | null {
    const v = this.d.env()[name];
    return v !== undefined && v.trim() !== '' ? v : null;
  }

  private tryDecrypt(cipher: string): string | null {
    try {
      return decryptSecret(cipher, this.d.config.secretsKey);
    } catch {
      return null;
    }
  }

  private label(e: EnvEntry): string {
    return e.label ?? e.name;
  }

  /* ───────── 모듈 ───────── */

  /**
   * 모듈 프로세스에 넘길 값: DB(비밀값은 풀어서) → 없으면 .env.
   * 저장돼 있지만 풀 수 없는 비밀값(SECRETS_KEY 가 바뀜)은 problems 에 정확한 이유를 담습니다.
   */
  resolveModule(manifest: Manifest): { values: Record<string, string>; missing: string[]; problems: string[] } {
    const rows = new Map(this.d.store.listModuleSettings(manifest.id).map((r) => [r.name, r]));
    const values: Record<string, string> = {};
    const missing: string[] = [];
    const problems: string[] = [];
    for (const e of manifest.env) {
      const row = rows.get(e.name);
      let v: string | null = null;
      if (row?.cipher) {
        v = this.tryDecrypt(row.cipher);
        if (v === null) {
          problems.push(`저장된 '${this.label(e)}'(${e.name})을(를) 풀 수 없습니다. SECRETS_KEY 가 저장할 때와 달라졌습니다. 원래 값으로 되돌리거나 설정 화면에서 값을 다시 입력하세요.`);
          continue;
        }
      } else if (row) {
        v = row.value;
      }
      if (v === null || v.trim() === '') v = this.envValue(e.name);
      if (v !== null && v.trim() !== '') values[e.name] = v;
      else if (e.required) missing.push(e.name);
    }
    return { values, missing, problems };
  }

  moduleFields(row: ModuleRow): ModuleFieldView[] {
    const rows = new Map(this.d.store.listModuleSettings(row.id).map((r) => [r.name, r]));
    return row.manifest.env.map((e) => {
      const secret = isSecretField(e);
      const saved = rows.get(e.name);
      const env = this.envValue(e.name);
      let source: FieldSource = 'empty';
      let value: string | null = null;
      let last4: string | null = null;
      if (saved?.cipher) {
        if (this.tryDecrypt(saved.cipher) === null) source = 'locked';
        else {
          source = 'db';
          last4 = saved.last4;
        }
      } else if (saved && saved.value !== null) {
        source = 'db';
        value = saved.value;
      } else if (env !== null) {
        source = 'env';
        if (secret) last4 = env.trim().slice(-4);
        else value = env;
      }
      return { name: e.name, label: this.label(e), description: e.description, required: e.required, secret, source, value, last4, envAlso: Boolean(saved) && env !== null, url: e.url ?? null };
    });
  }

  /** '설정 필요' 안내에 쓸 항목: 필수인데 비었거나, 저장돼 있지만 풀 수 없는 설정 */
  setupNeeds(row: ModuleRow): SetupNeed[] {
    return this.moduleFields(row)
      .filter((f) => f.source === 'locked' || (f.required && f.source === 'empty'))
      .map((f) => ({ name: f.name, label: f.label, state: f.source === 'locked' ? 'locked' : 'empty', url: f.url }));
  }

  /** 필수인데 비었거나 풀 수 없는 설정 이름 */
  missingFields(row: ModuleRow): string[] {
    return this.moduleFields(row)
      .filter((f) => f.required && (f.source === 'empty' || f.source === 'locked'))
      .map((f) => f.name);
  }

  /**
   * 화면에서 넣은 값 저장: { 이름: 값 } (null 이나 빈 문자열은 지움 → .env 값이나 빈 값으로 돌아감).
   * 비밀값은 암호화하고 끝 4자리만 따로 둡니다. 바뀐 이름 목록을 돌려줍니다.
   */
  saveModule(row: ModuleRow, raw: unknown): string[] {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ValidationError('module_settings_type', '설정은 { 이름: 값 } 형태의 객체여야 합니다.');
    }
    const decl = new Map(row.manifest.env.map((e) => [e.name, e]));
    const entries = Object.entries(raw as Record<string, unknown>);
    // 먼저 모두 검사하고, 하나라도 틀리면 아무것도 바꾸지 않습니다.
    const plan: { name: string; value: string | null; secret: boolean }[] = [];
    for (const [name, v] of entries) {
      const e = decl.get(name);
      if (!e) throw new ValidationError('module_setting_unknown', `'${row.manifest.name}' 모듈에는 '${name}' 설정이 없습니다. module.json 의 env 에 선언된 이름만 넣을 수 있습니다.`, { name });
      if (v === null) {
        plan.push({ name, value: null, secret: false });
        continue;
      }
      if (typeof v !== 'string') throw new ValidationError('module_setting_value', `'${this.label(e)}' 값은 문자열이어야 합니다. 받은 값: ${JSON.stringify(v)}`, { name });
      const t = v.trim();
      if (t.length > SETTING_VALUE_MAX) throw new ValidationError('module_setting_long', `'${this.label(e)}' 값은 ${SETTING_VALUE_MAX.toLocaleString()}자까지 넣을 수 있습니다. 지금 ${t.length.toLocaleString()}자입니다.`, { name });
      if (/[\0\r\n]/.test(t)) throw new ValidationError('module_setting_newline', `'${this.label(e)}' 값에 줄바꿈이나 NUL 문자를 넣을 수 없습니다.`, { name });
      plan.push({ name, value: t === '' ? null : t, secret: isSecretField(e) });
    }
    this.d.store.db.tx(() => {
      for (const p of plan) {
        if (p.value === null) this.d.store.deleteModuleSetting(row.id, p.name);
        else if (p.secret) this.d.store.setModuleSetting(row.id, p.name, { value: null, cipher: encryptSecret(p.value, this.d.config.secretsKey), last4: p.value.slice(-4) });
        else this.d.store.setModuleSetting(row.id, p.name, { value: p.value, cipher: null, last4: null });
      }
    });
    return plan.map((p) => p.name);
  }

  /** .env 에만 있는 이 모듈의 값을 DB 로 옮깁니다 (names 가 있으면 그 이름만). 옮긴 이름 목록. */
  importModuleEnv(row: ModuleRow, names?: readonly string[]): string[] {
    const fields = this.moduleFields(row);
    const values: Record<string, string> = {};
    for (const f of fields) {
      if (f.source !== 'env') continue;
      if (names && !names.includes(f.name)) continue;
      const v = this.envValue(f.name);
      if (v !== null) values[f.name] = v;
    }
    return Object.keys(values).length > 0 ? this.saveModule(row, values) : [];
  }

  /** 기본 금지 조항(비밀값 유출)이 비교할 모듈 비밀값: DB 에 저장된 것(풀어서)과 .env 에 있는 비밀 항목만 (일반 설정값은 넣지 않음) */
  secretValues(modules: readonly ModuleRow[]): string[] {
    const out: string[] = [];
    for (const m of modules) {
      const rows = new Map(this.d.store.listModuleSettings(m.id).map((r) => [r.name, r]));
      for (const e of m.manifest.env) {
        if (!isSecretField(e)) continue;
        const saved = rows.get(e.name);
        const v = saved?.cipher ? this.tryDecrypt(saved.cipher) : this.envValue(e.name);
        if (v && v.trim()) out.push(v.trim());
      }
    }
    return out;
  }

  /* ───────── 훅 값 ───────── */

  /** 훅의 $env:이름 이 가리키는 값: 화면에서 넣은 값(DB) → 없으면 .env */
  hookVar(name: string): string | undefined {
    const db = this.d.store.getHookVar(name);
    if (db !== null && db.trim() !== '') return db;
    return this.envValue(name) ?? undefined;
  }

  hookVars(): HookVarView[] {
    const usedBy = new Map<string, string[]>();
    for (const h of this.d.store.listHooks()) {
      for (const c of h.conditions) {
        const n = envRefName(c.value);
        if (!n) continue;
        const list = usedBy.get(n) ?? [];
        if (!list.includes(h.name)) list.push(h.name);
        usedBy.set(n, list);
      }
    }
    const db = new Map(this.d.store.listHookVars().map((v) => [v.name, v.value]));
    const names = [...new Set([...db.keys(), ...usedBy.keys()])].sort();
    return names.map((name) => {
      const saved = db.get(name);
      const env = this.envValue(name);
      const source: HookVarView['source'] = saved !== undefined ? 'db' : env !== null ? 'env' : 'empty';
      return { name, value: saved ?? env ?? null, source, usedBy: usedBy.get(name) ?? [] };
    });
  }

  setHookVar(name: unknown, value: unknown): void {
    if (typeof name !== 'string' || !HOOK_VAR_RE.test(name)) {
      throw new ValidationError('hook_var_name', `훅 값 이름은 대문자 · 숫자 · 밑줄로 64자까지 쓸 수 있습니다 (예: QUIET_HOURS). 받은 값: ${JSON.stringify(name)}`);
    }
    if (typeof value !== 'string' || value.trim() === '') throw new ValidationError('hook_var_value', `'${name}' 값이 비어 있습니다. 지우려면 삭제를 쓰세요.`);
    const t = value.trim();
    if (t.length > 1000) throw new ValidationError('hook_var_long', `'${name}' 값은 1,000자까지 넣을 수 있습니다. 지금 ${t.length.toLocaleString()}자입니다.`);
    if (/[\0\r\n]/.test(t)) throw new ValidationError('hook_var_newline', `'${name}' 값에 줄바꿈을 넣을 수 없습니다.`);
    this.d.store.setHookVar(name, t);
  }

  /** 훅이 쓰는 값 중 .env 에만 있는 것을 DB 로 옮깁니다. 옮긴 이름 목록. */
  importHookVars(): string[] {
    const moved: string[] = [];
    for (const v of this.hookVars()) {
      if (v.source !== 'env' || v.value === null) continue;
      this.d.store.setHookVar(v.name, v.value.trim());
      moved.push(v.name);
    }
    return moved;
  }

  /* ───────── .env 에 남은 값 · 읽기 전용 보기 ───────── */

  /** 화면(DB)에서 관리할 값인데 아직 .env 에서 읽고 있는 것 */
  envLeft(modules: readonly ModuleRow[]): { moduleId: string | null; name: string }[] {
    const out: { moduleId: string | null; name: string }[] = [];
    for (const m of modules) for (const f of this.moduleFields(m)) if (f.source === 'env') out.push({ moduleId: m.id, name: f.name });
    for (const v of this.hookVars()) if (v.source === 'env') out.push({ moduleId: null, name: v.name });
    return out;
  }

  /** 읽기 전용 .env 보기. 비밀값은 '설정됨'만 (SECRETS_KEY 는 바뀌었는지 알아볼 수 있게 지문 앞자리). */
  envGroups(): { title: string; items: EnvItemView[] }[] {
    const c = this.d.config;
    const set = (key: string, on: boolean, extra = ''): EnvItemView => ({ key, value: on ? `설정됨${extra ? ` · ${extra}` : ''}` : '비어 있음', tone: on ? 'ok' : 'muted', isNew: false });
    const val = (key: string, v: string | number | boolean | null | readonly string[]): EnvItemView => {
      const text = v === null || v === '' ? '—' : Array.isArray(v) ? v.join(',') : String(v);
      return { key, value: text, tone: text === '—' ? 'muted' : 'plain', isNew: NEW_ENV.has(key) };
    };
    const fp = crypto.createHash('sha256').update(c.secretsKey).digest('hex');
    return [
      {
        title: '로그인 · 암호화',
        items: [
          set('ADMIN_PASSWORD', c.adminPassword !== ''),
          set('SESSION_SECRET', c.sessionSecret !== ''),
          set('SECRETS_KEY', true, `${fp.slice(0, 4)} ${fp.slice(4, 8)}`),
          val('SESSION_TTL_HOURS', c.sessionTtlHours),
          val('LOGIN_MAX_ATTEMPTS', c.loginMaxAttempts),
          val('LOGIN_LOCK_MINUTES', c.loginLockMinutes),
        ],
      },
      {
        title: '서버',
        items: [val('HOST', c.host), val('PORT', c.port), val('PUBLIC_URL', c.publicUrl), val('TRUST_PROXY', c.trustProxy), val('TZ', this.envValue('TZ')), val('LOG_LEVEL', c.logLevel), val('DATA_DIR', c.dataDir)],
      },
      {
        title: '실행 한도',
        items: [
          val('AGENT_MAX_CONCURRENCY', c.agentMaxConcurrency),
          val('AGENT_QUEUE_MAX', c.agentQueueMax),
          val('APPROVAL_TIMEOUT_MINUTES', c.approvalTimeoutMinutes),
          val('HISTORY_MAX_MESSAGES', c.historyMaxMessages),
          val('DELEGATION_MAX_DEPTH', c.delegationMaxDepth),
          val('DELEGATION_MAX_ROUNDS', c.delegationMaxRounds),
          val('HEARTBEAT_MIN_MINUTES', c.heartbeatMinMinutes),
          val('ACTIVITY_KEEP', c.activityKeep),
          val('ATTACHMENT_MAX_MB', c.attachmentMaxMb),
          val('ATTACHMENTS_PER_MESSAGE', c.attachmentsPerMessage),
        ],
      },
      {
        title: 'Anthropic 연결',
        items: [
          set('ANTHROPIC_API_KEY', Boolean(c.anthropicApiKey), c.anthropicApiKey ? c.anthropicApiKey.trim().slice(-4) : ''),
          val('ANTHROPIC_BASE_URL', c.anthropicBaseUrl),
          val('ANTHROPIC_TIMEOUT_MS', c.anthropicTimeoutMs),
          val('ANTHROPIC_MAX_RETRIES', c.anthropicMaxRetries),
          val('ANTHROPIC_REFUSAL_FALLBACK', c.refusalFallback),
          val('AGENT_MAX_TOKENS', c.agentMaxTokens),
          val('AGENT_COMPACTION', c.compaction),
          val('MODELS_TIMEOUT_MS', c.modelsTimeoutMs),
          val('MODELS_CACHE_MINUTES', c.modelsCacheMinutes),
        ],
      },
      {
        title: '도구 한도',
        items: [
          val('SHELL_TIMEOUT_MS', c.shellTimeoutMs),
          val('SHELL_OUTPUT_MAX_BYTES', c.shellOutputMaxBytes),
          val('HTTP_TOOL_TIMEOUT_MS', c.httpToolTimeoutMs),
          val('HTTP_TOOL_MAX_BYTES', c.httpToolMaxBytes),
          val('GUARD_FLOOD_PER_MINUTE', c.guardFloodPerMinute),
          val('GUARD_LOOP_REPEAT', c.guardLoopRepeat),
        ],
      },
      {
        title: '모듈 실행',
        items: [
          val('MODULES_DIR', c.modulesDir),
          val('TEMPLATES_DIR', c.templatesDir),
          val('MODULE_SANDBOX', c.moduleSandbox),
          val('MODULE_CALL_TIMEOUT_MS', c.moduleCallTimeoutMs),
          val('MODULE_IDLE_TIMEOUT_MS', c.moduleIdleTimeoutMs),
          val('MODULE_RESTART_MAX', c.moduleRestartMax),
          val('MODULE_RESTART_WINDOW_MINUTES', c.moduleRestartWindowMinutes),
          val('GIT_BIN', c.gitBin),
        ],
      },
    ];
  }

  /* ───────── Anthropic 키 ───────── */

  keyViews(keys: readonly ApiKeyRow[], agents: readonly AgentRow[]): { id: string; label: string; source: 'env' | 'stored'; last4: string; users: { id: string; name: string; color: string }[] }[] {
    return keys.map((k) => ({
      id: k.id,
      label: k.label,
      source: k.source,
      last4: k.last4,
      users: agents.filter((a) => a.keyId === k.id).map((a) => ({ id: a.id, name: a.name, color: a.color })),
    }));
  }
}
