/**
 * 프로젝트 화면의 git 정보 (브랜치 · 원격과의 차이 · 바뀐 파일 · 마지막 커밋).
 *
 * 저장소는 에이전트가 쓸 수 있는 곳이라 .git/config 에 명령을 심을 수 있습니다 (core.fsmonitor, filter.*.clean 등은
 * git status 가 실행함). 서버가 대신 git 을 부르므로 그런 명령이 서버 권한 · 환경 변수로 돌지 않게:
 *  - 비밀값이 없는 최소 환경으로 실행하고, 시스템 · 사용자 git 설정을 읽지 않습니다.
 *  - 명령을 부를 수 있는 설정은 -c 로 끄고, 저장소 설정에 선언된 filter 도 이름별로 끕니다.
 *  - include 로 다른 설정 파일을 끌어오는 저장소는 읽지 않습니다 (그 안의 설정까지 따라가 끌 수 없으므로).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface GitFile {
  /** M · A · D · R · ?? · U 처럼 짧은 상태 */
  code: string;
  path: string;
}

export interface GitInfo {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** 바뀐 파일 (앞의 일부만) */
  files: GitFile[];
  /** 바뀐 파일 전체 수 */
  changed: number;
  commit: { hash: string; subject: string; at: number } | null;
}

export type GitResult = { ok: true; info: GitInfo } | { ok: false; reason: string };

/** 화면에 보일 바뀐 파일 수 */
export const GIT_FILES_SHOWN = 20;
const GIT_TIMEOUT_MS = 5000;

/**
 * git status --porcelain=v2 --branch -z 결과 해석.
 * 머리 줄: '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -0'
 * 파일: '1 XY …8칸… 경로', '2 XY …9칸… 경로\0원래경로', 'u XY …10칸… 경로', '? 경로'
 */
export function parseStatus(out: string): Omit<GitInfo, 'commit'> {
  const info: Omit<GitInfo, 'commit'> = { branch: null, upstream: null, ahead: 0, behind: 0, files: [], changed: 0 };
  const parts = out.split('\0');
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i] as string;
    i += 1;
    if (rec === '') continue;
    if (rec.startsWith('# ')) {
      const [key, ...rest] = rec.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') info.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') info.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          info.ahead = Number(m[1]);
          info.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = rec[0];
    let file: GitFile | null = null;
    if (kind === '1' || kind === '2' || kind === 'u') {
      // 앞의 고정 칸 수만큼 건너뛴 나머지가 경로입니다 (경로에 공백이 있을 수 있음).
      const fixed = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      const fields = rec.split(' ');
      const xy = fields[1] ?? '..';
      const p = fields.slice(fixed).join(' ');
      const code = kind === 'u' ? 'U' : xy[0] !== '.' ? (xy[0] as string) : (xy[1] ?? '?');
      file = { code, path: p };
      if (kind === '2') i += 1; // 원래 경로
    } else if (kind === '?') {
      file = { code: '??', path: rec.slice(2) };
    }
    if (file) {
      info.changed += 1;
      if (info.files.length < GIT_FILES_SHOWN) info.files.push(file);
    }
  }
  return info;
}

/** git log -1 --format=%h%x1f%s%x1f%ct 결과 해석 */
export function parseLastCommit(out: string): GitInfo['commit'] {
  const line = out.trim();
  if (line === '') return null;
  const [hash, subject, ct] = line.split('\x1f');
  if (!hash || ct === undefined || !/^\d+$/.test(ct)) return null;
  return { hash, subject: subject ?? '', at: Number(ct) * 1000 };
}

/**
 * 저장소 설정에서 끄지 못하는 것이 있으면 그 이유, 아니면 끌 filter 이름 목록.
 * [filter "이름"] 섹션의 이름을 모읍니다. include · includeIf 가 있으면 읽지 않습니다.
 */
export function scanRepoConfig(text: string): { filters: string[] } | { refuse: string } {
  const filters = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('[')) continue;
    if (/^\[\s*include(If)?\b/i.test(line)) return { refuse: 'git 설정에 다른 설정 파일을 끌어오는 include 가 있어 git 정보를 읽지 않았습니다.' };
    const m = /^\[\s*filter\s+"((?:[^"\\]|\\.)*)"\s*\]/i.exec(line);
    if (m) filters.add((m[1] as string).replace(/\\(.)/g, '$1'));
  }
  return { filters: [...filters] };
}

/** 명령을 부를 수 있는 설정을 끄는 -c 인자 */
export function hardeningArgs(filters: readonly string[]): string[] {
  const out = [
    '-c', 'core.fsmonitor=false',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.pager=cat',
    '-c', 'core.untrackedCache=false',
    '-c', 'diff.external=',
    '-c', 'log.showSignature=false',
    '-c', 'status.submoduleSummary=false',
  ];
  for (const f of filters) out.push('-c', `filter.${f}.clean=`, '-c', `filter.${f}.smudge=`, '-c', `filter.${f}.process=`, '-c', `filter.${f}.required=false`);
  return out;
}

function run(gitBin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(gitBin, args, { env, timeout: GIT_TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') reject(new Error(`git(${gitBin}) 을 찾지 못했습니다. GIT_BIN 을 확인하세요.`));
        else if (e.killed) reject(new Error(`git 이 ${GIT_TIMEOUT_MS / 1000}초 안에 끝나지 않았습니다.`));
        else reject(new Error((stderr || e.message).trim().split('\n').slice(-1)[0] ?? e.message));
        return;
      }
      resolve(stdout);
    });
  });
}

/** 저장소 폴더의 git 정보. .git 이 폴더인 일반 저장소만 읽습니다. */
export async function readGitInfo(dir: string, gitBin: string, homeDir: string): Promise<GitResult> {
  const dotGit = path.join(dir, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return { ok: false, reason: 'git 저장소가 아닙니다.' };
  }
  if (!stat.isDirectory()) return { ok: false, reason: '.git 이 폴더가 아니라(작업 트리 · 서브모듈) git 정보를 읽지 않았습니다.' };
  let configText = '';
  try {
    configText = fs.readFileSync(path.join(dotGit, 'config'), 'utf8');
  } catch {
    // 설정 파일이 없으면 끌 것도 없습니다.
  }
  const scan = scanRepoConfig(configText);
  if ('refuse' in scan) return { ok: false, reason: scan.refuse };
  fs.mkdirSync(homeDir, { recursive: true });
  // 비밀값이 든 서버 환경 변수는 넘기지 않습니다.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: homeDir,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  const base = [...hardeningArgs(scan.filters), '-C', dir];
  try {
    const status = parseStatus(await run(gitBin, [...base, 'status', '--porcelain=v2', '--branch', '-z', '--ignore-submodules=all'], env));
    let commit: GitInfo['commit'] = null;
    try {
      commit = parseLastCommit(await run(gitBin, [...base, 'log', '-1', '--no-color', '--format=%h%x1f%s%x1f%ct'], env));
    } catch {
      // 아직 커밋이 없는 저장소
    }
    return { ok: true, info: { ...status, commit } };
  } catch (err) {
    return { ok: false, reason: `git 정보를 읽지 못했습니다: ${(err as Error).message}` };
  }
}
