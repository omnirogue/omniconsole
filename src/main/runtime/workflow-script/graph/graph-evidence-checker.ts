import { createHash } from 'node:crypto'
import { checkGraphEvidence, type GraphEvidenceCheck } from './graph-evidence-check'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall, GraphOutcome } from './graph-plan-types'
import type { GraphPreVerify } from './graph-pre-verify'
import { checkGraphPreVerify } from './graph-pre-verify-check'

export type GraphEvidenceCheckerOptions = {
  store: GraphJevStore
  /** The verified workspace folder; a refusal marks every quote as not read. */
  workspace?: () => Promise<string>
  /** Only what the store already holds: recovery replays checks and never reads a file. */
  cacheOnly?: boolean
  log?: (message: string) => void
  check?: typeof checkGraphEvidence
  preVerify?: typeof checkGraphPreVerify
}

function evidenceMarkdown(
  checks: Record<string, GraphEvidenceCheck>,
  refused?: string,
  preVerify?: Record<string, GraphPreVerify>
): string {
  const count = (status: GraphEvidenceCheck['status']) =>
    Object.values(checks).filter((check) => check.status === status).length
  const verified = Object.values(preVerify ?? {})
  const dropped = verified.filter((check) => check.dropped).length
  const flagged = verified.filter((check) => !check.dropped && check.flags.length).length
  return [
    `Quotes checked in the files: ${count('found')} found at their line, ${count('moved')} found elsewhere in the file, ${count('missing')} not found in the file, ${count('unreadable')} in files that could not be read.`,
    ...(preVerify
      ? [
          `Citations and absence searches checked before review: ${verified.length} results, ${dropped} dropped (no file they cite exists), ${flagged} flagged for the reviewers.`
        ]
      : []),
    ...(refused ? [`The workspace could not be read: ${refused}`] : [])
  ].join('\n')
}

/** Checked once and kept, so a replay sees the same result and never reads the files again. */
export function createGraphEvidenceChecker(options: GraphEvidenceCheckerOptions) {
  return async (call: GraphCall): Promise<GraphOutcome> => {
    const request = call.evidence!
    const digest = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const stored = options.store.read(call.id)
    if (stored && stored.digest === digest) {
      return stored.outcome
    }
    if (options.cacheOnly) {
      throw new Error(`Evidence check is not recorded: ${call.id}`)
    }
    let root: string | null = null
    let refused: string | undefined = 'this run has no workspace folder'
    try {
      root = options.workspace ? await options.workspace() : null
      refused = root ? undefined : refused
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    const quoted = await (options.check ?? checkGraphEvidence)(request, root)
    const verified =
      request.preVerify?.length && root
        ? await (options.preVerify ?? checkGraphPreVerify)(request, root, quoted)
        : undefined
    const checks = verified?.checks ?? quoted
    const outcome: GraphOutcome = {
      value: {
        markdown: evidenceMarkdown(checks, refused, verified?.preVerify),
        checks,
        ...(verified ? { preVerify: verified.preVerify } : {}),
        ...(refused ? { error: refused } : {})
      }
    }
    try {
      options.store.write(call.id, {
        digest,
        outcome,
        ...(refused ? { detail: refused } : {}),
        at: Date.now()
      })
    } catch (error) {
      const gap = `Evidence checks could not be saved: ${error instanceof Error ? error.message : String(error)}`
      options.log?.(gap)
      return { value: { ...(outcome as { value: object }).value, error: gap } }
    }
    if (refused) {
      options.log?.(`The finders' quotes could not be checked: ${refused}`)
    }
    return outcome
  }
}

/** One run's evidence checker; its record file is opened only when a check actually comes. */
export function graphEvidenceCheckerForExecution(
  executionId: string,
  options: Omit<GraphEvidenceCheckerOptions, 'store'> = {}
): (call: GraphCall) => Promise<GraphOutcome> {
  let checker: ((call: GraphCall) => Promise<GraphOutcome>) | undefined
  return (call) => {
    checker ??= createGraphEvidenceChecker({
      ...options,
      store: GraphJevStore.forExecution(executionId, undefined, 'evidence.json')
    })
    return checker(call)
  }
}
