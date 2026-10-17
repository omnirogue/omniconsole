import { lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { runProcess } from '../../../../shared/child-process/run-process'
import { resolveInsideWorkspace } from '../../workspace-whole-file'
import type { GraphSearchCheck } from './graph-pre-verify'

export type GraphSearchRun = typeof runProcess

const SEARCH_TIMEOUT_MS = 5_000
const LIST_TIMEOUT_MS = 20_000
const SEARCH_OUTPUT_BYTES = 64 * 1024
const LIST_OUTPUT_BYTES = 32 * 1024 * 1024
const MAX_HITS = 5

/** Options that change what matches; passed on as rg's own short form. */
const MATCHING: Record<string, string> = {
  i: '-i',
  S: '-S',
  s: '-s',
  F: '-F',
  w: '-w',
  x: '-x',
  U: '-U',
  P: '-P',
  '--ignore-case': '-i',
  '--smart-case': '-S',
  '--case-sensitive': '-s',
  '--fixed-strings': '-F',
  '--word-regexp': '-w',
  '--line-regexp': '-x',
  '--multiline': '-U',
  '--pcre2': '-P'
}
/** Options that only shape output, which the app sets itself. */
const SHAPE = new Set(['n', 'H', 'h', 'N', 'l', 'c'])
const SHAPE_LONG = new Set([
  '--line-number',
  '--no-line-number',
  '--with-filename',
  '--no-filename',
  '--heading',
  '--no-heading',
  '--files-with-matches',
  '--count',
  '--column',
  '--vimgrep',
  '--trim'
])
/** Options with a value: scope ones are passed on, context and output ones dropped. */
const VALUED: Record<string, string | null> = {
  e: '-e',
  g: '--glob',
  t: '--type',
  T: '--type-not',
  d: '--max-depth',
  A: null,
  B: null,
  C: null,
  m: null,
  M: null,
  '--regexp': '-e',
  '--glob': '--glob',
  '--iglob': '--iglob',
  '--type': '--type',
  '--type-not': '--type-not',
  '--max-depth': '--max-depth',
  '--after-context': null,
  '--before-context': null,
  '--context': null,
  '--max-count': null,
  '--max-columns': null,
  '--color': null
}

/** Shell words of a command; a pipe ends it (its tail never changes a match), anything else is refused. */
export function graphShellWords(command: string): string[] | { refused: string } {
  const words: string[] = []
  let word = ''
  let open = false
  let quote: string | undefined
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!
    if (quote) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"' && /["\\$`]/.test(command[at + 1] ?? '')) {
        word += command[++at]
      } else {
        word += char
      }
    } else if (char === '"' || char === "'") {
      quote = char
      open = true
    } else if (char === '\\' && at + 1 < command.length) {
      word += command[++at]
      open = true
    } else if (/\s/.test(char) || char === '|') {
      if (word || open) {
        words.push(word)
      }
      word = ''
      open = false
      if (char === '|') {
        return words
      }
    } else if (/[;&<>`]/.test(char) || (char === '$' && command[at + 1] === '(')) {
      return { refused: 'it is more than one plain command' }
    } else {
      word += char
      open = true
    }
  }
  if (quote) {
    return { refused: 'a quote is not closed' }
  }
  return word || open ? [...words, word] : words
}

export type GraphSearchPlan = { options: string[]; patterns: string[]; paths: string[] }

/** A finder's `rg` search as allowlisted arguments; any other option is refused, never run. */
export function graphSearchPlan(search: string): GraphSearchPlan | { refused: string } {
  const words = graphShellWords(search)
  if (!Array.isArray(words)) {
    return words
  }
  if (words[0] !== 'rg') {
    return { refused: 'it is not an rg search' }
  }
  const plan: GraphSearchPlan = { options: [], patterns: [], paths: [] }
  const positional: string[] = []
  const value = (flag: string, given: string) => {
    const to = VALUED[flag]
    if (to === '-e') {
      plan.patterns.push(given)
    } else if (to) {
      plan.options.push(to, given)
    }
  }
  for (let at = 1; at < words.length; at++) {
    const word = words[at]!
    if (word === '--') {
      positional.push(...words.slice(at + 1))
      break
    }
    if (word.startsWith('--')) {
      const [flag, inline] = word.split(/=(.*)/s) as [string, string | undefined]
      if (flag in VALUED) {
        const given = inline ?? words[++at]
        if (given === undefined) {
          return { refused: `${flag} has no value` }
        }
        value(flag, given)
      } else if (MATCHING[flag] && inline === undefined) {
        plan.options.push(MATCHING[flag]!)
      } else if (!SHAPE_LONG.has(flag)) {
        return { refused: `the app does not re-run ${flag}` }
      }
      continue
    }
    if (word.startsWith('-') && word.length > 1) {
      for (let index = 1; index < word.length; index++) {
        const char = word[index]!
        if (char in VALUED) {
          const given = word.slice(index + 1) || words[++at]
          if (given === undefined) {
            return { refused: `-${char} has no value` }
          }
          value(char, given)
          break
        }
        if (MATCHING[char]) {
          plan.options.push(MATCHING[char]!)
        } else if (!SHAPE.has(char)) {
          return { refused: `the app does not re-run -${char}` }
        }
      }
      continue
    }
    positional.push(word)
  }
  if (!plan.patterns.length) {
    const pattern = positional.shift()
    if (pattern === undefined) {
      return { refused: 'it has no pattern' }
    }
    plan.patterns.push(pattern)
  }
  plan.paths = positional
  return plan
}

/** A path inside the workspace that exists; why not otherwise. */
async function searchPathError(root: string, path: string): Promise<string | undefined> {
  const rel = relative(resolve(root), resolve(root, path))
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return `${path} is outside the workspace`
  }
  if (!rel || (await resolveInsideWorkspace(root, path))) {
    return undefined
  }
  const exists = await lstat(resolve(root, path)).then(
    () => true,
    () => false
  )
  return exists ? `${path} leads outside the workspace` : `${path} is not in the workspace`
}

const BASE_ARGS = ['--no-config', '--color', 'never', '--path-separator', '/']

/** Runs a finder's search the way it was written, inside the workspace; a hit is `path:line`. */
export async function runGraphSearch(
  search: string,
  root: string,
  run: GraphSearchRun = runProcess
): Promise<GraphSearchCheck> {
  const plan = graphSearchPlan(search)
  if ('refused' in plan) {
    return { search, error: plan.refused }
  }
  for (const path of plan.paths) {
    const error = await searchPathError(root, path)
    if (error) {
      return { search, error }
    }
  }
  const args = [
    ...BASE_ARGS,
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--max-count',
    String(MAX_HITS),
    ...plan.options,
    ...plan.patterns.flatMap((pattern) => ['-e', pattern]),
    '--',
    ...(plan.paths.length ? plan.paths : ['.'])
  ]
  try {
    const result = await run({
      program: 'rg',
      args,
      cwd: root,
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxOutputBytes: SEARCH_OUTPUT_BYTES
    })
    const rows = result.stdout.split('\n').filter((row) => /^.+?:\d+:/.test(row))
    if (result.timedOut) {
      return { search, error: `it took over ${SEARCH_TIMEOUT_MS / 1000} s` }
    }
    // rg exits 2 on an error even after a match; a match still answers the claim.
    if (!rows.length && result.code !== 1) {
      return { search, error: result.stderr.trim().split('\n')[0]?.slice(0, 200) || 'rg failed' }
    }
    const hits = rows
      .slice(0, MAX_HITS)
      .map((row) => /^(.+?:\d+):/.exec(row)![1]!.replace(/^\.\//, ''))
    return {
      search,
      hits,
      ...(rows.length > MAX_HITS || result.stdoutTruncated ? { more: true as const } : {})
    }
  } catch {
    return { search, error: 'ripgrep (rg) could not be started' }
  }
}

/** Every file rg sees in the workspace, hidden ones too; undefined when the list is not whole. */
export async function listGraphWorkspaceFiles(
  root: string,
  run: GraphSearchRun = runProcess
): Promise<string[] | undefined> {
  try {
    const result = await run({
      program: 'rg',
      args: [...BASE_ARGS, '--files', '--hidden', '--glob', '!.git'],
      cwd: root,
      timeoutMs: LIST_TIMEOUT_MS,
      maxOutputBytes: LIST_OUTPUT_BYTES
    })
    return result.code === 0 && !result.timedOut && !result.stdoutTruncated
      ? result.stdout.split('\n').filter(Boolean)
      : undefined
  } catch {
    return undefined
  }
}

/** Looks for one line of a quote anywhere in the workspace: the files holding it, or undefined. */
export async function findGraphQuote(
  probe: string,
  root: string,
  run: GraphSearchRun = runProcess
): Promise<string[] | undefined> {
  try {
    const result = await run({
      program: 'rg',
      args: [...BASE_ARGS, '--files-with-matches', '--fixed-strings', '-e', probe, '--', '.'],
      cwd: root,
      timeoutMs: SEARCH_TIMEOUT_MS,
      maxOutputBytes: SEARCH_OUTPUT_BYTES
    })
    if (result.code === 1 && !result.timedOut) {
      return []
    }
    const files = result.stdout.split('\n').filter(Boolean)
    return result.code === 0 && files.length
      ? files.map((file) => file.replace(/^\.\//, ''))
      : undefined
  } catch {
    return undefined
  }
}
