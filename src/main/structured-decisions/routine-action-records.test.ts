import { createHash } from 'node:crypto'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  localActionBinding,
  localActionEnvelope,
  localActionReceipt
} from '../automations/local-advertising-action-service-fixtures'
import {
  advertisingTestEnvelope,
  advertisingTestPreview,
  advertisingTestReceipt
} from '../automations/typesafe-advertising-fixtures'
import type { AdvertisingActionBinding } from '../automations/typesafe-advertising-actions'
import { DecisionRecords } from './decision-records'
import {
  readAdvertisingObjectAction,
  writeAdvertisingActionBinding
} from './routine-action-records'
import { actionBindingSchema, hasUnresolvedAdvertisingAction } from './routine-decision-records'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, open: vi.fn(actual.open) }
})

const forbiddenIo = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Journal fixtures must not access credentials or providers.')
  })
)
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: forbiddenIo
}))
vi.mock('../automations/typesafe-advertising-coordinator', () => ({
  fetchCoordinatorAdvertisingEvidence: forbiddenIo
}))
vi.mock('../automations/local-meta-read-authority', () => ({
  authorizeLocalMetaRead: forbiddenIo
}))
vi.mock('../automations/typesafe-advertising-local-meta-evidence', () => ({
  fetchLocalMetaEvidence: forbiddenIo
}))

let directory: string
let records: DecisionRecords

beforeEach(async () => {
  const actualFs = await vi.importActual<typeof FsPromises>('node:fs/promises')
  vi.mocked(open).mockReset().mockImplementation(actualFs.open)
  directory = await mkdtemp(join(tmpdir(), 'omni-advertising-action-journal-'))
  records = new DecisionRecords(directory)
})

afterEach(async () => {
  expect(forbiddenIo).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function submittedBinding() {
  const binding = localActionBinding()
  return { ...binding, submitted: true, submittedAt: binding.preview.created_at }
}

function nextRunBinding() {
  const envelope = localActionEnvelope('TURN_ON')
  envelope.runId = 'run-2'
  envelope.decisions[0].id = '6'.repeat(64)
  const binding = localActionBinding(envelope)
  binding.preview.id = `act_${'b'.repeat(32)}`
  return binding
}

function readObject(binding: ReturnType<typeof localActionBinding>, store = records) {
  return readAdvertisingObjectAction(
    store,
    binding.preview.snapshot.adAccountId,
    binding.preview.snapshot.objectId
  )
}

function objectRecordPath(binding: ReturnType<typeof localActionBinding>) {
  const snapshot = binding.preview.snapshot
  const key = `native-object:${snapshot.adAccountId}:${snapshot.objectId}`
  return join(directory, `action-${createHash('sha256').update(key).digest('hex')}.json`)
}

function signedBinding(): AdvertisingActionBinding {
  const envelope = advertisingTestEnvelope()
  return {
    automationId: envelope.routineId,
    runId: envelope.runId,
    decisionId: envelope.decisions[0].id,
    principal: envelope.principal,
    sourceRevision: envelope.sourceRevision,
    idempotencyKey: `tsa:${envelope.decisions[0].id}`,
    preview: advertisingTestPreview(),
    submitted: true,
    receipt: advertisingTestReceipt()
  }
}

describe('advertising action journal', () => {
  it('round-trips an unresolved native send by decision and object after a restart', async () => {
    const binding = submittedBinding()
    await writeAdvertisingActionBinding(records, binding)

    const restarted = new DecisionRecords(directory)
    await expect(
      restarted.read('action', binding.decisionId, actionBindingSchema)
    ).resolves.toEqual(binding)
    await expect(readObject(binding, restarted)).resolves.toEqual(binding)
  })

  it('durably writes the native-object fence before the per-decision binding', async () => {
    const binding = submittedBinding()
    const write = vi.spyOn(records, 'write')

    await writeAdvertisingActionBinding(records, binding)

    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[0][0]).toBe('action')
    expect(write.mock.calls[0][1]).not.toBe(binding.decisionId)
    expect(write.mock.calls[1][0]).toBe('action')
    expect(write.mock.calls[1][1]).toBe(binding.decisionId)
    await expect(readObject(binding)).resolves.toEqual(binding)
  })

  it('retains the object fence after the decision write fails and the process restarts', async () => {
    const binding = submittedBinding()
    const write = records.write.bind(records)
    vi.spyOn(records, 'write')
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('Decision record unavailable'))

    await expect(writeAdvertisingActionBinding(records, binding)).rejects.toThrow(
      'Decision record unavailable'
    )

    const restarted = new DecisionRecords(directory)
    await expect(
      restarted.read('action', binding.decisionId, actionBindingSchema)
    ).resolves.toBeNull()
    await expect(readObject(binding, restarted)).resolves.toEqual(binding)
  })

  it('does not publish a decision binding when the object fence cannot be saved', async () => {
    const binding = submittedBinding()
    const write = vi.spyOn(records, 'write').mockRejectedValueOnce(new Error('Fence unavailable'))

    await expect(writeAdvertisingActionBinding(records, binding)).rejects.toThrow(
      'Fence unavailable'
    )

    expect(write).toHaveBeenCalledOnce()
    await expect(
      records.read('action', binding.decisionId, actionBindingSchema)
    ).resolves.toBeNull()
    await expect(readObject(binding)).resolves.toBeNull()
  })

  it('finds an uncertain old run through a new decision for the same native object', async () => {
    const binding = submittedBinding()
    const next = nextRunBinding()
    await writeAdvertisingActionBinding(records, binding)

    expect(next.runId).not.toBe(binding.runId)
    expect(next.decisionId).not.toBe(binding.decisionId)
    await expect(readObject(next, new DecisionRecords(directory))).resolves.toEqual(binding)
    await expect(records.read('action', next.decisionId, actionBindingSchema)).resolves.toBeNull()
  })

  it('does not let a new preview erase an unresolved object fence or authorize another send', async () => {
    const binding = submittedBinding()
    const next = nextRunBinding()
    await writeAdvertisingActionBinding(records, binding)
    await writeAdvertisingActionBinding(records, next)
    const restarted = new DecisionRecords(directory)

    await expect(readObject(next, restarted)).resolves.toEqual(binding)
    await expect(
      writeAdvertisingActionBinding(restarted, {
        ...next,
        submitted: true,
        submittedAt: next.preview.created_at
      })
    ).rejects.toThrow(/durable native object send fence/)

    await expect(readObject(next, restarted)).resolves.toEqual(binding)
    await expect(restarted.read('action', next.decisionId, actionBindingSchema)).resolves.toEqual(
      next
    )
  })

  it('records verified native observation without claiming action causality', async () => {
    const binding = submittedBinding()
    await writeAdvertisingActionBinding(records, binding)
    binding.receipt = localActionReceipt(binding.preview)

    await writeAdvertisingActionBinding(records, binding)

    const saved = await readObject(binding, new DecisionRecords(directory))
    expect(saved).toEqual(binding)
    expect(saved?.receipt?.execution?.verification).toMatchObject({
      status: 'verified',
      claim: 'target_state_observed',
      causality: 'unproven'
    })
  })

  it('allows a new exact approval after the previous object action is verified', async () => {
    const binding = submittedBinding()
    binding.receipt = localActionReceipt(binding.preview)
    await writeAdvertisingActionBinding(records, binding)
    const nextPreview = nextRunBinding()
    const next = {
      ...nextPreview,
      submitted: true,
      submittedAt: nextPreview.preview.created_at
    }

    await writeAdvertisingActionBinding(records, next)

    await expect(readObject(next, new DecisionRecords(directory))).resolves.toEqual(next)
    await expect(records.read('action', binding.decisionId, actionBindingSchema)).resolves.toEqual(
      binding
    )
    await expect(records.read('action', next.decisionId, actionBindingSchema)).resolves.toEqual(
      next
    )
  })

  it('does not let late verification of an old decision overwrite a newer submitted fence', async () => {
    const binding = submittedBinding()
    binding.receipt = localActionReceipt(binding.preview)
    await writeAdvertisingActionBinding(records, binding)
    const nextPreview = nextRunBinding()
    const next = {
      ...nextPreview,
      submitted: true,
      submittedAt: nextPreview.preview.created_at
    }
    await writeAdvertisingActionBinding(records, next)

    await expect(writeAdvertisingActionBinding(records, binding)).rejects.toThrow(
      /durable native object send fence/
    )

    await expect(readObject(next)).resolves.toEqual(next)
    await expect(records.read('action', next.decisionId, actionBindingSchema)).resolves.toEqual(
      next
    )
  })

  it('does not confuse another account or native object with an unresolved action', async () => {
    const binding = submittedBinding()
    await writeAdvertisingActionBinding(records, binding)

    await expect(
      readAdvertisingObjectAction(records, 'act_999999', binding.preview.snapshot.objectId)
    ).resolves.toBeNull()
    await expect(
      readAdvertisingObjectAction(records, binding.preview.snapshot.adAccountId, '999999')
    ).resolves.toBeNull()
    await expect(readObject(binding)).resolves.toEqual(binding)
  })

  it('rejects a local submitted binding without its durable timestamp before writing', async () => {
    const binding = { ...localActionBinding(), submitted: true }
    const write = vi.spyOn(records, 'write')

    await expect(writeAdvertisingActionBinding(records, binding)).rejects.toThrow(
      /submission timestamp/
    )

    expect(write).not.toHaveBeenCalled()
    await expect(readObject(binding)).resolves.toBeNull()
  })

  it('preserves the existing signed-backend preview and receipt without relabeling them', async () => {
    const binding = signedBinding()

    await writeAdvertisingActionBinding(records, binding)

    const saved = await new DecisionRecords(directory).read(
      'action',
      binding.decisionId,
      actionBindingSchema
    )
    expect(saved).toEqual(binding)
    expect(saved?.preview.protocol_version).toBe('human-action.v1')
    expect(saved?.preview).not.toHaveProperty('provider')
    expect(saved?.receipt).not.toHaveProperty('provider')
  })
})

describe('advertising object fence fail-closed reads', () => {
  it.each([
    ['empty record', Buffer.from('')],
    ['truncated JSON', Buffer.from('{"submitted":true')],
    ['invalid schema', Buffer.from('{"submitted":true}')],
    ['invalid UTF-8', Buffer.from([0xff, 0xfe])]
  ])('refuses a %s instead of admitting a new send', async (_label, contents) => {
    const binding = submittedBinding()
    await writeAdvertisingActionBinding(records, binding)
    const path = objectRecordPath(binding)
    await writeFile(path, contents)
    const restarted = new DecisionRecords(directory)
    const nextPreview = nextRunBinding()
    const next = {
      ...nextPreview,
      submitted: true,
      submittedAt: nextPreview.preview.created_at
    }

    await expect(readObject(binding, restarted)).rejects.toThrow(
      'The durable advertising action record is unavailable or invalid.'
    )
    await expect(writeAdvertisingActionBinding(restarted, next)).rejects.toThrow(
      'The durable advertising action record is unavailable or invalid.'
    )

    expect(await readFile(path)).toEqual(contents)
    await expect(restarted.read('action', next.decisionId, actionBindingSchema)).resolves.toBeNull()
  })

  it.each(['EACCES', 'EIO', 'ENOENT'])(
    'refuses an existing fence whose open fails with %s',
    async (code) => {
      const binding = submittedBinding()
      await writeAdvertisingActionBinding(records, binding)
      const original = await readFile(objectRecordPath(binding))
      const error = Object.assign(new Error('Simulated record access failure'), { code })
      vi.mocked(open).mockRejectedValueOnce(error).mockRejectedValueOnce(error)
      const nextPreview = nextRunBinding()
      const next = {
        ...nextPreview,
        submitted: true,
        submittedAt: nextPreview.preview.created_at
      }

      await expect(readObject(binding)).rejects.toThrow(/unavailable or invalid/)
      await expect(writeAdvertisingActionBinding(records, next)).rejects.toThrow(
        /unavailable or invalid/
      )

      expect(await readFile(objectRecordPath(binding))).toEqual(original)
      await expect(readObject(binding)).resolves.toEqual(binding)
      await expect(records.read('action', next.decisionId, actionBindingSchema)).resolves.toBeNull()
    }
  )

  it('refuses a non-regular object record without publishing a decision record', async () => {
    const binding = submittedBinding()
    await mkdir(objectRecordPath(binding))

    await expect(readObject(binding)).rejects.toThrow(/unavailable or invalid/)
    await expect(writeAdvertisingActionBinding(records, binding)).rejects.toThrow(
      /unavailable or invalid/
    )

    await expect(
      records.read('action', binding.decisionId, actionBindingSchema)
    ).resolves.toBeNull()
  })
})

const changedReservationFields: [string, (binding: ReturnType<typeof submittedBinding>) => void][] =
  [
    [
      'preview ID',
      (binding) => {
        binding.preview.id = `act_${'c'.repeat(32)}`
      }
    ],
    [
      'preview revision',
      (binding) => {
        binding.preview.revision = '7'.repeat(64)
      }
    ],
    [
      'idempotency key',
      (binding) => {
        binding.idempotencyKey = `tsa:${'8'.repeat(64)}`
      }
    ],
    [
      'submitted timestamp',
      (binding) => {
        binding.submittedAt = '2026-09-20T12:01:00+00:00'
      }
    ]
  ]

describe('advertising submitted reservation identity', () => {
  it.each(changedReservationFields)(
    'refuses a changed %s even when the decision ID is unchanged',
    async (_label, mutate) => {
      const binding = submittedBinding()
      await writeAdvertisingActionBinding(records, binding)
      const replacement = structuredClone(binding)
      mutate(replacement)
      const write = vi.spyOn(records, 'write')

      await expect(writeAdvertisingActionBinding(records, replacement)).rejects.toThrow(
        'The native object reservation preserves a different submitted preview.'
      )

      expect(write).not.toHaveBeenCalled()
      await expect(readObject(binding)).resolves.toEqual(binding)
      await expect(
        records.read('action', binding.decisionId, actionBindingSchema)
      ).resolves.toEqual(binding)
    }
  )
})

const wrongObjectReservations: [string, () => AdvertisingActionBinding][] = [
  ['unsubmitted preview', () => localActionBinding()],
  ['signed backend provider', signedBinding],
  [
    'different account',
    () => {
      const binding = submittedBinding()
      binding.preview.snapshot.adAccountId = 'act_999999'
      for (const ancestor of binding.preview.snapshot.ancestors) {
        ancestor.adAccountId = 'act_999999'
      }
      return binding
    }
  ],
  [
    'different native object',
    () => {
      const binding = submittedBinding()
      binding.preview.target.id = '999999'
      binding.preview.snapshot.objectId = '999999'
      binding.preview.snapshot.budgetOwnerId = '999999'
      return binding
    }
  ]
]

describe('advertising object journal key binding', () => {
  it.each(wrongObjectReservations)(
    'refuses a valid-schema record containing a %s at the selected object key',
    async (_label, fixture) => {
      const selected = submittedBinding()
      const replacement = fixture()
      expect(actionBindingSchema.safeParse(replacement).success).toBe(true)
      const contents = JSON.stringify(replacement)
      await writeFile(objectRecordPath(selected), contents)
      const write = vi.spyOn(records, 'write')

      await expect(readObject(selected)).rejects.toThrow(
        'The durable native object reservation names a different submitted action.'
      )
      await expect(hasUnresolvedAdvertisingAction(records, localActionEnvelope())).rejects.toThrow(
        'The durable native object reservation names a different submitted action.'
      )
      await expect(writeAdvertisingActionBinding(records, selected)).rejects.toThrow(
        'The durable native object reservation names a different submitted action.'
      )

      expect(write).not.toHaveBeenCalled()
      expect(await readFile(objectRecordPath(selected), 'utf8')).toBe(contents)
      await expect(
        records.read('action', selected.decisionId, actionBindingSchema)
      ).resolves.toBeNull()
    }
  )

  it.each([
    ['matching decision', '1'.repeat(64), true],
    ['different decision', '6'.repeat(64), false]
  ] as const)('retains orphan recovery only for the %s', async (_label, decisionId, expected) => {
    const binding = submittedBinding()
    const write = records.write.bind(records)
    vi.spyOn(records, 'write')
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error('Decision record unavailable'))
    await expect(writeAdvertisingActionBinding(records, binding)).rejects.toThrow(
      'Decision record unavailable'
    )
    const restarted = new DecisionRecords(directory)
    const envelope = localActionEnvelope()
    envelope.decisions[0].id = decisionId

    await expect(restarted.read('action', decisionId, actionBindingSchema)).resolves.toBeNull()
    await expect(hasUnresolvedAdvertisingAction(restarted, envelope)).resolves.toBe(expected)
    await expect(readObject(binding, restarted)).resolves.toEqual(binding)
  })
})

const mismatchedLocalBindingFields: [
  string,
  (binding: ReturnType<typeof submittedBinding>) => void
][] = [
  [
    'routine',
    (binding) => {
      binding.automationId = 'another-routine'
    }
  ],
  [
    'run',
    (binding) => {
      binding.runId = 'another-run'
    }
  ],
  [
    'decision',
    (binding) => {
      binding.decisionId = '9'.repeat(64)
    }
  ],
  [
    'principal',
    (binding) => {
      binding.principal = 'another-person'
    }
  ],
  [
    'source revision',
    (binding) => {
      binding.sourceRevision = '9'.repeat(64)
    }
  ],
  [
    'receipt ID',
    (binding) => {
      const preview = structuredClone(binding.preview)
      preview.id = `act_${'d'.repeat(32)}`
      binding.receipt = localActionReceipt(preview)
    }
  ],
  [
    'receipt revision',
    (binding) => {
      const preview = structuredClone(binding.preview)
      preview.revision = '9'.repeat(64)
      binding.receipt = localActionReceipt(preview)
    }
  ]
]

describe('advertising local action record authority binding', () => {
  it.each(mismatchedLocalBindingFields)(
    'refuses a %s that disagrees with its exact reviewed preview',
    async (_label, mutate) => {
      const binding = submittedBinding()
      const replacement = structuredClone(binding)
      mutate(replacement)
      const write = vi.spyOn(records, 'write')

      await expect(writeAdvertisingActionBinding(records, replacement)).rejects.toThrow(
        'The local action record must preserve its exact reviewed authority and decision.'
      )

      expect(write).not.toHaveBeenCalled()
      await expect(readObject(binding)).resolves.toBeNull()
    }
  )
})

const staleDecisionBindings: [string, () => ReturnType<typeof localActionBinding>][] = [
  ['unsubmitted preview', localActionBinding],
  [
    'verified receipt',
    () => {
      const binding = submittedBinding()
      binding.receipt = localActionReceipt(binding.preview)
      return binding
    }
  ]
]

describe('advertising unresolved reservation precedence', () => {
  it.each(staleDecisionBindings)(
    'recovers an interrupted submitted write despite a stale per-decision %s',
    async (_label, fixture) => {
      const stale = fixture()
      await writeAdvertisingActionBinding(records, stale)
      const submitted = submittedBinding()
      const write = records.write.bind(records)
      vi.spyOn(records, 'write')
        .mockImplementationOnce(write)
        .mockRejectedValueOnce(new Error('Decision overwrite interrupted'))

      await expect(writeAdvertisingActionBinding(records, submitted)).rejects.toThrow(
        'Decision overwrite interrupted'
      )

      const restarted = new DecisionRecords(directory)
      await expect(
        restarted.read('action', stale.decisionId, actionBindingSchema)
      ).resolves.toEqual(stale)
      await expect(readObject(submitted, restarted)).resolves.toEqual(submitted)
      await expect(hasUnresolvedAdvertisingAction(restarted, localActionEnvelope())).resolves.toBe(
        true
      )
    }
  )
})

const mismatchedRecoveryBindings: [
  string,
  (binding: ReturnType<typeof submittedBinding>) => void
][] = [
  [
    'run',
    (binding) => {
      binding.runId = 'different-run'
      binding.preview.run_id = binding.runId
    }
  ],
  [
    'principal',
    (binding) => {
      binding.principal = 'different-person'
      binding.preview.principal = binding.principal
    }
  ],
  [
    'source revision',
    (binding) => {
      binding.sourceRevision = 'e'.repeat(64)
      binding.preview.source_revision = binding.sourceRevision
    }
  ],
  [
    'decision',
    (binding) => {
      binding.decisionId = 'e'.repeat(64)
      binding.preview.decision_id = binding.decisionId
      binding.idempotencyKey = `tsa:${binding.decisionId}`
    }
  ]
]

describe('advertising unresolved reservation selection', () => {
  it.each(mismatchedRecoveryBindings)(
    'does not retain a stale unsubmitted decision for another %s reservation',
    async (_label, mutate) => {
      const selected = localActionBinding()
      await writeAdvertisingActionBinding(records, selected)
      const reservation = submittedBinding()
      mutate(reservation)
      expect(actionBindingSchema.safeParse(reservation).success).toBe(true)
      await writeFile(objectRecordPath(selected), JSON.stringify(reservation))
      const restarted = new DecisionRecords(directory)

      await expect(hasUnresolvedAdvertisingAction(restarted, localActionEnvelope())).resolves.toBe(
        false
      )
      await expect(
        restarted.read('action', selected.decisionId, actionBindingSchema)
      ).resolves.toEqual(selected)
      await expect(readObject(reservation, restarted)).resolves.toEqual(reservation)
    }
  )

  it('does not retain an unsubmitted decision for a different native target in the envelope', async () => {
    const selected = localActionBinding()
    const reservation = submittedBinding()
    await writeAdvertisingActionBinding(records, selected)
    await writeFile(objectRecordPath(selected), JSON.stringify(reservation))
    const envelope = localActionEnvelope()
    const target = envelope.decisions[0].target
    target.nativeId = '999999'
    target.adsetId = '999999'
    const restarted = new DecisionRecords(directory)

    await expect(
      readAdvertisingObjectAction(restarted, target.accountId, target.nativeId)
    ).resolves.toBeNull()
    await expect(hasUnresolvedAdvertisingAction(restarted, envelope)).resolves.toBe(false)
    await expect(readObject(reservation, restarted)).resolves.toEqual(reservation)
    await expect(
      restarted.read('action', selected.decisionId, actionBindingSchema)
    ).resolves.toEqual(selected)
  })
})
