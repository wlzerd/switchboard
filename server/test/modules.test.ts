import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../src/config/env.ts';
import type { ModuleRow, ModuleStatus } from '../src/db/store.ts';
import { checkRef, checkRepoUrl, extractZip, safeEntryName } from '../src/modules/archive.ts';
import { ModuleHost, restartDelayMs, shouldGiveUp } from '../src/modules/host.ts';
import { buildReport, type InstallContext } from '../src/modules/install.ts';
import { classifyLicense, detectLicenseText, packageLicense } from '../src/modules/license.ts';
import { parseManifest } from '../src/modules/manifest.ts';
import { staticCheck } from '../src/modules/static-check.ts';
import { createLogger } from '../src/log.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

describe('zip 항목 경로', () => {
  it.each([
    ['a/b.js', 'a/b.js'],
    ['./a//b.js', 'a/b.js'],
    ['a\\b.js', 'a/b.js'],
  ])('%s → %s', (name, want) => {
    expect(safeEntryName(name)).toEqual({ path: want });
  });

  it.each(['../evil.js', 'a/../../b.js', '/etc/passwd', 'C:/x.js', 'a\u0000b'])('거부: %j', (name) => {
    expect('error' in safeEntryName(name)).toBe(true);
  });
});

describe('extractZip', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'sb-zip-'));

  it('경로 탈출 항목이 하나라도 있으면 아무것도 쓰지 않는다', () => {
    const dir = tmp();
    const data = zipSync({ 'ok.js': strToU8('1'), '../evil.js': strToU8('2') });
    expect(() => extractZip(data, dir, { maxFiles: 10, maxBytes: 1000 })).toThrow('상위 폴더(..)');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('파일 수 경계: 한도와 같으면 통과, 넘으면 거부', () => {
    const files = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.txt`, strToU8('x')]));
    expect(extractZip(zipSync(files(3)), tmp(), { maxFiles: 3, maxBytes: 1000 })).toHaveLength(3);
    expect(() => extractZip(zipSync(files(4)), tmp(), { maxFiles: 3, maxBytes: 1000 })).toThrow('3개를 넘습니다');
  });

  it('풀린 크기 한도', () => {
    const data = zipSync({ 'big.txt': strToU8('a'.repeat(2000)) });
    expect(() => extractZip(data, tmp(), { maxFiles: 10, maxBytes: 1999 })).toThrow('MB');
    expect(extractZip(data, tmp(), { maxFiles: 10, maxBytes: 2000 })).toEqual(['big.txt']);
  });

  it('GitHub 형태의 최상위 폴더 하나는 벗긴다', () => {
    const dir = tmp();
    extractZip(zipSync({ 'repo-main/module.json': strToU8('{}'), 'repo-main/src/a.js': strToU8('') }), dir, { maxFiles: 10, maxBytes: 1000 });
    expect(fs.existsSync(path.join(dir, 'module.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'src', 'a.js'))).toBe(true);
  });

  it('깨진 파일은 형식 오류로 알린다', () => {
    expect(() => extractZip(new Uint8Array([1, 2, 3, 4]), tmp(), { maxFiles: 10, maxBytes: 1000 })).toThrow('zip 파일을 읽지 못했습니다');
  });
});

describe('저장소 주소·ref 검증', () => {
  it.each([
    ['https://github.com/a/b', null],
    ['https://github.com/a/b.git', null],
    ['http://github.com/a/b', 'https://'],
    ['https://user:pw@github.com/a/b', '비밀번호'],
    ['https://github.com/a', '저장소 경로가 아닙니다'],
    ['https://github.com/a/b/c', '저장소 경로가 아닙니다'],
    ['', '입력하세요'],
  ])('%s', (url, want) => {
    const r = checkRepoUrl(url);
    if (want === null) expect(r).toBeNull();
    else expect(r).toContain(want);
  });

  it.each([
    ['main', true],
    ['v1.0.2', true],
    ['feature/x', true],
    ['--upload-pack=evil', false],
    ['a..b', false],
    ['a b', false],
  ])('ref %s 허용 %s', (ref, ok) => {
    expect(checkRef(ref) === null).toBe(ok);
  });
});

describe('라이선스 분류', () => {
  it.each([
    ['MIT', 'permissive'],
    ['Apache-2.0 WITH LLVM-exception', 'permissive'],
    ['(MIT OR Apache-2.0)', 'permissive'],
    ['MIT OR GPL-3.0', 'permissive'],
    ['MIT AND GPL-3.0', 'copyleft'],
    ['LGPL-2.1+', 'weak-copyleft'],
    ['MPL-2.0', 'weak-copyleft'],
    ['AGPL-3.0-only', 'copyleft'],
    ['UNLICENSED', 'proprietary'],
    ['SEE LICENSE IN LICENSE.md', 'unknown'],
    ['', 'unknown'],
  ])('%s → %s', (expr, want) => {
    expect(classifyLicense(expr)).toBe(want);
  });

  it('package.json 의 여러 표기', () => {
    expect(packageLicense({ license: 'ISC' })).toBe('ISC');
    expect(packageLicense({ license: { type: 'MIT' } })).toBe('MIT');
    expect(packageLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0');
    expect(packageLicense({})).toBeNull();
  });

  it('LICENSE 본문 추정', () => {
    expect(detectLicenseText('MIT License\n\nPermission is hereby granted, free of charge, to any person')).toBe('MIT');
    expect(detectLicenseText('GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007')).toBe('GPL-3.0');
    expect(detectLicenseText('                                 Apache License\n                           Version 2.0, January 2004')).toBe('Apache-2.0');
    expect(detectLicenseText('그냥 텍스트')).toBeNull();
  });
});

describe('설치 점검 · 라이선스 항목', () => {
  const KEY32 = Buffer.alloc(32, 1).toString('base64');
  const config = parseConfig({ ADMIN_PASSWORD: 'x'.repeat(12), SESSION_SECRET: 's'.repeat(32), SECRETS_KEY: KEY32 }, repoRoot);
  const ctx: InstallContext = { config, toolOwners: () => new Map(), moduleExists: () => null, envHas: () => true };
  const repoLicense = fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8');
  const gpl = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n';

  /** 저장소의 blank 템플릿을 복사한 폴더에서 점검을 돌려 '라이선스' 항목만 꺼냅니다. */
  const licenseCheck = async (origin: 'template' | 'zip' | 'git', licenseFile: string | null, declared = 'MIT') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lic-'));
    try {
      fs.cpSync(path.join(repoRoot, 'templates', 'blank'), dir, { recursive: true });
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'module.json'), 'utf8')) as Record<string, unknown>;
      raw['license'] = declared;
      fs.writeFileSync(path.join(dir, 'module.json'), JSON.stringify(raw));
      if (licenseFile !== null) fs.writeFileSync(path.join(dir, 'LICENSE'), licenseFile);
      const report = await buildReport(dir, parseManifest(raw, 'test'), origin, 'test', null, ctx, { allowDependencies: false });
      return report.checks.find((c) => c.label === '라이선스');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it('저장소 LICENSE 는 MIT 로 인식된다', () => {
    expect(detectLicenseText(repoLicense)).toBe('MIT');
  });

  it('템플릿으로 만든 모듈은 LICENSE 파일이 없어도 경고하지 않는다 (저장소 라이선스를 따름)', async () => {
    expect((await licenseCheck('template', null))?.level).toBe('ok');
  });

  it('외부에서 받은 모듈은 LICENSE 파일이 없으면 경고한다', async () => {
    const c = await licenseCheck('zip', null);
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('LICENSE 파일이 없습니다');
  });

  it('LICENSE 와 module.json 표기가 맞으면 통과, 다르면 경고한다', async () => {
    expect((await licenseCheck('git', repoLicense))?.level).toBe('ok');
    const mismatch = await licenseCheck('git', gpl);
    expect(mismatch?.level).toBe('warn');
    expect(mismatch?.detail).toContain('GPL-3.0');
  });

  it('카피레프트 표기는 LICENSE 가 맞아도 조건을 알려준다', async () => {
    const c = await licenseCheck('zip', gpl, 'GPL-3.0');
    expect(c?.level).toBe('warn');
    expect(c?.detail).toContain('같은 라이선스 조건');
  });
});

describe('정적 검사', () => {
  const m = (childProcess = false) =>
    parseManifest({ id: 'x-mod', name: 'x', version: '1.0.0', license: 'MIT', permissions: { net: [], fsWrite: false, childProcess } }, 'test');

  it('eval 은 막고 이름에 eval 이 들어간 함수는 통과', () => {
    const f = staticCheck([{ path: 'index.js', content: 'const r = evaluate(x);\nobj.eval(1);\nconst y = eval("1");' }], m());
    expect(f.map((x) => `${x.rule}:${x.line}`)).toEqual(['eval:3']);
  });

  it('child_process 는 매니페스트가 허용하면 통과', () => {
    const code = "import { spawn } from 'node:child_process';";
    expect(staticCheck([{ path: 'a.js', content: code }], m(false)).map((x) => x.rule)).toEqual(['child-process']);
    expect(staticCheck([{ path: 'a.js', content: code }], m(true))).toEqual([]);
  });

  it('주석 줄과 node_modules 는 보지 않는다', () => {
    expect(staticCheck([{ path: 'a.js', content: '// eval(x)\n * new Function()' }], m())).toEqual([]);
    expect(staticCheck([{ path: 'node_modules/x/a.js', content: 'eval(1)' }], m())).toEqual([]);
  });
});

describe('재시작 정책', () => {
  it.each([
    [0, 1000],
    [1, 1000],
    [2, 2000],
    [6, 32000],
    [7, 60000],
    [100, 60000],
  ])('%i번째 → %ims', (attempt, want) => {
    expect(restartDelayMs(attempt)).toBe(want);
  });

  it('창 안의 종료 횟수가 max 와 같으면 계속, max+1 이면 포기', () => {
    const t = [0, 1, 2, 3, 4];
    expect(shouldGiveUp(t, 10, 5, 1000)).toBe(false);
    expect(shouldGiveUp([...t, 5], 10, 5, 1000)).toBe(true);
  });

  it('창 밖으로 나간 기록은 세지 않는다 (정확히 창 길이 = 밖)', () => {
    expect(shouldGiveUp([0, 1000, 1001], 1001, 1, 1000)).toBe(true);
    expect(shouldGiveUp([0, 1000], 1000, 1, 1000)).toBe(false);
  });

  it('max=0 이면 첫 종료에서 포기', () => {
    expect(shouldGiveUp([5], 5, 0, 1000)).toBe(true);
  });
});

describe('모듈 프로세스 격리 (실제 실행)', () => {
  let workDir: string;
  let config: Config;
  const statuses: ModuleStatus[] = [];

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-host-'));
    const outside = path.join(workDir, 'outside-secret.txt');
    fs.writeFileSync(outside, 'secret');
    const modDir = path.join(workDir, 'skills', 'probe');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'index.js'),
      `import fs from 'node:fs';
export default async function run(input, ctx) {
  if (input.op === 'env') return Object.keys(process.env).sort().join(',');
  if (input.op === 'read') { try { fs.readFileSync(${JSON.stringify(outside)}); return 'READ_OK'; } catch (e) { return e.code; } }
  if (input.op === 'write') { fs.writeFileSync(ctx.dataDir + '/x.txt', 'ok'); return 'WRITE_OK'; }
  if (input.op === 'fetch') { try { await ctx.fetch('http://127.0.0.1:9/'); return 'FETCH_OK'; } catch (e) { return e.message; } }
  if (input.op === 'throw') throw new Error('일부러 낸 오류');
  return { echo: input.op };
}`,
    );
    const KEY32 = Buffer.alloc(32, 1).toString('base64');
    config = parseConfig({ ADMIN_PASSWORD: 'x'.repeat(12), SESSION_SECRET: 's'.repeat(32), SECRETS_KEY: KEY32, DATA_DIR: path.join(workDir, 'data'), MODULE_CALL_TIMEOUT_MS: '15000' }, repoRoot);
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-should-not-leak';
  });

  afterAll(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const host = (): ModuleHost => {
    const manifest = parseManifest(
      { id: 'skill-probe', name: 'probe', version: '1.0.0', kind: 'skill', license: 'UNLICENSED', permissions: { net: ['api.example.com'] }, tools: [{ name: 'probe', description: 'test', input_schema: { type: 'object' } }] },
      'test',
    );
    const row: ModuleRow = { id: 'skill-probe', kind: 'skill', origin: 'agent', dir: path.join(workDir, 'skills', 'probe'), manifest, enabled: true, status: 'idle', statusDetail: null, createdBy: null, report: null, installedAt: 0, updatedAt: 0 };
    return new ModuleHost(row, {
      config,
      log: createLogger('error'),
      runnerPath: path.join(repoRoot, 'server', 'src', 'modules', 'runner.ts'),
      readDirs: [path.join(repoRoot, 'server', 'src'), path.join(repoRoot, 'node_modules')],
      envFor: () => ({ env: { NODE_ENV: 'test' }, missing: [] }),
      onStatus: (_id, s) => statuses.push(s),
      onInbound: () => {},
      onLog: () => {},
    });
  };

  it('서버 비밀 환경 변수는 전달되지 않고, 허용 폴더 밖 파일은 못 읽고, 데이터 폴더에는 쓸 수 있다', async () => {
    const h = host();
    const meta = { agentId: null, agentName: null, taskId: null };
    try {
      const env = await h.call('probe', { op: 'env' }, meta);
      expect(env).not.toContain('ANTHROPIC_API_KEY');
      expect(await h.call('probe', { op: 'read' }, meta)).toBe('ERR_ACCESS_DENIED');
      expect(await h.call('probe', { op: 'write' }, meta)).toBe('WRITE_OK');
      expect(await h.call('probe', { op: 'fetch' }, meta)).toContain('127.0.0.1 에 접속할 권한이 없습니다');
      expect(await h.call('probe', { op: 'x' }, meta)).toContain('"echo": "x"');
      await expect(h.call('probe', { op: 'throw' }, meta)).rejects.toThrow('일부러 낸 오류');
    } finally {
      await h.stop('shutdown');
    }
    expect(statuses).toContain('running');
  }, 30000);
});
