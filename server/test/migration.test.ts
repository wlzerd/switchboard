import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/schema.ts';
import { Db } from '../src/db/sqlite.ts';
import { Store } from '../src/db/store.ts';

// 이미 쓰던 데이터베이스(v4)를 새 코드로 열었을 때 v5(위임 · 하트비트 · 조용한 작업)로 올라가고 기존 행이 그대로 읽혀야 합니다.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-migrate-'));

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function makeV4(file: string): void {
  const raw = new DatabaseSync(file);
  for (let v = 0; v < 4; v += 1) raw.exec(MIGRATIONS[v] as string);
  raw.exec('PRAGMA user_version = 4');
  const now = 1_760_000_000_000;
  raw.exec(`
    INSERT INTO api_keys (id, label, source, cipher, last4, created_at) VALUES ('key_1', '기존 키', 'stored', 'c', 'abcd', ${now});
    INSERT INTO agents (id, name, color, role, model, effort, key_id, preset, permissions, limits, paused, created_at, updated_at)
      VALUES ('agt_old', '기존이', '#C6F35B', '', 'claude-opus-5-5', NULL, 'key_1', 'helper', '{}', '{"tokensPerDay":1000,"stepsPerTask":10,"concurrency":1,"messagesPerMinute":5}', 0, ${now}, ${now});
    INSERT INTO threads (id, agent_id, source, title, frozen_hash, created_at, updated_at) VALUES ('thr_1', 'agt_old', 'console', '웹 콘솔', NULL, ${now}, ${now});
    INSERT INTO tasks (id, agent_id, thread_id, title, origin, status, steps, error, created_at, started_at, finished_at)
      VALUES ('tsk_1', 'agt_old', 'thr_1', '예전 작업', 'console', 'done', '[]', NULL, ${now}, ${now}, ${now});
  `);
  raw.close();
}

describe('v4 → v5 마이그레이션', () => {
  const file = path.join(dir, 'old.db');
  makeV4(file);
  const db = new Db(file);
  const store = new Store(db);

  it('버전이 마지막 마이그레이션까지 올라갑니다', () => {
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
  });

  it('기존 에이전트는 위임 미허용 · 하트비트 없음 · 보고 채널 없음으로 읽힙니다', () => {
    const a = store.getAgent('agt_old');
    expect(a.delegation).toEqual({ accept: false, send: false, supervisorId: null });
    expect(a.heartbeat).toBeNull();
    expect(a.heartbeatLastAt).toBeNull();
    expect(a.report).toBeNull();
  });

  it('기존 작업은 보이는 작업(quiet=0)이고 위임받은 작업이 아닙니다', () => {
    const t = store.latestTask('agt_old');
    expect(t).toMatchObject({ id: 'tsk_1', quiet: false, delegatedBy: null });
    expect(store.activeDelegations()).toEqual([]);
  });

  it('다시 열어도 마이그레이션을 두 번 하지 않습니다', () => {
    db.close();
    const again = new Db(file);
    expect(again.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(MIGRATIONS.length);
    expect(new Store(again).getAgent('agt_old').name).toBe('기존이');
    again.close();
  });
});
