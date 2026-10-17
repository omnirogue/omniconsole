import {
  workflowContextAddSources,
  workflowContextSourceKey,
  workflowGitHubRepoValid,
  workflowGitRefValid,
  type WorkflowContextSource
} from './workflow-context-sources'

// github.com/<owner>/<name>, then optionally /tree/<ref>; the ref runs to the next space.
const GITHUB_URL =
  /(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)(\/tree\/[^\s"'`<>]+)?/gi
// A bare owner/name only when the text calls it a repo, before or after it.
const NAMED_REPO_BEFORE =
  /\b(?:repo|repository|github|gh)(?:\s*[:=])?\s+([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)/gi
const NAMED_REPO_AFTER = /(?:^|[\s(])([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\s+(?:repo|repository)\b/gi
// A quoted path may hold spaces; an unquoted one runs to the next space.
const QUOTED_PATH = /(["'`])((?:~[\\/]|\/|[A-Za-z]:[\\/])[^"'`\n]+?)\1/g
const BARE_PATH = /(?:^|[\s(<[])((?:~[\\/]|\/(?=[A-Za-z0-9._-])|[A-Za-z]:[\\/])[^\s"'`<>|]+)/g
const TRAILING = /[.,;:!?)\]}>]+$/
// github.com pages that are not repositories.
const NOT_OWNERS = new Set([
  'about',
  'apps',
  'collections',
  'enterprise',
  'explore',
  'features',
  'issues',
  'login',
  'marketplace',
  'new',
  'notifications',
  'orgs',
  'organizations',
  'pricing',
  'pulls',
  'search',
  'settings',
  'sponsors',
  'topics',
  'trending'
])

function repoName(owner: string, name: string): string | undefined {
  const repo = `${owner}/${name.replace(TRAILING, '').replace(/\.git$/i, '')}`
  return !NOT_OWNERS.has(owner.toLowerCase()) && workflowGitHubRepoValid(repo) ? repo : undefined
}

function githubSources(text: string): { index: number; source: WorkflowContextSource }[] {
  const found: { index: number; source: WorkflowContextSource }[] = []
  for (const match of text.matchAll(GITHUB_URL)) {
    const repo = repoName(match[1]!, match[2]!)
    const ref = match[3]?.slice('/tree/'.length).replace(TRAILING, '')
    if (repo) {
      found.push({
        index: match.index,
        source: { kind: 'github', repo, ...(ref && workflowGitRefValid(ref) ? { ref } : {}) }
      })
    }
  }
  // A bare owner/name that is really part of a github.com address was taken above.
  const urls = [...text.matchAll(GITHUB_URL)].map((match) => [
    match.index,
    match.index + match[0].length
  ])
  for (const pattern of [NAMED_REPO_BEFORE, NAMED_REPO_AFTER]) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index + match[0].indexOf(match[1]!)
      if (urls.some(([from, to]) => start >= from! && start < to!)) {
        continue
      }
      const [owner, name] = match[1]!.split('/') as [string, string]
      const repo = repoName(owner, name)
      if (repo) {
        found.push({ index: start, source: { kind: 'github', repo } })
      }
    }
  }
  return found
}

/** A path worth offering: a home path, or an absolute one with at least two segments. */
function pathSource(raw: string): WorkflowContextSource | undefined {
  const path = raw.replace(TRAILING, '')
  const segments = path.split(/[\\/]+/).filter(Boolean)
  // `~/x` is two segments; a bare `/day` is too often not a path at all.
  return segments.length >= 2 ? { kind: 'path', path } : undefined
}

function pathSources(text: string): { index: number; source: WorkflowContextSource }[] {
  const found: { index: number; source: WorkflowContextSource }[] = []
  const quoted: [number, number][] = []
  for (const match of text.matchAll(QUOTED_PATH)) {
    quoted.push([match.index, match.index + match[0].length])
    const source = pathSource(match[2]!)
    if (source) {
      found.push({ index: match.index, source })
    }
  }
  for (const match of text.matchAll(BARE_PATH)) {
    const start = match.index + match[0].indexOf(match[1]!)
    // A URL's path (github.com/…, https://…) is not a file on this computer.
    const before = text.slice(Math.max(0, start - 1), start)
    if (quoted.some(([from, to]) => start >= from && start < to) || before === ':') {
      continue
    }
    const source = pathSource(match[1]!)
    if (source) {
      found.push({ index: start, source })
    }
  }
  return found
}

/**
 * The files, folders and GitHub repositories a request names, in the order it names them, each
 * once: absolute and ~/ paths, github.com addresses (with /tree/<ref>), and owner/name only when
 * the text calls it a repo. Nothing is read or checked here; the host refuses what it must.
 */
export function workflowContextSourcesIn(text: string): WorkflowContextSource[] {
  const found = [...githubSources(text), ...pathSources(text)].sort((a, b) => a.index - b.index)
  return workflowContextAddSources(
    [],
    found.map((entry) => entry.source)
  )
}

/**
 * Sources the request names that are not chosen yet and that the person has not removed; the
 * new list, or undefined when nothing is new. Run once the person stops typing.
 */
export function workflowContextPrefill(
  prompt: string,
  chosen: readonly WorkflowContextSource[],
  dismissed: ReadonlySet<string>
): WorkflowContextSource[] | undefined {
  const fresh = workflowContextSourcesIn(prompt).filter(
    (source) => !dismissed.has(workflowContextSourceKey(source))
  )
  const next = workflowContextAddSources(chosen, fresh)
  return next.length > chosen.length ? next : undefined
}
