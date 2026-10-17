/**
 * A version that is a change to the code, read without running anything: its diff, the files it
 * touches, and why a file may not be touched. Git itself reads the paths (graph-check-apply.ts);
 * these rules decide what a private copy lets a version change.
 */
import { createHash } from 'node:crypto'

// Only a fence at the start of a line closes the block: a diff line always starts with a mark.
const DIFF_BLOCK = /^(`{3,})(?:diff|patch)\b[^\n]*\n([\s\S]*?)^\1[ \t]*$/gim

// Lines of a file's own header, before its `---` line: no separator is needed after them.
const FILE_HEADER =
  /^(?:diff |index |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename |copy )/

/**
 * `--recount` counts hunk lines until a `diff ` or `@@ ` line, so in a plain multi-file diff it
 * would read the next file's `---` header as a removed line. Each file header that follows hunk
 * lines gets a `diff` line first, which Git otherwise ignores, and blank lines before one are
 * dropped (a blank line in a hunk counts as unchanged).
 */
function separateFiles(patch: string): string {
  const lines = patch.split('\n')
  const out: string[] = []
  lines.forEach((line, index) => {
    const plainHeader =
      line.startsWith('--- ') &&
      !!lines[index + 1]?.startsWith('+++ ') &&
      !!lines[index + 2]?.startsWith('@@ ')
    if (plainHeader || line.startsWith('diff ')) {
      while (out.at(-1) === '') {
        out.pop()
      }
      const last = out.at(-1)
      if (plainHeader && last !== undefined && !FILE_HEADER.test(last)) {
        out.push(`diff ${line.slice(4)} ${lines[index + 1]!.slice(4)}`)
      }
    }
    out.push(line)
  })
  return out.join('\n')
}

/** The version's change: every ```diff block, in order, as one patch; undefined when it has none. */
export function graphPatchText(markdown: string): string | undefined {
  const blocks = [...markdown.matchAll(DIFF_BLOCK)].map((match) => match[2] ?? '')
  const patch = separateFiles(blocks.join('\n').replace(/\n+$/, ''))
  return patch.trim() ? `${patch}\n` : undefined
}

/** How a change that was not tested is reported, so why can be read back without the output. */
export const GRAPH_PATCH_NO_DIFF =
  'Not tested: this version has no ```diff block, so it has no change to test.'
export const GRAPH_PATCH_REFUSED = 'Not tested: the change was refused.'
export const GRAPH_PATCH_UNAPPLIED = 'Not tested: the diff does not apply to your code as it is.'

/**
 * One change however its diff was written: `--recount` ignores hunk line counts and the text
 * after a hunk's `@@`, and a plain apply never reads an `index` line's blob ids. Every other byte
 * counts, since whitespace and comments in a diff change the code it writes.
 */
export function normalizedPatchKey(patch: string): string {
  const lines = patch.split('\n').map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      return `@@ -${hunk[1]} +${hunk[2]} @@`
    }
    const index = /^index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]{6}))?$/.exec(line)
    return index ? `index${index[1] ? ` ${index[1]}` : ''}` : line
  })
  return createHash('sha256').update(lines.join('\n')).digest('hex')
}

/** `git apply --numstat -z` output: every file the patch touches, and those with binary content. */
export function graphPatchNumstat(output: string): { paths: string[]; binary: string[] } {
  const paths: string[] = []
  const binary: string[] = []
  for (const record of output.split('\0')) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record)
    if (!match) {
      continue
    }
    paths.push(match[3]!)
    if (match[1] === '-' || match[2] === '-') {
      binary.push(match[3]!)
    }
  }
  return { paths, binary }
}

const SPECIAL = /^(120000|160000)$/
// git apply --summary: a file created, deleted, or changed into or out of a link or submodule.
const SUMMARY_MODES = [/^\s*(?:create|delete) mode (\d{6}) /, /^\s*mode change (\d{6}) => (\d{6}) /]
// The patch's own headers, which also say when an existing link is only edited.
const HEADER_MODES = [
  /^(?:new file mode|deleted file mode|old mode|new mode) (\d{6})\s*$/,
  /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})\s*$/
]

function specialMode(text: string, patterns: RegExp[]): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    for (const pattern of patterns) {
      const mode = pattern
        .exec(line)
        ?.slice(1)
        .find((value) => SPECIAL.test(value ?? ''))
      if (mode) {
        return mode
      }
    }
  }
  return undefined
}

/** Why the patch's modes are refused: it makes, edits or removes a symbolic link or submodule. */
export function graphPatchModeProblem(summary: string, patch: string): string | undefined {
  const mode = specialMode(summary, SUMMARY_MODES) ?? specialMode(patch, HEADER_MODES)
  return mode === '120000'
    ? 'It changes a symbolic link, which could point outside the private copy.'
    : mode
      ? 'It changes a submodule, which the private copy does not have.'
      : undefined
}

// Invisible characters that some file systems drop from a name (git's own .git check drops them).
const IGNORABLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

/** `.git` as any file system may spell it: any case, trailing dots or spaces, or its short name. */
function gitFolderName(segment: string): boolean {
  const name = segment
    .replace(IGNORABLE, '')
    .replace(/[. ]+$/, '')
    .toLowerCase()
  return name === '.git' || /^git~\d+$/.test(name)
}

/** A person's glob as a regular expression: `*` and `?` stay inside a folder, `**` crosses them. */
function globSource(glob: string): string {
  let source = ''
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === '*' && glob[index + 1] === '*') {
      const folders = glob[index + 2] === '/'
      source += folders ? '(?:[^/]*/)*' : '.*'
      index += folders ? 2 : 1
    } else if (char === '*') {
      source += '[^/]*'
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return source
}

/**
 * Whether a person's pattern protects a repository path, the way .gitignore reads one: a pattern
 * without a slash matches a name at any depth, one with a slash from the top, a trailing slash
 * only folders, and a matched folder protects everything in it. Case never matters, because on
 * most computers `Tests/` and `tests/` are the same folder.
 */
export function graphProtectedBy(path: string, pattern: string): boolean {
  const typed = pattern.trim().replaceAll('\\', '/').normalize('NFC')
  const body = typed.replace(/^\/+|\/+$/g, '')
  if (!body || typed.startsWith('#')) {
    return false
  }
  const anchored = typed.startsWith('/') || body.includes('/')
  const matcher = new RegExp(`^${globSource(body)}$`, 'i')
  const segments = path.normalize('NFC').split('/')
  return segments.some((_, index) => {
    if (typed.endsWith('/') && index === segments.length - 1) {
      return false
    }
    return matcher.test(anchored ? segments.slice(0, index + 1).join('/') : segments[index]!)
  })
}

/** Why a version may not change this path, or undefined when it may. */
export function graphPatchPathProblem(
  path: string,
  protect: readonly string[]
): string | undefined {
  const segments = path.split('/')
  if (
    !path ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return `${path} is outside the repository.`
  }
  if (segments.some(gitFolderName)) {
    return `${path} is inside .git, where Git keeps its own records.`
  }
  if (segments.at(-1)!.toLowerCase() === '.gitignore') {
    // Why: the reset between versions keeps ignored files, so new ignore rules would outlive it.
    return `${path} changes what Git ignores.`
  }
  const pattern = protect.find((entry) => graphProtectedBy(path, entry))
  return pattern ? `${path} is protected (${pattern.trim()}).` : undefined
}

const EXIT_CALL = /\b(process\.exit|sys\.exit|os\._exit)\s*\(/g

/** Calls the change adds that end the process early: a test run may then pass without testing. */
export function graphPatchExits(patch: string): string[] {
  const found = new Set<string>()
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      for (const match of line.matchAll(EXIT_CALL)) {
        found.add(match[1]!)
      }
    }
  }
  return [...found]
}
