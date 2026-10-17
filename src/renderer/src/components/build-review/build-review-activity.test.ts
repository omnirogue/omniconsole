import { describe, expect, it, vi } from 'vitest'
import type { BuildReviewEvent } from '../../../../shared/build-review-pipeline'
import { buildReviewActivity } from './build-review-activity'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, english: string, args?: Record<string, unknown>) =>
    english.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(args?.[key] ?? ''))
}))

// The shapes the runtime writes: orchestration ids are a prefix and 12 hex digits, terminal
// handles `term_` and a UUID.
const RUN = 'run_0123456789ab'
const DISPATCH = 'ctx_a1b2c3d4e5f6'
const MESSAGE = 'msg_fedcba987654'
const TERMINAL = 'term_3f2504e0-4f89-11d3-9a0c-0305e82c3301'

function event(
  text: string,
  kind: BuildReviewEvent['kind'] = 'info',
  role: BuildReviewEvent['role'] = 'pipeline'
): BuildReviewEvent {
  return { at: '2026-09-21T12:00:00Z', kind, role, text }
}

const texts = (events: BuildReviewEvent[]) => buildReviewActivity(events).map((entry) => entry.text)

describe('buildReviewActivity', () => {
  it('drops heartbeats and rewords the runtime plumbing lines', () => {
    const entries = buildReviewActivity([
      event('Pipeline created for id:repo-1::/Users/me/app'),
      event(`Run ${RUN} bound to ${TERMINAL} (ad hoc: no omnios card)`),
      event('Starting codex / gpt-5.5 / high', 'worker_started', 'builder'),
      event('editing', 'heartbeat', 'builder'),
      event('alive', 'heartbeat', 'builder'),
      event(`Dispatch ${DISPATCH} is running`, 'info', 'builder'),
      event('builder reported succeeded: Search implemented', 'worker_done', 'builder'),
      event('Pipeline completed')
    ])
    expect(entries.map((entry) => entry.text)).toEqual([
      'Run created',
      'Run started',
      'Starting codex / gpt-5.5 / high',
      'Agent is running',
      'builder reported succeeded: Search implemented',
      'Run completed'
    ])
    expect(entries.map((entry) => entry.role)).toEqual([
      'pipeline',
      'pipeline',
      'builder',
      'builder',
      'builder',
      'pipeline'
    ])
  })

  it('rewords the linked-task lines without their card and note ids', () => {
    expect(
      texts([
        event('Recorded on card btk_AbC12345: review_verdict (note_77)'),
        event(
          'Could not record review_verdict on card btk_AbC12345: Hub writes are closed',
          'error'
        ),
        event(
          "All reviewers approved. Acceptance is decided on card btk_AbC12345: the builder's final_report and the hub's verification complete it, not this pipeline."
        ),
        event(`Ignored worker_done from ${TERMINAL}`),
        event('Pipeline cancelled'),
        event('Cancel requested by the operator')
      ])
    ).toEqual([
      'Recorded on the linked task',
      'Could not record on the linked task: Hub writes are closed',
      'All reviewers approved',
      'Ignored a report from an agent outside this run',
      'Run cancelled',
      'Cancel requested'
    ])
  })

  it('removes identifiers of the exact runtime shapes from any other runtime line', () => {
    expect(
      texts([event(`Delivery for ${DISPATCH} settled late (${MESSAGE}).`, 'error', 'reviewer')])
    ).toEqual(['Delivery for settled late.'])
    expect(texts([event(`stopped: ${TERMINAL} did not exit`, 'info', 'builder')])).toEqual([
      'stopped: did not exit'
    ])
  })

  it('keeps what people wrote exactly as written', () => {
    expect(
      texts([
        event('Should I delete task_runner.ts or keep run_7?', 'question', 'builder'),
        event(`Keep it; see ${RUN}.`, 'reply'),
        event('Blocked: needs id:secrets access', 'escalation', 'reviewer'),
        event(
          'reviewer reported succeeded: Found a leak in term_utils.ts',
          'worker_done',
          'reviewer'
        )
      ])
    ).toEqual([
      'Should I delete task_runner.ts or keep run_7?',
      `Keep it; see ${RUN}.`,
      'Blocked: needs id:secrets access',
      'reviewer reported succeeded: Found a leak in term_utils.ts'
    ])
    // Words that only look like ids are not ids, even on a runtime line.
    expect(texts([event('message: Rename task_runner to job_queue', 'info', 'builder')])).toEqual([
      'message: Rename task_runner to job_queue'
    ])
  })

  it('folds a repeated line and keeps errors marked', () => {
    const entries = buildReviewActivity([
      event('Waiting for the reviewer', 'info', 'pipeline'),
      event('Waiting for the reviewer', 'info', 'pipeline'),
      event('Coordinator closure is unverified; workspace remains reserved.', 'error')
    ])
    expect(entries).toHaveLength(2)
    expect(entries[1]!.kind).toBe('error')
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2)
  })
  it('words a stuck start and the workspace it held, without codes or ids', () => {
    expect(
      texts([
        event('release retained (no_owned_resource)', 'info', 'builder'),
        event('builder: Agent startup blocked: codex-hooks-review-prompt', 'error'),
        event('builder: agent_prompt_stalled', 'error'),
        event(
          `Build + Review pipeline brp_0123456789ab still owns this workspace (Run ${RUN}); inspect unresolved Dispatch ${DISPATCH}.`,
          'error'
        ),
        event('Kept its terminal open so you can answer it', 'info', 'builder'),
        event('Retry requested'),
        event('Workspace released')
      ])
    ).toEqual([
      "Kept the agent's terminal open",
      'Codex found new or changed hooks and wants you to review them — open the terminal to answer.',
      'The agent did not start on its task. Open the terminal to see what it is waiting for.',
      'An earlier Build + Review run still holds this workspace.',
      'Kept its terminal open so you can answer it',
      'Retry requested',
      'Workspace released'
    ])
    // The host's refusal of a second run, in plain words rather than its own jargon.
    expect(
      texts([event('Pipeline brp_0123456789ab is still building in this workspace.')])
    ).toEqual([
      'A Build + Review run is already working in this workspace. Stop it or wait for it to finish.'
    ])
  })
})
