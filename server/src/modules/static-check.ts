import type { InstallCheck } from '../db/store.ts';
import type { Manifest } from './manifest.ts';

export interface SourceFile {
  path: string;
  content: string;
}

export interface Finding {
  file: string;
  line: number;
  level: 'error' | 'warn';
  rule: string;
  message: string;
}

interface Rule {
  id: string;
  level: 'error' | 'warn';
  re: RegExp;
  message: string;
  /** 매니페스트가 허용하면 건너뜀 */
  allowedBy?: (m: Manifest) => boolean;
}

const RULES: readonly Rule[] = [
  { id: 'eval', level: 'error', re: /(^|[^\w.$])eval\s*\(/, message: 'eval() 은 임의 코드를 실행할 수 있어 쓸 수 없습니다.' },
  { id: 'new-function', level: 'error', re: /new\s+Function\s*\(/, message: 'new Function() 은 임의 코드를 실행할 수 있어 쓸 수 없습니다.' },
  {
    id: 'child-process',
    level: 'error',
    re: /(['"])(?:node:)?child_process\1/,
    message: "child_process 를 쓰려면 module.json 의 permissions.childProcess 를 true 로 선언하고 승인을 받아야 합니다.",
    allowedBy: (m) => m.permissions.childProcess,
  },
  { id: 'process-env', level: 'warn', re: /process\.env\b/, message: 'process.env 대신 ctx.env 를 쓰세요. 모듈에는 module.json 에 선언한 환경 변수만 전달됩니다.' },
  { id: 'raw-network', level: 'warn', re: /(['"])(?:node:)?(?:net|tls|dgram|http|https|http2)\1/, message: '저수준 네트워크 모듈을 씁니다. ctx.fetch 와 달리 도메인 허용 목록을 거치지 않으니 접속 대상을 확인하세요.' },
  { id: 'dynamic-import', level: 'warn', re: /(?:import|require)\s*\(\s*[^'"`\s)]/, message: '동적 import/require 의 대상이 문자열 상수가 아닙니다. 무엇을 불러오는지 확인하세요.' },
  { id: 'vm', level: 'warn', re: /(['"])(?:node:)?(?:vm|worker_threads)\1/, message: 'vm/worker_threads 를 씁니다. 다른 코드를 실행하는지 확인하세요.' },
];

const CODE_FILE = /\.(m?js|cjs)$/;

/** 모듈 코드에서 위험하거나 규칙에 어긋나는 패턴을 줄 단위로 찾습니다. node_modules 는 보지 않습니다. */
export function staticCheck(files: readonly SourceFile[], manifest: Manifest): Finding[] {
  const out: Finding[] = [];
  for (const f of files) {
    if (!CODE_FILE.test(f.path) || f.path.split('/').includes('node_modules')) continue;
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      for (const r of RULES) {
        if (r.allowedBy?.(manifest)) continue;
        if (r.re.test(line)) out.push({ file: f.path, line: i + 1, level: r.level, rule: r.id, message: r.message });
      }
    }
  }
  return out;
}

/** 결과를 설치 보고서 항목으로 요약합니다. */
export function findingsToCheck(findings: readonly Finding[]): InstallCheck {
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  if (errors.length > 0) {
    const f = errors[0] as Finding;
    return { label: '정적 검사', level: 'error', detail: `${f.file}:${f.line} ${f.message}${errors.length > 1 ? ` 외 ${errors.length - 1}건` : ''}` };
  }
  if (warns.length > 0) {
    const f = warns[0] as Finding;
    return { label: '정적 검사', level: 'warn', detail: `${f.file}:${f.line} ${f.message}${warns.length > 1 ? ` 외 ${warns.length - 1}건` : ''}` };
  }
  return { label: '정적 검사', level: 'ok', detail: 'eval · new Function · 선언하지 않은 child_process 없음' };
}
