import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AdvertisingEvidenceModule from './typesafe-advertising-evidence'
import { consoleAdvertisingActionsClient } from '../backoffice/console-advertising-actions-client'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import {
  advertisingEvidenceRevision,
  fetchAdvertisingEvidence
} from './typesafe-advertising-evidence'
import {
  TypesafeAdvertisingActionService,
  type AdvertisingActionBinding
} from './typesafe-advertising-actions'
import {
  advertisingTestEnvelope,
  advertisingTestEvidence,
  advertisingTestLocalObservation,
  advertisingTestPolicy,
  advertisingTestPreview,
  advertisingTestReceipt
} from './typesafe-advertising-fixtures'

vi.mock('../backoffice/console-advertising-actions-client', () => ({
  consoleAdvertisingActionsClient: { preview: vi.fn(), execute: vi.fn(), verify: vi.fn() }
}))
vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('./typesafe-advertising-evidence', async (original) => ({
  ...(await original<typeof AdvertisingEvidenceModule>()),
  fetchAdvertisingEvidence: vi.fn()
}))
const selection = { automationId: 'routine-1', runId: 'run-1', decisionId: '1'.repeat(64) }
let envelope = advertisingTestEnvelope()
let saved: AdvertisingActionBinding | null
let service: TypesafeAdvertisingActionService
let enabled = true
beforeEach(() => {
  vi.useFakeTimers().setSystemTime(new Date(advertisingTestEvidence.fetchedAt))
  vi.clearAllMocks()
  envelope = advertisingTestEnvelope()
  saved = null
  enabled = true
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      principal: 'person-1',
      bearer: 'test',
      baseUrl: 'https://example.invalid',
      isCurrent: () => true
    }
  })
  vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([structuredClone(advertisingTestEvidence)])
  vi.mocked(consoleAdvertisingActionsClient.preview).mockResolvedValue({
    ok: true,
    data: advertisingTestPreview()
  })
  vi.mocked(consoleAdvertisingActionsClient.execute).mockResolvedValue({
    ok: true,
    data: advertisingTestReceipt()
  })
  vi.mocked(consoleAdvertisingActionsClient.verify).mockResolvedValue({
    ok: true,
    data: advertisingTestReceipt()
  })
  service = new TypesafeAdvertisingActionService({
    loadEnvelope: async () => envelope,
    loadPolicy: async () => (enabled ? advertisingTestPolicy : null),
    loadAction: async () => (saved ? structuredClone(saved) : null),
    saveAction: async (binding) => {
      saved = structuredClone(binding)
    }
  })
})
afterEach(() => vi.useRealTimers())
async function execute(approved = true) {
  const { preview } = await service.preview(selection)
  return service.execute({
    ...selection,
    previewId: preview.id,
    expectedRevision: preview.revision,
    approved
  })
}
describe('bound advertising action execution', () => {
  it.each([true, false])(
    'does not send local evidence to signed action authority (recommendationOnly=%s)',
    async (recommendationOnly) => {
      envelope.decisions[0].evidence.source = 'local.meta.graph'
      envelope.decisions[0].evidence.measuredAt = null
      envelope.decisions[0].evidence.observation = advertisingTestLocalObservation
      envelope.decisions[0].recommendationOnly = recommendationOnly
      await expect(service.preview(selection)).rejects.toThrow(/not eligible|unavailable/)
      expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
      expect(consoleAdvertisingActionsClient.preview).not.toHaveBeenCalled()
      expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
      expect(saved).toBeNull()
    }
  )
  it('requires explicit approval and never treats the recommendation as authority', async () => {
    await expect(execute(false)).rejects.toThrow('Confirm')
    expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
    envelope.decisions[0].kind = 'INCREASE_BUDGET'
    envelope.decisions[0].recommendationOnly = true
    await expect(service.preview(selection)).rejects.toThrow('not eligible')
  })
  it('binds the provider preview to company, account, object and hierarchy', async () => {
    const wrong = advertisingTestPreview()
    wrong.snapshot.adAccountId = 'act_999999'
    vi.mocked(consoleAdvertisingActionsClient.preview).mockResolvedValue({ ok: true, data: wrong })
    await expect(service.preview(selection)).rejects.toThrow('does not match')
    expect(saved).toBeNull()
    expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
  })
  it('refreshes metrics immediately before executing and refuses a changed source', async () => {
    const { preview } = await service.preview(selection)
    vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([
      { ...advertisingTestEvidence, metrics: { ...advertisingTestEvidence.metrics, purchases: 1 } }
    ])
    await expect(
      service.execute({
        ...selection,
        previewId: preview.id,
        expectedRevision: preview.revision,
        approved: true
      })
    ).rejects.toThrow('evidence changed')
    expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
  })
  it('compares a CBO inherited budget ceiling in account units instead of the child’s absent own budget', async () => {
    const decision = envelope.decisions[0]
    decision.evidence.budgetOwnerId = '123458'
    decision.evidenceRevision = advertisingEvidenceRevision(decision.evidence)
    vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([decision.evidence])
    const preview = advertisingTestPreview()
    preview.snapshot.dailyBudget = null
    preview.snapshot.budgetOwnerId = '123458'
    preview.financial_impact.daily_budget_ceiling = '50'
    vi.mocked(consoleAdvertisingActionsClient.preview).mockResolvedValue({
      ok: true,
      data: preview
    })
    await expect(service.preview(selection)).resolves.toEqual({ preview })
  })
  it('persists the send fence first and reconciles repeated clicks without sending twice', async () => {
    vi.mocked(consoleAdvertisingActionsClient.execute).mockImplementation(async () => {
      expect(saved?.submitted).toBe(true)
      return { ok: true, data: advertisingTestReceipt() }
    })
    const { preview } = await service.preview(selection)
    const request = {
      ...selection,
      previewId: preview.id,
      expectedRevision: preview.revision,
      approved: true
    }
    await Promise.all([service.execute(request), service.execute(request)])
    expect(consoleAdvertisingActionsClient.execute).toHaveBeenCalledTimes(1)
    expect(consoleAdvertisingActionsClient.verify).toHaveBeenCalledTimes(1)
    expect(saved?.idempotencyKey).toBe(`tsa:${selection.decisionId}`)
  })
  it('preserves unknown sends and allows later verification without fresh metrics or a resend', async () => {
    vi.mocked(consoleAdvertisingActionsClient.execute).mockResolvedValue({
      ok: false,
      error: { code: 'backoffice_unavailable', message: 'Timeout' }
    })
    await expect(execute()).rejects.toThrow('unconfirmed')
    expect(saved?.submitted).toBe(true)
    vi.setSystemTime(new Date('2026-09-20T13:00:00Z'))
    enabled = false
    const result = await service.verify(selection)
    expect(result.receipt.status).toBe('verified')
    expect(consoleAdvertisingActionsClient.execute).toHaveBeenCalledTimes(1)
  })
  it('rechecks the kill switch and owning host after evidence refresh before sending', async () => {
    const { preview } = await service.preview(selection)
    vi.mocked(fetchAdvertisingEvidence).mockImplementation(async () => {
      enabled = false
      return [structuredClone(advertisingTestEvidence)]
    })
    const request = {
      ...selection,
      previewId: preview.id,
      expectedRevision: preview.revision,
      approved: true
    }
    await expect(service.execute(request)).rejects.toThrow('unavailable')
    expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
    enabled = true
    vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([
      structuredClone(advertisingTestEvidence)
    ])
    await expect(
      service.execute(request, () => {
        throw new Error('Owner changed')
      })
    ).rejects.toThrow('Owner changed')
    expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
  })
  it('never labels a different object’s verified readback as success', async () => {
    const receipt = advertisingTestReceipt()
    receipt.execution!.verification!.observed!.objectId = '999999'
    vi.mocked(consoleAdvertisingActionsClient.execute).mockResolvedValue({
      ok: true,
      data: receipt
    })
    await expect(execute()).rejects.toThrow('does not verify')
    expect(saved?.submitted).toBe(true)
    expect(saved?.receipt).toBeNull()
  })
})
