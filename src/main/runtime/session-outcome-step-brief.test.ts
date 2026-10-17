import { describe, expect, it, vi } from 'vitest'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import type {
  SessionOutcome,
  SessionOutcomeAttempt,
  SessionOutcomeSet
} from '../../shared/session-outcome-types'

const mocks = vi.hoisted(() => ({ launch: vi.fn(async () => ({})) }))
vi.mock('./session-outcome-executor', () => ({
  launchSessionOutcomeAction: mocks.launch,
  sessionOutcomeExecutionBrief: () => 'brief'
}))
const reports = new Map<string, string>()
vi.mock('./session-outcome-result', () => ({
  sessionOutcomeResultBody: (_runtime: unknown, attempt: SessionOutcomeAttempt) =>
    reports.get(attempt.actionId) ?? ''
}))

import { prepareOutcomeStep, WORK_PLAN_REPORT_EXCERPT_CHARS } from './session-outcome-step-brief'

function step(id: string, extra: Partial<SessionChainAgentStep> = {}): SessionChainAgentStep {
  return {
    id,
    outcomeId: 'ship',
    agent: 'codex',
    prompt: `do ${id}`,
    status: 'queued',
    ...extra
  } as SessionChainAgentStep
}

/** Every step but the last has completed and left the report `reports` holds for it. */
function scenario(steps: SessionChainAgentStep[]) {
  const done = steps.slice(0, -1)
  const outcome = {
    id: 'ship',
    title: 'Ship it',
    finish: 'complete',
    dependsOn: [],
    conditions: [{ id: 'file', kind: 'file', target: '/workspace/out.txt' }],
    actions: [],
    stepIds: steps.map((entry) => entry.id),
    revision: 1,
    status: 'pending',
    evidence: []
  } as unknown as SessionOutcome
  let chain = {
    id: 'chn_1',
    workspacePath: '/workspace',
    steps,
    outcomeSet: {
      outcomes: [outcome],
      completedSteps: done.map((entry) => entry.id),
      attempts: done.map(
        (entry) =>
          ({
            id: `attempt_${entry.id}`,
            outcomeId: 'ship',
            actionId: `step_${entry.id}`,
            actionKey: entry.id,
            outcomeRevision: 1,
            state: 'completed',
            startedAt: 1,
            updatedAt: 1
          }) as SessionOutcomeAttempt
      ),
      continuation: {},
      revision: 1
    } as unknown as SessionOutcomeSet
  } as unknown as SessionChain
  const access = {
    runtime: {} as never,
    read: () => chain,
    save: (updated: SessionChain) => {
      chain = updated
    },
    persistAttempt: () => {}
  }
  return {
    brief: () => prepareOutcomeStep(access, outcome, steps.at(-1)!.id).action.instruction
  }
}

describe('what a step is told about the steps before it', () => {
  it('reads only what `readsFrom` names, each excerpt labelled by its step', () => {
    reports.clear()
    reports.set('step_research', 'RESEARCH NOTES')
    reports.set('step_design', 'DESIGN NOTES')
    const brief = scenario([
      step('research'),
      step('design'),
      step('build', { readsFrom: ['design'] })
    ]).brief()

    expect(brief).toContain('=== design ===')
    expect(brief).toContain('DESIGN NOTES')
    expect(brief).not.toContain('RESEARCH NOTES')
    expect(brief).not.toContain('=== research ===')
  })

  it('falls back to every earlier completed step when nothing says otherwise', () => {
    reports.clear()
    reports.set('step_research', 'RESEARCH NOTES')
    reports.set('step_design', 'DESIGN NOTES')
    const brief = scenario([step('research'), step('design'), step('build')]).brief()

    expect(brief).toContain('=== research ===')
    expect(brief).toContain('=== design ===')
    expect(brief.indexOf('=== research ===')).toBeLessThan(brief.indexOf('=== design ==='))
  })

  it('says a declared producer left no report instead of quietly dropping it', () => {
    reports.clear()
    reports.set('step_design', '')
    const brief = scenario([step('design'), step('build', { readsFrom: ['design'] })]).brief()

    expect(brief).toContain('=== design ===')
    expect(brief).toContain('(no report was recorded for this step)')
  })

  it('keeps a reviewer out of its own round siblings', () => {
    reports.clear()
    reports.set('step_r1', 'FIRST REVIEWER SAID')
    const review = { groupId: 'critique', round: 1, maxRounds: 1, candidateVersion: 'v1' }
    const brief = scenario([
      step('r1', { group: 'critique_round_1', review: { ...review, reviewerId: 'r1' } }),
      step('r2', { group: 'critique_round_1', review: { ...review, reviewerId: 'r2' } })
    ] as SessionChainAgentStep[]).brief()

    expect(brief).not.toContain('FIRST REVIEWER SAID')
  })
})

describe('a report too long to inline', () => {
  const long = `HEAD-MARK${'x'.repeat(40_000)}TAIL-MARK`

  it('keeps its head and its tail, names what was dropped, and points at the folder', () => {
    reports.clear()
    reports.set('step_research', long)
    const brief = scenario([step('research'), step('write')]).brief()

    expect(brief).toContain('HEAD-MARK')
    expect(brief).toContain('TAIL-MARK')
    expect(brief).toContain('characters omitted from the middle of this report')
    expect(brief).toContain('full report: /workspace/.omni/runs/chn_1/research')
    // The excerpt is bounded; the pointer and the omission notice are the only additions.
    expect(brief.length).toBeLessThan(WORK_PLAN_REPORT_EXCERPT_CHARS + 1_000)
  })

  it('inlines a report that fits whole', () => {
    reports.clear()
    const fits = 'y'.repeat(WORK_PLAN_REPORT_EXCERPT_CHARS)
    reports.set('step_research', fits)
    const brief = scenario([step('research'), step('write')]).brief()

    expect(brief).toContain(fits)
    expect(brief).not.toContain('characters omitted')
  })
})
