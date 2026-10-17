import { describe, expect, it } from 'vitest'
import type { AutomationDispatchResult, AutomationRun } from '../../shared/automations-types'
import { NO_NEW_TURN_ERROR, reconcileCompletedAutomationRun } from './completed-run-reconciliation'

const STARTED_AT = Date.parse('2026-09-20T20:15:25.996Z')
const SCRAPE = [
  '  Worked for 8m 30s · done 4:08 PM',
  '■ Conversation interrupted - tell the model what to do differently.',
  '    🔒  This conversation is open in another app          R to Retry',
  '    r retry   esc/ctrl+c/q exit   ctrl+t transcript%'
].join('\n')
const snapshot = (content: string) => ({
  format: 'plain_text' as const,
  content,
  capturedAt: 1,
  truncated: false
})
const run = (overrides: Partial<AutomationRun> = {}): AutomationRun =>
  ({
    id: 'run-8',
    automationId: 'auto',
    status: 'dispatched',
    startedAt: STARTED_AT,
    dispatchedAt: STARTED_AT + 200,
    createdAt: STARTED_AT - 40,
    outputSnapshot: null,
    ...overrides
  }) as AutomationRun
const completed = (
  overrides: Partial<AutomationDispatchResult> = {}
): AutomationDispatchResult => ({
  runId: 'run-8',
  status: 'completed',
  ...overrides
})
const turn = (message: string) =>
  JSON.stringify({
    timestamp: '2026-09-20T20:18:00.000Z',
    type: 'event_msg',
    payload: { type: 'task_complete', last_agent_message: message }
  })

describe('reconcileCompletedAutomationRun', () => {
  it('takes the run message from the Codex rollout instead of the screen scrape', () => {
    const result = reconcileCompletedAutomationRun(
      completed({ outputSnapshot: snapshot('  wrapped screen\n  text') }),
      () => run({ providerSessionAgent: 'codex', providerSessionTranscriptPath: '/rollout.jsonl' }),
      () => turn('Paused both ad sets; read back PAUSED.')
    )
    expect(result.status).toBe('completed')
    expect(result.outputSnapshot?.content).toBe('Paused both ad sets; read back PAUSED.')
    expect(result.outputSnapshot?.capturedAt).toBe(Date.parse('2026-09-20T20:18:00.000Z'))
  })
  it('fails a run whose rollout shows no new turn and whose only output is a scrape', () => {
    const providerSession = {
      providerSessionId: 't',
      providerSessionAgent: 'codex' as const,
      providerSessionTranscriptPath: '/rollout.jsonl'
    }
    const scrapeOnly = snapshot('│ >_ OpenAI Codex (v0.155.1)\n  Worked for 2m 10s · done 4:08 PM')
    expect(
      reconcileCompletedAutomationRun(
        completed({ outputSnapshot: scrapeOnly, providerSession }),
        () => run(),
        () => ''
      )
    ).toMatchObject({ status: 'dispatch_failed', error: NO_NEW_TURN_ERROR })
    // The lock banner names the cause more precisely than "no new turn".
    expect(
      reconcileCompletedAutomationRun(
        completed({ outputSnapshot: snapshot(SCRAPE), providerSession }),
        () => run(),
        () => ''
      ).error
    ).toMatch(/open in another app/)
  })
  it('keeps a hook-reported message when the rollout is unreadable or has no turn', () => {
    const clean = completed({ outputSnapshot: snapshot('Report text') })
    const codexRun = () =>
      run({ providerSessionAgent: 'codex', providerSessionTranscriptPath: '/r' })
    expect(reconcileCompletedAutomationRun(clean, codexRun, () => null)).toBe(clean)
    expect(reconcileCompletedAutomationRun(clean, codexRun, () => '')).toBe(clean)
  })
  it('fails a thread-less completion whose scrape carries the resume-lock banner (runs 8/9)', () => {
    const result = reconcileCompletedAutomationRun(
      completed({ outputSnapshot: snapshot(SCRAPE) }),
      () => run(),
      () => null
    )
    expect(result.status).toBe('dispatch_failed')
    expect(result.error).toMatch(/open in another app/)
    expect(result.error).not.toMatch(/[■🔒]/u)
  })
  it('leaves non-completed writes and ordinary completions alone', () => {
    const failed = completed({ status: 'dispatch_failed', error: 'x' })
    expect(
      reconcileCompletedAutomationRun(
        failed,
        () => run(),
        () => null
      )
    ).toBe(failed)
    const ordinary = completed({ outputSnapshot: snapshot('Report text') })
    expect(
      reconcileCompletedAutomationRun(
        ordinary,
        () => null,
        () => null
      )
    ).toBe(ordinary)
  })
})
