import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config/env.ts';
import type { InstallCheck, InstallReport, ModuleOrigin } from '../db/store.ts';
import { ConflictError, ModuleError, NotFoundError, ValidationError } from '../errors.ts';
import { checkRef, checkRepoUrl, extractZip, fetchGit } from './archive.ts';
import { classifyLicense, findLicenseFile, scanNodeModules, type LicenseClass } from './license.ts';
import { MODULE_ID_RE, parseManifest, type Manifest } from './manifest.ts';
import { findingsToCheck, staticCheck, type SourceFile } from './static-check.ts';

const STAGE_TTL_MS = 30 * 60_000;
const MAX_FILES = 400;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const CODE_LIMIT = 2 * 1024 * 1024;

export interface Staged {
  token: string;
  dir: string;
  manifest: Manifest;
  report: InstallReport;
  origin: ModuleOrigin;
  createdAt: number;
}

export interface InstallContext {
  config: Config;
  /** 다른 모듈이 이미 쓰는 도구 이름 → 모듈 id */
  toolOwners: () => Map<string, string>;
  moduleExists: (id: string) => { origin: ModuleOrigin } | null;
  envHas: (name: string) => boolean;
}

/** 폴더 안의 파일을 스택으로 훑어 읽습니다 (node_modules·.git 제외). 개수·크기 한도를 넘으면 멈춥니다. */
export function readSourceFiles(root: string, limits = { maxFiles: MAX_FILES, maxBytes: CODE_LIMIT }): SourceFile[] {
  const out: SourceFile[] = [];
  let bytes = 0;
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    const abs = path.join(root, rel);
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        stack.push(childRel);
        continue;
      }
      if (!e.isFile()) continue;
      if (!/\.(m?js|cjs|json|md|txt)$/i.test(e.name)) continue;
      const size = fs.statSync(path.join(root, childRel)).size;
      bytes += size;
      if (out.length >= limits.maxFiles || bytes > limits.maxBytes) {
        throw new ModuleError('module_too_large', `모듈 소스가 너무 큽니다 (파일 ${limits.maxFiles}개 또는 ${Math.round(limits.maxBytes / 1024)}KB 초과). node_modules 없이 소스만 올려 주세요.`);
      }
      out.push({ path: childRel, content: fs.readFileSync(path.join(root, childRel), 'utf8') });
    }
  }
  return out;
}

function licenseLabel(c: LicenseClass): string {
  return { permissive: '허용형', 'weak-copyleft': '약한 카피레프트', copyleft: '카피레프트', proprietary: '비공개', unknown: '확인 불가' }[c];
}

function runNpmInstall(dir: string, timeoutMs: number): Promise<void> {
  const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'],
      { cwd: dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return reject(new ModuleError('npm_missing', 'npm 을 찾지 못해 모듈 의존성을 설치하지 못했습니다. Node.js 와 함께 설치되는 npm 이 PATH 에 있어야 합니다.', 500));
        if (e.killed) return reject(new ModuleError('npm_timeout', `의존성 설치가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다.`, 504));
        const last = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ');
        reject(new ModuleError('npm_failed', `의존성 설치 실패: ${last || e.message}`, 502));
      },
    );
  });
}

/**
 * 설치 전 점검. 막아야 하는 문제는 level=error, 사용자가 판단할 문제는 warn.
 */
export async function buildReport(
  dir: string,
  manifest: Manifest,
  origin: ModuleOrigin,
  sourceLabel: string,
  commit: string | null,
  ctx: InstallContext,
  opts: { allowDependencies: boolean },
): Promise<InstallReport> {
  const checks: InstallCheck[] = [];
  checks.push({ label: 'module.json', level: 'ok', detail: `${manifest.id} v${manifest.version} · 진입점 ${manifest.entry} · 도구 ${manifest.tools.length}개${manifest.channel ? ' · 채널' : ''}` });

  if (!fs.existsSync(path.join(dir, manifest.entry))) {
    checks.push({ label: '진입점', level: 'error', detail: `module.json 의 entry '${manifest.entry}' 파일이 없습니다.` });
  }

  // 라이선스
  const declared = classifyLicense(manifest.license);
  const lf = findLicenseFile(dir);
  if (origin === 'agent') {
    checks.push({ label: '라이선스', level: 'ok', detail: `에이전트가 이 서버에서 만든 코드 (${manifest.license})` });
  } else if (origin === 'template') {
    // 템플릿은 이 저장소의 일부(저장소 LICENSE 를 따름)라 따로 확인할 외부 출처가 없습니다.
    checks.push({ label: '라이선스', level: 'ok', detail: `이 저장소의 템플릿으로 만든 코드 (${manifest.license})` });
  } else if (!lf) {
    checks.push({ label: '라이선스', level: 'warn', detail: `module.json 에는 ${manifest.license}(${licenseLabel(declared)})로 적혀 있지만 LICENSE 파일이 없습니다. 출처에서 라이선스를 직접 확인하세요.` });
  } else if (lf.detected && lf.detected.toUpperCase() !== manifest.license.toUpperCase()) {
    checks.push({ label: '라이선스', level: 'warn', detail: `${lf.file}(${lf.detected})와 module.json(${manifest.license})의 라이선스가 다릅니다.` });
  } else if (declared === 'permissive') {
    checks.push({ label: '라이선스', level: 'ok', detail: `${manifest.license} · ${lf.file} 와 module.json 표기 일치` });
  } else {
    const what = declared === 'copyleft' ? '함께 배포하면 같은 라이선스 조건이 적용됩니다' : declared === 'weak-copyleft' ? '수정한 파일은 공개 조건이 붙습니다' : '라이선스를 확인할 수 없습니다';
    checks.push({ label: '라이선스', level: 'warn', detail: `${manifest.license}(${licenseLabel(declared)}) — ${what}` });
  }

  // 의존성
  const pkgPath = path.join(dir, 'package.json');
  let deps: string[] = [];
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { dependencies?: Record<string, string> };
      deps = Object.keys(pkg.dependencies ?? {});
    } catch {
      checks.push({ label: '의존성', level: 'error', detail: 'package.json 이 JSON 형식이 아닙니다.' });
    }
  }
  if (deps.length === 0) {
    checks.push({ label: '의존성 라이선스', level: 'ok', detail: '외부 패키지 없음' });
  } else if (!opts.allowDependencies) {
    checks.push({ label: '의존성 라이선스', level: 'error', detail: `에이전트가 만든 모듈은 외부 패키지를 쓸 수 없습니다 (${deps.slice(0, 3).join(', ')}${deps.length > 3 ? ' 외' : ''}). Node 내장 모듈과 ctx.fetch 만 쓰세요.` });
  } else {
    try {
      await runNpmInstall(dir, ctx.config.moduleCallTimeoutMs * 4);
      const found = scanNodeModules(dir);
      const counts = new Map<string, number>();
      for (const d of found) counts.set(d.license ?? '없음', (counts.get(d.license ?? '없음') ?? 0) + 1);
      const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l} ${n}`).join(' · ');
      const risky = found.filter((d) => d.cls === 'copyleft' || d.cls === 'unknown' || d.cls === 'proprietary');
      if (risky.length > 0) {
        const r = risky[0] as (typeof risky)[number];
        checks.push({ label: '의존성 라이선스', level: 'warn', detail: `${found.length}개 중 ${summary} — ${r.name}@${r.version}(${r.license ?? '표기 없음'}, ${licenseLabel(r.cls)})${risky.length > 1 ? ` 외 ${risky.length - 1}개` : ''} 확인 필요` });
      } else {
        checks.push({ label: '의존성 라이선스', level: 'ok', detail: `${found.length}개 모두 허용형 · ${summary}` });
      }
    } catch (err) {
      checks.push({ label: '의존성 라이선스', level: 'error', detail: (err as Error).message });
    }
  }

  checks.push({ label: '출처 고정', level: 'ok', detail: commit ? `${sourceLabel} @ ${commit.slice(0, 7)}` : sourceLabel });

  // 권한
  const p = manifest.permissions;
  const permParts = [p.net.length > 0 ? `net.fetch(${p.net.join(', ')})` : null, manifest.channel ? 'message.send' : null, p.childProcess ? 'child_process' : null].filter(Boolean);
  const wide = p.net.includes('*') || p.childProcess;
  checks.push({ label: '요청 권한', level: wide ? 'warn' : 'ok', detail: permParts.length > 0 ? `${permParts.join(' · ')}${wide ? ' — 범위가 넓습니다' : ''}` : '추가 권한 없음' });

  // 환경 변수
  if (manifest.env.length === 0) {
    checks.push({ label: '필요한 env', level: 'ok', detail: '없음' });
  } else {
    const missing = manifest.env.filter((e) => e.required && !ctx.envHas(e.name)).map((e) => e.name);
    checks.push({
      label: '필요한 env',
      level: missing.length > 0 ? 'warn' : 'ok',
      detail: missing.length > 0 ? `${missing.join(', ')} 이(가) .env 에 없습니다. 설치는 되지만 값을 넣기 전에는 시작하지 않습니다.` : manifest.env.map((e) => e.name).join(', '),
    });
  }

  // 정적 검사
  checks.push(findingsToCheck(staticCheck(readSourceFiles(dir), manifest)));

  // 이름 충돌
  const owners = ctx.toolOwners();
  const clash = manifest.tools.find((t) => owners.has(t.name) && owners.get(t.name) !== manifest.id);
  if (clash) {
    const owner = owners.get(clash.name);
    checks.push({
      label: '도구 이름',
      level: 'error',
      detail: owner === 'builtin' ? `'${clash.name}'은(는) 내장 도구 이름이라 쓸 수 없습니다. 다른 이름으로 바꾸세요.` : `도구 '${clash.name}'은(는) 이미 모듈 '${owner}'이(가) 쓰고 있습니다. 다른 이름으로 바꾸세요.`,
    });
  }
  const existing = ctx.moduleExists(manifest.id);
  if (existing && existing.origin !== origin) {
    checks.push({ label: '모듈 id', level: 'error', detail: `id '${manifest.id}'은(는) 이미 다른 방식(${existing.origin})으로 설치된 모듈이 쓰고 있습니다.` });
  }

  return { checks, source: sourceLabel, commit, checkedAt: Date.now() };
}

export class Installer {
  private readonly ctx: InstallContext;
  private readonly staged = new Map<string, Staged>();

  constructor(ctx: InstallContext) {
    this.ctx = ctx;
  }

  private stagingDir(): string {
    const dir = path.join(this.ctx.config.dataDir, 'tmp', crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [token, s] of this.staged) {
      if (now - s.createdAt > STAGE_TTL_MS) {
        fs.rmSync(s.dir, { recursive: true, force: true });
        this.staged.delete(token);
      }
    }
  }

  private stash(dir: string, manifest: Manifest, report: InstallReport, origin: ModuleOrigin): Staged {
    this.purgeExpired();
    const token = crypto.randomBytes(12).toString('base64url');
    const s: Staged = { token, dir, manifest, report, origin, createdAt: Date.now() };
    this.staged.set(token, s);
    return s;
  }

  private readManifest(dir: string, source: string): Manifest {
    const p = path.join(dir, 'module.json');
    if (!fs.existsSync(p)) throw new ModuleError('manifest_missing', `${source} 에 module.json 이 없습니다. 모듈 폴더 맨 위에 module.json 이 있어야 합니다.`);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      throw new ModuleError('manifest_json', `${source} 의 module.json 이 JSON 형식이 아닙니다: ${(err as Error).message}`);
    }
    return parseManifest(raw, source);
  }

  /** Git 저장소에서 내려받아 점검까지 합니다. 설치는 commit() 으로 확정합니다. */
  async fromGit(url: string, ref: string): Promise<Staged> {
    const urlErr = checkRepoUrl(url);
    if (urlErr) throw new ValidationError('git_url', urlErr);
    const refErr = checkRef(ref);
    if (refErr) throw new ValidationError('git_ref_format', refErr);
    const dir = this.stagingDir();
    try {
      const { commit } = await fetchGit(this.ctx.config.gitBin, url.trim(), ref.trim(), dir, this.ctx.config.moduleCallTimeoutMs * 2);
      const manifest = this.readManifest(dir, url);
      const u = new URL(url.trim());
      const report = await buildReport(dir, manifest, 'git', `${u.host}${u.pathname.replace(/\.git$/, '')}`, commit, this.ctx, { allowDependencies: true });
      return this.stash(dir, manifest, report, 'git');
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  async fromZip(data: Uint8Array, fileName: string): Promise<Staged> {
    const dir = this.stagingDir();
    try {
      extractZip(data, dir, { maxFiles: MAX_FILES, maxBytes: MAX_TOTAL_BYTES });
      const manifest = this.readManifest(dir, fileName);
      const sha = crypto.createHash('sha256').update(data).digest('hex');
      const report = await buildReport(dir, manifest, 'zip', `${fileName} · sha256 ${sha.slice(0, 12)}`, null, this.ctx, { allowDependencies: true });
      return this.stash(dir, manifest, report, 'zip');
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** 에이전트가 만든 모듈: 받은 파일로 폴더를 꾸리고 점검합니다. 외부 패키지는 허용하지 않습니다. */
  async fromFiles(files: SourceFile[], agentName: string): Promise<Staged> {
    const dir = this.stagingDir();
    try {
      if (files.length === 0) throw new ValidationError('module_files_empty', '파일이 하나도 없습니다. 최소한 module.json 과 진입점 파일이 필요합니다.');
      if (files.length > 20) throw new ValidationError('module_files_many', `파일은 20개까지 만들 수 있습니다. 지금 ${files.length}개입니다.`);
      let total = 0;
      for (const f of files) {
        const safe = f.path.replace(/\\/g, '/');
        if (safe.startsWith('/') || safe.split('/').includes('..') || safe.includes('\0')) {
          throw new ValidationError('module_file_path', `파일 경로 '${f.path}'는 모듈 폴더 밖을 가리킵니다.`);
        }
        total += Buffer.byteLength(f.content);
        if (total > 256 * 1024) throw new ValidationError('module_files_size', '파일 내용 합계가 256KB 를 넘습니다.');
        const target = path.join(dir, safe);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, f.content);
      }
      const manifest = this.readManifest(dir, `${agentName}이(가) 만든 모듈`);
      const report = await buildReport(dir, manifest, 'agent', `${agentName} 제작`, null, this.ctx, { allowDependencies: false });
      return this.stash(dir, manifest, report, 'agent');
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  /** 템플릿을 복사해 새 모듈을 만듭니다. id·이름은 사용자가 정합니다. */
  async fromTemplate(templateId: string, id: string, name: string): Promise<Staged> {
    if (!/^[a-z0-9-]{1,40}$/.test(templateId)) throw new ValidationError('template_id', `템플릿 id '${templateId}' 형식이 올바르지 않습니다.`);
    const src = path.join(this.ctx.config.templatesDir, templateId);
    if (!fs.existsSync(path.join(src, 'module.json'))) throw new NotFoundError('템플릿', templateId);
    if (!MODULE_ID_RE.test(id)) throw new ValidationError('module_id', `모듈 id '${id}'는 영문 소문자로 시작하고 소문자·숫자·하이픈만, 2~32자여야 합니다.`);
    if (this.ctx.moduleExists(id)) throw new ConflictError('module_exists', `id '${id}' 모듈이 이미 있습니다. 다른 id 를 쓰세요.`);
    const dir = this.stagingDir();
    try {
      fs.cpSync(src, dir, { recursive: true });
      const mPath = path.join(dir, 'module.json');
      const raw = JSON.parse(fs.readFileSync(mPath, 'utf8')) as Record<string, unknown>;
      raw['id'] = id;
      raw['name'] = name.trim() || id;
      // 템플릿 도구 이름이 겹치지 않도록 id 를 앞에 붙입니다.
      if (Array.isArray(raw['tools'])) {
        raw['tools'] = (raw['tools'] as Record<string, unknown>[]).map((t) => ({ ...t, handler: t['handler'] ?? t['name'], name: `${id.replace(/-/g, '_')}_${String(t['name'])}`.slice(0, 64) }));
      }
      fs.writeFileSync(mPath, JSON.stringify(raw, null, 2));
      const manifest = this.readManifest(dir, `템플릿 ${templateId}`);
      const report = await buildReport(dir, manifest, 'template', `템플릿 ${templateId}`, null, this.ctx, { allowDependencies: false });
      return this.stash(dir, manifest, report, 'template');
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  get(token: string): Staged {
    this.purgeExpired();
    const s = this.staged.get(token);
    if (!s) throw new ModuleError('stage_expired', '점검 결과가 만료되었거나 없습니다. 다시 검사하세요 (30분 동안 보관).', 410);
    return s;
  }

  /** 점검을 통과한(오류 없는) 모듈을 최종 위치로 옮깁니다. 돌려받은 경로에 모듈이 있습니다. */
  commit(token: string, kind: 'module' | 'skill'): { dir: string; manifest: Manifest; report: InstallReport; origin: ModuleOrigin } {
    const s = this.get(token);
    const blocking = s.report.checks.filter((c) => c.level === 'error');
    if (blocking.length > 0) {
      throw new ModuleError('install_blocked', `점검에서 해결해야 할 문제가 ${blocking.length}개 있어 설치하지 않았습니다: ${blocking.map((c) => `${c.label} — ${c.detail}`).join(' / ')}`, 409);
    }
    const base = kind === 'skill' ? 'skills' : 'modules';
    const dest = path.join(this.ctx.config.dataDir, base, s.manifest.id);
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(s.dir, dest);
    this.staged.delete(token);
    return { dir: dest, manifest: s.manifest, report: s.report, origin: s.origin };
  }

  discard(token: string): void {
    const s = this.staged.get(token);
    if (!s) return;
    fs.rmSync(s.dir, { recursive: true, force: true });
    this.staged.delete(token);
  }
}
