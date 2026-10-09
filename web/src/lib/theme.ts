import type { Meta, Theme, ThemeTokens } from './types';

/** #RRGGBB → 상대 휘도 (WCAG) */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1] as string, 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** 강조색 위 글자색: 검정과 흰색 중 대비가 큰 쪽 */
export function readableOn(bg: string): string {
  return contrast('#0B0D11', bg) >= contrast('#FFFFFF', bg) ? '#0B0D11' : '#FFFFFF';
}

export function hexA(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(m[1] as string, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 읽기 어려운 색 조합을 찾아 이유를 돌려줍니다 (본문 4.5:1, 강조 위 글자 4.5:1). */
export function contrastIssues(t: ThemeTokens): string[] {
  const out: string[] = [];
  const check = (label: string, fg: string, bg: string, min: number): void => {
    const r = contrast(fg, bg);
    if (r < min) out.push(`${label} 대비가 ${r.toFixed(1)}:1 입니다. ${min}:1 이상이어야 읽힙니다.`);
  };
  check('본문 글자와 카드', t.text, t.surface, 4.5);
  check('보조 글자와 카드', t.text2, t.surface, 4.5);
  check('강조색 위 글자', t.onAccent, t.accent, 4.5);
  return out;
}

const FONT_STACK: Record<Theme['font'], string> = {
  plex: "'IBM Plex Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif",
  noto: "'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif",
  system: "system-ui, -apple-system, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif",
};

export function fontStack(font: Theme['font']): string {
  return FONT_STACK[font];
}

export function defaultTheme(meta: Meta | null): Theme | null {
  if (!meta) return null;
  const d = meta.themes.default;
  const p = meta.themes.presets.find((x) => x.id === d.preset) ?? meta.themes.presets[0];
  if (!p) return null;
  return { name: p.name, tokens: p.tokens, radius: d.radius, font: d.font, density: d.density, motion: d.motion };
}

export const TOKEN_KEYS: readonly (keyof ThemeTokens)[] = ['bg', 'panel', 'surface', 'raised', 'line', 'line2', 'text', 'text2', 'text3', 'accent', 'onAccent', 'msg', 'skill', 'warn', 'danger'];

/** 테마 → CSS 변수 목록. 문서 전체(applyTheme)와 미리보기 영역이 같은 값을 씁니다. */
export function themeVars(theme: Theme): Record<string, string> {
  const t = theme.tokens;
  const vars: Record<string, string> = {};
  for (const k of TOKEN_KEYS) vars[`--${k}`] = t[k];
  vars['--accent-dim'] = hexA(t.accent, 0.12);
  vars['--accent-glow'] = hexA(t.accent, 0.3);
  vars['--msg-dim'] = hexA(t.msg, 0.13);
  vars['--skill-dim'] = hexA(t.skill, 0.12);
  vars['--warn-dim'] = hexA(t.warn, 0.12);
  vars['--danger-dim'] = hexA(t.danger, 0.12);
  vars['--radius'] = `${theme.radius}px`;
  vars['--radius-sm'] = `${Math.round(theme.radius * 0.75)}px`;
  vars['--radius-lg'] = `${Math.round(theme.radius * 1.3)}px`;
  vars['--font'] = fontStack(theme.font);
  vars['--pad'] = ['8px', '12px', '16px'][theme.density] as string;
  vars['--gap'] = ['8px', '12px', '16px'][theme.density] as string;
  return vars;
}

/** 테마를 CSS 변수로 문서 전체에 적용합니다. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(themeVars(theme))) root.style.setProperty(k, v);
  root.dataset['motion'] = String(theme.motion);
  root.style.colorScheme = luminance(theme.tokens.bg) > 0.5 ? 'light' : 'dark';
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONTS: readonly Theme['font'][] = ['plex', 'noto', 'system'];

/**
 * 가져온 테마 JSON 검사 (서버 PUT /api/theme 규칙과 같음). 문제가 있으면 무엇이 왜 틀렸는지 문자열로 돌려줍니다.
 */
export function parseThemeJson(text: string): Theme | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return `JSON 형식이 아닙니다: ${(err as Error).message}`;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return '테마는 { name, tokens, radius, font, density, motion } 형태의 객체여야 합니다.';
  const o = raw as Record<string, unknown>;
  const tokens = o['tokens'];
  if (tokens === null || typeof tokens !== 'object' || Array.isArray(tokens)) return '색 토큰(tokens)이 없습니다.';
  const t = tokens as Record<string, unknown>;
  const out = {} as ThemeTokens;
  for (const k of TOKEN_KEYS) {
    const v = t[k];
    if (typeof v !== 'string' || !HEX.test(v)) return `색 '${k}' 는 #RRGGBB 형식이어야 합니다. 받은 값: ${JSON.stringify(v)}`;
    out[k] = v.toUpperCase();
  }
  const radius = o['radius'];
  if (typeof radius !== 'number' || !Number.isInteger(radius) || radius < 0 || radius > 20) return `모서리(radius)는 0~20 사이 정수여야 합니다. 받은 값: ${JSON.stringify(radius)}`;
  const font = o['font'];
  if (!FONTS.includes(font as Theme['font'])) return `글꼴(font)은 ${FONTS.join(', ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(font)}`;
  const density = o['density'];
  if (density !== 0 && density !== 1 && density !== 2) return `밀도(density)는 0, 1, 2 중 하나여야 합니다. 받은 값: ${JSON.stringify(density)}`;
  const motion = o['motion'];
  if (motion !== 0 && motion !== 1 && motion !== 2) return `움직임(motion)은 0, 1, 2 중 하나여야 합니다. 받은 값: ${JSON.stringify(motion)}`;
  const name = typeof o['name'] === 'string' && o['name'].trim() ? o['name'].trim().slice(0, 30) : '가져온 테마';
  return { name, tokens: out, radius, font: font as Theme['font'], density, motion };
}
