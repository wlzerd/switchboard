import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

const require = createRequire(import.meta.url);

/**
 * node:sqlite 는 Node 22 에서 실험 기능 경고를 출력합니다.
 * 이 경고 하나만 걸러내고 다른 경고는 그대로 둡니다.
 */
function loadSqlite(): { DatabaseSync: typeof DatabaseSyncType } {
  const original = process.emitWarning;
  const filtered = function (this: NodeJS.Process, warning: string | Error, ...rest: unknown[]): void {
    const msg = typeof warning === 'string' ? warning : warning.message;
    if (msg.includes('SQLite is an experimental feature')) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    return require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
  } finally {
    process.emitWarning = original;
  }
}

export type Row = Record<string, unknown>;
export type Params = Record<string, string | number | bigint | null | Uint8Array>;

export class Db {
  private readonly db: DatabaseSyncType;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const { DatabaseSync } = loadSqlite();
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const current = Number((this.db.prepare('PRAGMA user_version').get() as Row)['user_version'] ?? 0);
    for (let v = current; v < MIGRATIONS.length; v += 1) {
      const sql = MIGRATIONS[v];
      if (sql === undefined) break;
      this.tx(() => {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, params: Params = {}): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, params: Params = {}): T | undefined {
    return this.stmt(sql).get(params) as T | undefined;
  }

  all<T = Row>(sql: string, params: Params = {}): T[] {
    return this.stmt(sql).all(params) as T[];
  }

  /** 함수 안의 쓰기를 하나의 트랜잭션으로 묶습니다. 중첩 호출은 바깥 트랜잭션에 합류합니다. */
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): void {
    this.cache.clear();
    this.db.close();
  }
}
