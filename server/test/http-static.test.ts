import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type App } from '../src/app.ts';
import { parseConfig } from '../src/config/env.ts';
import { buildServer } from '../src/http/server.ts';
import { createLogger } from '../src/log.ts';

// 웹 화면 파일 제공: 화면 주소는 index.html 로, 파일 요청은 실제 파일이나 404 로 답해야 합니다.
// (예전에는 서버를 켠 뒤 다시 빌드한 파일을 찾지 못해 index.html 을 JS 대신 돌려줬습니다.)
const repoRoot = path.resolve(import.meta.dirname, '..', '..');
let root: string;
let app: App;
let server: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-static-'));
  fs.mkdirSync(path.join(root, 'config'));
  for (const f of ['presets.json', 'guards.json', 'themes.json']) fs.copyFileSync(path.join(repoRoot, 'config', f), path.join(root, 'config', f));
  fs.mkdirSync(path.join(root, 'web', 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'dist', 'index.html'), '<!doctype html><title>Switchboard</title><div id="root"></div>');
  fs.writeFileSync(path.join(root, 'web', 'dist', 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(root, 'web', 'dist', 'assets', 'index-aaa.js'), 'console.log(1)');
  fs.mkdirSync(path.join(root, 'modules'));
  fs.mkdirSync(path.join(root, 'templates'));
  const config = parseConfig(
    {
      ADMIN_PASSWORD: 'static-test-password',
      SESSION_SECRET: 's'.repeat(40),
      SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
      DATA_DIR: path.join(root, 'data'),
      MODULES_DIR: path.join(root, 'modules'),
      TEMPLATES_DIR: path.join(root, 'templates'),
      LOG_LEVEL: 'error',
    },
    root,
  );
  app = await createApp(config, createLogger('error'));
  server = await buildServer(app);
});

afterAll(async () => {
  await server.close();
  app.db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('웹 화면 파일', () => {
  it('첫 화면과 화면 주소(깊은 링크)는 index.html 을 캐시 없이 준다', async () => {
    for (const url of ['/', '/console/agt_x', '/guard/agt_x?tab=1', '/modules']) {
      const r = await server.inject({ method: 'GET', url });
      expect({ url, status: r.statusCode }).toEqual({ url, status: 200 });
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.body).toContain('<div id="root">');
    }
  });

  it('이름에 해시가 있는 assets 는 JS 로, 오래 캐시하도록 준다', async () => {
    const r = await server.inject({ method: 'GET', url: '/assets/index-aaa.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
    expect(r.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('서버를 켠 뒤 새로 빌드된 파일도 바로 준다', async () => {
    fs.writeFileSync(path.join(root, 'web', 'dist', 'assets', 'index-bbb.js'), 'console.log(2)');
    const r = await server.inject({ method: 'GET', url: '/assets/index-bbb.js' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('console.log(2)');
  });

  it('없는 파일 요청은 index.html 이 아니라 404 와 이유를 준다', async () => {
    for (const url of ['/assets/index-old.js', '/assets/style.css', '/missing.png']) {
      const r = await server.inject({ method: 'GET', url });
      expect({ url, status: r.statusCode }).toEqual({ url, status: 404 });
      expect(r.headers['content-type']).toMatch(/^text\/plain/);
      expect(r.body).toContain('없습니다');
    }
  });

  it('dist 밖의 파일은 경로를 꾸며도 내보내지 않는다', async () => {
    for (const url of ['/../config/presets.json', '/%2e%2e/config/presets.json', '/assets/%2e%2e/%2e%2e/config/guards.json', '/..%2fconfig%2fguards.json']) {
      const r = await server.inject({ method: 'GET', url });
      expect(r.body).not.toContain('"presets"');
      expect(r.body).not.toContain('financeHosts');
    }
  });

  it('로그인 없이 API 는 막고, 없는 API 경로는 HTML 이 아니라 JSON 으로 답한다', async () => {
    const r = await server.inject({ method: 'GET', url: '/api/overview' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toMatch(/json/);
  });
});
