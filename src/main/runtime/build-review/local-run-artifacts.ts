import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { SESSION_CHAIN_OUTPUT_ROOT } from '../../../shared/session-chain-types'
import { listSessionChainOutputFiles } from '../rpc/methods/session-chains'
import { localRunNodeOutputDir } from './local-run-placement'

/** A report bigger than this is summarised by its head; the file itself stays on disk. */
export const LOCAL_RUN_REPORT_MAX_BYTES = 256 * 1024

export type LocalRunArtifacts = {
  outputDir: string
  manifestPath: string
  /** Every file the node produced in its output folder, absolute, sorted. */
  producedFiles: string[]
  producedFilesTruncated: boolean
  /** The report text the next node is handed. */
  text: string
  source: 'report-file' | 'report-body' | 'none'
  /** Why the report file was not used, when it was not. */
  refusal?: string
}

function readCapped(path: string): { text: string; truncated: boolean } | null {
  try {
    const size = statSync(path).size
    const buffer = readFileSync(path)
    const slice = buffer.subarray(0, LOCAL_RUN_REPORT_MAX_BYTES)
    return { text: slice.toString('utf8'), truncated: size > LOCAL_RUN_REPORT_MAX_BYTES }
  } catch {
    return null
  }
}

/**
 * Read one node's report, mechanically.
 *
 * The runner dictated the path, so anything else the worker reported is not trusted:
 * a path that resolves outside the workspace is refused and the worker's own report
 * body is used instead. Inlined text is capped so one runaway file cannot be pasted
 * into the next worker's prompt.
 */
export function readLocalRunReport(args: {
  workspacePath: string
  runId: string
  taskId: string
  /** What the worker said its report path was; may be absent, relative or wrong. */
  reportedPath: string | null
  /** The worker_done body, used when the file cannot be read. */
  reportBody: string | null
}): LocalRunArtifacts {
  const workspaceRoot = resolve(args.workspacePath)
  const outputDir = localRunNodeOutputDir(workspaceRoot, args.runId, args.taskId)
  const manifestPath = join(outputDir, 'manifest.md')
  const listing = listSessionChainOutputFiles({
    workspacePath: workspaceRoot,
    chainId: args.runId,
    stepId: args.taskId
  })
  const base: Omit<LocalRunArtifacts, 'text' | 'source' | 'refusal'> = {
    outputDir,
    manifestPath,
    producedFiles: listing.files,
    producedFilesTruncated: listing.truncated
  }
  const dictated = join(
    workspaceRoot,
    ...SESSION_CHAIN_OUTPUT_ROOT.split('/'),
    args.runId,
    `${args.taskId}.md`
  )
  const candidate = args.reportedPath?.trim()
    ? isAbsolute(args.reportedPath.trim())
      ? resolve(args.reportedPath.trim())
      : resolve(workspaceRoot, args.reportedPath.trim())
    : dictated
  const rel = relative(workspaceRoot, candidate)
  if (rel.startsWith('..') || rel.split(sep).includes('..') || isAbsolute(rel)) {
    return {
      ...base,
      text: args.reportBody ?? '',
      source: args.reportBody ? 'report-body' : 'none',
      refusal: 'The reported artifact path resolved outside the workspace and was not read.'
    }
  }
  const read = readCapped(candidate)
  if (!read) {
    return {
      ...base,
      text: args.reportBody ?? '',
      source: args.reportBody ? 'report-body' : 'none',
      refusal: `The report file ${candidate} could not be read.`
    }
  }
  return {
    ...base,
    text: read.truncated
      ? `${read.text}\n\n[truncated at ${LOCAL_RUN_REPORT_MAX_BYTES} bytes; the full report is at ${candidate}]`
      : read.text,
    source: 'report-file'
  }
}

/** Create the Run's output root and, in a repository, keep it out of the diff. */
export function prepareLocalRunOutputRoot(args: {
  workspacePath: string
  runId: string
  hasRepository: boolean
}): string {
  const root = join(args.workspacePath, ...SESSION_CHAIN_OUTPUT_ROOT.split('/'), args.runId)
  mkdirSync(root, { recursive: true })
  if (!args.hasRepository) {
    return root
  }
  // Why: only when a repository exists, and only for the run outputs — the rest of
  // `.omni` is the workspace's own convention and is not this runner's to ignore.
  const ignorePath = join(args.workspacePath, '.omni', '.gitignore')
  if (!existsSync(ignorePath)) {
    mkdirSync(join(args.workspacePath, '.omni'), { recursive: true })
    writeFileSync(ignorePath, 'runs/\n', 'utf8')
  }
  return root
}
