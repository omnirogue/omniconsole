import { workflowTemplate } from '../../../shared/workflow-graph-templates'
import { normalizeWorkflowSpec } from '../../../shared/workflow-graph-normalize'
import { quickDiscoverWorkflow } from '../../../shared/workflow-graph-quick-discover'
import type { WorkflowRoute, WorkflowSpec } from '../../../shared/workflow-graph'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { gitExecFileAsync } from '../../git/runner'
import type { ResolvedLocalWorkflowSeat } from '../../../shared/local-workflow-seats'
import {
  quickDiscoverBudget,
  quickDiscoverOverBudgetMessage,
  quickDiscoverTokenEstimate,
  type QuickDiscoverBudget
} from '../../../shared/workflow-quick-discover-budget'
import {
  localWorkflowDirectorySkipped,
  localWorkflowFileListable,
  localWorkflowNumberedSource
} from './local-workflow-scope'
import type {
  LocalWorkflowFrozenScope,
  LocalWorkflowWorkspace
} from './local-workflow-host-options'

/** Larger files are generated or data, not code one reader should spend its context on. */
export const QUICK_DISCOVER_FILE_LIMIT = 256 * 1024
const MAX_FILES = 20_000
const MAX_SCANNED = 200_000
const LOCK_FILE =
  /^(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|go\.sum|Pipfile\.lock|poetry\.lock|uv\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock|yarn\.lock|bun\.lockb?)$/i

export type QuickDiscoverBundle = {
  /** Every file as "--- path ---" and numbered lines, the way attached files are shown. */
  evidence: string
  files: { path: string; lines: number; bytes: number }[]
  /** Listed but left out, with why (too large, not UTF-8 text, unreadable). */
  skipped: { path: string; reason: string }[]
  estimatedTokens: number
}

/** Tracked and untracked files Git does not ignore; undefined when the folder is not in Git. */
async function gitListedFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await gitExecFileAsync(
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, maxBuffer: 64 * 1024 * 1024 }
    )
    return [...new Set(stdout.split('\0').filter(Boolean))]
  } catch {
    return undefined
  }
}

/** A folder workspace without Git: every file outside skipped folders. */
async function walkedFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const pending = ['']
  let scanned = 0
  while (pending.length && found.length < MAX_FILES && scanned < MAX_SCANNED) {
    const prefix = pending.shift()!
    const entries = await readdir(join(root, prefix), { withFileTypes: true })
    for (const entry of entries) {
      scanned++
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory() && !localWorkflowDirectorySkipped(entry.name)) {
        pending.push(path)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        found.push(path)
      }
    }
  }
  if (pending.length || scanned >= MAX_SCANNED || found.length >= MAX_FILES) {
    throw new Error('Quick Discover file scan hit its cap; choose a smaller scope or run Discover.')
  }
  return found
}

/** Source a reader should see: no vendored, build or dot folders, secrets, locks or non-text. */
export function quickDiscoverIncludesPath(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1)!
  return (
    parts.slice(0, -1).every((part) => !localWorkflowDirectorySkipped(part)) &&
    localWorkflowFileListable(name) &&
    !LOCK_FILE.test(name)
  )
}

/** A chosen file matches itself; a chosen folder ("dir/") matches everything under it. */
function inScope(path: string, scopeIds: readonly string[]): boolean {
  return (
    !scopeIds.length ||
    scopeIds.some((id) => (id.endsWith('/') ? path.startsWith(id) : path === id))
  )
}

/**
 * Collects the workspace's source (or the chosen files and folders) into one prompt, respecting
 * .gitignore, and refuses when it would take more than the seat's budget: never cut, never chunked.
 */
export async function bundleQuickDiscoverScope(input: {
  root: string
  scopeIds: readonly string[]
  budget: QuickDiscoverBudget
  /** The rest of the prompt (goal and instructions), counted against the same budget. */
  promptChars: number
  /** Tests list files without Git. */
  listFiles?: (root: string) => Promise<string[] | undefined>
}): Promise<QuickDiscoverBundle> {
  const root = await realpath(input.root)
  const listed = (await (input.listFiles ?? gitListedFiles)(root)) ?? (await walkedFiles(root))
  const paths = listed
    .filter((path) => quickDiscoverIncludesPath(path) && inScope(path, input.scopeIds))
    .sort((left, right) => left.localeCompare(right))

  if (paths.length > MAX_FILES) {
    throw new Error('Quick Discover file list hit its cap; choose a smaller scope or run Discover.')
  }
  const parts: string[] = []
  const files: QuickDiscoverBundle['files'] = []
  const skipped: QuickDiscoverBundle['skipped'] = []
  let chars = input.promptChars
  for (const path of paths) {
    const absolute = join(root, ...path.split('/'))
    try {
      const stat = await lstat(absolute)
      if (!stat.isFile()) {
        skipped.push({ path, reason: 'not a regular file' })
        continue
      }
      if (stat.size > QUICK_DISCOVER_FILE_LIMIT) {
        skipped.push({ path, reason: `larger than ${QUICK_DISCOVER_FILE_LIMIT} bytes` })
        continue
      }
      // Past the budget only sizes are summed, for the refusal's estimate.
      if (quickDiscoverTokenEstimate(chars) > input.budget.budgetTokens) {
        chars += stat.size
        continue
      }
      const bytes = await readFile(absolute)
      const text = bytes.toString('utf8')
      if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes)) {
        skipped.push({ path, reason: 'not UTF-8 text' })
        continue
      }
      const part = `\n--- ${path} ---\n${localWorkflowNumberedSource(text)}\n`
      chars += part.length
      parts.push(part)
      files.push({
        path,
        lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
        bytes: bytes.length
      })
    } catch {
      skipped.push({ path, reason: 'could not be read' })
    }
  }
  const estimatedTokens = quickDiscoverTokenEstimate(chars)
  if (estimatedTokens > input.budget.budgetTokens) {
    throw new Error(quickDiscoverOverBudgetMessage(estimatedTokens, input.budget))
  }
  if (!files.length) {
    throw new Error(
      'Quick Discover found no source files to read in this scope (ignored, vendored, build, lock and binary files are left out).'
    )
  }
  return { evidence: parts.join(''), files, skipped, estimatedTokens }
}

/**
 * Graph admission for Quick Discover: the frozen scope is the bundle, sized against the reader
 * seat's own context window. Files are read where the app runs, so the workspace must run here.
 */
export async function admitQuickDiscoverScope(input: {
  workspace: LocalWorkflowWorkspace
  scopeIds: readonly string[]
  /** The find step's seat; absent when an override removed that step. */
  seat: ResolvedLocalWorkflowSeat | undefined
  promptChars: number
}): Promise<LocalWorkflowFrozenScope> {
  if (!input.seat) {
    throw new Error('Quick Discover needs its "find" step, the one call that reads the scope.')
  }
  if (input.workspace.executionHost !== 'local') {
    throw new Error('Quick Discover reads the files on this computer: choose a local workspace.')
  }
  const bundle = await bundleQuickDiscoverScope({
    root: input.workspace.path,
    scopeIds: input.scopeIds,
    budget: quickDiscoverBudget(input.seat.agent, input.seat.model),
    promptChars: input.promptChars
  })
  if (bundle.skipped.length) {
    throw new Error(
      `Quick Discover could not read the whole scope: ${bundle.skipped.map((file) => `${file.path} (${file.reason})`).join('; ')}. Choose a smaller scope or run Discover.`
    )
  }
  return {
    evidence: bundle.evidence,
    sources: bundle.files.map((file) => ({
      ref: file.path,
      description: `${file.path} (${file.lines} ${file.lines === 1 ? 'line' : 'lines'})`
    })),
    coverage: bundle.files.map((file) => file.path)
  }
}

/** An unchanged Discover selection can use the whole-scope reader with an independent verifier. */
export function quickDiscoverSelection(
  spec: WorkflowSpec,
  available: readonly WorkflowRoute[]
): WorkflowSpec | undefined {
  const depth = spec.repeat ? 'thorough' : 'quick'
  const original = workflowTemplate('discover', available, { depth })
  if (JSON.stringify(spec) !== JSON.stringify(original)) {
    return undefined
  }
  const quick = normalizeWorkflowSpec(quickDiscoverWorkflow(available, true), available)
  return quick.steps.some((step) => step.kind === 'review') ? quick : undefined
}
