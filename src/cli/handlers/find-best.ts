/**
 * `omni find-best` — Find the best from a terminal, or from an agent working in a chat.
 *
 * The app owns workflow conversations, so the command asks the window to open a Find the best
 * conversation and start it (local-workflow-cli-run.ts, shared with `omni workflow run`), then
 * follows the run through the ordinary reads. Progress goes to stderr and the
 * report to stdout, so the report can be piped.
 */

import { parseFindScan, scanFormat } from '../../shared/workflow-find-scan'
import type { FindImportReceipt, WorkflowFindItem } from '../../shared/workflow-graph'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { findFollowLine, findResultJson, findResultText } from '../find-best-format'
import { followLocalWorkflow, startLocalWorkflowFromCli } from '../local-workflow-cli-run'
import { RuntimeClientError } from '../runtime-client'
import { workflowRun } from './workflow-run'
import {
  localWorkflowFindRequestSchema,
  type LocalWorkflowFindRequest
} from '../../shared/local-workflow-find-request'
import { LOCAL_WORKFLOW_METHODS } from '../../shared/local-workflow-rpc'

type Flags = Map<string, string | boolean>

const MAX_LIST_BYTES = 1024 * 1024

function text(flags: Flags, name: string): string | undefined {
  const value = flags.get(name)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function whole(flags: Flags, name: string): number | undefined {
  const value = text(flags, name)
  if (value === undefined) {
    return undefined
  }
  if (!/^\d+$/.test(value)) {
    throw new RuntimeClientError('invalid_argument', `--${name} takes a whole number.`)
  }
  return Number(value)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    bytes += buffer.length
    if (bytes > MAX_LIST_BYTES) {
      throw new RuntimeClientError('invalid_argument', 'The list is larger than 1 MB.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Opens the path once, refuses anything but a real file, and never reads past the byte limit. */
async function readListFile(path: string, flag = 'list'): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
    if (!(await handle.stat()).isFile()) {
      throw new Error('it is not a regular file')
    }
    // Read one byte past the limit so an oversized file is refused, never silently truncated.
    const buffer = Buffer.alloc(MAX_LIST_BYTES + 1)
    let read = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, null)
      if (bytesRead === 0) {
        break
      }
      read += bytesRead
      if (read > MAX_LIST_BYTES) {
        throw new Error('it is larger than 1 MB')
      }
    }
    return buffer.subarray(0, read).toString('utf8')
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'there is no such file'
        : error instanceof Error
          ? error.message
          : String(error)
    throw new RuntimeClientError(
      'invalid_argument',
      `--${flag}: could not read ${path}: ${reason}.`
    )
  } finally {
    await handle?.close()
  }
}

/** One option per line, from a file or from stdin (`-`); blank lines are skipped. */
async function readList(source: string, cwd: string): Promise<string[]> {
  const raw = source === '-' ? await readStdin() : await readListFile(resolve(cwd, source))
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** The request the flags describe, checked here so a mistake is named before anything starts. */
export function findRequestFromFlags(
  flags: Flags,
  items?: WorkflowFindItem[],
  importReceipt?: FindImportReceipt
): LocalWorkflowFindRequest {
  validateFindSources(flags)
  const versions = whole(flags, 'versions')
  if (items && versions !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--list and --versions do not go together: a list is judged as given.'
    )
  }
  const parsed = localWorkflowFindRequestSchema.safeParse({
    prompt: text(flags, 'prompt') ?? '',
    ...(items ? { items } : {}),
    ...(items && importReceipt ? { importReceipt } : {}),
    ...(versions !== undefined ? { versions: true, count: versions } : {}),
    ...(versions === undefined && whole(flags, 'count') !== undefined
      ? { count: whole(flags, 'count') }
      : {}),
    ...(whole(flags, 'keep') !== undefined ? { keep: whole(flags, 'keep') } : {}),
    ...(whole(flags, 'final') !== undefined ? { top: whole(flags, 'final') } : {}),
    ...(text(flags, 'rubric') ? { rubric: text(flags, 'rubric') } : {}),
    ...(text(flags, 'good') ? { good: text(flags, 'good')!.replaceAll('\\n', '\n') } : {})
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!
    const path = String(issue.path[0] ?? 'prompt')
    // The flags a person typed, not the request's own names.
    const field =
      path === 'top' ? 'final' : path === 'count' && versions !== undefined ? 'versions' : path
    throw new RuntimeClientError(
      'invalid_argument',
      field === 'prompt'
        ? 'Say what to find: omni find-best "<what to find>".'
        : `--${field === 'items' ? 'list' : field}: ${issue.message}`
    )
  }
  // The desktop's runtime socket refuses a frame over 1 MB; a --file that fits on disk can still
  // grow past that once every row is re-encoded as JSON with field names and escaping.
  const RPC_FRAME_SAFETY_MARGIN_BYTES = 8_192
  if (
    Buffer.byteLength(JSON.stringify(parsed.data)) >
    MAX_LIST_BYTES - RPC_FRAME_SAFETY_MARGIN_BYTES
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'This list is too large to send in one request once encoded; import fewer rows or shorten the detail column.'
    )
  }
  return parsed.data
}

export function validateFindSources(flags: Flags): void {
  const sources = ['list', 'file', 'versions'].filter((name) => flags.has(name))
  if (sources.length > 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `${sources.map((name) => `--${name}`).join(' and ')} do not go together: choose one source.`
    )
  }
  for (const name of sources) {
    if (!text(flags, name)) {
      throw new RuntimeClientError('invalid_argument', `--${name} needs a value.`)
    }
  }
}
const find: CommandHandler = async (ctx) => {
  validateFindSources(ctx.flags)
  const file = text(ctx.flags, 'file')
  let imported: ReturnType<typeof parseFindScan> | undefined
  if (file) {
    const raw = await readListFile(resolve(ctx.cwd, file), 'file')
    try {
      imported = parseFindScan(raw, scanFormat(file, raw))
    } catch (error) {
      throw new RuntimeClientError(
        'invalid_argument',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  if (imported) {
    process.stderr.write(
      `Imported ${imported.items.length} options; skipped ${imported.skipped} rows.\n`
    )
  }

  const list = text(ctx.flags, 'list')
  const request = findRequestFromFlags(
    ctx.flags,
    imported?.items ?? (list ? await readList(list, ctx.cwd) : undefined),
    imported?.receipt
  )
  const started = await startLocalWorkflowFromCli(ctx, LOCAL_WORKFLOW_METHODS.find, request)
  if (ctx.flags.get('no-follow') === true) {
    console.log(
      ctx.json
        ? JSON.stringify(started, null, 2)
        : `Find the best started in the app (run ${started.executionId}). Its report and results files appear there when it ends.`
    )
    return
  }
  if (!ctx.json) {
    process.stderr.write(
      'Find the best is running in the app; Ctrl-C stops following it, not the run.\n'
    )
  }
  const view = await followLocalWorkflow(ctx, started, findFollowLine)
  if (ctx.json) {
    // One document either way: a run that did not complete is reported in it, with a nonzero exit
    // and no second error document from the top-level handler (workflow-run.ts does the same).
    console.log(JSON.stringify(findResultJson(view, started), null, 2))
    if (view.state !== 'completed') {
      process.exitCode = 1
    }
    return
  }
  if (view.state === 'completed') {
    console.log(findResultText(view))
    return
  }
  throw new RuntimeClientError(
    'workflow_failed',
    view.graphRun?.find?.reason ?? view.error ?? `Find the best ended ${view.state}.`
  )
}

export const FIND_BEST_HANDLERS: Record<string, CommandHandler> = {
  'find-best': find,
  'workflow run': workflowRun
}
