import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdvertisingDecisionEnvelope } from '../../shared/typesafe-advertising'
import { localAdvertisingActionReceipt } from '../../shared/advertising-action-provider-contract'
import type * as AdvertisingEvidenceModule from './typesafe-advertising-evidence'
import { consoleAdvertisingActionsClient } from '../backoffice/console-advertising-actions-client'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { assertLocalMetaActionAuthorized } from './local-meta-action-authority'
import { fetchAdvertisingEvidence } from './typesafe-advertising-evidence'
import {
  executeLocalStatus,
  prepareLocalStatusPreview,
  verifyLocalStatus
} from './local-meta-status-provider'
import {
  TypesafeAdvertisingActionService,
  type AdvertisingActionBinding,
  type AdvertisingActionSelection,
  type AdvertisingActionStore
} from './typesafe-advertising-actions'
import {
  localActionBinding,
  localActionEnvelope,
  localActionPreview,
  localActionReceipt
} from './local-advertising-action-service-fixtures'

vi.mock('../backoffice/console-advertising-actions-client', () => ({
  consoleAdvertisingActionsClient: { preview: vi.fn(), execute: vi.fn(), verify: vi.fn() }
}))
vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('./local-meta-action-authority', () => ({ assertLocalMetaActionAuthorized: vi.fn() }))
vi.mock('./typesafe-advertising-evidence', async (original) => ({
  ...(await original<typeof AdvertisingEvidenceModule>()),
  fetchAdvertisingEvidence: vi.fn()
}))
vi.mock('./local-meta-status-provider', () => ({
  prepareLocalStatusPreview: vi.fn(),
  executeLocalStatus: vi.fn(),
  verifyLocalStatus: vi.fn()
}))

let envelope: AdvertisingDecisionEnvelope
let envelopes: Map<string, AdvertisingDecisionEnvelope>
let actions: Map<string, AdvertisingActionBinding>
let objects: Map<string, AdvertisingActionBinding>
let store: AdvertisingActionStore
let service: TypesafeAdvertisingActionService
let enabled: boolean
let scopeCurrent: boolean
let principalCurrent: boolean
let events: string[]
let afterSave: ((binding: AdvertisingActionBinding) => void) | undefined

function selection(source = envelope): AdvertisingActionSelection {
  return { automationId: source.routineId, runId: source.runId, decisionId: source.decisions[0].id }
}

function approval(
  preview: Awaited<ReturnType<typeof prepareLocalStatusPreview>>,
  source = envelope
) {
  return {
    ...selection(source),
    previewId: preview.id,
    expectedRevision: preview.revision,
    approved: true
  }
}

function secondRun() {
  const next = structuredClone(envelope)
  next.runId = 'run-2'
  next.decisions[0].id = '6'.repeat(64)
  envelopes.set(next.runId, next)
  return next
}

function saved(source = envelope) {
  return actions.get(source.decisions[0].id)
}

function orphanedSubmission() {
  const binding = {
    ...localActionBinding(envelope),
    submitted: true,
    submittedAt: new Date().toISOString()
  }
  const snapshot = binding.preview.snapshot
  objects.set(`${snapshot.adAccountId}:${snapshot.objectId}`, structuredClone(binding))
  return binding
}

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(new Date('2026-09-20T12:00:00Z'))
  vi.resetAllMocks()
  envelope = localActionEnvelope()
  envelopes = new Map([[envelope.runId, envelope]])
  actions = new Map()
  objects = new Map()
  events = []
  enabled = true
  scopeCurrent = true
  principalCurrent = true
  afterSave = undefined
  const locks = new Map<string, Promise<unknown>>()
  store = {
    loadEnvelope: async (_routineId, runId) => envelopes.get(runId) ?? null,
    loadPolicy: async () => (enabled ? envelope.policy : null),
    loadAction: async (decisionId) => structuredClone(actions.get(decisionId) ?? null),
    saveAction: async (binding) => {
      const snapshot = binding.preview.snapshot
      events.push(binding.submitted ? 'persist-submitted' : 'persist-preview')
      if (binding.submitted) {
        objects.set(`${snapshot.adAccountId}:${snapshot.objectId}`, structuredClone(binding))
      }
      actions.set(binding.decisionId, structuredClone(binding))
      afterSave?.(binding)
    },
    captureLocalScope: (routineId, runId, verificationOnly) => ({
      routineId,
      runId,
      isCurrent: () => scopeCurrent && (verificationOnly === true || enabled),
      assertCurrent: async () => {
        if (!scopeCurrent || (verificationOnly !== true && !enabled)) {
          throw new Error('Local owner, source or live configuration changed')
        }
      }
    }),
    loadObjectAction: async (accountId, nativeId) =>
      structuredClone(objects.get(`${accountId}:${nativeId}`) ?? null),
    withObjectLock: async (accountId, nativeId, work) => {
      const key = `${accountId}:${nativeId}`
      const result = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
      locks.set(key, result)
      try {
        return await result
      } finally {
        if (locks.get(key) === result) {
          locks.delete(key)
        }
      }
    }
  }
  vi.mocked(captureConsoleWorkflowPerson).mockImplementation(async () => ({
    ok: true,
    data: {
      principal: 'person-1',
      bearer: 'synthetic-session',
      baseUrl: 'https://example.invalid',
      isCurrent: () => principalCurrent
    }
  }))
  vi.mocked(assertLocalMetaActionAuthorized).mockImplementation(async (scope) => {
    await scope.assertCurrent?.()
    if (!scope.isCurrent()) {
      throw new Error('Local action authority changed')
    }
  })
  vi.mocked(fetchAdvertisingEvidence).mockImplementation(async () => [
    structuredClone(envelope.decisions[0].evidence)
  ])
  vi.mocked(prepareLocalStatusPreview).mockImplementation(async (context) => {
    await context.assertCurrent()
    return localActionPreview(context.envelope)
  })
  vi.mocked(executeLocalStatus).mockImplementation(async (context, binding) => {
    await context.assertCurrent()
    events.push('native-send')
    expect(saved(context.envelope)?.submitted).toBe(true)
    expect(binding.submitted).toBe(true)
    expect(saved(context.envelope)?.submittedAt).toBe(new Date().toISOString())
    expect(binding.submittedAt).toBe(saved(context.envelope)?.submittedAt)
    return localActionReceipt(binding.preview)
  })
  vi.mocked(verifyLocalStatus).mockImplementation(async (context, binding) => {
    await context.assertCurrent()
    const receipt = localActionReceipt(binding.preview)
    receipt.execution!.outcome = null
    return receipt
  })
  service = new TypesafeAdvertisingActionService(store)
})

afterEach(() => {
  expect(consoleAdvertisingActionsClient.preview).not.toHaveBeenCalled()
  expect(consoleAdvertisingActionsClient.execute).not.toHaveBeenCalled()
  expect(consoleAdvertisingActionsClient.verify).not.toHaveBeenCalled()
  vi.useRealTimers()
})

describe('local status service admission', () => {
  it.each(['absent', 'missing decision'] as const)(
    'refuses an initially %s envelope even when a later read would become actionable',
    async (kind) => {
      const initial = structuredClone(envelope)
      initial.decisions = []
      const read = vi
        .spyOn(store, 'loadEnvelope')
        .mockResolvedValueOnce(kind === 'absent' ? null : initial)
      await expect(service.preview(selection())).rejects.toThrow(/decision is unavailable/)
      expect(read).toHaveBeenCalledOnce()
      expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
      expect(prepareLocalStatusPreview).not.toHaveBeenCalled()
      expect(executeLocalStatus).not.toHaveBeenCalled()
      expect(actions.size).toBe(0)
    }
  )

  it.each(['captureLocalScope', 'withObjectLock', 'loadObjectAction'] as const)(
    'fails closed without the host-owned %s primitive',
    async (missing) => {
      delete store[missing]
      await expect(service.preview(selection())).rejects.toThrow()
      expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
      expect(prepareLocalStatusPreview).not.toHaveBeenCalled()
      expect(actions.size).toBe(0)
    }
  )

  it('rejects a revoked execution scope before any source or native preview request', async () => {
    scopeCurrent = false
    await expect(service.preview(selection())).rejects.toThrow()
    expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
    expect(prepareLocalStatusPreview).not.toHaveBeenCalled()
  })

  it.each(['PAUSE', 'TURN_ON'] as const)(
    'routes %s to the local provider without promoting recommendation authority',
    async (kind) => {
      envelope = localActionEnvelope(kind)
      envelopes.set(envelope.runId, envelope)
      const result = await service.preview(selection())
      expect(result.preview.protocol_version).toBe('local-human-action.v1')
      expect(envelope.decisions[0].recommendationOnly).toBe(true)
      expect(prepareLocalStatusPreview).toHaveBeenCalledOnce()
      const { receipt } = await service.execute(approval(localActionPreview(envelope)))
      expect(receipt.status).toBe('verified')
      expect(localAdvertisingActionReceipt.parse(receipt).preview.transition.to).toBe(
        kind === 'PAUSE' ? 'paused' : 'active'
      )
      expect(executeLocalStatus).toHaveBeenCalledOnce()
      expect(events.indexOf('persist-submitted')).toBeLessThan(events.indexOf('native-send'))
    }
  )

  it('still requires approval of the exact local preview', async () => {
    await service.preview(selection())
    const request = approval(localActionPreview())
    await expect(service.execute({ ...request, approved: false })).rejects.toThrow(/Confirm/)
    await expect(
      service.execute({ ...request, previewId: `act_${'b'.repeat(32)}` })
    ).rejects.toThrow(/different|match/)
    await expect(service.execute({ ...request, expectedRevision: '7'.repeat(64) })).rejects.toThrow(
      /different|match/
    )
    expect(executeLocalStatus).not.toHaveBeenCalled()
    expect(saved()?.submitted).toBe(false)
  })

  it.each(['KEEP_RUNNING', 'NO_ACTION', 'INCREASE_BUDGET', 'DECREASE_BUDGET'] as const)(
    'cannot convert %s into a native action',
    async (kind) => {
      envelope.decisions[0].kind = kind
      envelope.decisions[0].parameters = {}
      await expect(service.preview(selection())).rejects.toThrow()
      expect(prepareLocalStatusPreview).not.toHaveBeenCalled()
      expect(executeLocalStatus).not.toHaveBeenCalled()
    }
  )

  it('refuses a local decision marked executable by its reasoning provider', async () => {
    envelope.decisions[0].recommendationOnly = false
    await expect(service.preview(selection())).rejects.toThrow()
    expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
    expect(prepareLocalStatusPreview).not.toHaveBeenCalled()
  })
})

describe('local status service one-send and recovery', () => {
  it('persists first and serializes duplicate approval clicks into one native send', async () => {
    await service.preview(selection())
    const request = approval(localActionPreview())
    await Promise.all([service.execute(request), service.execute(request)])
    expect(executeLocalStatus).toHaveBeenCalledOnce()
    expect(verifyLocalStatus).toHaveBeenCalledOnce()
    expect(saved()?.submitted).toBe(true)
    expect(events.indexOf('persist-submitted')).toBeLessThan(events.indexOf('native-send'))
  })

  it('preserves an uncertain send and restart recovery only verifies, even after the live kill switch', async () => {
    await service.preview(selection())
    vi.mocked(executeLocalStatus).mockRejectedValueOnce(new Error('Native result unknown'))
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow()
    expect(saved()?.submitted).toBe(true)
    expect(saved()?.receipt).toBeNull()
    enabled = false
    service = new TypesafeAdvertisingActionService(store)
    const { receipt } = await service.verify(selection())
    expect(receipt.status).toBe('verified')
    expect(receipt.execution?.outcome).toBeNull()
    expect(executeLocalStatus).toHaveBeenCalledOnce()
    expect(verifyLocalStatus).toHaveBeenCalledOnce()
  })

  it('cannot bypass an uncertain send through another run or service instance', async () => {
    await service.preview(selection())
    vi.mocked(executeLocalStatus).mockRejectedValueOnce(new Error('Native result unknown'))
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow()
    const next = secondRun()
    const restarted = new TypesafeAdvertisingActionService(store)
    await restarted.preview(selection(next))
    await expect(restarted.execute(approval(localActionPreview(next), next))).rejects.toThrow()
    expect(executeLocalStatus).toHaveBeenCalledOnce()
    expect(saved(next)?.submitted).toBe(false)
  })

  it('serializes different runs on one object and refuses the second when the first send is uncertain', async () => {
    await service.preview(selection())
    const next = secondRun()
    await service.preview(selection(next))
    vi.mocked(executeLocalStatus).mockRejectedValueOnce(new Error('Native result unknown'))
    const results = await Promise.allSettled([
      service.execute(approval(localActionPreview())),
      new TypesafeAdvertisingActionService(store).execute(approval(localActionPreview(next), next))
    ])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
    expect(executeLocalStatus).toHaveBeenCalledOnce()
    expect(saved()?.submitted).toBe(true)
    expect(saved(next)?.submitted).toBe(false)
  })

  it('does not verify a preview that was never submitted', async () => {
    await service.preview(selection())
    await expect(service.verify(selection())).rejects.toThrow(/no recorded|not submitted/)
    expect(verifyLocalStatus).not.toHaveBeenCalled()
    expect(executeLocalStatus).not.toHaveBeenCalled()
  })

  it('preserves the send fence if verification cannot establish native state', async () => {
    await service.preview(selection())
    vi.mocked(executeLocalStatus).mockRejectedValueOnce(new Error('Native result unknown'))
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow()
    vi.mocked(verifyLocalStatus).mockRejectedValueOnce(new Error('Native read unavailable'))
    await expect(service.verify(selection())).rejects.toThrow()
    expect(saved()?.submitted).toBe(true)
    expect(saved()?.receipt).toBeNull()
    expect(executeLocalStatus).toHaveBeenCalledOnce()
  })

  it('does not send when the durable submitted record cannot be saved', async () => {
    await service.preview(selection())
    vi.spyOn(store, 'saveAction').mockRejectedValueOnce(new Error('Storage unavailable'))
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow(
      'Storage unavailable'
    )
    expect(saved()?.submitted).toBe(false)
    expect(executeLocalStatus).not.toHaveBeenCalled()
  })

  it('requires a fresh exact approval for a reverse action after verified state', async () => {
    await service.preview(selection())
    await service.execute(approval(localActionPreview()))
    const reverse = localActionEnvelope('TURN_ON')
    reverse.runId = 'reverse-run'
    reverse.decisions[0].id = '9'.repeat(64)
    envelopes.set(reverse.runId, reverse)
    vi.mocked(fetchAdvertisingEvidence).mockResolvedValue([reverse.decisions[0].evidence])
    await service.preview(selection(reverse))
    const request = approval(localActionPreview(reverse), reverse)
    await expect(service.execute({ ...request, approved: false })).rejects.toThrow('Confirm')
    expect(executeLocalStatus).toHaveBeenCalledOnce()
    const { receipt } = await service.execute(request)
    expect(receipt.preview.verb).toBe('resume')
    expect(executeLocalStatus).toHaveBeenCalledTimes(2)
    expect(saved(reverse)?.submitted).toBe(true)
  })
})

describe('local status service revocation fences', () => {
  it.each(['kill', 'scope', 'principal'] as const)(
    'rejects %s revocation during source refresh before submit',
    async (kind) => {
      await service.preview(selection())
      vi.mocked(fetchAdvertisingEvidence).mockImplementationOnce(async () => {
        if (kind === 'kill') {
          enabled = false
        }
        if (kind === 'scope') {
          scopeCurrent = false
        }
        if (kind === 'principal') {
          principalCurrent = false
        }
        return [structuredClone(envelope.decisions[0].evidence)]
      })
      await expect(service.execute(approval(localActionPreview()))).rejects.toThrow()
      expect(executeLocalStatus).not.toHaveBeenCalled()
      expect(saved()?.submitted).toBe(false)
    }
  )

  it('rejects changed source revision after approval', async () => {
    await service.preview(selection())
    envelope.sourceRevision = '8'.repeat(64)
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow()
    expect(executeLocalStatus).not.toHaveBeenCalled()
    expect(saved()?.submitted).toBe(false)
  })

  it('rechecks the owning host immediately before sending', async () => {
    await service.preview(selection())
    await expect(
      service.execute(approval(localActionPreview()), () => {
        throw new Error('Owner changed')
      })
    ).rejects.toThrow('Owner changed')
    expect(executeLocalStatus).not.toHaveBeenCalled()
    expect(saved()?.submitted).toBe(false)
  })

  it('keeps a durable fence if authority changes while the submit record is saved', async () => {
    await service.preview(selection())
    afterSave = (binding) => {
      if (binding.submitted) {
        scopeCurrent = false
      }
    }
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow()
    expect(saved()?.submitted).toBe(true)
    expect(executeLocalStatus).not.toHaveBeenCalled()
  })

  it('refuses to publish a provider preview after its captured source scope changes', async () => {
    vi.mocked(prepareLocalStatusPreview).mockImplementationOnce(async () => {
      scopeCurrent = false
      return localActionPreview()
    })
    await expect(service.preview(selection())).rejects.toThrow()
    expect(saved()).toBeUndefined()
    expect(executeLocalStatus).not.toHaveBeenCalled()
  })

  it('does not bypass principal or owning scope for read-only unknown-send recovery', async () => {
    await service.preview(selection())
    vi.mocked(executeLocalStatus).mockRejectedValueOnce(new Error('Native result unknown'))
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow()
    enabled = false
    scopeCurrent = false
    await expect(service.verify(selection())).rejects.toThrow()
    expect(verifyLocalStatus).not.toHaveBeenCalled()
    expect(saved()?.submitted).toBe(true)
  })
})

describe('local status service orphaned durable reservation recovery', () => {
  it('recovers from an object-first crash with native reads only when its decision record is missing', async () => {
    const reservation = orphanedSubmission()
    enabled = false
    service = new TypesafeAdvertisingActionService(store)
    const { receipt } = await service.verify(selection())
    expect(receipt.status).toBe('verified')
    expect(receipt.execution?.outcome).toBeNull()
    expect(verifyLocalStatus).toHaveBeenCalledOnce()
    expect(executeLocalStatus).not.toHaveBeenCalled()
    expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
    expect(saved()?.submittedAt).toBe(reservation.submittedAt)
    expect(saved()?.preview).toEqual(reservation.preview)
  })

  it('reconciles an approval retry against an orphaned reservation without resending', async () => {
    const reservation = orphanedSubmission()
    await service.execute(approval(reservation.preview))
    expect(verifyLocalStatus).toHaveBeenCalledOnce()
    expect(executeLocalStatus).not.toHaveBeenCalled()
    expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
    expect(saved()?.submitted).toBe(true)
  })

  it('keeps the original submitted preview recoverable when review is reopened after an object-first crash', async () => {
    const reservation = orphanedSubmission()
    enabled = false
    const result = await service.preview(selection())
    expect(result.preview).toEqual(reservation.preview)
    expect(prepareLocalStatusPreview).not.toHaveBeenCalled()
    expect(fetchAdvertisingEvidence).not.toHaveBeenCalled()
    await service.verify(selection())
    expect(verifyLocalStatus).toHaveBeenCalledOnce()
    expect(executeLocalStatus).not.toHaveBeenCalled()
  })

  it('preserves the submitted preview over a newer unsubmitted same-decision record without resending', async () => {
    const reservation = orphanedSubmission()
    const replacement = localActionBinding(envelope)
    replacement.preview.id = `act_${'b'.repeat(32)}`
    actions.set(envelope.decisions[0].id, replacement)
    await expect(service.execute(approval(replacement.preview))).rejects.toThrow(/different|match/)
    expect(verifyLocalStatus).not.toHaveBeenCalled()
    await service.execute(approval(reservation.preview))
    expect(verifyLocalStatus).toHaveBeenCalledOnce()
    expect(executeLocalStatus).not.toHaveBeenCalled()
    expect(saved()?.preview.id).toBe(reservation.preview.id)
    expect(saved()?.submitted).toBe(true)
  })

  it.each(['runId', 'principal', 'sourceRevision'] as const)(
    'does not recover an orphan belonging to a different %s',
    async (field) => {
      const binding = orphanedSubmission()
      binding[field] = field === 'sourceRevision' ? 'a'.repeat(64) : 'another-owner'
      const snapshot = binding.preview.snapshot
      objects.set(`${snapshot.adAccountId}:${snapshot.objectId}`, binding)
      await expect(service.verify(selection())).rejects.toThrow(/unavailable/)
      expect(verifyLocalStatus).not.toHaveBeenCalled()
      expect(executeLocalStatus).not.toHaveBeenCalled()
    }
  )

  it('fails closed on an unreadable object fence instead of treating it as an absent action', async () => {
    await service.preview(selection())
    store.loadObjectAction = vi
      .fn<NonNullable<AdvertisingActionStore['loadObjectAction']>>()
      .mockRejectedValueOnce(new Error('Stored action is unreadable'))
    await expect(service.execute(approval(localActionPreview()))).rejects.toThrow(
      'Stored action is unreadable'
    )
    expect(executeLocalStatus).not.toHaveBeenCalled()
    expect(saved()?.submitted).toBe(false)
  })
})
