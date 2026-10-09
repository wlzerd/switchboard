/**
 * 순서대로 적용되는 마이그레이션. 이미 배포된 항목은 고치지 말고 새 항목을 뒤에 추가합니다.
 * 적용된 버전은 PRAGMA user_version 에 기록됩니다.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('env', 'stored')),
    cipher TEXT,
    last4 TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    effort TEXT,
    key_id TEXT NOT NULL REFERENCES api_keys(id),
    preset TEXT NOT NULL,
    permissions TEXT NOT NULL,
    limits TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE modules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('module', 'skill')),
    origin TEXT NOT NULL,
    dir TEXT NOT NULL,
    manifest TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    status_detail TEXT,
    created_by TEXT,
    report TEXT,
    installed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE agent_modules (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    module_id TEXT NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
    config TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (agent_id, module_id)
  );

  CREATE TABLE hooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    event TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    action TEXT NOT NULL,
    conditions TEXT NOT NULL,
    reason TEXT NOT NULL,
    modify TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    frozen_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (agent_id, source)
  );

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_thread ON messages(thread_id, id);

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    steps TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX idx_tasks_agent ON tasks(agent_id, created_at);

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    task_id TEXT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL,
    status TEXT NOT NULL,
    decision TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    category TEXT NOT NULL,
    tone TEXT NOT NULL,
    who TEXT NOT NULL,
    text TEXT NOT NULL,
    agent_id TEXT,
    module_id TEXT,
    data TEXT
  );
  CREATE INDEX idx_activity_ts ON activity(ts);

  CREATE TABLE usage_daily (
    agent_id TEXT NOT NULL,
    day TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, day)
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );

  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    spec TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run INTEGER,
    last_run INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  // v2: 사람이 보는 대화 타임라인 (모델에 보내는 messages 와 분리)
  `
  CREATE TABLE timeline (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    task_id TEXT,
    kind TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_timeline_thread ON timeline(thread_id, id);
  `,
  // v3: 같은 키를 두 번 저장하지 않도록 지문(HMAC)을 둡니다.
  `
  ALTER TABLE api_keys ADD COLUMN fingerprint TEXT;
  CREATE UNIQUE INDEX idx_api_keys_fingerprint ON api_keys(fingerprint) WHERE fingerprint IS NOT NULL;
  `,
  // v4: 예약 실행 결과를 보낼 채널 대상
  `
  ALTER TABLE schedules ADD COLUMN reply TEXT;
  `,
  // v5: 위임 설정 · 하트비트 · 보고 받을 곳, 조용한 작업(보고할 게 없으면 남기지 않음)과 위임 추적
  `
  ALTER TABLE agents ADD COLUMN delegation TEXT NOT NULL DEFAULT '{"accept":false,"send":false,"supervisorId":null}';
  ALTER TABLE agents ADD COLUMN heartbeat TEXT;
  ALTER TABLE agents ADD COLUMN heartbeat_last_at INTEGER;
  ALTER TABLE agents ADD COLUMN report TEXT;
  ALTER TABLE tasks ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN delegated_by TEXT;
  CREATE INDEX idx_tasks_delegated ON tasks(delegated_by) WHERE delegated_by IS NOT NULL;
  `,
  // v6: 허용 폴더 (작업 폴더 밖에서 사용자가 허락한 폴더와 읽기 · 쓰기 범위)
  `
  ALTER TABLE agents ADD COLUMN folders TEXT NOT NULL DEFAULT '[]';
  `,
];
