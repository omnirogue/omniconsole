/**
 * `session find-owner` over past work: conversations `session search` finds (by what was said and
 * by topic) that no live session holds: archived (by hand or automatically), exited, or closed. JEV
 * judges them like live ones; unsure is not related. They decide only where no live session does:
 * a live duplicate or file-conflict owner, and a free live owner, win (equally related → live).
 */

import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import { sessionManageHostKey } from '../../shared/session-manage-query'
import type { SessionManageEntry } from '../../shared/session-manage-types'
import {
  SESSION_OWNER_RELATED_MIN,
  type SessionFindOwnerResult,
  type SessionOwnerPastCandidate,
  type SessionOwnerPastKind
} from '../../shared/session-owner-types'
import {
  formatSessionReference,
  isSessionReferenceAgent,
  rowsForSessionReference,
  type SessionReference
} from '../../shared/session-reference'
import type { SessionSearchHit } from '../../shared/session-search-types'
import { findSessionOwner, type SessionOwnerDeps } from './session-manage-owner'
import type { SessionOwnerJudgement } from './session-manage-owner-jev'

/** Past conversations located and sent to JEV per request, strongest search hits first. */
export const SESSION_OWNER_MAX_PAST_JUDGED = 3

export type SessionOwnerPastDeps = {
  /** The row as `session list` observes it now (archived and exited rows too). */
  observe(row: SessionManageSidebarRow): Promise<SessionManageEntry>
  /** Whether the person deleted or hid a conversation no row lists; null when the window can't say. */
  organization(reference: SessionReference): Promise<{ deleted: boolean; hidden: boolean } | null>
  /** Its goal line, read from the first genuine prompt of its transcript. */
  goal(hit: SessionSearchHit): Promise<string | null>
  judge(
    task: string,
    session: { title: string; goal: string | null; summary: string | null }
  ): Promise<SessionOwnerJudgement | { failed: string }>
}

type Unchecked = SessionFindOwnerResult['unchecked'][number]

const URL = /https?:\/\/[^\s)>\]]+/g

/** The output links the index recorded, which it adds to the summary as "Outputs: …". */
export function sessionOwnerPastLinks(summary: string | null): string[] {
  const outputs = summary?.split('\n').find((line) => /^\s*Outputs?:/i.test(line))
  return [...new Set((outputs ?? '').match(URL) ?? [])]
}

type Located = {
  hit: SessionSearchHit
  reference: SessionReference
  kind: SessionOwnerPastKind
  row: SessionManageSidebarRow | null
}

/** Where each local hit is now; live ones are the live search's, and odd ones are unchecked. */
async function locate(
  hits: readonly SessionSearchHit[],
  rows: readonly SessionManageSidebarRow[],
  exclude: ReadonlySet<string>,
  deps: SessionOwnerPastDeps,
  unchecked: Unchecked[]
): Promise<Located[]> {
  const located: Located[] = []
  const seen = new Set<string>()
  for (const hit of hits) {
    // Why stop: hits are ranked, and only the judged few can decide; the rest cost row reads.
    if (located.length >= SESSION_OWNER_MAX_PAST_JUDGED) {
      break
    }
    const hostId = sessionManageHostKey(hit.executionHostId)
    if (hostId !== 'local' || !isSessionReferenceAgent(hit.agent)) {
      continue
    }
    const reference: SessionReference = { agent: hit.agent, sessionId: hit.sessionId, hostId }
    const ref = formatSessionReference(reference)
    if (seen.has(ref)) {
      continue
    }
    seen.add(ref)
    const holding = rowsForSessionReference(
      { ...reference, transcriptPath: hit.transcriptPath },
      rows.filter((row) => row.paneKey !== null && !row.folded)
    )
    if (holding.some((row) => exclude.has(row.paneKey!))) {
      continue
    }
    if (holding.length > 1) {
      unchecked.push({
        paneKey: null,
        title: hit.title,
        reason: `${ref} is held by ${holding.length} rows`
      })
      continue
    }
    const row = holding[0] ?? null
    if (!row) {
      const filed = await deps.organization(reference).catch(() => null)
      if (!filed) {
        unchecked.push({
          paneKey: null,
          title: hit.title,
          reason: 'the window could not say whether the person deleted or hid it'
        })
      } else if (!filed.deleted && !filed.hidden) {
        located.push({ hit, reference, kind: 'closed', row })
      }
      continue
    }
    const entry = await deps.observe(row)
    if (
      entry.verdict === 'unverifiable' ||
      (entry.verdict === 'live' && entry.state === 'unknown')
    ) {
      if (row.archived) {
        unchecked.push({ paneKey: row.paneKey, title: entry.title, reason: 'its state is unknown' })
      }
      continue
    }
    if (row.archived) {
      located.push({ hit, reference, kind: 'archived', row })
    } else if (entry.verdict === 'exited') {
      located.push({ hit, reference, kind: 'exited', row })
    }
    // A live, unarchived row is a live candidate: `findSessionOwner` judged it already.
  }
  return located
}

const passes = (score: number | null): boolean =>
  score !== null && score >= SESSION_OWNER_RELATED_MIN

function byBest(left: SessionOwnerPastCandidate, right: SessionOwnerPastCandidate): number {
  return (
    Number(passes(right.duplicate)) - Number(passes(left.duplicate)) ||
    (right.related ?? -1) - (left.related ?? -1) ||
    (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0)
  )
}

/** The strongest few past conversations for the task, judged, best first. */
export async function sessionOwnerPastCandidates(
  input: {
    task: string
    hits: readonly SessionSearchHit[]
    rows: readonly SessionManageSidebarRow[]
    exclude: ReadonlySet<string>
  },
  deps: SessionOwnerPastDeps
): Promise<{ past: SessionOwnerPastCandidate[]; unchecked: Unchecked[]; failures: string[] }> {
  const unchecked: Unchecked[] = []
  const failures: string[] = []
  // Why only the window's new rows: without provider ids a closed tab and an open one look alike.
  if (input.rows.some((row) => !('providerSessionId' in row))) {
    return {
      past: [],
      unchecked: [
        {
          paneKey: null,
          title: 'past conversations',
          reason:
            'this window does not name each row’s provider conversation, so past work was not checked'
        }
      ],
      failures
    }
  }
  const located = await locate(input.hits, input.rows, input.exclude, deps, unchecked)
  const past = await Promise.all(
    located.map(async ({ hit, reference, kind, row }) => {
      const title = row?.title ?? hit.title
      const goal = await deps.goal(hit).catch(() => null)
      const judgement = await deps
        .judge(input.task, { title, goal, summary: hit.summary })
        .catch((error: unknown) => ({
          failed: error instanceof Error ? error.message : String(error)
        }))
      if ('failed' in judgement) {
        failures.push(judgement.failed)
      }
      const scored = 'failed' in judgement ? null : judgement
      const archiveKind = row?.archived ? (row.archiveKind ?? 'manual') : null
      return {
        ref: formatSessionReference(reference),
        kind,
        title,
        paneKey: row?.paneKey ?? null,
        archiveKind,
        cwd: hit.cwd,
        transcriptPath: hit.transcriptPath,
        lastActivityAt: hit.lastActivityAt,
        related: scored?.related ?? null,
        duplicate: scored?.duplicate ?? null,
        finished: archiveKind === 'automatic',
        links: sessionOwnerPastLinks(hit.summary),
        goal
      } satisfies SessionOwnerPastCandidate
    })
  )
  return { past: past.sort(byBest), unchecked, failures }
}

const assignByRef = (candidate: SessionOwnerPastCandidate): string =>
  `omni session assign --ref ${candidate.ref} --task "<the task>" --reason "<why this conversation>"`

/**
 * The past-work half of the decision table. A finished same deliverable is reused over anything
 * but a live duplicate; a past continuation is taken only where no live owner can take the task
 * (the live answer was busy-related, launch-new or coverage-incomplete).
 */
export function decideWithPastWork(
  live: SessionFindOwnerResult,
  past: readonly SessionOwnerPastCandidate[]
): SessionFindOwnerResult {
  const withPast = { ...live, past: [...past] }
  if (live.disposition === 'duplicate') {
    return withPast
  }
  const output = past.find((candidate) => candidate.finished && passes(candidate.duplicate))
  if (output) {
    const where = output.links.length
      ? `: ${output.links.slice(0, 3).join(' ')}`
      : ` (${output.ref})`
    // Why: a live launch recommend contradicts "launch nothing".
    const reuse: SessionFindOwnerResult = { ...withPast }
    if (live.launchNew) {
      delete reuse.recommend
    }
    return {
      ...reuse,
      disposition: 'reuse-output',
      launchNew: false,
      pastOwner: output,
      reason: `“${output.title}” already delivered this and its work was verified complete${where}. Reuse that result and point the person to it; launch nothing.`
    }
  }
  if (live.disposition === 'assign' || live.disposition === 'conflict-owner-busy') {
    return withPast
  }
  const continuation = past.find(
    (candidate) => passes(candidate.duplicate) || passes(candidate.related)
  )
  if (!continuation) {
    return withPast
  }
  const name = `“${continuation.title}”`
  // Why drop them: a busy live owner is not the one to act on when past work continues the task.
  const rest: SessionFindOwnerResult = { ...withPast }
  delete rest.owner
  delete rest.recommend
  return continuation.kind === 'archived'
    ? {
        ...rest,
        disposition: 'unarchive-and-continue',
        launchNew: false,
        pastOwner: continuation,
        reason: `${name} is archived (${continuation.archiveKind === 'automatic' ? 'filed automatically' : 'by hand'}) and this task continues its work: unarchive it and give it the task instead of launching a new session.`,
        recommend: assignByRef(continuation)
      }
    : {
        ...rest,
        disposition: 'resume',
        launchNew: false,
        pastOwner: continuation,
        reason: `${name} ${continuation.kind === 'exited' ? 'exited' : 'was closed'} and this task continues its work: resume it on this computer and give it the task instead of launching a new session.`,
        recommend: assignByRef(continuation)
      }
}

/**
 * `findSessionOwner`, then past work from the same search: one search, a bounded JEV budget, and
 * no past lookup at all when a live session already does the task.
 */
export async function findSessionOwnerWithPastWork(
  input: Parameters<typeof findSessionOwner>[0] & { rows: readonly SessionManageSidebarRow[] },
  deps: SessionOwnerDeps & { past: SessionOwnerPastDeps }
): Promise<SessionFindOwnerResult> {
  let searched: ReturnType<SessionOwnerDeps['search']> | null = null
  const search: SessionOwnerDeps['search'] = (task) => (searched ??= deps.search(task))
  const live = await findSessionOwner(input, { ...deps, search })
  if (live.disposition === 'duplicate') {
    return { ...live, past: [] }
  }
  const { hits = [] } = await search(input.task)
  const found = await sessionOwnerPastCandidates(
    { task: input.task, hits, rows: input.rows, exclude: input.exclude ?? new Set() },
    deps.past
  )
  const decided = decideWithPastWork(live, found.past)
  const jevError = decided.jevError ?? found.failures[0]
  return {
    ...decided,
    unchecked: [...decided.unchecked, ...found.unchecked],
    ...(jevError ? { jevError } : {})
  }
}
