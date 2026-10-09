/**
 * 사용자가 쓴 정규식(훅 조건 · 수정 패턴)을 시간 제한을 두고 실행합니다.
 *
 * 정규식은 입력에 따라 되추적이 폭발해(예: /^(\w+\s?)*$/ 에 'aaaa…!') 서버 전체(이벤트 루프)를 멈출 수 있습니다.
 * 그래서 별도 스레드(워커)에서 돌리고, 메인 스레드는 결과를 동기적으로 기다리다 시간이 지나면 그 스레드를 끝냅니다.
 * 훅 평가는 동기 함수라 Atomics.wait + receiveMessageOnPort 로 기다립니다.
 */
import v8 from 'node:v8';
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

// 되추적이 지나치게 많으면 V8 이 입력 길이에 비례하는 엔진으로 바꿔 돌립니다 (그 엔진이 다룰 수 있는 정규식만).
// 'l' 플래그는 그 엔진으로만 도는지 미리 확인하는 데 씁니다. 플래그는 프로세스 전체(워커 포함)에 적용됩니다.
v8.setFlagsFromString('--enable-experimental-regexp-engine');
v8.setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks');

function linearCheckAvailable(): boolean {
  try {
    new RegExp('a', 'l');
    return true;
  } catch {
    return false;
  }
}
const LINEAR_AVAILABLE = linearCheckAvailable();

/** 'l' 과 함께 쓸 수 있는 플래그. i · u · v · d 는 정규식의 구조(되추적 위험)와 상관없어 빼고 봅니다. */
const LINEAR_FLAGS = new Set(['g', 'm', 's', 'y']);

/**
 * 입력 길이에 비례해 끝나는 방식으로 검사할 수 없는 정규식이면 그 이유, 아니면 null.
 * 역참조 · 앞 보기는 그 방식으로 돌 수 없어, 긴 입력에서 검사가 끝나지 않을 수 있습니다.
 */
export function linearProblem(source: string, flags: string): string | null {
  if (!LINEAR_AVAILABLE) return null;
  const keep = [...new Set(flags.split(''))].filter((f) => LINEAR_FLAGS.has(f)).join('');
  try {
    new RegExp(source, `${keep}l`);
    return null;
  } catch {
    if (/\\[1-9]|\\k</.test(source)) return '역참조(\\1 · \\k<이름>)가 있는 정규식은 쓸 수 없습니다. 입력이 길면 검사가 끝나지 않을 수 있습니다.';
    if (/\(\?[=!]/.test(source)) return '앞 보기((?=…) · (?!…))가 있는 정규식은 쓸 수 없습니다. 입력이 길면 검사가 끝나지 않을 수 있습니다.';
    return '이 정규식은 입력 길이에 비례해 끝나는 방식으로 검사할 수 없습니다. 역참조 · 앞 보기 없이 다시 쓰세요.';
  }
}

export type RegexResult<T> = { ok: true; value: T } | { ok: false; timedOut: boolean; error: string };

type Job = { op: 'test'; source: string; flags: string; text: string } | { op: 'replace'; source: string; flags: string; text: string; replacement: string };
type Reply = { id: number; ok: true; value: boolean | string } | { id: number; ok: false; error: string };

/** 워커 코드 (CommonJS · 별도 파일 없이 eval 로 띄움). signal[0]: 답이 왔음, signal[1]: 준비됨 */
const WORKER_CODE = `
const { workerData } = require('node:worker_threads');
const v8 = require('node:v8');
v8.setFlagsFromString('--enable-experimental-regexp-engine-on-excessive-backtracks');
const signal = new Int32Array(workerData.signal);
const port = workerData.port;
port.on('message', (job) => {
  let out;
  try {
    const re = new RegExp(job.source, job.flags);
    out = job.op === 'test' ? { id: job.id, ok: true, value: re.test(job.text) } : { id: job.id, ok: true, value: job.text.replace(re, job.replacement) };
  } catch (err) {
    out = { id: job.id, ok: false, error: String((err && err.message) || err) };
  }
  port.postMessage(out);
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
});
Atomics.store(signal, 1, 1);
Atomics.notify(signal, 1);
`;

export class RegexRunner {
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private signal: Int32Array | null = null;
  private seq = 0;
  readonly timeoutMs: number;
  private readonly startMs: number;

  /** timeoutMs: 정규식 하나의 제한 시간 · startMs: 워커가 처음 뜨는 동안 기다릴 시간 */
  constructor(timeoutMs = 200, startMs = 5000) {
    this.timeoutMs = timeoutMs;
    this.startMs = startMs;
  }

  test(source: string, flags: string, text: string): RegexResult<boolean> {
    return this.run<boolean>({ op: 'test', source, flags, text });
  }

  replace(source: string, flags: string, text: string, replacement: string): RegexResult<string> {
    return this.run<string>({ op: 'replace', source, flags, text, replacement });
  }

  /** 워커를 내립니다 (서버 종료 · 시험). 다음 호출 때 다시 띄웁니다. */
  close(): void {
    const w = this.worker;
    this.port?.close();
    this.worker = null;
    this.port = null;
    this.signal = null;
    if (w) void w.terminate();
  }

  private ensure(): { port: MessagePort; signal: Int32Array } {
    if (this.worker && this.port && this.signal) return { port: this.port, signal: this.signal };
    const sab = new SharedArrayBuffer(8);
    const signal = new Int32Array(sab);
    const { port1, port2 } = new MessageChannel();
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { signal: sab, port: port2 }, transferList: [port2] });
    // 서버가 끝날 때 이 워커 때문에 프로세스가 남지 않게 합니다.
    worker.unref();
    port1.unref();
    worker.on('error', () => {
      if (this.worker === worker) this.close();
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.close();
    });
    this.worker = worker;
    this.port = port1;
    this.signal = signal;
    return { port: port1, signal };
  }

  private run<T extends boolean | string>(job: Job): RegexResult<T> {
    const { port, signal } = this.ensure();
    const id = ++this.seq;
    Atomics.store(signal, 0, 0);
    port.postMessage({ ...job, id });
    // 스레드가 막 떴다면 준비될 때까지만 따로 기다립니다. 정규식에 주는 시간은 그 뒤부터 셉니다
    // (시작 여유 시간을 정규식 실행에 쓰게 두면, 시간 초과 직후 다음 검사에서 서버가 그만큼 멈춥니다).
    const startDeadline = Date.now() + this.startMs;
    while (Atomics.load(signal, 1) !== 1) {
      const left = startDeadline - Date.now();
      if (left <= 0) {
        this.close();
        return { ok: false, timedOut: true, error: `정규식 검사 스레드가 ${this.startMs}ms 안에 뜨지 않았습니다` };
      }
      Atomics.wait(signal, 1, 0, left);
    }
    const limit = this.timeoutMs;
    const deadline = Date.now() + limit;
    // 반복은 길어야 몇 번입니다: 답이 오면 끝나고, 시간이 지나면 워커를 내리고 끝납니다.
    for (;;) {
      const left = deadline - Date.now();
      if (left > 0) Atomics.wait(signal, 0, 0, left);
      const got = receiveMessageOnPort(port);
      if (got) {
        Atomics.store(signal, 0, 0);
        const reply = got.message as Reply;
        // 앞서 시간이 지나 버린 요청의 늦은 답은 건너뜁니다.
        if (reply.id !== id) continue;
        return reply.ok ? { ok: true, value: reply.value as T } : { ok: false, timedOut: false, error: `정규식을 실행하지 못했습니다: ${reply.error}` };
      }
      if (Date.now() >= deadline) {
        this.close();
        // 다음 검사가 스레드 시작을 기다리지 않도록 바로 새로 띄워 둡니다.
        this.ensure();
        return { ok: false, timedOut: true, error: `정규식 검사가 ${limit}ms 안에 끝나지 않았습니다 (입력에 따라 되추적이 많은 정규식)` };
      }
    }
  }
}

/** 서버 전체가 함께 쓰는 실행기 */
export const regexRunner = new RegexRunner();
