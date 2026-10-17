import { homedir } from 'node:os'
import { DEFAULT_COMPANY_WORK_ROOT, expandHome } from '../../shared/company-folders'

export type TranscriptSessionScope = { company: string | null; domain: string | null }

function segments(value: string): string[] {
  return value
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean)
}

/**
 * The estate files work as `~/Work/<Company>/<Domain>/…`, so a session's cwd names
 * the company and department it served. Anything outside that root is `null`, not
 * a guess: the hub's viewer filters by these, and a wrong company is worse than none.
 */
export function transcriptSessionScope(
  cwd: string | null | undefined,
  options: { home?: string; workRoot?: string | null } = {}
): TranscriptSessionScope {
  if (!cwd) {
    return { company: null, domain: null }
  }
  const home = options.home ?? homedir()
  const root = segments(expandHome(options.workRoot?.trim() || DEFAULT_COMPANY_WORK_ROOT, home))
  const path = segments(cwd)
  const caseFold = process.platform === 'win32' || process.platform === 'darwin'
  const same = (a: string, b: string) => (caseFold ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (path.length < root.length + 1 || !root.every((part, index) => same(part, path[index]!))) {
    return { company: null, domain: null }
  }
  const company = path[root.length] ?? null
  const domain = path[root.length + 1] ?? null
  return { company, domain }
}
