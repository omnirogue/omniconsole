/**
 * `omni session assign --ref`: give a task to the past conversation `find-owner` named. An archived
 * one is unarchived (the recorded organization change, keep-visible like the row's Unarchive); an
 * exited or closed one is resumed on this computer (`session resume`); then the task goes through
 * `session assign`, as the first prompt of a just-resumed conversation when it was reopened.
 * Nothing changes for a live row that is busy: hold the task (`--when-idle`) instead.
 */

import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import type {
  SessionManageActionResult,
  SessionManageEntry
} from '../../shared/session-manage-types'
import {
  parseSessionReference,
  rowsForSessionReference,
  type SessionReference
} from '../../shared/session-reference'
import type { SessionResumeResult } from '../../shared/session-resume-types'
import { sessionOwnerLoad } from './session-manage-owner-load'
import { SessionManagePartialError, SessionManageRefusal } from './session-manage-refusal'

/** How long a reopened conversation may take to read as free before the task is given up. */
export const ASSIGN_AFTER_RESUME_WAIT_MS = 45_000
const POLL_MS = 1_500

export type AssignRefDeps = {
  readRows(): Promise<SessionManageSidebarRow[]>
  observe(row: SessionManageSidebarRow): Promise<{ entry: SessionManageEntry; bound: boolean }>
  /** `session archive --unarchive` for this row, through the organization change path. */
  unarchive(row: SessionManageSidebarRow, dryRun: boolean): Promise<{ summary: string }>
  resume(dryRun: boolean): Promise<SessionResumeResult>
  /** `session assign` on this pane; `firstTurn` when the host has not watched it reply yet. */
  assign(
    paneKey: string,
    options: { firstTurn: boolean; dryRun: boolean }
  ): Promise<{ result: SessionManageActionResult; entryId?: string }>
  sleep(ms: number): Promise<void>
  now(): number
}

export type AssignRefResult = {
  result: SessionManageActionResult & { ref: string; steps: string[] }
  entryId?: string
}

function refuse(message: string): never {
  throw new SessionManageRefusal(`${message} Nothing changed.`)
}

function holding(
  reference: SessionReference,
  rows: readonly SessionManageSidebarRow[]
): SessionManageSidebarRow[] {
  return rowsForSessionReference(
    reference,
    rows.filter((row) => row.paneKey !== null && !row.folded)
  )
}

/** The one live, free row holding it once it reopened; the reason when there is none in time. */
async function waitUntilFree(
  deps: AssignRefDeps,
  reference: SessionReference
): Promise<{ paneKey: string } | { waiting: string }> {
  const deadline = deps.now() + ASSIGN_AFTER_RESUME_WAIT_MS
  let waiting = 'no sidebar row holds it yet'
  for (;;) {
    const rows = holding(reference, await deps.readRows())
    const live: { row: SessionManageSidebarRow; words: string; light: boolean }[] = []
    for (const row of rows.filter((entry) => !entry.archived)) {
      const { entry, bound } = await deps.observe(row)
      if (entry.verdict === 'live') {
        live.push({ row, ...sessionOwnerLoad(entry, bound) })
      }
    }
    if (live.length === 1 && live[0]!.light) {
      return { paneKey: live[0]!.row.paneKey! }
    }
    waiting =
      live.length > 1 ? `${live.length} panes hold it` : (live[0]?.words ?? 'it is not live yet')
    if (deps.now() >= deadline) {
      return { waiting }
    }
    await deps.sleep(POLL_MS)
  }
}

export async function assignByRef(
  deps: AssignRefDeps,
  input: { ref: string; dryRun: boolean }
): Promise<AssignRefResult> {
  const reference = parseSessionReference(input.ref)
  if (!reference) {
    refuse(`${input.ref} is not a session reference (<claude|codex>:<id>@<host>).`)
  }
  if (reference.hostId !== 'local') {
    refuse(
      `${input.ref} lives on ${reference.hostId}, not this computer; a conversation there cannot be resumed or given a task from here yet.`
    )
  }
  const rows = holding(reference, await deps.readRows())
  if (rows.length > 1) {
    refuse(
      `${input.ref} is held by ${rows.length} sidebar rows (${rows.map((row) => row.paneKey).join(', ')}); name one with --pane.`
    )
  }
  const row = rows[0] ?? null
  const observed = row ? await deps.observe(row) : null
  const live = observed?.entry.verdict === 'live'
  if (
    observed &&
    (observed.entry.verdict === 'unverifiable' || observed.entry.state === 'unknown')
  ) {
    refuse(
      `“${observed.entry.title}” cannot be verified (${observed.entry.waitingOn ?? 'unknown'}).`
    )
  }
  if (observed && live) {
    const load = sessionOwnerLoad(observed.entry, observed.bound)
    if (!load.light) {
      refuse(
        `“${observed.entry.title}” is busy (${load.words}). Hold the task for it instead: omni session assign --ref ${input.ref} --task "<the task>" --when-idle --reason "<why>"`
      )
    }
  }
  const steps: string[] = []
  if (row?.archived) {
    steps.push((await deps.unarchive(row, input.dryRun)).summary)
  }
  const partial = (message: string): never => {
    if (steps.length === 0 || input.dryRun) {
      refuse(message)
    }
    throw new SessionManagePartialError(`${message} Nothing was sent.`, steps.join('; '))
  }
  let paneKey = live ? row!.paneKey! : null
  let firstTurn = false
  if (!live) {
    let resumed: SessionResumeResult
    try {
      resumed = await deps.resume(input.dryRun)
    } catch (error) {
      if (error instanceof SessionManagePartialError || steps.length === 0) {
        throw error
      }
      return partial(error instanceof Error ? error.message : String(error))
    }
    steps.push(resumed.summary)
    if (input.dryRun) {
      return {
        result: {
          dryRun: true,
          action: 'assign',
          target: { paneKey: row?.paneKey ?? null, title: row?.title ?? input.ref },
          actor: resumed.actor,
          ref: input.ref,
          steps,
          summary: `${steps.join(' ')} Then it would be given the task once it reads as free (dry run: nothing changed).`
        }
      }
    }
    const free = await waitUntilFree(deps, reference)
    if ('waiting' in free) {
      return partial(
        `It reopened, but did not read as free within ${ASSIGN_AFTER_RESUME_WAIT_MS / 1000} s (${free.waiting}), so the task was not given. Send it when it is: omni session assign --ref ${input.ref} --task "<the task>" --reason "<why>"`
      )
    }
    paneKey = free.paneKey
    // Why unconfirmed too: it read live and free in the window just now, so its reply is the first.
    firstTurn =
      resumed.outcome === 'resumed' ||
      resumed.outcome === 'restarted' ||
      resumed.outcome === 'started_unconfirmed'
  }
  try {
    const assigned = await deps.assign(paneKey!, { firstTurn, dryRun: input.dryRun })
    return {
      ...assigned,
      result: {
        ...assigned.result,
        ref: input.ref,
        steps: [...steps, assigned.result.summary],
        summary: [...steps, assigned.result.summary].join(' ')
      }
    }
  } catch (error) {
    if (error instanceof SessionManagePartialError || steps.length === 0 || input.dryRun) {
      throw error
    }
    return partial(error instanceof Error ? error.message : String(error))
  }
}
