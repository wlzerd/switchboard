import path from 'node:path';
import { z } from 'zod';
import { ModuleError } from '../errors.ts';

export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

const ICONS = ['chat', 'plane', 'git', 'rss', 'doc', 'link', 'cube', 'globe', 'clock', 'bolt'] as const;

const jsonSchemaObject = z
  .object({
    type: z.literal('object', { error: "input_schema.type 은 'object' 여야 합니다." }),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

const toolSchema = z.object({
  name: z.string().regex(TOOL_NAME_RE, { error: '도구 이름은 영문 소문자로 시작하고 소문자·숫자·밑줄만, 64자 이하여야 합니다 (예: weather_now).' }),
  title: z.string().min(1).max(40).optional(),
  /** 코드에서 내보내는 함수 이름이 name 과 다를 때 (템플릿으로 만든 모듈 등) */
  handler: z.string().regex(/^[A-Za-z_$][\w$]*$/, { error: 'handler 는 자바스크립트 함수 이름이어야 합니다.' }).optional(),
  description: z.string().min(1, { error: '도구 설명(description)이 비어 있습니다. 모델이 언제 이 도구를 쓸지 판단하는 근거입니다.' }).max(1024),
  input_schema: jsonSchemaObject,
});

const envSchema = z.object({
  name: z.string().regex(ENV_NAME_RE, { error: '환경 변수 이름은 대문자로 시작하고 대문자·숫자·밑줄만 쓸 수 있습니다 (예: NOTION_TOKEN).' }),
  required: z.boolean().default(true),
  description: z.string().max(200).default(''),
});

export const manifestSchema = z.object({
  id: z.string().regex(MODULE_ID_RE, { error: 'id 는 영문 소문자로 시작하고 소문자·숫자·하이픈만, 2~32자여야 합니다 (예: notion-sync).' }),
  name: z.string().min(1, { error: 'name 이 비어 있습니다.' }).max(40),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, { error: 'version 은 1.0.0 같은 형식이어야 합니다.' }),
  description: z.string().max(300).default(''),
  kind: z.enum(['module', 'skill']).default('module'),
  entry: z.string().default('index.js'),
  license: z.string().min(1, { error: 'license 가 비어 있습니다. MIT 같은 SPDX 식별자를 적으세요.' }),
  author: z.string().max(80).default(''),
  icon: z.enum(ICONS).default('cube'),
  channel: z
    .object({
      label: z.string().min(1).max(40),
    })
    .nullable()
    .default(null),
  env: z.array(envSchema).max(20).default([]),
  permissions: z
    .object({
      net: z.array(z.string().min(1).max(200)).max(50).default([]),
      fsWrite: z.boolean().default(false),
      childProcess: z.boolean().default(false),
    })
    .default({ net: [], fsWrite: false, childProcess: false }),
  tools: z.array(toolSchema).max(30).default([]),
  tests: z
    .array(
      z.object({
        tool: z.string(),
        input: z.record(z.string(), z.unknown()),
        expectIncludes: z.string().optional(),
      }),
    )
    .max(10)
    .default([]),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestTool = Manifest['tools'][number];

function issuePath(p: readonly PropertyKey[]): string {
  return p.length === 0 ? '(최상위)' : p.map((x) => (typeof x === 'number' ? `[${x}]` : String(x))).join('.').replace(/\.\[/g, '[');
}

/** module.json 검증. 실패하면 어느 항목이 왜 틀렸는지 전부 담아 던집니다. */
export function parseManifest(raw: unknown, source: string): Manifest {
  const r = manifestSchema.safeParse(raw);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${issuePath(i.path)}: ${i.message}`);
    throw new ModuleError('manifest_invalid', `${source} 의 module.json 이 올바르지 않습니다.\n- ${lines.join('\n- ')}`, 400, { issues: lines });
  }
  const m = r.data;
  const entry = path.posix.normalize(m.entry);
  if (entry.startsWith('..') || path.posix.isAbsolute(entry) || !/\.(m?js)$/.test(entry)) {
    throw new ModuleError('manifest_entry', `${source}: entry '${m.entry}'는 모듈 폴더 안의 .js 또는 .mjs 파일이어야 합니다.`);
  }
  const names = new Set<string>();
  for (const t of m.tools) {
    if (names.has(t.name)) throw new ModuleError('manifest_tool_dup', `${source}: 도구 이름 '${t.name}'이(가) 두 번 선언되어 있습니다.`);
    names.add(t.name);
  }
  for (const t of m.tests) {
    if (!names.has(t.tool)) throw new ModuleError('manifest_test_tool', `${source}: 테스트가 선언되지 않은 도구 '${t.tool}'을(를) 부릅니다.`);
  }
  if (m.kind === 'skill' && m.tools.length !== 1) {
    throw new ModuleError('manifest_skill_tools', `${source}: 스킬은 도구를 정확히 하나 선언해야 합니다. 지금 ${m.tools.length}개입니다.`);
  }
  return { ...m, entry };
}
