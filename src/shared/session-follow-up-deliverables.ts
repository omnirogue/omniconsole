import { SESSION_FOLLOW_UP_SUMMARY_MAX_CHARS } from './session-follow-up-rule'

/**
 * Which files a saved follow-up delivers: paths the person named, or the files a
 * run's manifest declares. Resolution never lists a directory and refuses anything
 * outside the workspace, so unrelated files cannot join the package.
 */
function separatorFor(workspacePath: string): '/' | '\\' {
  return workspacePath.includes('\\') && !workspacePath.includes('/') ? '\\' : '/'
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function segments(value: string): string[] {
  return value.split(/[\\/]+/).filter(Boolean)
}

function comparablePath(path: string, caseless: boolean): string {
  const forward = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return caseless ? forward.toLowerCase() : forward
}

function isInside(root: string, candidate: string): boolean {
  const caseless = /^[A-Za-z]:/.test(root) || root.startsWith('\\\\')
  return comparablePath(candidate, caseless).startsWith(`${comparablePath(root, caseless)}/`)
}

export function outputFileName(path: string): string {
  return segments(path).at(-1) ?? path
}

function parentDirectory(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : path
}

/** A typed output path resolved against `base` (default: the workspace); null outside the workspace. */
export function resolveWorkspaceOutputPath(
  workspacePath: string,
  input: string,
  base: string = workspacePath
): string | null {
  const cleaned = input.trim().replace(/^["'`]+|["'`]+$/g, '')
  const parts = segments(cleaned)
  if (!cleaned || parts.includes('..')) {
    return null
  }
  if (isAbsolutePath(cleaned)) {
    return isInside(workspacePath, cleaned) ? cleaned : null
  }
  const relative = parts.filter((part) => part !== '.')
  if (relative.length === 0) {
    return null
  }
  const resolved = [base.replace(/[\\/]+$/, ''), ...relative].join(separatorFor(workspacePath))
  return isInside(workspacePath, resolved) ? resolved : null
}

const PATH_LIKE = /\.[A-Za-z0-9]{1,8}$/

function looksLikePath(value: string): boolean {
  return PATH_LIKE.test(value) && !/^[a-z]+:\/\//i.test(value) && value.length <= 4096
}

function manifestEntry(line: string): string | null {
  if (!line || line.startsWith('#') || /^\|?\s*:?-{3,}/.test(line)) {
    return null
  }
  const code = /`([^`]+)`/.exec(line)?.[1]?.trim()
  if (code && looksLikePath(code)) {
    return code
  }
  const link = /\[[^\]]*\]\(([^)\s]+)\)/.exec(line)?.[1]
  if (link && looksLikePath(link)) {
    return link
  }
  const cell = line.startsWith('|') ? line.split('|')[1]?.trim() : null
  const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)?.[1]
  const text = (cell ?? item ?? line).split(/\s+(?:—|–|-)\s+|\s*:\s+|\s+\(/)[0]!.trim()
  const token = (text.includes(' ') ? text.split(' ')[0]! : text).replace(/[,;:]+$/, '')
  return looksLikePath(token) ? token : null
}

/**
 * Files a run's manifest declares; entries outside the workspace are refused. A relative entry
 * names a file beside the manifest; `inWorkspace` is the same entry read from the workspace root,
 * because a stage that improved the person's own files lists them the way it sees them.
 */
export function parseDeliverablesManifest(
  markdown: string,
  manifestPath: string,
  workspacePath: string
): { paths: string[]; refused: string[]; inWorkspace: Record<string, string> } {
  const base = parentDirectory(manifestPath)
  const paths: string[] = []
  const refused: string[] = []
  const inWorkspace: Record<string, string> = {}
  for (const raw of markdown.split(/\r?\n/)) {
    const entry = manifestEntry(raw.trim())
    if (!entry) {
      continue
    }
    const resolved = resolveWorkspaceOutputPath(workspacePath, entry, base)
    if (!resolved) {
      refused.push(entry)
    } else if (resolved !== manifestPath && !paths.includes(resolved)) {
      paths.push(resolved)
      const fromRoot = resolveWorkspaceOutputPath(workspacePath, entry)
      if (fromRoot && fromRoot !== resolved && fromRoot !== manifestPath) {
        inWorkspace[resolved] = fromRoot
      }
    }
  }
  return { paths, refused, inWorkspace }
}

export function finalSummaryFileName(sessionLabel: string): string {
  const slug = sessionLabel
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${slug || 'session'}-final-summary.md`
}

/** A named Markdown file holding the session's final output, fenced so it renders as written. */
export function buildFinalSummaryMarkdown(args: {
  title: string
  sessionLabel: string
  finishedAt: string
  workspacePath: string
  output: string
}): string {
  const header = [
    `# ${args.title}`,
    '',
    `- Session: ${args.sessionLabel}`,
    `- Finished: ${args.finishedAt}`,
    `- Workspace: ${args.workspacePath}`,
    ''
  ].join('\n')
  const longestRun = Math.max(0, ...(args.output.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  const room = SESSION_FOLLOW_UP_SUMMARY_MAX_CHARS - header.length - fence.length * 2 - 16
  const output =
    args.output.length > room ? `…${args.output.slice(args.output.length - room)}` : args.output
  return `${header}\n${fence}text\n${output}\n${fence}\n`
}
