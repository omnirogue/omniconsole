/**
 * A workflow conversation (Council, Discover, Evolve, Build + Review …) is a tab with no pane:
 * its work is a run that the controller which started it records and drives. These are the
 * shared words for that run's state and for addressing the anchor tab by its run (C6).
 */

import { z } from 'zod'
import {
  buildReviewEndedWithChangesRequested,
  buildReviewWaitsOnPerson,
  type BuildReviewPipelineSnapshot
} from './build-review-pipeline'
import type { LocalWorkflowRunState } from './local-workflow-view'

/** Where a started run stands, as its controller records it. */
export type WorkflowRunState = 'running' | 'needs-you' | 'done' | 'failed' | 'stopped'

/**
 * What the window knows of an anchor's run: never started (`draft`), Start in flight
 * (`starting`), not read yet (`unknown`), the run's state, the controller has no such run
 * (`missing`, "run not found") or the read failed (`unavailable`, "status unavailable").
 */
export type SessionWorkflowAnchorStatus =
  | 'draft'
  | 'starting'
  | 'unknown'
  | WorkflowRunState
  | 'missing'
  | 'unavailable'

/** The anchor tab's run, carried on management rows; older windows omit it. */
export type SessionManageWorkflowAnchor = {
  /** The runtime that started the run and owns its record: this computer's own (`{kind:'local'}`). */
  controller: 'local'
  preset: string
  /** An execution, Evolve run or Build + Review pipeline id; null before the run exists. */
  runId: string | null
  status: SessionWorkflowAnchorStatus
}

/** Addresses exactly one pane-less workflow anchor: its controller and its run. */
export const SessionWorkflowAnchorRefSchema = z
  .object({
    controller: z.literal('local'),
    runId: z.string().trim().min(1).max(200)
  })
  .strict()
export type SessionWorkflowAnchorRef = z.infer<typeof SessionWorkflowAnchorRefSchema>

export function sessionWorkflowAnchorRef(
  anchor: SessionManageWorkflowAnchor | undefined
): SessionWorkflowAnchorRef | null {
  return anchor?.runId ? { controller: anchor.controller, runId: anchor.runId } : null
}

export function sameSessionWorkflowAnchor(
  anchor: SessionManageWorkflowAnchor | undefined,
  ref: SessionWorkflowAnchorRef
): boolean {
  return anchor?.controller === ref.controller && anchor.runId === ref.runId
}

export function localWorkflowRunState(state: LocalWorkflowRunState): WorkflowRunState {
  switch (state) {
    case 'running':
    case 'pausing':
    case 'stopping':
      return 'running'
    // Why recovery_required: the run header shows it as amber "Needs you" and holds it with the
    // paused states; the tab and sidebar row must show the same state.
    case 'paused':
    case 'budget_paused':
    case 'recovery_required':
      return 'needs-you'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'stopped'
  }
}

/** A worker's open question, or a run that ended with changes still requested, is the person's. */
export function buildReviewRunState(pipeline: BuildReviewPipelineSnapshot): WorkflowRunState {
  if (buildReviewWaitsOnPerson(pipeline) || buildReviewEndedWithChangesRequested(pipeline)) {
    return 'needs-you'
  }
  switch (pipeline.stage) {
    case 'starting':
    case 'building':
    case 'reviewing':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'stopped'
  }
}

/** The controller's own words when it holds no such run (see its throw sites). */
export const LOCAL_WORKFLOW_NOT_FOUND = 'Workflow was not found'
export const buildReviewPipelineNotFound = (id: string): string =>
  `Build + Review pipeline ${id} was not found.`
export const evolveRunNotFound = (id: string): string => `No Evolve run ${id} on this computer.`

const NOT_FOUND_PATTERNS = [
  /(?:^|: |\n)Workflow was not found$/,
  /Build \+ Review pipeline \S+ was not found\.$/,
  /No Evolve run \S+ on this computer\.$/
]

/**
 * Positive evidence that the controller holds no such run: its own not-found answer, however a
 * transport re-wrapped the message. Any other failure is a failed read, never absence.
 */
export function isWorkflowRunNotFound(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof (error as { message?: unknown } | null)?.message === 'string'
          ? (error as { message: string }).message
          : ''
  const trimmed = message.trimEnd()
  return NOT_FOUND_PATTERNS.some((pattern) => pattern.test(trimmed))
}
