import path from 'node:path';
import { z } from 'zod';
import { ModuleError } from '../errors.ts';

export const MODULE_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

const ICONS = ['chat', 'plane', 'git', 'rss', 'doc', 'link', 'cube', 'globe', 'clock', 'bolt', 'mail', 'screen'] as const;

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
  /** 설정 화면에 보일 짧은 이름 (없으면 name) */
  label: z.string().min(1).max(40).optional(),
  /** 비밀값(토큰 · 비밀번호)인지. 비밀값은 SECRETS_KEY 로 암호화해 저장하고 화면에는 끝 4자리만 보입니다. 없으면 이름으로 짐작합니다. */
  secret: z.boolean().optional(),
  /** 값을 만드는 곳(토큰 발급 페이지 등). 설정 화면과 '설정 필요' 안내에 링크로 보입니다. https 만 */
  url: z
    .string()
    .max(500)
    .refine((v) => {
      try {
        return new URL(v).protocol === 'https:';
      } catch {
        return false;
      }
    }, { error: 'env 의 url 은 https:// 로 시작하는 주소여야 합니다 (값을 만드는 페이지).' })
    .optional(),
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
      /** false 면 받기만 하는 채널 (예: 이메일). 전송 권한 · send_message · 보고 채널에서 빠집니다. */
      send: z.boolean().default(true),
    })
    .nullable()
    .default(null),
  /** 화면 제어 모듈: 연결된 에이전트에게 Claude 컴퓨터 사용 도구 묶음을 열어 주고, 그 동작을 export default 의 computer.run 으로 처리합니다. */
  computer: z
    .object({ label: z.string().min(1).max(40) })
    .nullable()
    .default(null),
  /** 기본 제공 모듈이 처음 등록될 때 켤지 (화면 제어처럼 위험한 모듈은 false) */
  defaultEnabled: z.boolean().default(true),
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
  if (m.channel && m.computer) {
    throw new ModuleError('manifest_channel_computer', `${source}: channel 과 computer 는 함께 선언할 수 없습니다. 메시지 채널과 화면 제어는 서로 다른 모듈로 만드세요.`);
  }
  if (m.kind === 'skill' && m.computer) throw new ModuleError('manifest_skill_computer', `${source}: 스킬은 화면 제어(computer)를 선언할 수 없습니다.`);
  if (m.kind === 'skill' && m.tools.length !== 1) {
    throw new ModuleError('manifest_skill_tools', `${source}: 스킬은 도구를 정확히 하나 선언해야 합니다. 지금 ${m.tools.length}개입니다.`);
  }
  return { ...m, entry };
}
