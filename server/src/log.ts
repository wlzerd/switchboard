import type { LogLevel } from './config/env.ts';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

/** 한 줄짜리 구조화 로그. 비밀값이 섞이지 않도록 data 에는 키 원문을 넣지 않습니다. */
export function createLogger(level: LogLevel, scope = 'app'): Logger {
  const min = ORDER[level];
  const write = (lv: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[lv] < min) return;
    const line = `${new Date().toISOString()} ${lv.toUpperCase().padEnd(5)} [${scope}] ${msg}${data ? ' ' + safeJson(data) : ''}`;
    if (lv === 'error' || lv === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (s) => createLogger(level, `${scope}:${s}`),
  };
}

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v));
  } catch {
    return '[직렬화할 수 없는 로그 데이터]';
  }
}
