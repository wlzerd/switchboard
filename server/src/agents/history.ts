/**
 * 모델에 보내는 대화 기록 다루기.
 * 원칙: 기록은 덧붙이기만 합니다. 어쩔 수 없이 앞부분을 덜어낼 때는 남는 턴의 thinking 블록을 함께 지웁니다
 * (앞부분이 바뀌면 이후 thinking 블록이 무효가 되므로).
 */

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: unknown;
}

type Block = { type?: unknown; id?: unknown; tool_use_id?: unknown } & Record<string, unknown>;

function blocks(content: unknown): Block[] | null {
  return Array.isArray(content) ? (content as Block[]) : null;
}

const THINKING = new Set(['thinking', 'redacted_thinking']);

/** assistant 메시지에서 thinking 블록을 지웁니다. 지운 뒤 비는 assistant 메시지는 뺍니다 (연속된 user 메시지는 API가 합칩니다). */
export function stripThinking(messages: readonly HistoryMessage[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const m of messages) {
    const bs = blocks(m.content);
    if (m.role !== 'assistant' || !bs) {
      out.push(m);
      continue;
    }
    const kept = bs.filter((b) => !THINKING.has(String(b.type)));
    if (kept.length > 0) out.push({ role: 'assistant', content: kept });
  }
  return out;
}

/** user 메시지가 '깨끗한 턴 시작'인지: tool_result 가 없는 user 메시지. 여기서 자르면 tool_use/tool_result 짝이 깨지지 않습니다. */
export function isCleanUserTurn(m: HistoryMessage): boolean {
  if (m.role !== 'user') return false;
  const bs = blocks(m.content);
  if (!bs) return true;
  return !bs.some((b) => b.type === 'tool_result');
}

/**
 * 서버 측 요약(compaction)을 못 쓰는 모델에서 기록 길이를 제한합니다.
 * 뒤에서 max 개 근처의 '깨끗한 턴 시작'부터 남기고, 남는 턴의 thinking 블록을 지웁니다.
 * 잘라낼 지점이 max 범위 안에 없으면 그 이전의 가장 가까운 깨끗한 지점을 씁니다 (max 를 조금 넘을 수 있음).
 */
export function boundHistory(messages: readonly HistoryMessage[], max: number): { messages: HistoryMessage[]; trimmed: boolean } {
  if (messages.length <= max) return { messages: [...messages], trimmed: false };
  const from = messages.length - max;
  let start = -1;
  for (let i = from; i < messages.length; i += 1) {
    if (isCleanUserTurn(messages[i] as HistoryMessage)) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    for (let i = from - 1; i >= 0; i -= 1) {
      if (isCleanUserTurn(messages[i] as HistoryMessage)) {
        start = i;
        break;
      }
    }
  }
  if (start <= 0) return { messages: [...messages], trimmed: false };
  return { messages: stripThinking(messages.slice(start)), trimmed: true };
}

/**
 * 대체 모델(fallback)로 넘어간 응답을 기록에 넣기 전에 정리합니다.
 * 마지막 fallback 블록 앞쪽의 thinking·redacted_thinking·tool_use, 그리고 결과 짝이 없는 server_tool_use 를 뺍니다.
 */
export function sanitizeFallbackContent(content: readonly Block[]): Block[] {
  let last = -1;
  for (let i = content.length - 1; i >= 0; i -= 1) {
    if ((content[i] as Block).type === 'fallback') {
      last = i;
      break;
    }
  }
  if (last === -1) return [...content];
  const resultIds = new Set<string>();
  for (const b of content) {
    if (typeof b.type === 'string' && b.type.endsWith('_tool_result') && typeof b.tool_use_id === 'string') resultIds.add(b.tool_use_id);
  }
  const out: Block[] = [];
  for (let i = 0; i < content.length; i += 1) {
    const b = content[i] as Block;
    if (i < last) {
      if (THINKING.has(String(b.type)) || b.type === 'tool_use') continue;
      if (b.type === 'server_tool_use' && !(typeof b.id === 'string' && resultIds.has(b.id))) continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * 이전 실행이 도구 호출 직후 중단되어 tool_result 가 없는 tool_use 가 남았으면,
 * 짝이 되는 오류 결과를 덧붙여 기록을 API가 받을 수 있는 상태로 만듭니다 (기존 메시지는 고치지 않음).
 */
export function danglingToolResults(messages: readonly HistoryMessage[]): HistoryMessage | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const bs = blocks(last.content);
  if (!bs) return null;
  const uses = bs.filter((b) => b.type === 'tool_use' && typeof b.id === 'string');
  if (uses.length === 0) return null;
  return {
    role: 'user',
    content: uses.map((b) => ({
      type: 'tool_result',
      tool_use_id: b.id as string,
      // 도구 묶음(화면 제어)의 호출이면 결과에도 그 이름을 붙여야 API 가 받아 줍니다.
      ...(typeof b['toolset_name'] === 'string' ? { toolset_name: b['toolset_name'] } : {}),
      is_error: true,
      content: '이전 실행이 중단되어 이 도구의 결과가 없습니다. 필요하면 다시 호출하세요.',
    })),
  };
}

/** 최종 응답에서 사람에게 보여줄 텍스트만 모읍니다. */
export function textOf(content: readonly Block[]): string {
  return content
    .filter((b) => b.type === 'text' && typeof b['text'] === 'string')
    .map((b) => b['text'] as string)
    .join('\n')
    .trim();
}
