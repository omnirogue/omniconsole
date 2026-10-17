/**
 * What a workflow's agents may read besides the task: files and folders on this computer and
 * GitHub repositories (optionally at a branch, tag or commit). The host copies them into one
 * private folder per run, so every agent still reads exactly one frozen folder.
 */
export type WorkflowContextSource =
  | { kind: 'path'; path: string }
  | { kind: 'github'; repo: string; ref?: string }

export const WORKFLOW_CONTEXT_MAX_SOURCES = 24
export const WORKFLOW_CONTEXT_MAX_PATH_CHARS = 4096

const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** An owner/name GitHub accepts; `.` and `..` are never a repository. */
export function workflowGitHubRepoValid(repo: string): boolean {
  const name = repo.split('/')[1] ?? ''
  return GITHUB_REPO.test(repo) && name !== '.' && name !== '..'
}

/** A branch, tag or commit that is safe as one `git` argument (git check-ref-format, narrowed). */
export function workflowGitRefValid(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 200 &&
    !ref.startsWith('-') &&
    !ref.startsWith('/') &&
    !ref.endsWith('/') &&
    !ref.endsWith('.') &&
    !ref.endsWith('.lock') &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.includes('@{') &&
    ![...ref].some((char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f) &&
    !/[~^:?*[\\]/.test(ref)
  )
}

/** A full commit id: fetched by id, since `clone --branch` only takes branches and tags. */
export function workflowGitRefIsCommit(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref)
}

export function workflowContextSourceValid(source: WorkflowContextSource): boolean {
  if (source.kind === 'path') {
    const path = source.path.trim()
    return !!path && path === source.path && path.length <= WORKFLOW_CONTEXT_MAX_PATH_CHARS
  }
  return (
    workflowGitHubRepoValid(source.repo) &&
    (source.ref === undefined || workflowGitRefValid(source.ref))
  )
}

/** One key per source: GitHub names ignore case, paths do not. */
export function workflowContextSourceKey(source: WorkflowContextSource): string {
  return source.kind === 'path'
    ? `path:${source.path}`
    : `github:${source.repo.toLowerCase()}@${source.ref ?? ''}`
}

/** The last segment of a path written with / or \. */
export function workflowPathBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? path
}

/** Short text for a chip: the file or folder name, or owner/name and the ref when one is set. */
export function workflowContextSourceLabel(source: WorkflowContextSource): string {
  if (source.kind === 'path') {
    return workflowPathBasename(source.path) || source.path
  }
  return source.ref ? `${source.repo} @ ${source.ref}` : source.repo
}

/** `existing` with each valid new source appended once, up to the limit. */
export function workflowContextAddSources(
  existing: readonly WorkflowContextSource[],
  added: readonly WorkflowContextSource[]
): WorkflowContextSource[] {
  const keys = new Set(existing.map(workflowContextSourceKey))
  const next = [...existing]
  for (const source of added) {
    const key = workflowContextSourceKey(source)
    if (next.length >= WORKFLOW_CONTEXT_MAX_SOURCES || keys.has(key)) {
      continue
    }
    if (workflowContextSourceValid(source)) {
      keys.add(key)
      next.push(source)
    }
  }
  return next
}

export function workflowContextRemoveSource(
  existing: readonly WorkflowContextSource[],
  removed: WorkflowContextSource
): WorkflowContextSource[] {
  const key = workflowContextSourceKey(removed)
  return existing.filter((source) => workflowContextSourceKey(source) !== key)
}
