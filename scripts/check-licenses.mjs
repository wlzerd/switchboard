// 의존성 라이선스 점검.
//   npm run licenses            → 배포되는(dev 제외) 패키지의 라이선스를 확인하고, 제한적이거나 알 수 없는 것이 있으면 실패
//   npm run licenses -- --write → docs/THIRD_PARTY_LICENSES.md 를 다시 만듭니다
// 트리 순회는 재귀 대신 스택을 씁니다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyLicense, findLicenseFile, scanNodeModules } from '../server/src/modules/license.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

/** npm ls 로 배포 의존성(이름@버전) 목록을 얻습니다. 문제가 있어도 npm ls 는 JSON 을 내므로 stdout 을 씁니다. */
function productionPackages() {
  let out;
  try {
    out = execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--omit=dev', '--all', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  } catch (err) {
    out = err.stdout;
    if (!out) throw new Error(`npm ls 를 실행하지 못했습니다: ${err.message}`);
  }
  const tree = JSON.parse(out);
  const keys = new Set();
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (!dep || typeof dep !== 'object') continue;
      if (dep.version) keys.add(`${name}@${dep.version}`);
      stack.push(dep);
    }
  }
  return keys;
}

const workspaceNames = new Set();
for (const ws of JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces ?? []) {
  try {
    workspaceNames.add(JSON.parse(fs.readFileSync(path.join(root, ws, 'package.json'), 'utf8')).name);
  } catch {
    // 워크스페이스 package.json 이 없으면 건너뜁니다.
  }
}

const prod = productionPackages();
// 루트와 각 워크스페이스의 node_modules 를 모두 훑습니다 (호이스팅되지 않은 패키지 포함).
const scanned = new Map();
const workspaceDirs = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces ?? []).map((ws) => path.join(root, ws));
for (const dir of [root, ...workspaceDirs]) {
  for (const p of scanNodeModules(dir)) scanned.set(`${p.name}@${p.version}`, p);
}

const rows = [];
const missing = [];
for (const key of [...prod].sort()) {
  const p = scanned.get(key);
  if (!p) {
    missing.push(key);
    continue;
  }
  if (workspaceNames.has(p.name)) continue;
  let license = p.license;
  let cls = p.cls;
  let note = '';
  if (cls === 'unknown') {
    const lf = findLicenseFile(p.dir);
    if (lf?.detected) {
      license = lf.detected;
      cls = classifyLicense(lf.detected);
      note = `${lf.file} 로 확인`;
    }
  }
  rows.push({ name: p.name, version: p.version, license: license ?? '(표기 없음)', cls, repository: p.repository, note });
}

const LABEL = { permissive: '허용형', 'weak-copyleft': '약한 카피레프트', copyleft: '카피레프트', proprietary: '비공개', unknown: '확인 불가' };
const counts = {};
for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
const risky = rows.filter((r) => r.cls !== 'permissive');

console.log(`배포 의존성 ${rows.length}개: ${Object.entries(counts).map(([k, n]) => `${LABEL[k]} ${n}`).join(' · ')}`);
if (missing.length > 0) console.log(`node_modules 에서 찾지 못한 패키지 ${missing.length}개 (npm install 이 필요할 수 있음): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
for (const r of risky) console.log(`  확인 필요 · ${r.name}@${r.version} — ${r.license} (${LABEL[r.cls]})${r.repository ? ` · ${r.repository}` : ''}`);

if (write) {
  const clean = (url) => (url ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/');
  const lines = [
    '# 서드파티 라이선스',
    '',
    '`npm run licenses -- --write` 로 만든 파일입니다. 배포되는 의존성(개발 도구 제외)과 라이선스, 출처를 적습니다.',
    '',
    '| 패키지 | 버전 | 라이선스 | 출처 |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license}${r.note ? ` (${r.note})` : ''} | ${r.repository ? clean(r.repository) : '-'} |`),
    '',
  ];
  const target = path.join(root, 'docs', 'THIRD_PARTY_LICENSES.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, lines.join('\n'));
  console.log(`${path.relative(root, target)} 를 다시 만들었습니다 (${rows.length}개).`);
}

if (risky.some((r) => r.cls === 'copyleft' || r.cls === 'proprietary' || r.cls === 'unknown')) {
  console.error('카피레프트 · 비공개 · 확인 불가 라이선스가 있습니다. 출처에서 직접 확인한 뒤 교체하거나 문서에 사유를 남기세요.');
  process.exit(1);
}
