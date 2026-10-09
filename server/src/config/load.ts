import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type Config } from './env.ts';

/**
 * 저장소 루트를 찾습니다: 이 파일에서 위로 올라가며 workspaces 가 있는 package.json 을 찾습니다.
 * 재귀 대신 반복문을 씁니다.
 */
export function findRootDir(startFile: string = fileURLToPath(import.meta.url)): string {
  let dir = path.dirname(startFile);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
        if (Array.isArray(pkg.workspaces)) return dir;
      } catch {
        // 깨진 package.json 은 루트로 보지 않고 계속 올라갑니다.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** 루트의 .env 를 읽고(있을 때만) 설정을 검증해 돌려줍니다. 이미 설정된 환경 변수는 덮어쓰지 않습니다. */
export function loadConfig(): Config {
  const rootDir = findRootDir();
  const envPath = path.join(rootDir, '.env');
  if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
  return parseConfig(process.env, rootDir);
}
