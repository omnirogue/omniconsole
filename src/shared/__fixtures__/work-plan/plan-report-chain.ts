import type { SessionChain, SessionChainAgentStep } from '../../session-chain-types'
import type { SessionOutcome, SessionOutcomeAttempt } from '../../session-outcome-types'
import type { WorkPlanArtifact } from '../../work-plan-artifact-schema'
import type { WorkPlanReportRuntime } from '../../work-plan-report-topology'

const AT = 1_750_000_000_000

function step(
  id: string,
  agent: SessionChainAgentStep['agent'],
  presetId: SessionChainAgentStep['presetId'],
  extra: Partial<SessionChainAgentStep> = {}
): SessionChainAgentStep {
  return {
    id,
    agent,
    presetId,
    prompt: `${presetId} the launch page`,
    model: `${agent}-model`,
    status: 'queued',
    ...extra
  }
}

/**
 * Sal's worked example as the host holds it: ⑂3 Research → ◇ → ⑂3 Plan → ⚖ → ✨ → ✓ → 👤, with two
 * seats running, one queued and one verdict already spent. Shared by the report snapshot and the
 * card-post snapshot so both read the SAME run.
 */
export function planReportChain(): SessionChain {
  const attempts: SessionOutcomeAttempt[] = [
    ['research-1', 'completed'],
    ['research-2', 'completed'],
    ['research-3', 'completed'],
    ['synthesis', 'completed'],
    ['plan-1', 'running'],
    ['plan-2', 'running']
  ].map(([stepId, state]) => ({
    id: `attempt-${stepId}`,
    outcomeId: 'launch',
    actionId: `step_${stepId}`,
    actionKey: `key-${stepId}`,
    outcomeRevision: 1,
    state: state as SessionOutcomeAttempt['state'],
    startedAt: AT,
    updatedAt: AT
  }))
  return {
    id: 'chain-plan-report',
    workspacePath: '/workspace/launch',
    worktreeId: 'worktree-1',
    hostId: 'host-1',
    sourcePaneKey: 'pane-1',
    sourceRowKey: 'row-1',
    auto: false,
    currentIndex: 4,
    state: 'launching',
    createdAt: AT,
    updatedAt: AT,
    verdicts: [
      {
        stepId: 'plan-judge',
        attemptId: 'attempt-plan-judge',
        verdict: { kind: 'judge', status: 'pass', winnerId: 'plan-2' },
        consumptionKey: 'plan-judge:select-winner:1',
        consumedAt: AT + 1000
      }
    ],
    steps: [
      step('research-1', 'claude', 'research', { group: 'research', status: 'launched' }),
      step('research-2', 'codex', 'research', { group: 'research', status: 'launched' }),
      step('research-3', 'grok', 'research', { group: 'research', status: 'launched' }),
      step('synthesis', 'claude', 'synthesize', { status: 'launched', launchedAt: AT + 60_000 }),
      step('plan-1', 'claude', 'plan', { group: 'plan', status: 'launched' }),
      step('plan-2', 'codex', 'plan', { group: 'plan', status: 'launched' }),
      step('plan-3', 'grok', 'plan', { group: 'plan' }),
      step('plan-judge', 'kimi', 'judge', {
        verdict: { kind: 'judge', over: ['plan-1', 'plan-2', 'plan-3'], consumed: 'select-winner' }
      }),
      step('improve', 'claude', 'improve', { readsWinnerOf: 'plan-judge' }),
      step('verify', 'codex', 'verify', {
        verdict: { kind: 'verify', over: ['improve'], consumed: 'gate' },
        review: {
          groupId: 'verify',
          reviewerId: 'codex',
          round: 1,
          maxRounds: 2,
          candidateVersion: 'candidate-1'
        }
      })
    ],
    outcomeSet: {
      schemaVersion: 1,
      revision: 3,
      outcomes: [planReportOutcome()],
      removals: [],
      attempts,
      completedSteps: ['research-1', 'research-2', 'research-3', 'synthesis'],
      continuation: {
        owner: 'execution-host',
        hostId: 'host-1',
        epoch: 'epoch-1',
        state: 'owned'
      },
      updatedAt: AT
    }
  }
}

export function planReportOutcome(): SessionOutcome {
  return {
    id: 'launch',
    title: 'Ship the launch page',
    finish: 'my-review',
    outputKind: 'plan',
    dependsOn: [],
    revision: 1,
    status: 'running',
    stepIds: ['research-1', 'synthesis', 'plan-1', 'plan-judge', 'improve', 'verify'],
    conditions: [
      {
        id: 'dw-plan',
        kind: 'file',
        label: 'the plan document exists and matches work-plan-v1',
        target: '.omni/runs/chain-plan-report/plan-1/plan.json',
        fileVersions: [
          { path: '.omni/runs/chain-plan-report/plan-1/plan.json', schema: 'work-plan-v1' }
        ]
      },
      { id: 'dw-review', kind: 'review', label: 'you approved the plan', target: 'launch' }
    ],
    actions: [],
    evidence: [
      {
        id: 'evidence-plan',
        outcomeId: 'launch',
        outcomeRevision: 1,
        conditionId: 'dw-plan',
        conditionKey: 'file:.omni/runs/chain-plan-report/plan-1/plan.json',
        kind: 'file',
        target: '.omni/runs/chain-plan-report/plan-1/plan.json',
        version: 'a'.repeat(64),
        receipt: `sha256:${'a'.repeat(64)}:/workspace/launch/.omni/runs/chain-plan-report/plan-1/plan.json`,
        verifiedAt: AT + 2000,
        verifier: 'execution-host'
      }
    ]
  }
}

export function planReportArtifact(): WorkPlanArtifact {
  return {
    schema: 'work-plan-v1',
    title: 'Launch page plan',
    summary: 'Write the offer, build one page, verify the price is stated once.',
    assumptions: ['The price is final at $499.'],
    steps: [
      {
        n: 1,
        title: 'Write the offer copy',
        detail: 'State the offer and the price in the hero.',
        files: ['index.html'],
        owner: 'claude',
        dependsOn: []
      },
      {
        n: 2,
        title: 'Build the page',
        detail: 'One static page, no framework.',
        files: ['index.html', 'styles.css'],
        owner: 'codex',
        dependsOn: [1]
      }
    ],
    risks: ['The price could change before launch.'],
    openQuestions: ['Which domain does it ship on?'],
    mockups: [{ file: 'hero.html', title: 'Hero with price' }],
    estimate: 'about half a day'
  }
}

export function planReportRuntime(): WorkPlanReportRuntime {
  return { now: AT + 3000, planVersion: 1 }
}
