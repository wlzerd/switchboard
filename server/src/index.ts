import { createApp } from './app.ts';
import { loadConfig } from './config/load.ts';
import { ConfigError } from './errors.ts';
import { buildServer } from './http/server.ts';
import { createLogger } from './log.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`\n${err.message}\n\n.env.example 을 참고해 저장소 루트의 .env 를 고친 뒤 다시 시작하세요.\n\n`);
      process.exit(78);
    }
    throw err;
  }

  const log = createLogger(config.logLevel);
  const app = await createApp(config, log);
  const server = await buildServer(app);

  try {
    await server.listen({ host: config.host, port: config.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') log.error(`포트 ${config.port} 를 이미 다른 프로그램이 쓰고 있습니다. .env 의 PORT 를 바꾸거나 그 프로그램을 끄세요.`);
    else if (code === 'EACCES') log.error(`포트 ${config.port} 를 열 권한이 없습니다. 1024 미만 포트는 관리자 권한이 필요합니다. 리버스 프록시 뒤에서 높은 포트를 쓰세요.`);
    else if (code === 'EADDRNOTAVAIL') log.error(`HOST=${config.host} 주소를 이 서버에서 쓸 수 없습니다. 0.0.0.0 이나 이 서버의 IP 로 바꾸세요.`);
    else log.error('서버를 열지 못했습니다', { error: (err as Error).message });
    process.exit(1);
  }
  log.info(`Switchboard 가 http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port} 에서 실행 중입니다${config.publicUrl ? ` (외부 주소 ${config.publicUrl})` : ''}`);

  await app.registry.startChannels();
  app.scheduler.start();
  app.manager.startHeartbeats();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log.info(`${signal} 신호를 받아 종료합니다`);
    app.scheduler.stop();
    app.manager.shutdown();
    app.approvals.shutdown();
    await server.close().catch(() => {});
    await app.registry.shutdown().catch(() => {});
    app.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error('처리되지 않은 Promise 거부', { error: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined });
  });
}

void main();
