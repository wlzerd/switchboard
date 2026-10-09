// 이메일 채널 모듈 (받기 전용). imapflow(MIT)로 IMAP 편지함을 지켜보고 mailparser(MIT)로 본문을 읽습니다.
// 새 메일이 오면 '조용한 판단' 메시지(quiet: true)로 연결된 에이전트에게 넘깁니다.
// 에이전트는 알릴 만한 메일일 때만 보고하고, 아니면 아무 흔적도 남기지 않습니다.
// 편지함은 읽기 전용으로 열고 본문은 BODY.PEEK 로 가져오므로 메일이 읽음으로 바뀌지 않습니다.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  baselineUid,
  bodyText,
  buildNotice,
  buildSearch,
  describeError,
  formatMail,
  formatSearchResult,
  mailboxLabel,
  parseConfig,
  parseState,
  parseUid,
  planCheck,
  reconnectDelay,
  selectNew,
  splitForNotice,
  summarize,
} from './lib.js';

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** 메일이 한꺼번에 여러 통 올 때 한 번에 묶어 알리려고 잠깐 기다립니다 */
const EXISTS_DEBOUNCE_MS = 2_000;
/** 미리보기용으로 메일 앞부분만 받아 옵니다 */
const NOTICE_SOURCE_BYTES = 64 * 1024;
const READ_SOURCE_BYTES = 2 * 1024 * 1024;
const LOCK_TIMEOUT_MS = 20_000;
const PARSE_OPTIONS = { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 1_000_000 };
const FETCH_SUMMARY = { uid: true, envelope: true, internalDate: true, flags: true, bodyStructure: true };

/** 이 모듈이 직접 만든 오류 (문구를 그대로 돌려줌). 그 밖의 오류는 describeError 로 원인별 문구로 바꿉니다. */
class MailError extends Error {}

let ctx = null;
let cfg = null;
let client = null;
let state = null;
/** 방금 연(또는 다시 연) 편지함 정보. 다음 확인 때 기준점부터 맞춥니다. */
let opened = null;
let stopped = true;
let pollTimer = null;
let debounceTimer = null;
let reconnectTimer = null;
let attempt = 0;
let checking = false;
let again = false;

function statePath() {
  return path.join(ctx.dataDir, 'state.json');
}

async function loadState() {
  try {
    const parsed = parseState(await fs.readFile(statePath(), 'utf8'));
    if (!parsed) ctx.log.warn('저장된 감시 상태(state.json)의 형식이 맞지 않아 지금 시점부터 다시 지켜봅니다.');
    return parsed;
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    ctx.log.warn(`감시 상태(state.json)를 읽지 못해 지금 시점부터 다시 지켜봅니다: ${err?.message ?? err}`);
    return null;
  }
}

async function saveState(next) {
  // 쓰는 도중 꺼져도 파일이 깨지지 않게 임시 파일에 쓴 뒤 바꿔 끼웁니다.
  const file = statePath();
  await fs.writeFile(`${file}.tmp`, JSON.stringify(next));
  await fs.rename(`${file}.tmp`, file);
  state = next;
}

async function connect() {
  const c = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tls,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    // NAT·방화벽이 조용한 연결을 끊지 않도록 IDLE 을 주기적으로 다시 겁니다.
    maxIdleTime: 4 * 60_000,
  });
  c.on('error', (err) => ctx.log.warn(describeError(err, cfg)));
  c.on('exists', (d) => {
    if (client === c && d.count > d.prevCount) scheduleCheck();
  });
  c.on('mailboxOpen', (box) => {
    if (client === c) opened = box;
  });
  c.on('close', () => {
    if (client !== c) return;
    client = null;
    if (!stopped) scheduleReconnect();
  });
  try {
    await c.connect();
    const box = await c.mailboxOpen(cfg.mailbox, { readOnly: true });
    client = c;
    opened = box;
  } catch (err) {
    c.close();
    throw err;
  }
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  attempt += 1;
  const delay = reconnectDelay(attempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
  ctx.log.warn(`메일 서버와의 연결이 끊어졌습니다. ${Math.round(delay / 1000)}초 뒤 다시 연결합니다 (${attempt}번째).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().then(
      () => {
        if (stopped) {
          // 다시 연결하는 사이에 모듈이 꺼졌으면 방금 연 연결을 닫습니다.
          const c = client;
          client = null;
          c?.close();
          return;
        }
        attempt = 0;
        ctx.log.info('메일 서버에 다시 연결했습니다.');
        void check();
      },
      (err) => {
        if (err?.authenticationFailed) {
          // 비밀번호가 바뀐 경우: 계속 시도하면 계정이 잠길 수 있으니 프로세스를 끝내 모듈 화면에 원인을 띄웁니다.
          ctx.log.error(describeError(err, cfg));
          process.exit(1);
        }
        ctx.log.warn(describeError(err, cfg));
        scheduleReconnect();
      },
    );
  }, delay);
}

function scheduleCheck() {
  if (stopped || debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void check();
  }, EXISTS_DEBOUNCE_MS);
}

/** 확인이 겹치면 하나만 돌고, 도는 중에 들어온 요청은 끝난 뒤 한 번 더 돕니다 (재귀 없이 반복). */
async function check() {
  if (checking) {
    again = true;
    return;
  }
  checking = true;
  try {
    do {
      again = false;
      await checkOnce();
    } while (again && !stopped);
  } catch (err) {
    ctx.log.warn(`새 메일을 확인하지 못했습니다: ${describeError(err, cfg)}`);
  } finally {
    checking = false;
  }
}

async function checkOnce() {
  const c = client;
  if (!c || !c.usable) return;
  const lock = await c.getMailboxLock(cfg.mailbox, { readOnly: true, acquireTimeout: LOCK_TIMEOUT_MS });
  try {
    if (opened) {
      const box = opened;
      opened = null;
      const validity = String(box.uidValidity);
      const plan = planCheck(state, { mailbox: cfg.mailbox, uidValidity: validity });
      if (plan.kind === 'baseline') {
        let base = baselineUid(box.uidNext);
        if (base === null) base = box.exists > 0 ? ((await c.fetchOne('*', { uid: true }))?.uid ?? 0) : 0;
        await saveState({ mailbox: cfg.mailbox, uidValidity: validity, lastUid: base });
        if (plan.reason === 'validity') ctx.log.warn(`서버가 '${cfg.mailbox}'의 UID 를 새로 매겼습니다(UIDVALIDITY 변경). 지금 있는 메일은 건너뛰고 이후 메일부터 알립니다.`);
        else ctx.log.info(`'${cfg.mailbox}'에 지금 있는 메일은 건너뛰고, 이후 새로 오는 메일부터 알립니다.`);
      }
    }
    if (!state || !c.mailbox || c.mailbox.exists === 0) return;

    const lastUid = state.lastUid;
    const fresh = selectNew(await c.fetchAll(`${lastUid + 1}:*`, FETCH_SUMMARY, { uid: true }), lastUid);
    if (fresh.length === 0) return;

    const { older, detailed } = splitForNotice(fresh);
    const sources = new Map();
    try {
      const parts = await c.fetchAll(detailed.map((m) => m.uid).join(','), { uid: true, source: { maxLength: NOTICE_SOURCE_BYTES } }, { uid: true });
      for (const p of parts) if (p.source) sources.set(p.uid, p.source);
    } catch (err) {
      ctx.log.warn(`미리보기를 가져오지 못해 제목만 알립니다: ${describeError(err, cfg)}`);
    }
    const items = [];
    for (const m of detailed) {
      let snippet = '';
      const source = sources.get(m.uid);
      if (source) {
        try {
          snippet = bodyText(await simpleParser(source, PARSE_OPTIONS));
        } catch (err) {
          ctx.log.warn(`uid ${m.uid} 메일 본문을 읽지 못해 미리보기 없이 알립니다: ${err?.message ?? err}`);
        }
      }
      items.push(summarize(m, snippet));
    }

    // 기준점을 먼저 옮겨 저장한 뒤 알립니다 (다시 시작해도 같은 메일을 두 번 알리지 않게).
    await saveState({ ...state, lastUid: fresh[fresh.length - 1].uid });
    ctx.emit({
      target: cfg.mailbox,
      targetLabel: mailboxLabel(cfg.mailbox),
      userId: 'email',
      userName: '이메일',
      text: buildNotice(items, older, cfg.mailbox),
      direct: true,
      quiet: true,
    });
  } finally {
    lock.release();
  }
}

/** 도구가 쓰는 편지함 잠금. 연결이 없으면 이유를 알려 줍니다. */
async function withMailbox(fn) {
  const c = client;
  if (!c || !c.usable) {
    throw new MailError(stopped ? '이메일 모듈이 멈춰 있습니다. 모듈 화면에서 켜세요.' : '메일 서버에 연결되어 있지 않습니다 (다시 연결하는 중입니다). 잠시 뒤 다시 시도하세요.');
  }
  let lock;
  try {
    lock = await c.getMailboxLock(cfg.mailbox, { readOnly: true, acquireTimeout: LOCK_TIMEOUT_MS });
  } catch (err) {
    throw new Error(describeError(err, cfg));
  }
  try {
    return await fn(c);
  } catch (err) {
    if (err instanceof MailError) throw err;
    throw new Error(describeError(err, cfg));
  } finally {
    lock.release();
  }
}

export default {
  async activate(context) {
    ctx = context;
    cfg = parseConfig(ctx.env);
    state = await loadState();
    opened = null;
    attempt = 0;
    stopped = false;
    try {
      await connect();
    } catch (err) {
      stopped = true;
      throw new Error(describeError(err, cfg));
    }
    ctx.log.info(`${cfg.host} 에 ${cfg.user} 로 연결해 '${cfg.mailbox}'을(를) 지켜봅니다.`);
    // 첫 확인은 activate 가 끝난 뒤에 합니다 (오래 걸려도 모듈 시작 제한 시간에 걸리지 않게).
    setTimeout(() => void check(), 0);
    // IDLE 을 못 쓰는 서버나 놓친 알림을 위한 안전망
    pollTimer = setInterval(() => scheduleCheck(), cfg.checkMinutes * 60_000);
  },

  async deactivate() {
    stopped = true;
    for (const t of [pollTimer, debounceTimer, reconnectTimer]) if (t) clearTimeout(t);
    pollTimer = null;
    debounceTimer = null;
    reconnectTimer = null;
    const c = client;
    client = null;
    if (!c) return;
    try {
      await c.logout();
    } catch {
      c.close();
    }
  },

  tools: {
    async email_search(input) {
      const { query, limit, recent } = buildSearch(input);
      return withMailbox(async (c) => {
        if (recent) {
          const total = c.mailbox ? c.mailbox.exists : 0;
          if (total === 0) return formatSearchResult([], { total, recent, mailbox: cfg.mailbox });
          const from = Math.max(1, total - limit + 1);
          const messages = await c.fetchAll(`${from}:*`, FETCH_SUMMARY);
          return formatSearchResult(messages, { total, recent, mailbox: cfg.mailbox });
        }
        const uids = (await c.search(query, { uid: true })) || [];
        if (uids.length === 0) return formatSearchResult([], { total: 0, recent, mailbox: cfg.mailbox });
        const pick = [...uids].sort((a, b) => a - b).slice(-limit);
        const messages = await c.fetchAll(pick.join(','), FETCH_SUMMARY, { uid: true });
        return formatSearchResult(messages, { total: uids.length, recent, mailbox: cfg.mailbox });
      });
    },

    async email_read(input) {
      const uid = parseUid(input?.uid);
      return withMailbox(async (c) => {
        const m = await c.fetchOne(String(uid), { uid: true, flags: true, source: { maxLength: READ_SOURCE_BYTES } }, { uid: true });
        if (!m || !m.source) {
          throw new MailError(`uid ${uid} 메일이 '${mailboxLabel(cfg.mailbox)}'에 없습니다. 지워졌거나 다른 편지함으로 옮겨졌습니다. email_search 로 다시 찾으세요.`);
        }
        let parsed;
        try {
          parsed = await simpleParser(m.source, PARSE_OPTIONS);
        } catch (err) {
          throw new MailError(`uid ${uid} 메일의 형식을 읽지 못했습니다 (MIME 해석 실패): ${err?.message ?? err}`);
        }
        return formatMail({
          uid,
          mailbox: cfg.mailbox,
          seen: m.flags instanceof Set && m.flags.has('\\Seen'),
          truncated: m.source.length >= READ_SOURCE_BYTES,
          nonce: randomUUID().slice(0, 8),
          parsed,
        });
      });
    },
  },
};
