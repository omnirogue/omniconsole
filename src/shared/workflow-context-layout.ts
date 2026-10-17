import { workflowPathBasename, type WorkflowContextSource } from './workflow-context-sources'

/** Where one source sits in a run's context folder (a relative path with / separators). */
export type WorkflowContextEntry =
  | { kind: 'workspace'; folder: string }
  | { kind: 'path'; path: string; folder: string }
  | { kind: 'github'; repo: string; ref?: string; folder: string }

export const WORKFLOW_CONTEXT_WORKSPACE_FOLDER = 'workspace'
export const WORKFLOW_CONTEXT_GITHUB_FOLDER = 'github'

/** A folder name that is safe on every file system and never hidden. */
function safeName(text: string): string {
  const name = text
    .replace(/[^A-Za-z0-9._@ -]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 80)
    .trim()
  return name || 'item'
}

/** `name`, or `name-2`, `name-3`… when taken (compared without case, as macOS and Windows do). */
function unique(name: string, taken: Set<string>): string {
  let candidate = name
  for (let count = 2; taken.has(candidate.toLowerCase()); count++) {
    candidate = `${name}-${count}`
  }
  taken.add(candidate.toLowerCase())
  return candidate
}

/**
 * The context folder's layout: `workspace/` for the current workspace, `<name>/` for each file or
 * folder (its own name, made unique), and `github/<owner>__<repo>@<ref>/` for each repository
 * (`default` for its default branch). Pure: the host and the note agents read share it.
 */
export function workflowContextLayout(
  sources: readonly WorkflowContextSource[],
  includeWorkspace: boolean
): WorkflowContextEntry[] {
  const top = new Set([WORKFLOW_CONTEXT_WORKSPACE_FOLDER, WORKFLOW_CONTEXT_GITHUB_FOLDER])
  const repos = new Set<string>()
  const entries: WorkflowContextEntry[] = includeWorkspace
    ? [{ kind: 'workspace', folder: WORKFLOW_CONTEXT_WORKSPACE_FOLDER }]
    : []
  for (const source of sources) {
    if (source.kind === 'path') {
      const folder = unique(safeName(workflowPathBasename(source.path)), top)
      entries.push({ kind: 'path', path: source.path, folder })
      continue
    }
    const [owner, name] = source.repo.split('/') as [string, string]
    const leaf = unique(
      safeName(`${owner}__${name}@${source.ref ? source.ref.replace(/\//g, '_') : 'default'}`),
      repos
    )
    entries.push({
      kind: 'github',
      repo: source.repo,
      ...(source.ref ? { ref: source.ref } : {}),
      folder: `${WORKFLOW_CONTEXT_GITHUB_FOLDER}/${leaf}`
    })
  }
  return entries
}

/** What a run's snapshot keeps: each folder and where it came from (a repo's resolved commit). */
export type WorkflowContextRecordEntry = WorkflowContextEntry & { commit?: string }
