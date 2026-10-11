// 서버 도구(Anthropic 이 실행하는 웹 검색 · 웹 가져오기): 보낼 버전 고르기, 400 오류 가르기, 키 · 모델마다 기억하기.
// 서버 도구를 실은 요청이 400 으로 거절되면 원인에 따라 그 도구만 낮추거나 뺍니다. 원인이 서버 도구가 아니면 원래 오류를 그대로 알립니다.

export type ServerToolName = 'web_search' | 'web_fetch';

/** 도구마다 보낼 버전 (앞에서부터 단계 0, 1). 단계가 목록 길이에 이르면 보내지 않습니다. */
export const SERVER_TOOL_VERSIONS: Record<ServerToolName, readonly string[]> = {
  web_search: ['web_search_20260209', 'web_search_20250305'],
  web_fetch: ['web_fetch_20260209', 'web_fetch_20250910'],
};

/** 조직 설정에서 꺼져 있던 도구를 다시 보내 볼 때까지의 시간 (Console 에서 켜면 서버를 다시 켜지 않아도 이 안에 다시 씀) */
export const SERVER_TOOL_RECHECK_MS = 60 * 60_000;

/** 조직 관리자가 웹 검색 등을 켜고 끄는 곳 */
export const CONSOLE_CAPABILITIES_URL = 'https://platform.claude.com/settings/capabilities';

const LABEL: Record<ServerToolName, string> = { web_search: '웹 검색', web_fetch: '웹 가져오기' };

/** 요청에 실어 보낸 서버 도구. index 는 tools 배열 안의 위치 (오류가 'tools.N' 으로 가리킬 때 씀) */
export interface SentServerTool {
  name: ServerToolName;
  type: string;
  index: number;
}

/** off: 조직 설정에서 꺼짐 (버전을 낮춰도 풀리지 않음) · version: 모델이 이 버전을 받지 않음 */
export type ServerToolFault = { kind: 'off'; tool: ServerToolName } | { kind: 'version'; tools: ServerToolName[] };

const NOT_ENABLED: Record<ServerToolName, RegExp> = {
  web_search: /web search is not enabled/i,
  web_fetch: /web fetch is not enabled/i,
};
/** 어느 도구인지 짚지 않고 서버 도구가 쓰는 기능(동적 거르기 · 코드 실행)을 탓하는 오류 */
const SERVER_FEATURE = /allowed_callers|code[ _]execution|dynamic filtering|programmatic tool/i;

/** 서버 도구를 실은 요청의 400 오류 → 원인. 보낸 서버 도구 탓이 아니면 null */
export function classifyServerToolError(message: string, sent: readonly SentServerTool[]): ServerToolFault | null {
  // 낮추거나 뺄 도구가 없으면 다시 보내도 같은 요청이라 서버 도구 오류로 보지 않습니다 (끝없이 되풀이하지 않게).
  if (sent.length === 0) return null;
  for (const s of sent) if (NOT_ENABLED[s.name].test(message)) return { kind: 'off', tool: s.name };
  const text = message.toLowerCase();
  const indexes = new Set([...message.matchAll(/\btools\.(\d+)\b/g)].map((m) => Number(m[1])));
  const named = sent.filter((s) => indexes.has(s.index) || text.includes(s.name) || text.includes(s.name.replace('_', ' ')));
  if (named.length > 0) return { kind: 'version', tools: named.map((s) => s.name) };
  if (SERVER_FEATURE.test(message)) return { kind: 'version', tools: sent.map((s) => s.name) };
  return null;
}

/** 조직 설정에서 꺼진 도구를 빼고 진행할 때 대화에 남기는 안내 */
export function serverToolOffNotice(tool: ServerToolName): string {
  const off = tool === 'web_search' ? " 쓰지 않을 거면 이 에이전트의 '웹 검색' 권한을 차단하세요." : '';
  return `${LABEL[tool]}(${tool}): Anthropic 조직 설정에서 꺼져 있어 이 도구 없이 진행합니다. 쓰려면 조직 관리자가 Claude Console 기능 설정(${CONSOLE_CAPABILITIES_URL})에서 켜세요. 켜면 ${SERVER_TOOL_RECHECK_MS / 60_000}분 안에 다시 씁니다.${off}`;
}

/** 모델이 어떤 버전도 받지 않아 도구를 뺄 때 대화에 남기는 안내 */
export function serverToolDroppedNotice(tool: ServerToolName, model: string): string {
  return `${LABEL[tool]}(${tool}): '${model}' 모델이 이 도구를 받지 않아 빼고 진행합니다.`;
}

/** 서버가 떠 있는 동안 키 · 모델마다 서버 도구를 어떻게 보낼지 기억합니다. 조직 설정은 키(조직)마다, 버전은 키 · 모델마다 따로 */
export class ServerToolState {
  /** `${키}\n${모델}\n${도구}` → 버전 단계 */
  private readonly levels = new Map<string, number>();
  /** `${키}\n${도구}` → 다시 보내 볼 시각 */
  private readonly offUntil = new Map<string, number>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 지금 보낼 버전. 보내지 않으면 null */
  version(keyId: string, model: string, tool: ServerToolName): string | null {
    if (this.isOff(keyId, tool)) return null;
    return SERVER_TOOL_VERSIONS[tool][this.levels.get(`${keyId}\n${model}\n${tool}`) ?? 0] ?? null;
  }

  /** 한 단계 낮추고 낮춘 뒤의 버전을 돌려줍니다. 더 낮출 버전이 없어 빼면 null */
  lower(keyId: string, model: string, tool: ServerToolName): string | null {
    const k = `${keyId}\n${model}\n${tool}`;
    const next = Math.min((this.levels.get(k) ?? 0) + 1, SERVER_TOOL_VERSIONS[tool].length);
    this.levels.set(k, next);
    return SERVER_TOOL_VERSIONS[tool][next] ?? null;
  }

  /** 조직 설정에서 꺼져 있다고 기억합니다 (SERVER_TOOL_RECHECK_MS 뒤에 다시 보내 봄) */
  turnOff(keyId: string, tool: ServerToolName): void {
    this.offUntil.set(`${keyId}\n${tool}`, this.now() + SERVER_TOOL_RECHECK_MS);
  }

  isOff(keyId: string, tool: ServerToolName): boolean {
    const k = `${keyId}\n${tool}`;
    const until = this.offUntil.get(k);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.offUntil.delete(k);
    return false;
  }
}
