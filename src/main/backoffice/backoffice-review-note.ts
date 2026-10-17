/**
 * Build + Review → omnios card projection.
 *
 * A pipeline bound to a card records what its workers actually did as
 * progress notes with evidence: the builder's report, each reviewer's verdict,
 * and the round outcome. None of these notes carries a completion verb; the
 * card's acceptance stays with the builder's final_report and the hub's
 * verifier (SYSTEMS.md: a local review never completes an outcome by itself).
 */
import { HUB_TASK_ID_PATTERN } from '../../shared/omnios-task-binding'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'

import type {
  BuildReviewNoteEvent as BackofficeReviewEvent,
  BuildReviewNoteInput as BackofficeReviewNoteInput,
  BuildReviewNoteResult as BackofficeReviewNoteResult
} from '../../shared/build-review-note'

export type { BackofficeReviewEvent, BackofficeReviewNoteInput, BackofficeReviewNoteResult }

const SUMMARY: Record<BackofficeReviewEvent, string> = {
  build_reported: 'Build + Review: builder reported',
  review_verdict: 'Build + Review: reviewer verdict',
  review_approved: 'Build + Review: all reviewers approved — candidate for verification',
  review_changes_requested: 'Build + Review: reviewers requested changes',
  review_limit_reached: 'Build + Review: review limit reached with unresolved findings'
}

function clean(value: string | null | undefined, max: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : null
}

export function buildBackofficeReviewNote(input: BackofficeReviewNoteInput) {
  if (!HUB_TASK_ID_PATTERN.test(input.hubTaskId)) {
    throw new Error('A review note needs an omnios card id (btk_…).')
  }
  if (!Object.hasOwn(SUMMARY, input.event)) {
    throw new Error(`Unknown review event: ${String(input.event)}`)
  }
  const summary = SUMMARY[input.event]
  const evidence: { kind: 'text' | 'file'; ref: string; label: string }[] = [
    { kind: 'text', ref: input.pipelineId, label: 'IDE Build+Review pipeline' },
    { kind: 'text', ref: `round ${input.round}`, label: 'Build+Review round' }
  ]
  if (input.runId) {
    evidence.push({ kind: 'text', ref: input.runId, label: 'IDE run id' })
  }
  const worker = clean(input.worker, 200)
  if (worker) {
    evidence.push({ kind: 'text', ref: worker, label: 'worker' })
  }
  if (input.verdict) {
    evidence.push({ kind: 'text', ref: input.verdict, label: 'reviewer verdict' })
  }
  if (input.outcome) {
    evidence.push({ kind: 'text', ref: input.outcome, label: 'worker outcome' })
  }
  const reportPath = clean(input.reportPath, 1000)
  if (reportPath) {
    evidence.push({ kind: 'file', ref: reportPath, label: 'worker report' })
  }
  const files = (input.filesModified ?? [])
    .map((file) => clean(file, 500))
    .filter((file): file is string => Boolean(file))
  for (const file of files.slice(0, 40)) {
    evidence.push({ kind: 'file', ref: file, label: 'modified file' })
  }
  const detail = clean(input.detail, 1500)
  const note = [
    summary,
    `Pipeline: ${input.pipelineId} · round ${input.round}`,
    worker ? `Worker: ${worker}` : null,
    input.verdict ? `Verdict: ${input.verdict}` : null,
    files.length ? `Files: ${files.length}` : null,
    detail,
    input.event === 'review_approved'
      ? 'Acceptance is decided on this card: the builder files a final_report and the hub verifies it.'
      : null
  ]
    .filter(Boolean)
    .join('\n')
  return {
    note,
    note_kind: 'progress' as const,
    payload: { summary, done: [] as string[], evidence }
  }
}

/** Never throws; a refused or unreachable omnios is an event on the pipeline, not a failure. */
export async function postBackofficeReviewNote(
  input: BackofficeReviewNoteInput
): Promise<BackofficeReviewNoteResult> {
  try {
    const body = buildBackofficeReviewNote(input)
    const snapshot = getBackofficeSnapshot()
    if (!snapshot.configured) {
      return { ok: false, message: snapshot.message }
    }
    const bearer = await currentBearerToken()
    if (!bearer) {
      return { ok: false, message: 'Sign in to record Build + Review facts on the card.' }
    }
    const response = await fetch(`${snapshot.baseUrl}/api/team/tasks/${input.hubTaskId}/comment`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body)
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: false, message: `omnios refused the review note (HTTP ${response.status}).` }
    }
    const stored = (await response.json().catch(() => null)) as { id?: unknown } | null
    const noteId = typeof stored?.id === 'string' && stored.id ? stored.id : null
    return noteId
      ? { ok: true, noteId }
      : { ok: false, message: 'omnios did not confirm the stored note.' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}
