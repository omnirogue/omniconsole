// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionChain } from '../../../../shared/session-chain-types'
import {
  sessionOutcomeActionKey,
  sessionOutcomeConditionKey
} from '../../../../shared/session-outcome-types'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { workflowPreviewFixture } from '../console-workflows/console-workflow-test-fixtures'
import { sessionOutcomeWorkflowSchema } from '../../../../shared/session-outcome-workflow'
import type { SessionOutcomeSet } from '../../../../shared/session-outcome-types'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  hasRuntimeRpcErrorCode: (error: { code?: string }, code: string) => error.code === code
}))
vi.mock('@/lib/session-chain-registry', () => ({
  getSessionChainEntry: () => null,
  getAllSessionChainEntries: () => []
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replace(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('./use-next-step-session-phase', () => ({
  useNextStepSessionPhaseInput: () => ({ agentState: 'done', returned: false })
}))
import { NextStepOutcomeStatus } from './NextStepOutcomeStatus'
import { OutcomeResumeAction } from './OutcomeResumeAction'

const capabilities = {
  version: 1,
  durableContinuation: true,
  remoteRuntimeOwnership: 1,
  placementScope: 'runtime-local',
  executionRuntimeId: 'host-incarnation'
}
function recoveredChain(): SessionChain {
  const action = {
    id: 'build',
    instruction: 'Produce the saved report',
    agent: 'codex' as const,
    authority: 'existing-user-authority' as const,
    conditionIds: ['file']
  }
  return {
    id: 'saved',
    hostId: 'runtime:peer',
    placement: 'runtime:peer',
    workspacePath: '/project',
    worktreeId: 'folder:project',
    sourcePaneKey: 'source',
    sourceRowKey: 'source-row',
    steps: [],
    currentIndex: 0,
    state: 'waiting',
    auto: true,
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 4,
      removals: [],
      updatedAt: 2,
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch',
        sourceReady: true,
        state: 'owned'
      },
      outcomes: [
        {
          id: 'report',
          title: 'Report',
          finish: 'complete',
          dependsOn: [],
          revision: 2,
          status: 'blocked',
          blockedReason: 'Launch did not start. Resume to retry.',
          conditions: [{ id: 'file', kind: 'file', target: '/project/report.txt' }],
          actions: [action],
          evidence: []
        }
      ],
      attempts: [
        {
          id: 'abandoned',
          outcomeId: 'report',
          actionId: action.id,
          actionKey: sessionOutcomeActionKey(action),
          outcomeRevision: 2,
          state: 'blocked',
          launchDisposition: 'not-started',
          startedAt: 1,
          updatedAt: 2
        }
      ]
    }
  }
}

function publication(
  state: 'prepared' | 'requested' | 'blocked' | 'merged'
): NonNullable<SessionOutcomeSet['publications']>[number] {
  return {
    id: 'publication',
    outcomeId: 'prior',
    conditionId: 'merge',
    state,
    admission: {
      provider: 'github',
      producerGitSha: 'a'.repeat(40),
      acceptedReviews: [
        {
          artifactId: 'artifact',
          artifactVersion: 'version',
          reviewerId: 'reviewer',
          verdict: 'accepted',
          producerGitSha: 'a'.repeat(40),
          repo: 'fixture/repository',
          prNumber: 1,
          headRef: 'work',
          baseRef: 'main',
          headSha: 'a'.repeat(40)
        }
      ],
      review: {
        repo: 'fixture/repository',
        prNumber: 1,
        url: 'https://example.invalid/review/1',
        state: state === 'merged' ? 'merged' : 'open',
        headRef: 'work',
        baseRef: 'main',
        headSha: 'a'.repeat(40),
        mergeCommitSha: state === 'merged' ? 'b'.repeat(40) : null
      }
    }
  }
}

function workflowFixture() {
  const { graph, digest, workflow_id } = workflowPreviewFixture()
  return sessionOutcomeWorkflowSchema.parse({
    operationId: 'prepared-recovery-test',
    definitionSha256: digest,
    phase: 'prepared',
    preview: {
      ok: true,
      graph,
      digest,
      workflow_id,
      admission: {
        filing_root_task_id: 'btk_test1234',
        filing_root_expected_revision: 1,
        objective: {
          goal_id: 'goal',
          title: 'Saved work',
          desired_result: 'Verified output',
          acceptance_policy: { required: true },
          verification_policy: { required: true }
        },
        org_unit_id: 'ou_dev',
        expected_authority_epoch: 1
      }
    },
    stages: [{ key: 'build', outcomeIds: ['report'], actionIds: ['build'], stepIds: [] }],
    activations: []
  })
}

function addPredecessor(
  chain: SessionChain,
  state: 'blocked' | 'completed',
  launchDisposition?: 'started' | 'not-started' | 'unverifiable'
): void {
  const set = chain.outcomeSet!
  const prior = structuredClone(set.outcomes[0]!)
  prior.id = 'prior'
  prior.title = 'Predecessor'
  prior.status = state === 'completed' ? 'satisfied' : 'blocked'
  prior.conditions[0]!.id = 'prior-file'
  prior.actions[0]!.id = 'prior-action'
  prior.actions[0]!.conditionIds = ['prior-file']
  if (state === 'completed') {
    prior.evidence = [
      {
        id: 'prior-proof',
        outcomeId: prior.id,
        conditionId: 'prior-file',
        outcomeRevision: prior.revision,
        conditionKey: sessionOutcomeConditionKey(prior.conditions[0]!),
        kind: 'file',
        target: prior.conditions[0]!.target,
        receipt: 'verified-file',
        verifiedAt: 2,
        verifier: 'execution-host'
      }
    ]
  }
  set.outcomes.unshift(prior)
  set.attempts.unshift({
    ...set.attempts[0]!,
    id: 'prior-attempt',
    outcomeId: prior.id,
    actionId: 'prior-action',
    actionKey: sessionOutcomeActionKey(prior.actions[0]!),
    state,
    launchDisposition
  })
}

function Harness({ initial }: { initial: SessionChain }) {
  const [chain, setChain] = useState(initial)
  const [error, setError] = useState('')
  const outcome = chain.outcomeSet!.outcomes[0]!
  return (
    <>
      <NextStepOutcomeStatus
        session={{ paneKey: 'source', label: 'Work' } as SidebarSession}
        outcome={{
          id: outcome.id,
          finish: null,
          instructions: '',
          steps: [],
          status:
            outcome.status === 'satisfied'
              ? 'complete'
              : outcome.status === 'blocked'
                ? 'needs-you'
                : 'waiting',
          needsYouReason: outcome.blockedReason
        }}
        chain={chain}
        onChainChanged={setChain}
        onError={setError}
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  )
}
function openDetails(chain = recoveredChain()): void {
  render(<Harness initial={chain} />)
  fireEvent.click(screen.getByRole('button', { name: /verified/ }))
}
afterEach(() => {
  cleanup()
  rpc.mockReset()
  replaceRuntimeEnvironmentRevisions([])
})

it('resumes once on the execution host and renders fresh host progress without inventing completion', async () => {
  const chain = recoveredChain()
  const resumed = structuredClone(chain)
  resumed.hostId = resumed.placement = 'local'
  resumed.outcomeSet!.attempts[0]!.state = 'retryable'
  resumed.outcomeSet!.outcomes[0]!.status = 'pending'
  resumed.outcomeSet!.outcomes[0]!.blockedReason = undefined
  const completed = structuredClone(resumed)
  const outcome = completed.outcomeSet!.outcomes[0]!
  const condition = outcome.conditions[0]!
  outcome.status = 'satisfied'
  outcome.evidence = [
    {
      id: 'receipt',
      outcomeId: outcome.id,
      conditionId: condition.id,
      outcomeRevision: outcome.revision,
      conditionKey: sessionOutcomeConditionKey(condition),
      kind: condition.kind,
      target: condition.target,
      receipt: 'file:verified',
      verifiedAt: 3,
      verifier: 'execution-host'
    }
  ]
  completed.outcomeSet!.attempts.push({
    ...completed.outcomeSet!.attempts[0]!,
    id: 'actual',
    state: 'completed',
    launchDisposition: 'started',
    dispatchId: 'actual-dispatch'
  })
  let releaseResume!: (value: { chain: SessionChain }) => void
  const pendingResume = new Promise((resolve) => {
    releaseResume = resolve
  })
  let releaseProgress!: (value: { chain: SessionChain }) => void
  const pendingProgress = new Promise((resolve) => {
    releaseProgress = resolve
  })
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'sessionChain.outcomeCapabilities') {
      return capabilities
    }
    if (method === 'sessionChain.resumeOutcomes') {
      return pendingResume
    }
    if (method === 'sessionChain.outcomeProgress') {
      return pendingProgress
    }
    throw new Error(`Unexpected method ${method}`)
  })
  openDetails(chain)
  const resume = screen.getByRole('button', { name: 'Resume saved work' })
  fireEvent.click(resume)
  fireEvent.click(resume)
  await waitFor(() =>
    expect(rpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'peer' },
      'sessionChain.resumeOutcomes',
      { id: 'saved', expectedRevision: 4, expectedExecutionRuntimeId: 'host-incarnation' },
      expect.any(Object)
    )
  )
  expect((screen.getByRole('button', { name: 'Resuming…' }) as HTMLButtonElement).disabled).toBe(
    true
  )
  expect(screen.queryByText('Complete')).toBeNull()
  releaseResume({ chain: resumed })
  await waitFor(() => expect(screen.getByText('Waiting on the agents')).toBeTruthy())
  expect(screen.getByRole('button', { name: '0/1 verified' })).toBeTruthy()
  releaseProgress({ chain: completed })
  await waitFor(() => expect(screen.getByText('Complete')).toBeTruthy())
  expect(screen.getByRole('button', { name: '1/1 verified' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Resume saved work' })).toBeNull()
  expect(rpc.mock.calls.filter((call) => call[1] === 'sessionChain.resumeOutcomes')).toHaveLength(1)
  expect(rpc.mock.calls.every((call) => call[0].environmentId === 'peer')).toBe(true)
})

it.each(['Outcome revision conflict.', 'Execution host unavailable.'])(
  'keeps the saved work blocked and exposes a failed Resume: %s',
  async (message) => {
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'sessionChain.outcomeCapabilities') {
        return capabilities
      }
      throw new Error(message)
    })
    openDetails()
    fireEvent.click(screen.getByRole('button', { name: 'Resume saved work' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(message))
    expect(screen.getByRole('button', { name: '0/1 verified' })).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Resume saved work' }) as HTMLButtonElement).disabled
    ).toBe(false)
    expect(rpc.mock.calls.some((call) => call[1] === 'sessionChain.outcomeProgress')).toBe(false)
  }
)

it.each([
  [
    'incomplete source',
    (chain: SessionChain) => {
      chain.outcomeSet!.continuation.sourceReady = false
    }
  ],
  [
    'unverifiable owner',
    (chain: SessionChain) => {
      chain.outcomeSet!.continuation.state = 'unverifiable'
    }
  ],
  [
    'unverifiable attempt',
    (chain: SessionChain) => {
      chain.outcomeSet!.attempts[0]!.state = 'unverifiable'
    }
  ],
  [
    'started attempt',
    (chain: SessionChain) => {
      chain.outcomeSet!.attempts[0]!.launchDisposition = 'started'
    }
  ],
  [
    'old revision',
    (chain: SessionChain) => {
      chain.outcomeSet!.attempts[0]!.outcomeRevision = 1
    }
  ],
  [
    'edited action',
    (chain: SessionChain) => {
      chain.outcomeSet!.outcomes[0]!.actions[0]!.instruction = 'Different work'
    }
  ],
  [
    'already retried',
    (chain: SessionChain) => {
      chain.outcomeSet!.attempts.push({
        ...chain.outcomeSet!.attempts[0]!,
        id: 'retry',
        state: 'running'
      })
    }
  ]
] as const)('does not offer Resume for %s', (_name, change) => {
  const chain = recoveredChain()
  change(chain)
  openDetails(chain)
  expect(screen.queryByRole('button', { name: 'Resume saved work' })).toBeNull()
  expect(rpc).not.toHaveBeenCalled()
})

it.each([
  [
    'active workflow',
    (chain: SessionChain) => {
      chain.outcomeSet!.workflow = workflowFixture()
    }
  ],
  [
    'active historical workflow',
    (chain: SessionChain) => {
      chain.outcomeSet!.workflowHistory = [workflowFixture()]
    }
  ],
  ...(['prepared', 'requested', 'blocked'] as const).map(
    (state) =>
      [
        `${state} publication`,
        (chain: SessionChain) => {
          chain.outcomeSet!.publications = [publication(state)]
        }
      ] as const
  ),
  [
    'human handoff definition',
    (chain: SessionChain) => {
      chain.outcomeSet!.outcomes[0]!.finish = 'human-handoff'
    }
  ],
  [
    'handoff condition',
    (chain: SessionChain) => {
      chain.outcomeSet!.outcomes[0]!.conditions.push({
        id: 'handoff',
        kind: 'handoff',
        target: 'emp_recipient'
      })
    }
  ],
  [
    'handoff step',
    (chain: SessionChain) => {
      chain.steps.push({
        kind: 'handoff',
        id: 'handoff',
        status: 'queued',
        handoff: {
          revision: 1,
          taskId: null,
          taskTitle: 'Send result',
          sessionLabel: 'Work',
          recipients: [
            {
              employeeId: 'emp_recipient',
              name: 'Recipient',
              operationId: 'op_existing',
              delivery: 'failed'
            }
          ],
          deliverables: { kind: 'files', paths: [] },
          includeSummary: true,
          note: '',
          savedAt: 1
        }
      })
    }
  ],
  [
    'another started blocked action',
    (chain: SessionChain) => {
      addPredecessor(chain, 'blocked', 'started')
    }
  ],
  [
    'another blocked action without launch proof',
    (chain: SessionChain) => {
      addPredecessor(chain, 'blocked')
    }
  ]
] as const)(
  'does not expose whole-set retries through action recovery with %s',
  (_name, change) => {
    const chain = recoveredChain()
    change(chain)
    openDetails(chain)
    expect(screen.queryByRole('button', { name: 'Resume saved work' })).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  }
)

it('keeps simple recovery available after completed predecessors and retired history', () => {
  const chain = recoveredChain()
  addPredecessor(chain, 'completed', 'started')
  chain.outcomeSet!.workflowHistory = [{ ...workflowFixture(), retired: true }]
  chain.outcomeSet!.publications = [publication('merged')]
  openDetails(chain)
  expect(screen.getByRole('button', { name: 'Resume saved work' })).toBeTruthy()
  expect(rpc).not.toHaveBeenCalled()
})

it.each(['another plan', 'unmounted'])(
  'does not publish a late failure after the details show %s',
  async (change) => {
    let rejectResume!: (cause: Error) => void
    const response = new Promise((_resolve, reject) => {
      rejectResume = reject
    })
    rpc.mockImplementation(async (_target, method) =>
      method === 'sessionChain.outcomeCapabilities' ? capabilities : response
    )
    const onChanged = vi.fn(),
      onError = vi.fn()
    const chain = recoveredChain()
    const view = render(
      <OutcomeResumeAction chain={chain} onChanged={onChanged} onError={onError} />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume saved work' }))
    await waitFor(() =>
      expect(rpc.mock.calls.some((call) => call[1] === 'sessionChain.resumeOutcomes')).toBe(true)
    )
    if (change === 'unmounted') {
      view.unmount()
      render(<OutcomeResumeAction chain={chain} onChanged={onChanged} onError={onError} />)
    } else {
      const other = recoveredChain()
      other.id = 'other'
      other.hostId = other.placement = 'runtime:other-peer'
      other.outcomeSet!.revision = 5
      view.rerender(<OutcomeResumeAction chain={other} onChanged={onChanged} onError={onError} />)
    }
    onError.mockClear()
    await act(async () => {
      rejectResume(new Error('Late original-host failure'))
    })
    expect(onError).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(
      (screen.getByRole('button', { name: 'Resume saved work' }) as HTMLButtonElement).disabled
    ).toBe(false)
  }
)
