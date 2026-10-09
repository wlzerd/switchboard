import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config/env.ts';
import { decryptSecret, encryptSecret, hmac, sha256 } from '../crypto/secrets.ts';
import type { ApiKeyRow, Store } from '../db/store.ts';
import { KeyError } from '../errors.ts';
import type { Logger } from '../log.ts';
import { describeAnthropicError } from './errors.ts';
import { checkKeyFormat, last4, normalizeKey } from './key-format.ts';
import { groupModels, summarizeModel, type GroupedModels, type ModelSummary, type RawModel } from './models.ts';

/** Models API 에서 대체 모델 목록(allowed_fallback_models)을 받으려면 이 베타 헤더가 필요합니다. */
const FALLBACK_LIST_BETA = 'server-side-fallback-2026-06-01';
/** 한 키에서 읽을 최대 모델 수 (페이지가 끝없이 이어지는 이상 상황 방지) */
const MAX_MODELS = 500;

export interface VerifyResult {
  keyId: string;
  keyLabel: string;
  models: ModelSummary[];
  grouped: GroupedModels;
}

export class AnthropicService {
  private readonly config: Config;
  private readonly store: Store;
  private readonly log: Logger;
  private readonly clients = new Map<string, { fp: string; client: Anthropic }>();
  private readonly modelCache = new Map<string, { at: number; models: ModelSummary[] }>();

  constructor(config: Config, store: Store, log: Logger) {
    this.config = config;
    this.store = store;
    this.log = log;
  }

  /** 서버 시작 시 .env 기본 키를 키 목록에 등록합니다 (값은 저장하지 않고 끝 4자리만). */
  syncEnvKey(): ApiKeyRow | null {
    const key = this.config.anthropicApiKey;
    const existing = this.store.findEnvKey();
    if (!key) return existing;
    const tail = last4(key);
    if (existing) {
      if (existing.last4 !== tail) this.store.updateEnvKeyLast4(existing.id, tail);
      return { ...existing, last4: tail };
    }
    return this.store.insertKey({ label: '.env 기본 키', source: 'env', cipher: null, last4: tail }, null);
  }

  /** 에이전트가 쓰는 키의 원문. 로그나 응답에는 절대 넣지 않습니다. */
  resolveKey(keyId: string): string {
    const row = this.store.getKey(keyId);
    if (row.source === 'env') {
      if (!this.config.anthropicApiKey) {
        throw new KeyError('env_key_missing', "이 에이전트는 '.env 기본 키'를 쓰는데 ANTHROPIC_API_KEY 가 비어 있습니다. .env 에 값을 넣고 서버를 다시 시작하세요.", 409);
      }
      return this.config.anthropicApiKey;
    }
    if (!row.cipher) throw new KeyError('stored_key_empty', `저장된 키 '${row.label}'의 암호문이 비어 있습니다. 키를 다시 입력하세요.`, 409);
    return decryptSecret(row.cipher, this.config.secretsKey);
  }

  /** 기본 금지 조항(비밀값 유출)이 비교할 실제 비밀값 목록 */
  knownSecretValues(): string[] {
    const out: string[] = [];
    if (this.config.anthropicApiKey) out.push(this.config.anthropicApiKey);
    for (const k of this.store.listKeys()) {
      if (k.source !== 'stored' || !k.cipher) continue;
      try {
        out.push(decryptSecret(k.cipher, this.config.secretsKey));
      } catch {
        // 복호화 실패는 resolveKey 에서 정확한 문구로 드러납니다.
      }
    }
    return out;
  }

  private newClient(apiKey: string, timeout: number, maxRetries: number): Anthropic {
    return new Anthropic({
      apiKey,
      authToken: null,
      baseURL: this.config.anthropicBaseUrl ?? undefined,
      timeout,
      maxRetries,
    });
  }

  client(keyId: string): Anthropic {
    const key = this.resolveKey(keyId);
    const fp = sha256(key);
    const cached = this.clients.get(keyId);
    if (cached && cached.fp === fp) return cached.client;
    const client = this.newClient(key, this.config.anthropicTimeoutMs, this.config.anthropicMaxRetries);
    this.clients.set(keyId, { fp, client });
    return client;
  }

  private host(): string {
    if (!this.config.anthropicBaseUrl) return 'api.anthropic.com';
    try {
      return new URL(this.config.anthropicBaseUrl).host;
    } catch {
      return this.config.anthropicBaseUrl;
    }
  }

  /** Models API 를 페이지 끝까지 읽습니다. 대체 모델 정보가 담기도록 베타 헤더를 먼저 시도합니다. */
  private async fetchModels(client: Anthropic, op: 'verify' | 'models'): Promise<ModelSummary[]> {
    const collect = async (iter: AsyncIterable<unknown>): Promise<ModelSummary[]> => {
      const out: ModelSummary[] = [];
      for await (const m of iter) {
        out.push(summarizeModel(m as RawModel));
        if (out.length >= MAX_MODELS) break;
      }
      return out;
    };
    try {
      return await collect(client.beta.models.list({ betas: [FALLBACK_LIST_BETA] }));
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) {
        // 이 조직에 베타가 열려 있지 않은 경우. 대체 모델 정보 없이 기본 목록을 씁니다.
        this.log.info('대체 모델 베타 없이 모델 목록을 다시 읽습니다', { reason: err.message.slice(0, 120) });
        try {
          return await collect(client.models.list());
        } catch (inner) {
          throw describeAnthropicError(inner, { op, timeoutMs: this.config.modelsTimeoutMs, host: this.host() });
        }
      }
      throw describeAnthropicError(err, { op, timeoutMs: this.config.modelsTimeoutMs, host: this.host() });
    }
  }

  /**
   * 키 확인: 형식 → 인증 → 모델 목록. 성공하면 직접 입력한 키는 암호화해 저장하고(같은 키는 한 번만) 모델 목록을 돌려줍니다.
   */
  async verify(input: { source: 'env' } | { source: 'manual'; key: string }): Promise<VerifyResult> {
    let apiKey: string;
    if (input.source === 'env') {
      if (!this.config.anthropicApiKey) {
        throw new KeyError('env_key_missing', "ANTHROPIC_API_KEY 가 .env 에 없습니다. 값을 넣고 서버를 다시 시작하거나 '직접 입력'을 쓰세요.", 409);
      }
      apiKey = this.config.anthropicApiKey;
      const issue = checkKeyFormat(apiKey);
      if (issue) throw new KeyError(issue.code, `.env 의 ANTHROPIC_API_KEY: ${issue.message}`, 400, { stage: 'format' });
    } else {
      const issue = checkKeyFormat(input.key);
      if (issue) throw new KeyError(issue.code, issue.message, 400, { stage: 'format' });
      apiKey = normalizeKey(input.key);
    }

    const client = this.newClient(apiKey, this.config.modelsTimeoutMs, 0);
    let models: ModelSummary[];
    try {
      models = await this.fetchModels(client, 'verify');
    } catch (err) {
      if (err instanceof KeyError) throw err;
      const e = err as { code: string; message: string; status: number };
      throw new KeyError(e.code, e.message, e.status, { stage: 'auth' });
    }
    if (models.length === 0) {
      throw new KeyError('models_empty', '키는 유효하지만 이 키로 쓸 수 있는 모델이 없습니다(목록 0개). 조직의 모델 접근 설정을 확인하세요.', 409, { stage: 'models' });
    }

    let row: ApiKeyRow;
    if (input.source === 'env') {
      row = this.syncEnvKey() as ApiKeyRow;
    } else {
      const fp = hmac(this.config.sessionSecret, apiKey);
      row =
        this.store.findKeyByFingerprint(fp) ??
        this.store.insertKey({ label: `직접 입력 · …${last4(apiKey)}`, source: 'stored', cipher: encryptSecret(apiKey, this.config.secretsKey), last4: last4(apiKey) }, fp);
    }
    this.modelCache.set(row.id, { at: Date.now(), models });
    return { keyId: row.id, keyLabel: row.label, models, grouped: groupModels(models) };
  }

  /** 키별 모델 목록 (캐시). force 면 다시 불러옵니다. */
  async models(keyId: string, force = false): Promise<ModelSummary[]> {
    const ttl = this.config.modelsCacheMinutes * 60_000;
    const cached = this.modelCache.get(keyId);
    if (!force && cached && Date.now() - cached.at < ttl) return cached.models;
    const client = this.newClient(this.resolveKey(keyId), this.config.modelsTimeoutMs, 1);
    const models = await this.fetchModels(client, 'models');
    this.modelCache.set(keyId, { at: Date.now(), models });
    return models;
  }

  /** 캐시에 있는 모델 표시 이름 (네트워크 호출 없이). 없으면 null. */
  cachedModelName(keyId: string, modelId: string): string | null {
    return this.modelCache.get(keyId)?.models.find((m) => m.id === modelId)?.name ?? null;
  }

  /** 모델 정보 하나. 목록을 못 읽으면 null 을 돌려 호출부가 기본 동작(기능 플래그 없이)으로 진행하게 합니다. */
  async modelInfo(keyId: string, modelId: string): Promise<ModelSummary | null> {
    try {
      const list = await this.models(keyId);
      return list.find((m) => m.id === modelId) ?? null;
    } catch (err) {
      this.log.warn('모델 정보를 읽지 못해 기능 플래그 없이 진행합니다', { modelId, error: (err as Error).message });
      return null;
    }
  }
}
