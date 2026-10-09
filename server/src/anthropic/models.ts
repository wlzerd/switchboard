/**
 * 모델 목록 정리. 모델 이름·한도·기능은 모두 Models API 응답에서 가져오고 코드에 박아두지 않습니다.
 */

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** Models API 응답 중 우리가 쓰는 부분만. SDK 타입 변화에 덜 흔들리도록 느슨하게 받습니다. */
export interface RawModel {
  id: string;
  display_name?: string | null;
  created_at?: string | null;
  lifecycle?: string | null;
  line?: string | null;
  max_input_tokens?: number | null;
  max_tokens?: number | null;
  retires_at?: string | null;
  allowed_fallback_models?: string[] | null;
  capabilities?: unknown;
}

export interface ModelSummary {
  id: string;
  name: string;
  line: string | null;
  createdAt: string | null;
  lifecycle: 'active' | 'deprecated' | 'retired';
  contextTokens: number | null;
  maxOutputTokens: number | null;
  efforts: Effort[];
  adaptiveThinking: boolean;
  compaction: boolean;
  imageInput: boolean;
  fallback: boolean;
  /** 서버 측 웹 검색 도구 지원. 응답에 정보가 없으면 지원한다고 봅니다. */
  webSearch: boolean;
  retiresAt: string | null;
}

/** capabilities 의 잎(leaf) 값을 경로로 읽습니다. 경로 중간이 없으면 false. */
export function capSupported(caps: unknown, pathParts: readonly string[]): boolean {
  let node: unknown = caps;
  for (const part of pathParts) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  if (node === null || typeof node !== 'object') return false;
  return (node as { supported?: unknown }).supported === true;
}

function hasPath(caps: unknown, pathParts: readonly string[]): boolean {
  let node: unknown = caps;
  for (const part of pathParts) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[part];
  }
  return node !== undefined && node !== null;
}

function lifecycleOf(v: string | null | undefined): ModelSummary['lifecycle'] {
  return v === 'deprecated' || v === 'retired' ? v : 'active';
}

function positiveOrNull(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

export function summarizeModel(m: RawModel): ModelSummary {
  const caps = m.capabilities;
  const effortSupported = capSupported(caps, ['effort']);
  const efforts = effortSupported ? EFFORT_LEVELS.filter((lv) => capSupported(caps, ['effort', lv])) : [];
  return {
    id: m.id,
    name: m.display_name && m.display_name.trim() ? m.display_name : m.id,
    line: m.line ?? null,
    createdAt: m.created_at ?? null,
    lifecycle: lifecycleOf(m.lifecycle),
    contextTokens: positiveOrNull(m.max_input_tokens),
    maxOutputTokens: positiveOrNull(m.max_tokens),
    efforts,
    adaptiveThinking: capSupported(caps, ['thinking', 'types', 'adaptive']),
    compaction: capSupported(caps, ['context_management', 'compact_20260112']),
    imageInput: capSupported(caps, ['image_input']),
    fallback: Array.isArray(m.allowed_fallback_models) && m.allowed_fallback_models.length > 0,
    webSearch: hasPath(caps, ['server_tools']) ? capSupported(caps, ['server_tools', 'web_search']) : true,
    retiresAt: m.retires_at ?? null,
  };
}

/** 정렬용 시각. 형식이 잘못되었거나 없으면 0 (가장 오래된 것으로 취급). */
export function releaseTime(m: Pick<ModelSummary, 'createdAt'>): number {
  if (!m.createdAt) return 0;
  const t = Date.parse(m.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

/** 출시가 늦은 순, 같으면 id 사전순 — 결과가 항상 같도록. */
export function compareNewestFirst(a: ModelSummary, b: ModelSummary): number {
  const d = releaseTime(b) - releaseTime(a);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface GroupedModels {
  /** 계열(line)마다 가장 최근의 active 모델 하나 */
  latest: ModelSummary[];
  /** 나머지 (이전 버전, deprecated, 계열 없는 모델) */
  older: ModelSummary[];
}

/**
 * 계열별 최신 모델을 앞에 보여주고 나머지는 '이전 버전'으로 접습니다.
 * retired 모델은 고를 수 없으므로 뺍니다. 계열이 없는(line=null) 모델은 계열을 추측하지 않고 이전 버전에 둡니다.
 */
export function groupModels(models: readonly ModelSummary[]): GroupedModels {
  const usable = models.filter((m) => m.lifecycle !== 'retired').slice().sort(compareNewestFirst);
  const seenLines = new Set<string>();
  const latest: ModelSummary[] = [];
  const older: ModelSummary[] = [];
  for (const m of usable) {
    if (m.line !== null && m.lifecycle === 'active' && !seenLines.has(m.line)) {
      seenLines.add(m.line);
      latest.push(m);
    } else {
      older.push(m);
    }
  }
  return { latest, older };
}

/** 요청에 넣을 max_tokens: 설정값과 모델 한도 중 작은 값. */
export function clampMaxTokens(configured: number, model: Pick<ModelSummary, 'maxOutputTokens'> | null): number {
  const cap = model?.maxOutputTokens ?? null;
  return cap !== null && cap < configured ? cap : configured;
}
