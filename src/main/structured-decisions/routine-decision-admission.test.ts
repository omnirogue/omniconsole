import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { RoutineStructuredResult } from '../../shared/routine-structured-result'
import type { AdvertisingActionBinding } from '../automations/typesafe-advertising-actions'
import type * as AdvertisingEvidenceModule from '../automations/typesafe-advertising-evidence'
import { fetchAdvertisingEvidence } from '../automations/typesafe-advertising-evidence'
import { evaluateAdvertisingRoutine } from '../automations/typesafe-advertising-evaluation'
import {
  advertisingTestEnvelope,
  advertisingTestEvidence,
  advertisingTestPreview,
  advertisingTestReceipt
} from '../automations/typesafe-advertising-fixtures'
import { consoleAdvertisingActionsClient } from '../backoffice/console-advertising-actions-client'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import type { Store } from '../persistence'
import { parseDecisionConfiguration } from './decision-configuration'
import type { DecisionRecords } from './decision-records'
import type { DecisionService } from './decision-service'
import { classifyRoutineOutput } from './routine-classification'
import { routineDecisionSourceRevision } from './routine-decision-records'
import { RoutineDecisionService } from './routine-decision-service'

vi.mock('./routine-classification', () => ({ classifyRoutineOutput: vi.fn() }))
vi.mock('../automations/typesafe-advertising-evaluation', () => ({
  evaluateAdvertisingRoutine: vi.fn()
}))
vi.mock('../automations/typesafe-advertising-evidence', async (original) => ({
  ...(await original<typeof AdvertisingEvidenceModule>()),
  fetchAdvertisingEvidence: vi.fn()
}))
vi.mock('../backoffice/console-advertising-actions-client', () => ({
  consoleAdvertisingActionsClient: { preview: vi.fn(), execute: vi.fn(), verify: vi.fn() }
}))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))

type Contract = 'classification.v1' | 'advertising.v1'
type Capture = { content: string; provenance?: unknown }
const confirmed: Capture = {
  content: 'The current-turn final report cites the observed source.',
  provenance: 'assistant_message'
}
const rejectedCaptures: { label: string; capture: Capture }[] = [
  {
    label: 'completed startup screen with API 429',
    capture: {
      content: 'Claude Code\n> Run the daily report\nAPI Error: 429 rate_limit_error',
      provenance: 'terminal_capture'
    }
  },
  {
    label: 'legacy report without provenance',
    capture: { content: 'The report claims completion, but its capture source is unknown.' }
  },
  {
    label: 'tool output',
    capture: {
      content: '{"type":"tool_result","content":"All checks passed"}',
      provenance: 'terminal_capture'
    }
  },
  {
    label: 'provider error',
    capture: { content: 'API Error: 529 overloaded_error', provenance: 'terminal_capture' }
  },
  {
    label: 'unproven assistant-looking terminal text',
    capture: { content: confirmed.content, provenance: 'terminal_capture' }
  },
  {
    label: 'unknown provenance value',
    capture: { content: confirmed.content, provenance: 'assistant_response' }
  }
]

function classificationResult(sourceRevision: string): RoutineStructuredResult {
  return {
    protocol: 'routine-classification.v1',
    routineId: 'routine-1',
    runId: 'run-1',
    sourceRevision,
    evaluatedAt: Date.now(),
    status: 'ready',
    reason: null,
    verdict: 'PASS',
    severity: 'INFO',
    confidence: 0.9,
    provider: 'typesafe',
    model: 'fixture'
  }
}

function fixture(contract: Contract, capture: Capture = confirmed) {
  const envelope = advertisingTestEnvelope()
  const automation = {
    id: envelope.routineId,
    prompt: 'Read the trusted source',
    executionTargetType: 'local',
    executionTargetId: 'local',
    structuredOutput:
      contract === 'classification.v1'
        ? { provider: 'typesafe', contract }
        : { provider: 'typesafe', contract, advertising: { ...envelope.policy } }
  } as Automation
  const run = {
    id: envelope.runId,
    automationId: automation.id,
    status: 'completed',
    outputSnapshot: {
      format: 'plain_text',
      capturedAt: Date.now(),
      truncated: false,
      ...capture
    }
  } as AutomationRun
  const source = routineDecisionSourceRevision(automation, run)
  const classification = classificationResult(source)
  const section = contract === 'classification.v1' ? 'classification' : 'advertising'
  const resultKey = `result:${automation.id}:${run.id}:${section}`
  const saved =
    contract === 'classification.v1' ? { source, result: classification } : { source, envelope }
  const stored = new Map<string, unknown>()
  const records = {
    read: vi.fn(async <T>(kind: string, key: string, schema: ZodType<T>) => {
      const parsed = schema.safeParse(stored.get(`${kind}:${key}`))
      return parsed.success ? parsed.data : null
    }),
    write: vi.fn(async <T>(kind: string, key: string, value: T, schema: ZodType<T>) => {
      stored.set(`${kind}:${key}`, structuredClone(schema.parse(value)))
    })
  }
  const configuration = parseDecisionConfiguration({
    version: 1,
    enabled: true,
    capabilities: {
      'routine.structured': { mode: 'live' },
      'advertising.routine': { mode: 'live' }
    }
  })
  const evaluate = vi.fn()
  const notify = vi.fn()
  const service = new RoutineDecisionService({
    store: {
      listAutomations: () => [automation],
      listAutomationRuns: () => [run],
      automationOwnerPrecondition: () => ({ selector: { kind: 'self' } })
    } as unknown as Store,
    service: { evaluate } as unknown as DecisionService,
    configuration: () => configuration,
    records: records as unknown as DecisionRecords,
    notify
  })
  const read = () =>
    contract === 'classification.v1'
      ? service.classification(automation.id, run.id)
      : service.advertising(automation.id, run.id)
  return {
    service,
    read,
    run,
    envelope,
    classification,
    resultKey,
    saved,
    stored,
    records,
    configuration,
    evaluate,
    notify
  }
}

function expectNoInference(f: ReturnType<typeof fixture>) {
  expect(classifyRoutineOutput).not.toHaveBeenCalled()
  expect(evaluateAdvertisingRoutine).not.toHaveBeenCalled()
  expect(f.evaluate).not.toHaveBeenCalled()
  expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
  expect(consoleAdvertisingActionsClient.preview).not.toHaveBeenCalled()
  expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date(advertisingTestEvidence.fetchedAt))
  vi.clearAllMocks()
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      principal: 'person-1',
      bearer: 'test',
      baseUrl: 'https://example.invalid',
      isCurrent: () => true
    }
  })
  vi.mocked(classifyRoutineOutput).mockImplementation(async (input) =>
    classificationResult(input.sourceRevision)
  )
  vi.mocked(evaluateAdvertisingRoutine).mockResolvedValue(advertisingTestEnvelope())
  vi.mocked(consoleAdvertisingActionsClient.verify).mockResolvedValue({
    ok: true,
    data: advertisingTestReceipt()
  })
})
afterEach(() => vi.useRealTimers())
describe.each(['classification.v1', 'advertising.v1'] as const)(
  '%s source admission',
  (contract) => {
    it.each(
      rejectedCaptures.flatMap((row) => [
        { ...row, cached: false, operation: 'inference' },
        { ...row, cached: true, operation: 'same-source cache reuse' }
      ])
    )('rejects $label before $operation', async ({ capture, cached }) => {
      const f = fixture(contract, capture)
      if (cached) {
        f.stored.set(f.resultKey, f.saved)
      }

      await expect(f.read()).rejects.toThrow('final assistant response')

      expect(f.run.status).toBe('completed')
      expectNoInference(f)
      expect(f.stored.get(f.resultKey)).toBe(cached ? f.saved : undefined)
      expect(f.records.write).not.toHaveBeenCalled()
      expect(f.notify).not.toHaveBeenCalled()
      expect(consoleAdvertisingActionsClient.verify).not.toHaveBeenCalled()
    })

    it('admits a proven final assistant message and then reuses its validated result', async () => {
      const f = fixture(contract)
      const expected = contract === 'classification.v1' ? f.classification : f.envelope
      const inference =
        contract === 'classification.v1' ? classifyRoutineOutput : evaluateAdvertisingRoutine

      await expect(f.read()).resolves.toEqual(expected)
      await expect(f.read()).resolves.toEqual(expected)

      expect(inference).toHaveBeenCalledTimes(1)
      expect(inference).toHaveBeenCalledWith(
        expect.objectContaining({ content: confirmed.content }),
        expect.any(Function)
      )
      expect(f.records.write).toHaveBeenCalledTimes(1)
      expect(f.notify).toHaveBeenCalledTimes(1)
    })
  }
)

describe('legacy submitted advertising recovery is not fresh inference', () => {
  it.each([true, false])(
    'preserves get and verify with the global live flag %s',
    async (enabled) => {
      const f = fixture('advertising.v1', { content: 'Legacy captured report without provenance.' })
      f.configuration.enabled = enabled
      f.stored.set(f.resultKey, f.saved)
      const decision = f.envelope.decisions[0]!
      const selection = {
        automationId: f.envelope.routineId,
        runId: f.envelope.runId,
        decisionId: decision.id
      }
      const binding: AdvertisingActionBinding = {
        ...selection,
        principal: f.envelope.principal,
        sourceRevision: f.envelope.sourceRevision,
        idempotencyKey: `tsa:${decision.id}`,
        preview: advertisingTestPreview(),
        submitted: true,
        receipt: null
      }
      f.stored.set(`action:${decision.id}`, binding)

      await expect(f.read()).resolves.toEqual(f.envelope)
      expect(f.records.write).not.toHaveBeenCalled()
      await expect(f.service.actions.verify(selection)).resolves.toEqual({
        receipt: advertisingTestReceipt()
      })

      expectNoInference(f)
      expect(consoleAdvertisingActionsClient.verify).toHaveBeenCalledTimes(1)
      expect(consoleAdvertisingActionsClient.verify).toHaveBeenCalledWith(
        {
          id: binding.preview.id,
          target: binding.preview.target,
          verb: 'pause'
        },
        f.envelope.principal
      )
      expect(f.stored.get(f.resultKey)).toBe(f.saved)
      expect(f.records.write).toHaveBeenCalledTimes(1)
      expect(f.records.write.mock.calls[0]?.slice(0, 2)).toEqual(['action', decision.id])
      expect(f.notify).not.toHaveBeenCalled()
      await expect(f.read()).rejects.toThrow('final assistant response')
      expectNoInference(f)
    }
  )
})
