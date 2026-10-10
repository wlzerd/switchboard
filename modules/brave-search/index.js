// Brave 검색 모듈 (도구만). Brave Search API 의 LLM Context 를 ctx.fetch 로만 부릅니다 (허용 도메인: api.search.brave.com).
// 검색 한 번에 관련 페이지의 본문 발췌까지 받아 오므로 페이지를 따로 열어 읽지 않아도 됩니다.
// API 키는 요청 머리글에만 넣고 로그 · 오류 문구에 남기지 않습니다. Brave 약관에 따라 결과를 따로 저장 · 캐시하지 않습니다.
import { buildRequest, describeError, formatContext, parseConfig } from './lib.js';

/** Brave 권장 제한 시간 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 초당 한도에 걸렸을 때 이만큼 안에 풀리면 기다렸다 다시 보냅니다 (처음 포함 MAX_ATTEMPTS 번까지) */
const RETRY_WAIT_MAX_MS = 3_000;
const MAX_ATTEMPTS = 2;

let ctx = null;
let cfg = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(req) {
  let res;
  try {
    res = await ctx.fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error(`Brave 검색이 ${REQUEST_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다. 잠시 뒤 다시 시도하세요.`);
    throw new Error(`Brave Search 에 연결하지 못했습니다: ${err?.message ?? err}. 서버의 인터넷 연결을 확인하세요.`);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new Error(`Brave 응답을 해석하지 못했습니다 (HTTP ${res.status}).`);
    }
  }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

const tools = {
  async brave_search(input) {
    if (!cfg) throw new Error('Brave 검색 모듈이 아직 시작되지 않았습니다.');
    const req = buildRequest(input, cfg);
    // 초당 한도에 걸리면 정해진 횟수까지만 다시 보냅니다 (끝없이 되풀이하지 않게 횟수를 셉니다).
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const res = await call(req);
      if (res.ok) {
        ctx.status('');
        return formatContext(res.data, req);
      }
      const err = describeError(res.status, res.data, res.headers);
      if (err.kind === 'rate' && attempt < MAX_ATTEMPTS && err.retryInMs <= RETRY_WAIT_MAX_MS) {
        await sleep(err.retryInMs);
        continue;
      }
      // 키 · 플랜 · 한도 문제는 모듈 화면에도 띄워 사용자가 알 수 있게 합니다.
      if (err.kind === 'auth' || err.kind === 'plan' || err.kind === 'quota') ctx.status(err.message);
      throw new Error(err.message);
    }
    throw new Error('Brave 의 초당 요청 한도에 연달아 걸렸습니다. 잠시 뒤 다시 시도하세요.');
  },
};

export default {
  async activate(context) {
    ctx = context;
    cfg = parseConfig(ctx.env);
    // 검색 한 번마다 요금이 들어서 시작할 때 키 확인용 검색은 하지 않습니다 (첫 검색에서 키가 틀리면 이유를 알림).
    ctx.log.info(`Brave 검색을 쓸 수 있습니다 (국가 ${cfg.country} · 언어 ${cfg.lang} · 본문 ${cfg.maxTokens.toLocaleString()} 토큰까지).`);
  },

  async deactivate() {
    cfg = null;
  },

  tools,
};
