// Tavily 검색 모듈 (도구만). Tavily Search API 를 ctx.fetch 로만 부릅니다 (허용 도메인: api.tavily.com).
// 검색 한 번에 관련 페이지의 제목 · 주소 · 본문 발췌와 짧은 요약 답변을 받아 옵니다.
// API 키는 요청 머리글에만 넣고 로그 · 오류 문구에 남기지 않습니다. 검색 결과는 따로 저장 · 캐시하지 않습니다.
import { buildRequest, describeError, formatResults, parseConfig } from './lib.js';

/** 검색 한 번의 제한 시간 (advanced 검색은 몇 초 걸릴 수 있음) */
const REQUEST_TIMEOUT_MS = 30_000;
/** 요청 빈도 한도에 걸렸을 때 이만큼 안에 풀리면 기다렸다 다시 보냅니다 (처음 포함 MAX_ATTEMPTS 번까지) */
const RETRY_WAIT_MAX_MS = 3_000;
const MAX_ATTEMPTS = 2;

let ctx = null;
let cfg = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(req) {
  let res;
  try {
    res = await ctx.fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error(`Tavily 검색이 ${REQUEST_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다. 잠시 뒤 다시 시도하세요.`);
    throw new Error(`Tavily 에 연결하지 못했습니다: ${err?.message ?? err}. 서버의 인터넷 연결을 확인하세요.`);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (res.ok) throw new Error(`Tavily 응답을 해석하지 못했습니다 (HTTP ${res.status}).`);
    }
  }
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

const tools = {
  async tavily_search(input) {
    if (!cfg) throw new Error('Tavily 검색 모듈이 아직 시작되지 않았습니다.');
    const req = buildRequest(input, cfg);
    const key = cfg.key;
    // 요청 빈도 한도에 걸리면 정해진 횟수까지만 다시 보냅니다 (끝없이 되풀이하지 않게 횟수를 셉니다).
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const res = await call(req);
      if (res.ok) {
        ctx.status('');
        return formatResults(res.data, req);
      }
      const err = describeError(res.status, res.data, res.headers);
      if (err.kind === 'rate' && attempt < MAX_ATTEMPTS && err.retryInMs !== null && err.retryInMs <= RETRY_WAIT_MAX_MS) {
        await sleep(err.retryInMs);
        continue;
      }
      // 문구에 Tavily 가 돌려준 글이 붙으므로, 혹시 키가 섞여 있으면 가립니다.
      const message = err.message.replaceAll(key, '(API 키)');
      // 키 · 한도 문제는 모듈 화면에도 띄워 사용자가 알 수 있게 합니다.
      if (err.kind === 'auth' || err.kind === 'quota') ctx.status(message);
      throw new Error(message);
    }
    throw new Error('Tavily 요청 한도에 연달아 걸렸습니다. 잠시 뒤 다시 시도하세요.');
  },
};

export default {
  async activate(context) {
    ctx = context;
    cfg = parseConfig(ctx.env);
    // 검색 한 번마다 크레딧이 들어서 시작할 때 키 확인용 검색은 하지 않습니다 (첫 검색에서 키가 틀리면 이유를 알림).
    ctx.log.info(`Tavily 검색을 쓸 수 있습니다 (깊이 ${cfg.depth} · 결과 ${cfg.maxResults}개 · 요약 답변 ${cfg.answer}${cfg.country ? ` · 나라 ${cfg.country}` : ''}).`);
  },

  async deactivate() {
    cfg = null;
  },

  tools,
};
