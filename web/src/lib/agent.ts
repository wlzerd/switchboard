import type { Effort } from './types';

/** 에이전트 색 후보 (사용자가 색 선택기로 다른 색도 고를 수 있습니다) */
export const AGENT_COLORS = ['#C6F35B', '#6CB6FF', '#FFB547', '#FF7AB6', '#B69CFF', '#4FD1C5', '#FF8A5B', '#E8EAEE'] as const;

export const EFFORT_LABEL: Record<Effort, string> = { low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대' };

export const NAME_MAX = 24;
const NAME_RE = /^[\p{L}\p{N} _-]+$/u;

/**
 * 이름 검사 (서버 규칙과 같음: 1~24자, 글자·숫자·공백·-·_, 다른 에이전트와 겹치지 않음).
 * 문제가 없으면 null, 있으면 화면에 보여줄 문구를 돌려줍니다.
 */
export function agentNameProblem(raw: string, others: readonly { id: string; name: string }[], exceptId: string | null = null): string | null {
  const name = raw.trim();
  if (name.length === 0) return '이름을 입력하세요.';
  if (name.length > NAME_MAX) return `이름은 ${NAME_MAX}자까지 쓸 수 있습니다. 지금 ${name.length}자입니다.`;
  if (!NAME_RE.test(name)) {
    const bad = [...new Set([...name].filter((c) => !NAME_RE.test(c)))].join(' ');
    return `이름에 쓸 수 없는 문자가 있습니다: ${bad} (글자, 숫자, 공백, -, _ 만 가능)`;
  }
  if (others.some((a) => a.id !== exceptId && a.name === name)) return `'${name}'은(는) 이미 쓰고 있는 에이전트 이름입니다.`;
  return null;
}

/** 같은 이름이 있으면 뒤에 숫자를 붙인 다음 이름을 제안합니다 (예: 리서처 → 리서처 2). */
export function nextFreeName(base: string, others: readonly { name: string }[]): string {
  const taken = new Set(others.map((a) => a.name));
  const root = base.trim().replace(/\s+\d+$/, '') || base.trim();
  if (!taken.has(root)) return root;
  for (let i = 2; i <= taken.size + 1; i += 1) {
    const candidate = `${root} ${i}`;
    if (candidate.length > NAME_MAX) break;
    if (!taken.has(candidate)) return candidate;
  }
  return root;
}
