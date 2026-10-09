import { EventEmitter } from 'node:events';

/**
 * 이메일 모듈 시험용 가짜 IMAP 서버 · 클라이언트. imapflow 의 ImapFlow 자리에 끼워 넣습니다.
 * 실제 서버처럼 UID FETCH n:* 가 n 이 가장 큰 UID 보다 클 때 마지막 메일을 돌려주는 규칙까지 흉내 냅니다.
 */

export interface FakeMessage {
  uid: number;
  flags: Set<string>;
  internalDate: Date;
  envelope: { subject: string; from: { name?: string; address?: string }[]; date: Date };
  bodyStructure: unknown;
  source: Buffer;
}

export const server = {
  uidValidity: 100n,
  messages: [] as FakeMessage[],
  nextUid: 1,
  failAuth: false,
  boxes: new Set(['INBOX']),
  reset(): void {
    this.uidValidity = 100n;
    this.messages = [];
    this.nextUid = 1;
    this.failAuth = false;
    this.boxes = new Set(['INBOX']);
    FakeImapFlow.instances = [];
  },
  /** 메일을 서버에 넣습니다 (아직 클라이언트에 알리지 않음). */
  add(subject: string, opts: { from?: string; text?: string; attachment?: string; seen?: boolean } = {}): number {
    const uid = this.nextUid;
    this.nextUid += 1;
    const from = opts.from ?? 'Boss <boss@example.com>';
    const text = opts.text ?? `${subject} 본문입니다.`;
    const head = `From: ${from}\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: Fri, 09 Oct 2026 14:03:00 +0900\r\nMessage-ID: <${uid}@example.com>\r\nMIME-Version: 1.0\r\n`;
    const source = opts.attachment
      ? Buffer.from(
          `${head}Content-Type: multipart/mixed; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n--b1\r\nContent-Type: application/pdf; name="${opts.attachment}"\r\nContent-Disposition: attachment; filename="${opts.attachment}"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQK\r\n--b1--\r\n`,
        )
      : Buffer.from(`${head}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${text}\r\n`);
    const bodyStructure = opts.attachment
      ? { type: 'multipart/mixed', childNodes: [{ type: 'text/plain' }, { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: opts.attachment } }] }
      : { type: 'text/plain' };
    const name = /^(.*?)\s*</.exec(from)?.[1];
    const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
    this.messages.push({
      uid,
      flags: new Set(opts.seen ? ['\\Seen'] : []),
      internalDate: new Date(2026, 9, 9, 14, 3),
      envelope: { subject, from: [{ name, address }], date: new Date(2026, 9, 9, 14, 3) },
      bodyStructure,
      source,
    });
    return uid;
  },
};

export class FakeImapFlow extends EventEmitter {
  static instances: FakeImapFlow[] = [];
  readonly opts: Record<string, unknown>;
  usable = false;
  mailbox: { path: string; uidValidity: bigint; uidNext: number; exists: number } | false = false;
  openedReadOnly: boolean | undefined;
  readonly fetches: { range: string; query: Record<string, unknown>; uid: boolean }[] = [];
  closed = false;

  constructor(opts: Record<string, unknown>) {
    super();
    this.opts = opts;
    FakeImapFlow.instances.push(this);
  }

  async connect(): Promise<void> {
    if (server.failAuth) throw Object.assign(new Error('Authentication failed.'), { authenticationFailed: true, responseText: '[AUTHENTICATIONFAILED] Invalid credentials (Failure)' });
    this.usable = true;
  }

  async mailboxOpen(path: string, opts?: { readOnly?: boolean }) {
    if (!server.boxes.has(path)) throw Object.assign(new Error('Command failed'), { serverResponseCode: 'NONEXISTENT', responseText: 'Unknown Mailbox' });
    this.mailbox = { path, uidValidity: server.uidValidity, uidNext: server.nextUid, exists: server.messages.length };
    this.openedReadOnly = opts?.readOnly;
    this.emit('mailboxOpen', this.mailbox);
    return this.mailbox;
  }

  async getMailboxLock(path: string) {
    if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    return { path, release(): void {} };
  }

  private pick(range: string, uid: boolean): FakeMessage[] {
    const all = server.messages;
    if (uid && range.endsWith(':*')) {
      const from = Number(range.slice(0, -2));
      const hit = all.filter((m) => m.uid >= from);
      // IMAP 규칙: n:* 는 *:n 과 같아서, 새 메일이 없어도 마지막 메일 하나가 돌아옵니다.
      return hit.length > 0 ? hit : all.slice(-1);
    }
    if (uid) {
      const want = new Set(range.split(',').map(Number));
      return all.filter((m) => want.has(m.uid));
    }
    const from = Number(range.split(':')[0]);
    return all.slice(from - 1);
  }

  private view(m: FakeMessage, query: Record<string, unknown>) {
    const out: Record<string, unknown> = { uid: m.uid, seq: server.messages.indexOf(m) + 1 };
    if (query['flags']) out['flags'] = new Set(m.flags);
    if (query['envelope']) out['envelope'] = m.envelope;
    if (query['internalDate']) out['internalDate'] = m.internalDate;
    if (query['bodyStructure']) out['bodyStructure'] = m.bodyStructure;
    if (query['source']) {
      const s = query['source'];
      const max = typeof s === 'object' && s !== null && typeof (s as { maxLength?: number }).maxLength === 'number' ? (s as { maxLength: number }).maxLength : Infinity;
      out['source'] = m.source.subarray(0, max);
    }
    return out;
  }

  async fetchAll(range: string, query: Record<string, unknown>, opts?: { uid?: boolean }) {
    if (!this.usable) throw Object.assign(new Error('Connection not available'), { code: 'NoConnection' });
    this.fetches.push({ range, query, uid: opts?.uid === true });
    return this.pick(range, opts?.uid === true).map((m) => this.view(m, query));
  }

  async fetchOne(seq: string, query: Record<string, unknown>, opts?: { uid?: boolean }) {
    this.fetches.push({ range: seq, query, uid: opts?.uid === true });
    if (seq === '*') {
      const last = server.messages[server.messages.length - 1];
      return last ? this.view(last, query) : false;
    }
    const found = this.pick(seq, opts?.uid === true)[0];
    return found ? this.view(found, query) : false;
  }

  async search(q: Record<string, unknown>) {
    return server.messages
      .filter((m) => (typeof q['subject'] !== 'string' || m.envelope.subject.includes(q['subject'])) && (q['seen'] === undefined || m.flags.has('\\Seen') === q['seen']))
      .map((m) => m.uid);
  }

  async logout(): Promise<void> {
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.usable = false;
    this.emit('close');
  }

  /** 서버에 메일이 도착했다고 이 연결에 알립니다 (IDLE 중 EXISTS). */
  notifyExists(): void {
    if (!this.mailbox) return;
    const prev = this.mailbox.exists;
    this.mailbox.exists = server.messages.length;
    this.emit('exists', { path: this.mailbox.path, count: this.mailbox.exists, prevCount: prev });
  }
}
