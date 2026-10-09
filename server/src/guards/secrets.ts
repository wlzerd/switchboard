/**
 * 비밀값 탐지. 알려진 토큰 형식과, 서버가 실제로 가진 비밀값(.env 의 키·토큰, 저장된 API 키) 원문을 함께 찾습니다.
 */

interface SecretPattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { kind: 'Anthropic API 키', re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenAI API 키', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/ },
  { kind: 'GitHub 토큰', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/ },
  { kind: 'Slack 토큰', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Telegram 봇 토큰', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { kind: 'Discord 봇 토큰', re: /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}/ },
  { kind: 'AWS 액세스 키', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'Google API 키', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe 비밀 키', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/ },
  { kind: '개인 키', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

/** 너무 짧은 값은 일반 단어와 겹치므로 원문 비교에서 뺍니다. */
export const KNOWN_SECRET_MIN_LENGTH = 8;

export interface SecretHit {
  kind: string;
  /** 1부터 시작하는 줄 번호 */
  line: number;
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

export function findSecret(text: string, known: readonly string[] = []): SecretHit | null {
  if (!text) return null;
  let best: { kind: string; index: number } | null = null;
  for (const value of known) {
    if (value.length < KNOWN_SECRET_MIN_LENGTH) continue;
    const idx = text.indexOf(value);
    if (idx !== -1 && (best === null || idx < best.index)) best = { kind: '서버에 등록된 비밀값', index: idx };
  }
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m && (best === null || m.index < best.index)) best = { kind: p.kind, index: m.index };
  }
  return best ? { kind: best.kind, line: lineOf(text, best.index) } : null;
}
