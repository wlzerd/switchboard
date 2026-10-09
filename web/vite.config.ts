import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// 저장소 루트의 .env 에서 서버 포트를 읽어 개발 중 /api 를 서버로 넘깁니다.
export default defineConfig(({ mode }) => {
  const rootDir = fileURLToPath(new URL('..', import.meta.url));
  const env = loadEnv(mode, rootDir, '');
  const apiPort = Number(env['PORT'] || 8787);
  const devPort = Number(env['WEB_DEV_PORT'] || 5173);
  return {
    plugins: [react()],
    server: {
      port: devPort,
      proxy: {
        '/api': { target: `http://127.0.0.1:${apiPort}`, ws: true },
        '/healthz': { target: `http://127.0.0.1:${apiPort}` },
      },
    },
    build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  };
});
