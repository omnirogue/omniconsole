import { describe, expect, it } from 'vitest'
import { assessRetirement, ENABLE_FLAG, runCli } from './vendor-retirement-check.mjs'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const HOUR = 60 * 60 * 1000
const iso = (time) => new Date(time).toISOString()
const resource = {
  provider: 'provider',
  accountId: 'account',
  instanceId: 'legacy-email',
  contractId: 'contract'
}
const reviewFields = [
  'migrationResult',
  'naturalWorkerRuns',
  'routesAndDependencies',
  'backupRestore',
  'protectedSessions',
  'telemetryHandoff',
  'currentInvoice',
  'contractAndNotice',
  'destinationCosts'
]

function completePacket() {
  const evidence = Object.fromEntries(
    [...reviewFields, 'exactChangeApproval', 'providerCancellation', 'nextInvoice'].map((field) => [
      field,
      {
        status: 'verified',
        reference: `receipt:${field}`,
        observedAt: iso(NOW),
        resource: { ...resource }
      }
    ])
  )
  evidence.exactChangeApproval.effectiveAt = iso(NOW - 72 * HOUR)
  evidence.naturalWorkerRuns.effectiveAt = iso(NOW - 48 * HOUR)
  evidence.providerCancellation.effectiveAt = iso(NOW - 24 * HOUR)
  evidence.nextInvoice.effectiveAt = iso(NOW - HOUR)
  return {
    schemaVersion: 1,
    candidateId: 'C01',
    resource: { ...resource },
    workerCutoverAt: iso(NOW - 72 * HOUR),
    evidence,
    clients: [
      {
        id: 'fleet-client',
        verdict: 'live',
        dependencyResolved: true,
        reference: 'host:bridge-removed',
        observedAt: iso(NOW)
      }
    ]
  }
}

const assess = (packet, phase = 'review') => assessRetirement(packet, { now: NOW, phase })
const blockedAt = (result, field) =>
  expect(result.blockers.some((blocker) => blocker.field === field)).toBe(true)

describe('email-server retirement evidence', () => {
  it('accepts a review packet without claiming cancellation or savings', () => {
    const packet = completePacket()
    delete packet.evidence.providerCancellation
    delete packet.evidence.nextInvoice
    expect(assess(packet)).toEqual({
      candidateId: 'C01',
      phase: 'review',
      status: 'ready_for_review',
      authorizesCancellation: false,
      blockers: []
    })
    expect(assess(packet, 'closure').status).toBe('blocked')
  })

  it.each(reviewFields)('blocks a missing %s receipt', (field) => {
    const packet = completePacket()
    delete packet.evidence[field]
    blockedAt(assess(packet), `evidence.${field}`)
  })

  it.each(['pending', 'failed', 'unknown', true])('rejects evidence status %s', (status) => {
    const packet = completePacket()
    packet.evidence.backupRestore.status = status
    blockedAt(assess(packet), 'evidence.backupRestore')
  })

  it.each([48 * HOUR - 1, 0, -HOUR])(
    'blocks cutover age %d before the full observation period',
    (age) => {
      const packet = completePacket()
      packet.workerCutoverAt = iso(NOW - age)
      blockedAt(assess(packet), 'workerCutoverAt')
    }
  )

  it('accepts the exact 48-hour boundary', () => {
    const packet = completePacket()
    packet.workerCutoverAt = iso(NOW - 48 * HOUR)
    expect(assess(packet).status).toBe('ready_for_review')
  })

  it('rejects a natural worker run from before cutover even with a fresh readback', () => {
    const packet = completePacket()
    packet.evidence.naturalWorkerRuns.effectiveAt = iso(NOW - 73 * HOUR)
    blockedAt(assess(packet), 'evidence.naturalWorkerRuns.effectiveAt')
  })

  it.each(['2026-10-17', '2026-10-14T12:00:00', '2026-02-30T12:00:00Z', null, 1792000000000])(
    'rejects invalid UTC cutover %s',
    (value) => {
      const packet = completePacket()
      packet.workerCutoverAt = value
      blockedAt(assess(packet), 'workerCutoverAt')
    }
  )

  it.each([NOW + 1, NOW - 24 * HOUR - 1, NOW - 96 * HOUR])(
    'blocks stale, future or pre-cutover readback %d',
    (time) => {
      const packet = completePacket()
      packet.evidence.naturalWorkerRuns.observedAt = iso(time)
      blockedAt(assess(packet), 'evidence.naturalWorkerRuns.observedAt')
    }
  )

  it.each(['provider', 'accountId', 'instanceId', 'contractId'])(
    'rejects evidence from another %s',
    (field) => {
      const packet = completePacket()
      packet.evidence.currentInvoice.resource[field] = 'another'
      blockedAt(assess(packet), `evidence.currentInvoice.resource.${field}`)
      delete packet.resource[field]
      blockedAt(assess(packet), `resource.${field}`)
    }
  )

  it('preserves an unreachable client as unverifiable even if resolution is claimed', () => {
    const packet = completePacket()
    packet.clients[0].verdict = 'unverifiable'
    blockedAt(assess(packet), 'clients[0].verdict')
  })

  it('requires a fresh resolution receipt even for an exited client', () => {
    const packet = completePacket()
    packet.clients[0].verdict = 'exited'
    packet.clients[0].dependencyResolved = false
    packet.clients[0].observedAt = iso(NOW - 25 * HOUR)
    blockedAt(assess(packet), 'clients[0]')
    blockedAt(assess(packet), 'clients[0].observedAt')
  })

  it('rejects omitted inventories and duplicate client identities', () => {
    const packet = completePacket()
    packet.clients.push({ ...packet.clients[0] })
    blockedAt(assess(packet), 'clients[1]')
    delete packet.clients
    blockedAt(assess(packet), 'clients')
  })

  it('requires provider confirmation and a subsequent invoice for closure', () => {
    const packet = completePacket()
    expect(assess(packet, 'closure').status).toBe('closure_evidence_complete')
    expect(assess(packet, 'closure').authorizesCancellation).toBe(false)
    for (const field of ['exactChangeApproval', 'providerCancellation', 'nextInvoice']) {
      const missing = structuredClone(packet)
      delete missing.evidence[field]
      blockedAt(assess(missing, 'closure'), `evidence.${field}`)
    }
  })

  it('rejects cancellation before the observation period or exact approval', () => {
    const packet = completePacket()
    packet.evidence.providerCancellation.effectiveAt = iso(NOW - 25 * HOUR)
    blockedAt(assess(packet, 'closure'), 'evidence.providerCancellation.effectiveAt')
    packet.evidence.providerCancellation.effectiveAt = iso(NOW - 24 * HOUR)
    packet.evidence.exactChangeApproval.effectiveAt = iso(NOW - 23 * HOUR)
    blockedAt(assess(packet, 'closure'), 'evidence.providerCancellation.effectiveAt')
  })

  it('rejects invoices at/before cancellation and future closure dates', () => {
    const packet = completePacket()
    packet.evidence.nextInvoice.effectiveAt = packet.evidence.providerCancellation.effectiveAt
    blockedAt(assess(packet, 'closure'), 'evidence.nextInvoice.effectiveAt')
    packet.evidence.providerCancellation.effectiveAt = iso(NOW + HOUR)
    blockedAt(assess(packet, 'closure'), 'evidence.providerCancellation.effectiveAt')
  })

  it.each(['naturalWorkerRuns', 'exactChangeApproval', 'providerCancellation', 'nextInvoice'])(
    'rejects a %s readback before the event it verifies',
    (field) => {
      const packet = completePacket()
      packet.evidence[field].effectiveAt = iso(NOW - HOUR)
      packet.evidence[field].observedAt = iso(NOW - 2 * HOUR)
      blockedAt(assess(packet, 'closure'), `evidence.${field}.observedAt`)
    }
  )

  it('fails closed on unsupported versions and malformed packets', () => {
    expect(assess({}).status).toBe('blocked')
    const packet = completePacket()
    packet.schemaVersion = 2
    packet.candidateId = 'C02'
    blockedAt(assess(packet), 'schemaVersion')
    blockedAt(assess(packet), 'candidateId')
    for (const value of [null, [], 'packet']) {
      expect(() => assess(value)).toThrow()
    }
  })
})

describe('read-only retirement CLI', () => {
  function invoke(args, { enabled = '1', read = () => JSON.stringify(completePacket()) } = {}) {
    const output = []
    const code = runCli(args, {
      env: { [ENABLE_FLAG]: enabled },
      read,
      write: (line) => output.push(line)
    })
    return { code, output: output.join('\n') }
  }

  it.each([undefined, '0', 'true'])(
    'stays disabled for flag %s without reading a packet',
    (enabled) => {
      const read = () => {
        throw new Error('must not read')
      }
      expect(invoke(['packet.json'], { enabled: enabled ?? '', read })).toMatchObject({ code: 3 })
    }
  )

  it('exposes help without enabling the tool', () => {
    expect(invoke(['--help'], { enabled: '' })).toMatchObject({ code: 0 })
  })

  it('generates an incomplete template without reading files or enabling assessments', () => {
    const result = invoke(['--template'], {
      enabled: '',
      read: () => {
        throw new Error('must not read')
      }
    })
    expect(result.code).toBe(0)
    const template = JSON.parse(result.output)
    expect(assess(template).status).toBe('blocked')
    expect(template.clients[0].verdict).toBe('unverifiable')
  })

  it.each(
    [
      [],
      ['--execute'],
      ['packet', '--phase', 'cancel'],
      ['packet', '--phase'],
      ['packet', '--force', 'closure']
    ].map((args) => [args])
  )('rejects invalid arguments %j', (args) => {
    expect(invoke(args).code).toBe(2)
  })

  it('returns 1 with actionable blockers and 2 for unreadable or malformed input', () => {
    const blocked = invoke(['packet.json'], { read: () => '{}' })
    expect(blocked.code).toBe(1)
    expect(JSON.parse(blocked.output).blockers.length).toBeGreaterThan(0)
    for (const read of [
      () => '{bad',
      () => 'null',
      () => {
        throw new Error('private-content')
      }
    ]) {
      const result = invoke(['packet.json'], { read })
      expect(result.code).toBe(2)
      expect(result.output).not.toContain('private-content')
    }
  })

  it('evaluates a complete packet and never echoes resource identities', () => {
    const packet = completePacket()
    const now = Date.now()
    packet.workerCutoverAt = iso(now - 72 * HOUR)
    packet.evidence.naturalWorkerRuns.effectiveAt = iso(now - HOUR)
    for (const item of Object.values(packet.evidence)) {
      item.observedAt = iso(now)
    }
    packet.clients[0].observedAt = iso(now)
    const result = invoke(['packet.json'], { read: () => JSON.stringify(packet) })
    expect(result.code).toBe(0)
    expect(result.output).not.toContain(resource.instanceId)
  })
})
