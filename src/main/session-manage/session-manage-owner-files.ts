// The files a task names (paths, file names and globs in its own words, plus `--files`), and
// which of a worktree's changed files they cover: `session find-owner`'s strongest signal.

const MAX_TASK_FILES = 50
const TRAILING_PUNCTUATION = /[.,;:!?)\]}>'"`]+$/
const LEADING_PUNCTUATION = /^[(<[{'"`]+/
const LINE_SUFFIX = /:\d+(?::\d+)?$/
const FILE_NAME = /^[\w.-]*[A-Za-z_-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,7}$/
const GLOB_CHARS = /[*?{]/

function cleanToken(raw: string): string {
  return raw
    .replace(LEADING_PUNCTUATION, '')
    .replace(TRAILING_PUNCTUATION, '')
    .replace(LINE_SUFFIX, '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

function looksLikePath(token: string): boolean {
  if (!token || token.includes('://') || token.startsWith('@') || !/[A-Za-z]/.test(token)) {
    return false
  }
  if (GLOB_CHARS.test(token)) {
    return token.includes('/') || token.includes('.')
  }
  if (token.includes('/')) {
    // Why a dot or two segments: "and/or" and "A/B" are words, not paths.
    const segments = token.split('/').filter(Boolean)
    return segments.length >= 2 && (token.includes('.') || segments.length >= 3)
  }
  return FILE_NAME.test(token)
}

/** Explicit paths, file names and globs in the task text, then the `--files` list; de-duplicated. */
export function sessionOwnerTaskFiles(task: string, files: readonly string[] = []): string[] {
  const found = new Set<string>()
  for (const raw of [...task.split(/[\s,]+/), ...files]) {
    const token = cleanToken(raw.trim())
    if (looksLikePath(token) || files.includes(raw)) {
      if (token) {
        found.add(token)
      }
    }
    if (found.size >= MAX_TASK_FILES) {
      break
    }
  }
  return [...found]
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+^$()|[\]\\]/g, '\\$&')
}

function globRegExp(glob: string): RegExp {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      index += slash ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '{') {
      const close = glob.indexOf('}', index)
      if (close === -1) {
        source += '\\{'
        continue
      }
      source += `(?:${glob
        .slice(index + 1, close)
        .split(',')
        .map(escapeRegExp)
        .join('|')})`
      index = close
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`^${source}$`)
}

/** The pattern relative to the worktree, or null when it is an absolute path outside it. */
function relativeTo(pattern: string, worktreePath: string | null): string | null {
  if (!pattern.startsWith('/') && !/^[A-Za-z]:\//.test(pattern)) {
    return pattern
  }
  const root = worktreePath?.replace(/\\/g, '/').replace(/\/+$/, '')
  return root && pattern.startsWith(`${root}/`) ? pattern.slice(root.length + 1) : null
}

function covers(pattern: string, file: string): boolean {
  if (GLOB_CHARS.test(pattern)) {
    const target = pattern.includes('/') ? file : (file.split('/').pop() ?? file)
    return globRegExp(pattern).test(target)
  }
  const directory = pattern.replace(/\/+$/, '')
  return file === directory || file.endsWith(`/${directory}`) || file.startsWith(`${directory}/`)
}

/** The worktree's changed files (relative to its root) that the task's files cover. */
export function sessionOwnerOverlap(
  taskFiles: readonly string[],
  changed: readonly string[],
  worktreePath: string | null
): string[] {
  const patterns = taskFiles.flatMap((file) => relativeTo(file, worktreePath) ?? [])
  return changed.filter((file) => patterns.some((pattern) => covers(pattern, file)))
}
