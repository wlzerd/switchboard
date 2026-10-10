/** 콘솔 입력창의 쓰다 만 지시 (에이전트마다 브라우저에 보관) */
const DRAFT_KEY = 'sb.draft.';

export function readDraft(agentId: string): string {
  try {
    return localStorage.getItem(DRAFT_KEY + agentId) ?? '';
  } catch {
    return '';
  }
}

export function writeDraft(agentId: string, text: string): void {
  try {
    if (text) localStorage.setItem(DRAFT_KEY + agentId, text);
    else localStorage.removeItem(DRAFT_KEY + agentId);
  } catch {
    // 저장소를 쓸 수 없으면 초안 기억만 빠집니다.
  }
}
