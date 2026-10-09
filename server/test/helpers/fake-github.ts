/**
 * GitHub REST API 의 일부를 메모리에서 흉내 내는 가짜 서버 (fetch 함수로 씀).
 * 이슈 · 댓글 · 라벨 · 내용(contents) · git 데이터(ref · commit · tree) · PR 만 다룹니다.
 */

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  state_reason: string | null;
  user: string;
  labels: string[];
  pull: boolean;
  created_at: string;
  updated_at: string;
}

interface FakeRepo {
  owner: string;
  name: string;
  defaultBranch: string;
  issues: FakeIssue[];
  comments: Map<number, { id: number; body: string; user: string; created_at: string }[]>;
  refs: Map<string, string>;
  commits: Map<string, { tree: string; parents: string[]; message: string }>;
  trees: Map<string, Map<string, string>>;
  pulls: { number: number; head: string; base: string; title: string; body: string; draft: boolean; state: 'open' }[];
}

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}): Response => new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export class FakeGitHub {
  token = 'github_pat_test_0000';
  login = 'switchboard-bot';
  repos = new Map<string, FakeRepo>();
  calls: Call[] = [];
  /** 이 값이 있으면 모든 요청에 1차 호출 한도 응답 (재설정 시각, 초) */
  rateLimitedUntil: number | null = null;
  private seq = 0;
  private time = Date.parse('2026-10-09T05:00:00Z');

  private sha(): string {
    this.seq += 1;
    return this.seq.toString(16).padStart(40, '0');
  }

  private now(): string {
    this.time += 60_000;
    return new Date(this.time).toISOString();
  }

  addRepo(full: string, files: Record<string, string> = { 'README.md': '# hello\n' }, defaultBranch = 'main'): FakeRepo {
    const [owner, name] = full.split('/') as [string, string];
    const tree = this.sha();
    const commit = this.sha();
    const repo: FakeRepo = {
      owner,
      name,
      defaultBranch,
      issues: [],
      comments: new Map(),
      refs: new Map([[defaultBranch, commit]]),
      commits: new Map([[commit, { tree, parents: [], message: 'init' }]]),
      trees: new Map([[tree, new Map(Object.entries(files))]]),
      pulls: [],
    };
    this.repos.set(full.toLowerCase(), repo);
    return repo;
  }

  addIssue(full: string, title: string, opts: { body?: string; pull?: boolean; state?: 'open' | 'closed'; labels?: string[]; user?: string } = {}): FakeIssue {
    const repo = this.repo(full);
    const number = repo.issues.reduce((n, i) => Math.max(n, i.number), 0) + 1;
    const at = this.now();
    const issue: FakeIssue = { number, title, body: opts.body ?? '', state: opts.state ?? 'open', state_reason: null, user: opts.user ?? 'alice', labels: opts.labels ?? [], pull: opts.pull === true, created_at: at, updated_at: at };
    repo.issues.push(issue);
    return issue;
  }

  addComment(full: string, number: number, body: string, user = 'bob'): void {
    const repo = this.repo(full);
    const list = repo.comments.get(number) ?? [];
    list.push({ id: list.length + 1, body, user, created_at: this.now() });
    repo.comments.set(number, list);
  }

  repo(full: string): FakeRepo {
    const r = this.repos.get(full.toLowerCase());
    if (!r) throw new Error(`가짜 저장소 없음: ${full}`);
    return r;
  }

  /** 브랜치 끝 커밋의 파일들 */
  filesAt(full: string, branch: string): Map<string, string> | null {
    const repo = this.repo(full);
    const sha = repo.refs.get(branch);
    if (!sha) return null;
    const c = repo.commits.get(sha);
    return c ? (repo.trees.get(c.tree) ?? null) : null;
  }

  private issueView(repo: FakeRepo, i: FakeIssue): Record<string, unknown> {
    const base = `https://github.com/${repo.owner}/${repo.name}`;
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      state_reason: i.state_reason,
      user: { login: i.user },
      labels: i.labels.map((name) => ({ name })),
      assignees: [],
      comments: repo.comments.get(i.number)?.length ?? 0,
      created_at: i.created_at,
      updated_at: i.updated_at,
      html_url: `${base}/${i.pull ? 'pull' : 'issues'}/${i.number}`,
      ...(i.pull ? { pull_request: { url: `${base}/pull/${i.number}` } } : {}),
    };
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const query = Object.fromEntries(url.searchParams.entries());
    this.calls.push({ method, path: url.pathname, query, body, headers });
    if (url.host !== 'api.github.com') return json(400, { message: `unexpected host ${url.host}` });
    if (headers['authorization'] !== `Bearer ${this.token}`) return json(401, { message: 'Bad credentials' });
    if (this.rateLimitedUntil !== null) return json(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(this.rateLimitedUntil) });
    if (url.pathname === '/user' && method === 'GET') return json(200, { login: this.login });

    const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!m) return json(404, { message: 'Not Found' });
    const repo = this.repos.get(`${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`.toLowerCase());
    if (!repo) return json(404, { message: 'Not Found' });
    const rest = m[3] ?? '';
    const base = `https://github.com/${repo.owner}/${repo.name}`;

    if (rest === '' && method === 'GET') return json(200, { full_name: `${repo.owner}/${repo.name}`, default_branch: repo.defaultBranch });

    if (rest === 'issues' && method === 'GET') {
      const state = query['state'] ?? 'open';
      const labels = query['labels'] ? query['labels'].split(',') : [];
      const per = Number(query['per_page'] ?? 30);
      const page = Number(query['page'] ?? 1);
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .filter((i) => labels.every((l) => i.labels.includes(l)))
        .sort((a, b) => b.number - a.number)
        .slice((page - 1) * per, page * per)
        .map((i) => this.issueView(repo, i));
      const etag = `"${Buffer.from(JSON.stringify(list)).toString('base64').slice(0, 24)}${list.length}"`;
      if (headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
      return json(200, list, { etag });
    }

    let mm = /^issues\/(\d+)$/.exec(rest);
    if (mm) {
      const issue = repo.issues.find((i) => i.number === Number(mm![1]));
      if (!issue) return json(404, { message: 'Not Found' });
      if (method === 'GET') return json(200, this.issueView(repo, issue));
      if (method === 'PATCH') {
        const b = body as { title?: string; state?: 'open' | 'closed'; state_reason?: string };
        if (b.title) issue.title = b.title;
        if (b.state) issue.state = b.state;
        if (b.state_reason) issue.state_reason = b.state_reason;
        issue.updated_at = this.now();
        return json(200, this.issueView(repo, issue));
      }
    }

    mm = /^issues\/(\d+)\/comments$/.exec(rest);
    if (mm) {
      const n = Number(mm[1]);
      if (!repo.issues.some((i) => i.number === n)) return json(404, { message: 'Not Found' });
      if (method === 'GET') {
        const per = Number(query['per_page'] ?? 30);
        const page = Number(query['page'] ?? 1);
        const list = (repo.comments.get(n) ?? []).slice((page - 1) * per, page * per).map((c) => ({ id: c.id, body: c.body, user: { login: c.user }, created_at: c.created_at }));
        return json(200, list);
      }
      if (method === 'POST') {
        this.addComment(`${repo.owner}/${repo.name}`, n, (body as { body: string }).body, this.login);
        const id = repo.comments.get(n)!.length;
        return json(201, { id, html_url: `${base}/issues/${n}#issuecomment-${id}` });
      }
    }

    mm = /^issues\/(\d+)\/labels(?:\/(.+))?$/.exec(rest);
    if (mm) {
      const issue = repo.issues.find((i) => i.number === Number(mm![1]));
      if (!issue) return json(404, { message: 'Not Found' });
      if (method === 'POST' && !mm[2]) {
        for (const l of (body as { labels: string[] }).labels) if (!issue.labels.includes(l)) issue.labels.push(l);
        return json(200, issue.labels.map((name) => ({ name })));
      }
      if (method === 'DELETE' && mm[2]) {
        const name = decodeURIComponent(mm[2]);
        if (!issue.labels.includes(name)) return json(404, { message: 'Label does not exist' });
        issue.labels = issue.labels.filter((l) => l !== name);
        return json(200, issue.labels.map((n) => ({ name: n })));
      }
    }

    mm = /^contents(?:\/(.*))?$/.exec(rest);
    if (mm && method === 'GET') {
      const p = mm[1] ? decodeURIComponent(mm[1]) : '';
      const files = this.filesAt(`${repo.owner}/${repo.name}`, query['ref'] ?? repo.defaultBranch);
      if (!files) return json(404, { message: 'No commit found for the ref' });
      const content = files.get(p);
      if (content !== undefined) {
        return json(200, { type: 'file', path: p, size: Buffer.byteLength(content), sha: 'f'.repeat(40), encoding: 'base64', content: Buffer.from(content).toString('base64') });
      }
      const prefix = p === '' ? '' : `${p}/`;
      const seen = new Map<string, 'file' | 'dir'>();
      for (const [fp, c] of files) {
        if (!fp.startsWith(prefix)) continue;
        const restPath = fp.slice(prefix.length);
        const head = restPath.split('/')[0]!;
        seen.set(head, restPath.includes('/') ? 'dir' : 'file');
        void c;
      }
      if (seen.size === 0) return json(404, { message: 'Not Found' });
      return json(200, [...seen].map(([name, type]) => ({ type, name, path: `${prefix}${name}`, size: type === 'file' ? Buffer.byteLength(files.get(`${prefix}${name}`) ?? '') : 0 })));
    }

    mm = /^git\/ref\/heads\/(.+)$/.exec(rest);
    if (mm && method === 'GET') {
      const sha = repo.refs.get(decodeURIComponent(mm[1]!));
      return sha ? json(200, { ref: `refs/heads/${mm[1]}`, object: { sha, type: 'commit' } }) : json(404, { message: 'Not Found' });
    }

    mm = /^git\/commits\/([0-9a-f]+)$/.exec(rest);
    if (mm && method === 'GET') {
      const c = repo.commits.get(mm[1]!);
      return c ? json(200, { sha: mm[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : json(404, { message: 'Not Found' });
    }

    if (rest === 'git/trees' && method === 'POST') {
      const b = body as { base_tree: string; tree: { path: string; content?: string; sha?: string | null }[] };
      const baseFiles = repo.trees.get(b.base_tree);
      if (!baseFiles) return json(422, { message: 'Invalid tree info' });
      const next = new Map(baseFiles);
      for (const e of b.tree) {
        if (e.sha === null) {
          if (!next.has(e.path)) return json(422, { message: 'GitRPC::BadObjectState' });
          next.delete(e.path);
        } else next.set(e.path, e.content ?? '');
      }
      const sha = this.sha();
      repo.trees.set(sha, next);
      return json(201, { sha });
    }

    if (rest === 'git/commits' && method === 'POST') {
      const b = body as { message: string; tree: string; parents: string[] };
      const sha = this.sha();
      repo.commits.set(sha, { tree: b.tree, parents: b.parents, message: b.message });
      return json(201, { sha, html_url: `${base}/commit/${sha}` });
    }

    if (rest === 'git/refs' && method === 'POST') {
      const b = body as { ref: string; sha: string };
      const branch = b.ref.replace(/^refs\/heads\//, '');
      if (repo.refs.has(branch)) return json(422, { message: 'Reference already exists' });
      repo.refs.set(branch, b.sha);
      return json(201, { ref: b.ref, object: { sha: b.sha } });
    }

    mm = /^git\/refs\/heads\/(.+)$/.exec(rest);
    if (mm && method === 'PATCH') {
      const branch = decodeURIComponent(mm[1]!);
      const cur = repo.refs.get(branch);
      if (!cur) return json(422, { message: 'Reference does not exist' });
      const b = body as { sha: string; force: boolean };
      const c = repo.commits.get(b.sha);
      if (!b.force && !c?.parents.includes(cur)) return json(422, { message: 'Update is not a fast forward' });
      repo.refs.set(branch, b.sha);
      return json(200, { ref: `refs/heads/${branch}`, object: { sha: b.sha } });
    }

    if (rest === 'pulls' && method === 'POST') {
      const b = body as { title: string; head: string; base: string; body?: string; draft?: boolean };
      if (!repo.refs.has(b.head)) return json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] });
      if (repo.pulls.some((p) => p.head === b.head && p.base === b.base && p.state === 'open')) {
        return json(422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${repo.owner}:${b.head}.` }] });
      }
      const number = this.addIssue(`${repo.owner}/${repo.name}`, b.title, { pull: true, user: this.login }).number;
      repo.pulls.push({ number, head: b.head, base: b.base, title: b.title, body: b.body ?? '', draft: b.draft === true, state: 'open' });
      return json(201, { number, html_url: `${base}/pull/${number}` });
    }

    if (rest === 'pulls' && method === 'GET') {
      const head = (query['head'] ?? '').split(':')[1];
      const list = repo.pulls.filter((p) => (!head || p.head === head) && (!query['base'] || p.base === query['base']));
      return json(200, list.map((p) => ({ number: p.number, html_url: `${base}/pull/${p.number}`, state: p.state })));
    }

    return json(404, { message: `가짜 서버에 없는 경로: ${method} ${url.pathname}` });
  };
}
