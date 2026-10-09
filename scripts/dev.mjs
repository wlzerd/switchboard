// 개발 모드: 서버(node --watch)와 화면(vite)을 함께 띄웁니다. 하나가 죽으면 나머지도 정리합니다.
// 사용: npm run dev
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

const procs = [
  { name: 'server', tint: 36, args: ['run', 'dev', '-w', 'server'] },
  { name: 'web', tint: 35, args: ['run', 'dev', '-w', 'web'] },
];

let stopping = false;
const children = [];

function pipe(stream, label, out) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      out.write(`${label} ${buf.slice(0, nl)}\n`);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buf) out.write(`${label} ${buf}\n`);
  });
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null && !c.killed) c.kill('SIGTERM');
  // 5초 안에 끝나지 않으면 강제로 끝냅니다.
  setTimeout(() => {
    for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
    process.exit(code);
  }, 5000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null ? Promise.resolve() : new Promise((r) => c.once('exit', r))))).then(() => process.exit(code));
}

for (const p of procs) {
  const label = paint(p.tint, `[${p.name}]`.padEnd(8));
  const child = spawn(npm, p.args, { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], shell: isWin, env: { ...process.env, FORCE_COLOR: color ? '1' : '0' } });
  children.push(child);
  pipe(child.stdout, label, process.stdout);
  pipe(child.stderr, label, process.stderr);
  child.on('error', (err) => {
    process.stderr.write(`${label} 시작하지 못했습니다: ${err.message} (npm 이 PATH 에 있는지 확인하세요)\n`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.stderr.write(`${label} 종료됨 (${signal ? `신호 ${signal}` : `코드 ${code}`}) — 나머지도 멈춥니다.\n`);
    stopAll(code ?? 1);
  });
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
