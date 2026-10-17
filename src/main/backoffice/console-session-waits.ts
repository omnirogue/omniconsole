import { z } from 'zod'
import type { SessionChain } from '../../shared/session-chain-types'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  sessionOutcomeWaitsSummary,
  sessionWaitsFingerprint,
  type SessionWaitSummaryItem
} from '../../shared/session-outcome-waits-summary'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'
import { consoleSessionDetail, consoleSessionRow } from './console-jira-session'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import { requestConsoleWorkflow as request } from './console-workflow-transport'

/** The last list omnios accepted per plan, so a 30 s check that changed nothing writes nothing. */
const published = new Map<string, { fingerprint: string; waits: SessionWaitSummaryItem[] }>()
/** When a list whose only change is waits turning `unavailable` was first seen, per plan. */
const flippedSince = new Map<string, { fingerprint: string; at: number }>()
/** An omnios redeploy reads as `unavailable` for about a minute; each write flags the digest. */
const AVAILABILITY_SETTLE_MS = 120_000
/** One write per plan at a time: a later save waits for the earlier one instead of racing it. */
const inFlight = new Map<string, Promise<void>>()

const EMPTY_SUMMARY = {
  version: 1 as const,
  visibility: 'private' as const,
  company_key: null,
  division: null,
  purpose: '',
  progress: '',
  next_action: '',
  responsible_actor: '',
  work_ref: null,
  parent_ledger_id: null,
  outcome_refs: [],
  handoff_refs: []
}

async function writeOnce(
  ledgerId: string,
  waits: ReturnType<typeof sessionOutcomeWaitsSummary>,
  principal: string,
  isCurrent: () => boolean
): Promise<ConsoleWorkflowResult<unknown>> {
  const read = await request(
    `/api/sessions/${ledgerId}`,
    'GET',
    consoleSessionDetail,
    undefined,
    15_000,
    false,
    principal,
    isCurrent
  )
  if (!read.ok) {
    return read
  }
  // Whole-summary write: every text field is copied back as it is, or omnios would blank it.
  const { revision, ...fields } = read.data.session.work_summary ?? {
    ...EMPTY_SUMMARY,
    revision: 0
  }
  return request(
    `/api/agent-sessions/${ledgerId}/register`,
    'POST',
    z.object({ ok: z.literal(true), row: consoleSessionRow }),
    { work_summary: { ...fields, expected_revision: revision, waits } },
    30_000,
    false,
    principal,
    isCurrent
  )
}

function onlyBecameUnavailable(
  before: readonly SessionWaitSummaryItem[],
  after: readonly SessionWaitSummaryItem[]
): boolean {
  return (
    before.length === after.length &&
    before.every((item, index) => {
      const { checked_at: _before, status, ...rest } = item
      const { checked_at: _after, status: next, ...nextRest } = after[index]!
      return (
        JSON.stringify(rest) === JSON.stringify(nextRest) &&
        (status === next || next === 'unavailable')
      )
    })
  )
}

/** Turning `unavailable` is written only once it has held for the settle time. */
function flipSettled(chainId: string, fingerprint: string, now: number): boolean {
  const seen = flippedSince.get(chainId)
  if (seen?.fingerprint !== fingerprint) {
    flippedSince.set(chainId, { fingerprint, at: now })
    return false
  }
  return now - seen.at >= AVAILABILITY_SETTLE_MS
}

async function publish(chain: SessionChain): Promise<void> {
  const waits = sessionOutcomeWaitsSummary(chain)
  const fingerprint = sessionWaitsFingerprint(waits)
  const last = published.get(chain.id)
  if (last?.fingerprint === fingerprint) {
    flippedSince.delete(chain.id)
    return
  }
  if (
    last &&
    onlyBecameUnavailable(last.waits, waits) &&
    !flipSettled(chain.id, fingerprint, Date.now())
  ) {
    return
  }
  const person = await captureConsoleWorkflowPerson()
  if (!person.ok) {
    return
  }
  const source = ledgerSourceForSession(chain.sourcePaneKey, person.data.principal)
  if (!source) {
    // A conversation omnios has no ledger row for (another account, a remote host) shows nothing.
    return
  }
  let saved = await writeOnce(source.ledgerId, waits, person.data.principal, person.data.isCurrent)
  if (!saved.ok && saved.error.status === 409) {
    // Someone else saved the summary in between: read it again and write once more.
    saved = await writeOnce(source.ledgerId, waits, person.data.principal, person.data.isCurrent)
  }
  if (saved.ok) {
    published.set(chain.id, { fingerprint, waits })
    flippedSince.delete(chain.id)
  } else {
    console.warn('[outcomes] omnios did not take the waits list', chain.id, saved.error.code)
  }
}

/**
 * CONTRACT.md §3: tell omnios what this session waits on, so its session detail and Decisions
 * digest show the same list. Fire and forget from the terminal writer; only a changed list writes.
 */
export function publishSessionWaits(chain: SessionChain): void {
  const previous = inFlight.get(chain.id) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => publish(chain))
    .catch((error) => console.warn('[outcomes] waits publish failed', chain.id, error))
    .finally(() => {
      if (inFlight.get(chain.id) === next) {
        inFlight.delete(chain.id)
      }
    })
  inFlight.set(chain.id, next)
}

export function resetPublishedSessionWaitsForTest(): void {
  published.clear()
  flippedSince.clear()
  inFlight.clear()
}
