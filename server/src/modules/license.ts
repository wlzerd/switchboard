/**
 * 라이선스 확인. 모듈 설치와 이 프로젝트 자체의 의존성 점검(scripts/check-licenses.mjs)에 함께 씁니다.
 * 디렉터리는 재귀 대신 스택으로 훑습니다.
 */
import fs from 'node:fs';
import path from 'node:path';

export type LicenseClass = 'permissive' | 'weak-copyleft' | 'copyleft' | 'proprietary' | 'unknown';

const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'ISC', 'BSD-2-CLAUSE', 'BSD-3-CLAUSE', 'BSD-0-CLAUSE', '0BSD', 'APACHE-2.0', 'UNLICENSE', 'CC0-1.0',
  'BLUEOAK-1.0.0', 'ZLIB', 'PYTHON-2.0', 'OFL-1.1', 'CC-BY-4.0', 'CC-BY-3.0', 'WTFPL', 'BSL-1.0', 'X11', 'ARTISTIC-2.0',
]);
const WEAK = new Set(['MPL-2.0', 'LGPL-2.1', 'LGPL-2.1-ONLY', 'LGPL-2.1-OR-LATER', 'LGPL-3.0', 'LGPL-3.0-ONLY', 'LGPL-3.0-OR-LATER', 'EPL-1.0', 'EPL-2.0', 'CDDL-1.0', 'CDDL-1.1']);
const STRONG_PREFIX = ['GPL-', 'AGPL-', 'SSPL', 'EUPL-', 'OSL-', 'CPAL-', 'RPL-'];

function classifyOne(id: string): LicenseClass {
  const u = id.trim().toUpperCase().replace(/\+$/, '');
  if (u === '') return 'unknown';
  if (u === 'UNLICENSED' || u === 'PROPRIETARY') return 'proprietary';
  if (PERMISSIVE.has(u)) return 'permissive';
  if (WEAK.has(u)) return 'weak-copyleft';
  if (STRONG_PREFIX.some((p) => u.startsWith(p))) return 'copyleft';
  return 'unknown';
}

const RANK: Record<LicenseClass, number> = { permissive: 0, 'weak-copyleft': 1, unknown: 2, proprietary: 3, copyleft: 4 };

/**
 * SPDX 식 분류. 'A OR B' 는 더 자유로운 쪽, 'A AND B' 는 더 제한적인 쪽을 따릅니다.
 * 괄호는 한 단계까지만 풉니다(실제 패키지에서 쓰는 형태).
 */
export function classifyLicense(expr: string | null | undefined): LicenseClass {
  if (!expr) return 'unknown';
  if (/^SEE LICENSE IN/i.test(expr.trim())) return 'unknown';
  const flat = expr.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const alternatives = flat.split(/\s+OR\s+/i);
  let best: LicenseClass | null = null;
  for (const alt of alternatives) {
    let worst: LicenseClass = 'permissive';
    for (const part of alt.split(/\s+AND\s+/i)) {
      const c = classifyOne(part.replace(/\s+WITH\s+.*$/i, ''));
      if (RANK[c] > RANK[worst]) worst = c;
    }
    if (best === null || RANK[worst] < RANK[best]) best = worst;
  }
  return best ?? 'unknown';
}

/** package.json 의 license / licenses 필드에서 SPDX 식을 꺼냅니다. */
export function packageLicense(pkg: Record<string, unknown>): string | null {
  const l = pkg['license'];
  if (typeof l === 'string') return l;
  if (l && typeof l === 'object' && typeof (l as { type?: unknown }).type === 'string') return (l as { type: string }).type;
  const ls = pkg['licenses'];
  if (Array.isArray(ls)) {
    const types = ls.map((x) => (x && typeof x === 'object' ? (x as { type?: unknown }).type : x)).filter((t): t is string => typeof t === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return null;
}

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'COPYING', 'COPYING.md'];

/** LICENSE 파일 내용으로 대표 라이선스를 추정합니다. 모르면 null. */
export function detectLicenseText(text: string): string | null {
  const t = text.slice(0, 4000);
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return 'LGPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return /Version 2/i.test(t) ? 'GPL-2.0' : 'GPL-3.0';
  if (/Mozilla Public License,? (?:Version )?2\.0/i.test(t)) return 'MPL-2.0';
  if (/Apache License/i.test(t) && /Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(t)) return 'MIT';
  if (/ISC License|Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return 'ISC';
  if (/Redistribution and use in source and binary forms/i.test(t)) return /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  if (/SIL OPEN FONT LICENSE/i.test(t)) return 'OFL-1.1';
  return null;
}

export function findLicenseFile(dir: string): { file: string; detected: string | null } | null {
  for (const name of LICENSE_FILES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return { file: name, detected: detectLicenseText(fs.readFileSync(p, 'utf8')) };
    }
  }
  return null;
}

export interface DependencyLicense {
  name: string;
  version: string;
  license: string | null;
  cls: LicenseClass;
  repository: string | null;
  dir: string;
}

function repoUrl(pkg: Record<string, unknown>): string | null {
  const r = pkg['repository'];
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && typeof (r as { url?: unknown }).url === 'string') return (r as { url: string }).url;
  return null;
}

/**
 * node_modules 를 훑어 설치된 패키지의 라이선스를 모읍니다 (중첩 node_modules 포함).
 * 같은 이름@버전은 한 번만 셉니다.
 */
export function scanNodeModules(root: string): DependencyLicense[] {
  const out: DependencyLicense[] = [];
  const seen = new Set<string>();
  const stack: string[] = [path.join(root, 'node_modules')];
  while (stack.length > 0) {
    const nm = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(nm, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      if (e.name.startsWith('.')) continue;
      const full = path.join(nm, e.name);
      if (e.name.startsWith('@')) {
        // 스코프 폴더: 한 단계 안의 패키지들을 같은 방식으로 처리
        let scoped: fs.Dirent[];
        try {
          scoped = fs.readdirSync(full, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const s of scoped) if (s.isDirectory() || s.isSymbolicLink()) visitPackage(path.join(full, s.name));
        continue;
      }
      visitPackage(full);
    }
  }
  return out;

  function visitPackage(dir: string): void {
    const pj = path.join(dir, 'package.json');
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(fs.readFileSync(pj, 'utf8')) as Record<string, unknown>;
    } catch {
      return;
    }
    const name = typeof pkg['name'] === 'string' ? pkg['name'] : path.basename(dir);
    const version = typeof pkg['version'] === 'string' ? pkg['version'] : '0.0.0';
    const key = `${name}@${version}`;
    if (!seen.has(key)) {
      seen.add(key);
      const license = packageLicense(pkg);
      out.push({ name, version, license, cls: classifyLicense(license), repository: repoUrl(pkg), dir });
    }
    const nested = path.join(dir, 'node_modules');
    if (fs.existsSync(nested)) stack.push(nested);
  }
}
