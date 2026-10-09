import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { ModuleError } from '../errors.ts';

export interface ZipLimits {
  maxFiles: number;
  maxBytes: number;
}

/**
 * zip 항목 이름이 안전한지. 압축 해제 경로가 대상 폴더를 벗어나는 항목(zip slip)을 막습니다.
 * 안전하면 정리된 상대 경로, 아니면 이유를 담은 문자열을 { error } 로 돌려줍니다.
 */
export function safeEntryName(name: string): { path: string } | { error: string } {
  if (name.includes('\0')) return { error: `항목 이름에 NUL 문자가 있습니다: ${JSON.stringify(name)}` };
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) return { error: `절대 경로 항목은 풀 수 없습니다: ${name}` };
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return { error: `상위 폴더(..)를 가리키는 항목은 풀 수 없습니다: ${name}` };
  return { path: parts.join('/') };
}

/** zip 을 dest 에 풉니다. 파일 수·전체 크기 한도를 넘거나 위험한 경로가 있으면 하나도 쓰지 않고 실패합니다. */
export function extractZip(data: Uint8Array, dest: string, limits: ZipLimits): string[] {
  let count = 0;
  let declared = 0;
  let problem: string | null = null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter(file) {
        if (problem) return false;
        if (file.name.endsWith('/')) return false;
        const safe = safeEntryName(file.name);
        if ('error' in safe) {
          problem = safe.error;
          return false;
        }
        count += 1;
        declared += file.originalSize;
        if (count > limits.maxFiles) problem = `파일이 ${limits.maxFiles}개를 넘습니다.`;
        else if (declared > limits.maxBytes) problem = `압축을 풀면 ${Math.round(limits.maxBytes / 1024 / 1024)}MB 를 넘습니다.`;
        return problem === null;
      },
    });
  } catch (err) {
    throw new ModuleError('zip_corrupt', `zip 파일을 읽지 못했습니다: ${(err as Error).message}`);
  }
  if (problem) throw new ModuleError('zip_rejected', `zip 을 풀지 않았습니다. ${problem}`);

  let actual = 0;
  for (const content of Object.values(files)) actual += content.length;
  if (actual > limits.maxBytes) throw new ModuleError('zip_rejected', `zip 을 풀지 않았습니다. 실제 크기(${actual}바이트)가 선언된 크기와 다르고 한도를 넘습니다.`);

  // 모든 파일이 한 최상위 폴더 아래 있으면(GitHub 다운로드 형태) 그 폴더를 벗깁니다.
  const names = Object.keys(files).map((n) => (safeEntryName(n) as { path: string }).path);
  const firstSeg = names[0]?.split('/')[0];
  const strip = firstSeg !== undefined && names.length > 0 && names.every((n) => n.startsWith(`${firstSeg}/`)) ? `${firstSeg}/` : '';

  const written: string[] = [];
  for (const [rawName, content] of Object.entries(files)) {
    const rel = (safeEntryName(rawName) as { path: string }).path.slice(strip.length);
    if (rel === '') continue;
    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(rel);
  }
  return written;
}

export interface GitResult {
  commit: string;
}

function run(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env['PATH'] ?? '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', HOME: cwd } },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (e.code === 'ENOENT') {
          reject(new ModuleError('git_missing', `git 실행 파일을 찾지 못했습니다(GIT_BIN=${bin}). git 을 설치하거나 .env 의 GIT_BIN 에 경로를 지정하세요.`, 500));
          return;
        }
        if (e.killed) {
          reject(new ModuleError('git_timeout', `git ${args[0]} 가 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않았습니다. 저장소가 너무 크거나 네트워크가 느립니다.`, 504));
          return;
        }
        const last = stderr.trim().split('\n').filter(Boolean).pop() ?? e.message;
        reject(new ModuleError('git_failed', `git ${args[0]} 실패: ${last}`, 502));
      },
    );
  });
}

/** 저장소의 특정 ref(브랜치·태그·커밋)를 dest 에 내려받고, 고정된 커밋 해시를 돌려줍니다. */
export async function fetchGit(bin: string, url: string, ref: string, dest: string, timeoutMs: number): Promise<GitResult> {
  fs.mkdirSync(dest, { recursive: true });
  await run(bin, ['init', '-q'], dest, timeoutMs);
  await run(bin, ['remote', 'add', 'origin', url], dest, timeoutMs);
  try {
    await run(bin, ['fetch', '-q', '--depth', '1', '--no-tags', 'origin', ref], dest, timeoutMs);
  } catch (err) {
    if (err instanceof ModuleError && err.code === 'git_failed') {
      throw new ModuleError('git_ref', `저장소에서 '${ref}'을(를) 가져오지 못했습니다. 저장소 주소와 브랜치·태그·커밋 이름을 확인하세요. (${err.message})`, 502);
    }
    throw err;
  }
  await run(bin, ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], dest, timeoutMs);
  const { stdout } = await run(bin, ['rev-parse', 'HEAD'], dest, timeoutMs);
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true });
  return { commit: stdout.trim() };
}

/** 저장소 주소 검증: https://호스트/소유자/저장소(.git) 형태만 받습니다. */
export function checkRepoUrl(raw: string): string | null {
  const v = raw.trim();
  if (v === '') return '저장소 주소를 입력하세요.';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return `URL 형식이 아닙니다: '${v.slice(0, 60)}'`;
  }
  if (u.protocol !== 'https:') return `https:// 로 시작하는 주소만 받습니다. 입력값은 '${u.protocol}//' 입니다.`;
  if (u.username || u.password) return '주소에 사용자 이름이나 비밀번호를 넣지 마세요. 공개 저장소 주소만 받습니다.';
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) return `저장소 경로가 아닙니다. https://호스트/소유자/저장소 형식이어야 합니다 (지금 경로: ${u.pathname}).`;
  return null;
}

/** ref 검증: 옵션처럼 보이는 값(-로 시작)이나 공백·특수문자를 막습니다. */
export function checkRef(raw: string): string | null {
  const v = raw.trim();
  if (v === '') return '브랜치·태그·커밋을 입력하세요 (예: main, v1.0.0).';
  if (v.startsWith('-')) return `'${v}'처럼 -로 시작하는 값은 쓸 수 없습니다.`;
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(v) || v.includes('..')) return `브랜치·태그·커밋 이름에 쓸 수 없는 문자가 있습니다: '${v}'`;
  return null;
}
