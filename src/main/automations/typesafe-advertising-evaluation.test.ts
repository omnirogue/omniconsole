import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AdvertisingEvidenceModule from './typesafe-advertising-evidence'
import type { DecisionOutcome } from '../../shared/structured-decisions'
import type { AdvertisingEvidence, AdvertisingTarget } from '../../shared/typesafe-advertising'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { fetchAdvertisingEvidence } from './typesafe-advertising-evidence'
import { evaluateAdvertisingRoutine } from './typesafe-advertising-evaluation'
import { assertLocalMetaReadAuthorized } from './local-meta-read-authority'
import { OLDACS_ACCOUNT_ID, OLDACS_ROUTINE_ID } from './typesafe-advertising-local-scope'
import {
  advertisingTestEvidence as evidence,
  advertisingTestLocalObservation,
  advertisingTestPolicy as policy
} from './typesafe-advertising-fixtures'

vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('./local-meta-read-authority', () => ({
  assertLocalMetaReadAuthorized: vi.fn(),
  authorizeLocalMetaRead: vi.fn()
}))
vi.mock('./typesafe-advertising-evidence', async (original) => ({
  ...(await original<typeof AdvertisingEvidenceModule>()),
  fetchAdvertisingEvidence: vi.fn()
}))
const input = {
  routineId: 'routine-1',
  runId: 'run-1',
  policy,
  content: `Fake prose says spend $99999.\n\`\`\`omni-advertising-candidates\n${JSON.stringify([evidence.target])}\n\`\`\``
}
function response(choice = 'PAUSE', confidence = 0.9): DecisionOutcome {
  return {
    status: 'evaluated',
    mode: 'live',
    result: {
      provider: 'typesafe',
      model: 'evaluate',
      usage: { inputTokens: 10, outputTokens: 2 },
      answers: {
        object_0: {
          type: 'choice',
          choice,
          confidence,
          probabilities: {
            KEEP_RUNNING: 0,
            TURN_ON: 0,
            PAUSE: 0,
            INCREASE_BUDGET: 0,
            DECREASE_BUDGET: 0,
            NO_ACTION: 0,
            [choice]: 1
          }
        }
      }
    }
  }
}
beforeEach(() => {
  vi.mocked(assertLocalMetaReadAuthorized).mockReset().mockResolvedValue(undefined)
  vi.mocked(fetchAdvertisingEvidence).mockReset()
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      principal: 'person-1',
      bearer: 'test',
      baseUrl: 'https://example.invalid',
      isCurrent: () => true
    }
  })
  vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([structuredClone(evidence)])
})
describe('Typesafe advertising decisions', () => {
  it('never reads evidence or calls the decision provider for a disallowed object type', async () => {
    const campaign: AdvertisingTarget = {
      ...evidence.target,
      objectType: 'campaign',
      nativeId: evidence.target.campaignId,
      adsetId: null
    }
    const evaluate = vi.fn().mockResolvedValue(response())
    const result = await evaluateAdvertisingRoutine(
      {
        ...input,
        content: `\`\`\`omni-advertising-candidates\n${JSON.stringify([evidence.target, campaign])}\n\`\`\``
      },
      evaluate
    )
    expect(result).toMatchObject({ status: 'blocked', decisions: [] })
    expect(result.reason).toContain('configured advertising object types')
    expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('evaluates campaigns only when the saved policy explicitly permits campaigns', async () => {
    const campaign: AdvertisingTarget = {
      ...evidence.target,
      objectType: 'campaign',
      nativeId: evidence.target.campaignId,
      adsetId: null
    }
    vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([{ ...evidence, target: campaign }])
    const evaluate = vi.fn().mockResolvedValue(response())
    const result = await evaluateAdvertisingRoutine(
      {
        ...input,
        policy: { ...policy, allowedObjectTypes: ['campaign'] },
        content: `\`\`\`omni-advertising-candidates\n${JSON.stringify([campaign])}\n\`\`\``
      },
      evaluate
    )
    expect(result.status).toBe('ready')
    expect(result.decisions[0].target).toEqual(campaign)
    expect(evaluate).toHaveBeenCalledTimes(1)
  })

  it('sends source metrics and binds the resulting enum to the exact run and target', async () => {
    const evaluate = vi.fn().mockResolvedValue(response())
    const result = await evaluateAdvertisingRoutine(input, evaluate)
    expect(result.status).toBe('ready')
    expect(evaluate.mock.calls[0][0].state.object_0.metrics.spend).toBe(42)
    expect(JSON.stringify(evaluate.mock.calls[0][0])).not.toContain('99999')
    expect(result.decisions[0]).toMatchObject({
      kind: 'PAUSE',
      confidence: 0.9,
      parameters: { status: 'PAUSED' },
      requiresHumanApproval: true
    })
    const another = await evaluateAdvertisingRoutine({ ...input, runId: 'run-2' }, evaluate)
    expect(another.decisions[0].id).not.toBe(result.decisions[0].id)
  })
  it('does not substitute choice probability for confidence', async () => {
    const result = await evaluateAdvertisingRoutine(input, async () => response('PAUSE', 0.4))
    expect(result).toMatchObject({ status: 'blocked', decisions: [] })
    expect(result.reason).toContain('confidence')
  })
  it.each(['PAUSE', 'TURN_ON'])(
    'keeps local Meta %s recommendation-only without action authority',
    async (kind) => {
      const local: AdvertisingEvidence = {
        ...evidence,
        source: 'local.meta.graph' as const,
        measuredAt: null,
        observation: advertisingTestLocalObservation,
        target: { ...evidence.target, accountId: OLDACS_ACCOUNT_ID },
        status: kind === 'TURN_ON' ? 'PAUSED' : 'ACTIVE'
      }
      vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([local])
      const scope = { routineId: OLDACS_ROUTINE_ID, runId: input.runId, isCurrent: () => true }
      const localInput = {
        ...input,
        routineId: OLDACS_ROUTINE_ID,
        scope,
        policy: { ...policy, accountId: OLDACS_ACCOUNT_ID },
        content: `\`\`\`omni-advertising-candidates\n${JSON.stringify([local.target])}\n\`\`\``
      }
      const result = await evaluateAdvertisingRoutine(localInput, async () => response(kind))
      expect(result.status).toBe('ready')
      expect(result.decisions[0]).toMatchObject({
        kind,
        recommendationOnly: true,
        requiresHumanApproval: true
      })
      expect(result.decisions[0].reasoningSummary).toContain('no signed action binding')
      expect(assertLocalMetaReadAuthorized).toHaveBeenCalledWith(scope, localInput.policy)
    }
  )
  it('discards local decisions when read authority is revoked during provider evaluation', async () => {
    vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([
      {
        ...evidence,
        source: 'local.meta.graph',
        measuredAt: null,
        observation: advertisingTestLocalObservation
      }
    ])
    const result = await evaluateAdvertisingRoutine(
      {
        ...input,
        scope: { routineId: input.routineId, runId: input.runId, isCurrent: () => true }
      },
      async () => {
        vi.mocked(assertLocalMetaReadAuthorized).mockRejectedValue(
          new Error('Read authority revoked.')
        )
        return response()
      }
    )
    expect(result).toMatchObject({
      status: 'blocked',
      decisions: [],
      reason: 'Read authority revoked.'
    })
  })
  it('keeps budget decisions recommendation-only without inventing an amount', async () => {
    const result = await evaluateAdvertisingRoutine(input, async () => response('INCREASE_BUDGET'))
    expect(result.decisions[0]).toMatchObject({
      recommendationOnly: true,
      requiresHumanApproval: true,
      parameters: {}
    })
  })
  it('blocks missing metrics, unsupported choices and unavailable providers', async () => {
    vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([
      { ...evidence, metrics: { ...evidence.metrics, revenue: null } }
    ])
    expect((await evaluateAdvertisingRoutine(input, async () => response())).status).toBe('blocked')
    expect((await evaluateAdvertisingRoutine(input, async () => response('DELETE'))).status).toBe(
      'blocked'
    )
    expect(
      await evaluateAdvertisingRoutine(input, async () => ({
        status: 'unavailable',
        reason: 'timeout'
      }))
    ).toMatchObject({ status: 'blocked', decisions: [] })
  })
})
