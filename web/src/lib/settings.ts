import type { FieldSource, ModuleField } from './types';

/** 값이 어디서 오는지 보여 줄 표시 (글자 · 색 갈래) */
export function sourceBadge(f: Pick<ModuleField, 'source' | 'secret' | 'required'>): { text: string; tone: 'ok' | 'msg' | 'warn' | 'bad' | '' } {
  switch (f.source) {
    case 'db':
      return f.secret ? { text: 'DB · 암호화', tone: 'ok' } : { text: 'DB', tone: 'msg' };
    case 'env':
      return { text: '.env에서 읽는 중', tone: 'warn' };
    case 'locked':
      return { text: '풀 수 없음 · 다시 입력', tone: 'bad' };
    case 'empty':
      return f.required ? { text: '비어 있음 · 필수', tone: 'bad' } : { text: '기본값', tone: '' };
  }
}

/**
 * 저장할 값 만들기: 고친 칸만 보냅니다. 빈 문자열은 '지움'(null), 그대로인 칸은 보내지 않습니다.
 * 비밀값은 입력한 새 값이 있을 때만 보냅니다 (화면에는 원래 값이 없음).
 */
export function settingsPatch(fields: readonly ModuleField[], drafts: Readonly<Record<string, string>>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const f of fields) {
    if (!(f.name in drafts)) continue;
    const v = (drafts[f.name] ?? '').trim();
    if (f.secret) {
      if (v !== '') out[f.name] = v;
      continue;
    }
    const before = f.value ?? '';
    // 그대로면 보내지 않습니다.
    if (v === before) continue;
    // 비우면 DB 값을 지웁니다 (.env 값은 화면에서 지울 수 없음).
    if (v === '') {
      if (f.source === 'db') out[f.name] = null;
      continue;
    }
    out[f.name] = v;
  }
  return out;
}

/** 저장해도 필수 값이 비는지: 필수 칸이 비었거나 풀 수 없고, 새 값도 없으면 그 이름 */
export function stillMissing(fields: readonly ModuleField[], drafts: Readonly<Record<string, string>>): string[] {
  return fields
    .filter((f) => {
      if (!f.required) return false;
      const d = drafts[f.name];
      if (d !== undefined && d.trim() !== '') return false;
      if (d !== undefined && !f.secret) {
        // 비운 칸: .env 값은 그대로 남고, DB 값을 지우면 .env 값이 있을 때만 채워집니다.
        if (f.source === 'env') return false;
        if (f.source === 'db') return !f.envAlso;
        return true;
      }
      return f.source === 'empty' || f.source === 'locked';
    })
    .map((f) => f.label);
}

export const SOURCE_ORDER: Record<FieldSource, number> = { locked: 0, empty: 1, env: 2, db: 3 };
