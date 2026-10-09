/**
 * 도구 입력 검증용 JSON Schema 부분 집합.
 * 지원: type, properties, required, additionalProperties(false), enum, items, minLength, maxLength, minimum, maximum, minItems, maxItems.
 * 중첩 구조는 재귀 대신 작업 스택으로 검사합니다.
 */

type Schema = Record<string, unknown>;

interface Job {
  value: unknown;
  schema: Schema;
  path: string;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return expected === 'number' && actual === 'integer';
}

const MAX_JOBS = 50_000;

/** 첫 번째로 찾은 오류를 '경로: 이유' 형태로 돌려줍니다. 통과하면 null. */
export function validateJson(value: unknown, schema: Schema): string | null {
  const stack: Job[] = [{ value, schema, path: 'input' }];
  let processed = 0;
  while (stack.length > 0) {
    processed += 1;
    if (processed > MAX_JOBS) return 'input: 입력 구조가 너무 큽니다.';
    const { value: v, schema: s, path } = stack.pop() as Job;
    const actual = typeOf(v);
    const t = s['type'];
    if (typeof t === 'string' && !typeMatches(t, actual)) return `${path}: ${t} 이어야 하는데 ${actual} 입니다.`;
    if (Array.isArray(t) && !t.some((x) => typeof x === 'string' && typeMatches(x, actual))) return `${path}: ${t.join(' | ')} 중 하나여야 하는데 ${actual} 입니다.`;
    if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).some((e) => e === v)) {
      return `${path}: ${(s['enum'] as unknown[]).map((e) => JSON.stringify(e)).join(', ')} 중 하나여야 합니다. 받은 값: ${JSON.stringify(v)}`;
    }
    if (actual === 'string') {
      const str = v as string;
      if (typeof s['minLength'] === 'number' && str.length < s['minLength']) return `${path}: ${s['minLength']}자 이상이어야 합니다 (지금 ${str.length}자).`;
      if (typeof s['maxLength'] === 'number' && str.length > s['maxLength']) return `${path}: ${s['maxLength']}자 이하여야 합니다 (지금 ${str.length}자).`;
    }
    if (actual === 'number' || actual === 'integer') {
      const n = v as number;
      if (typeof s['minimum'] === 'number' && n < s['minimum']) return `${path}: ${s['minimum']} 이상이어야 합니다 (받은 값 ${n}).`;
      if (typeof s['maximum'] === 'number' && n > s['maximum']) return `${path}: ${s['maximum']} 이하여야 합니다 (받은 값 ${n}).`;
    }
    if (actual === 'array') {
      const arr = v as unknown[];
      if (typeof s['minItems'] === 'number' && arr.length < s['minItems']) return `${path}: 항목이 ${s['minItems']}개 이상이어야 합니다.`;
      if (typeof s['maxItems'] === 'number' && arr.length > s['maxItems']) return `${path}: 항목은 ${s['maxItems']}개까지입니다 (지금 ${arr.length}개).`;
      const items = s['items'];
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        for (let i = arr.length - 1; i >= 0; i -= 1) stack.push({ value: arr[i], schema: items as Schema, path: `${path}[${i}]` });
      }
    }
    if (actual === 'object') {
      const obj = v as Record<string, unknown>;
      const props = (s['properties'] && typeof s['properties'] === 'object' ? s['properties'] : {}) as Record<string, Schema>;
      if (Array.isArray(s['required'])) {
        for (const key of s['required'] as unknown[]) {
          if (typeof key === 'string' && !(key in obj)) return `${path}.${key}: 필수 값이 없습니다.`;
        }
      }
      if (s['additionalProperties'] === false) {
        const extra = Object.keys(obj).find((k) => !(k in props));
        if (extra !== undefined) return `${path}.${extra}: 스키마에 없는 속성입니다.`;
      }
      const keys = Object.keys(props);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const k = keys[i] as string;
        if (k in obj && obj[k] !== undefined) stack.push({ value: obj[k], schema: props[k] as Schema, path: `${path}.${k}` });
      }
    }
  }
  return null;
}
