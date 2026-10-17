import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostSnapshot } from '../../shared/session-hosts-status'
import type { SessionOwnerLedgerState } from '../../shared/session-parity'
import {
  readOwnerLedgerStates,
  readSessionParityPopulation,
  withOwnerLedgers
} from './session-parity-read'

const mocks = vi.hoisted(() => ({ snapshots: vi.fn() }))
vi.mock('../session-host-remote/remote-conversation-ledger-runtime', () => ({
  getRemoteConversationLedgerStore: () => ({ snapshots: mocks.snapshots })
}))

const READY: SessionOwnerLedgerState = {
  hostId: 'runtime:env-studio',
  generation: 'gen-1',
  revision: 4,
  source: 'window',
  state: 'ready',
  asOf: 100
}

function runtime(answer: (kind: string) => unknown) {
  return {
    requestSessionFolders: vi.fn(async (request: { kind: string }) => answer(request.kind))
  }
}

function host(hostKey: string): RemoteHostSnapshot {
  return { hostKey, kind: 'runtime', state: 'ready', capabilities: [], checkedAt: 1, counts: null }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.snapshots.mockResolvedValue([])
})

describe('session parity reads from the window (step 8)', () => {
  it("takes each paired owner's ledger state from the window", async () => {
    const window = runtime((kind) => (kind === 'readOwnerLedgers' ? [READY] : undefined))
    await expect(readOwnerLedgerStates(window)).resolves.toEqual([READY])
    expect(mocks.snapshots).not.toHaveBeenCalled()
  })

  it('falls back to the kept snapshots, as of their newest evidence, with no window or an older one', async () => {
    mocks.snapshots.mockResolvedValue([
      {
        environmentId: 'env-studio',
        set: { generation: 'gen-1', revision: 9, source: 'main' },
        asOf: 60,
        savedAt: 70
      },
      {
        environmentId: 'env-saved',
        set: { generation: 'g', revision: 1, source: 'window' },
        savedAt: 80
      },
      // Workflow records only: no ledger state to report.
      { environmentId: 'env-workflows', savedAt: 90 }
    ])
    const expected = [
      {
        hostId: 'runtime:env-studio',
        generation: 'gen-1',
        revision: 9,
        source: 'main',
        state: 'stale',
        asOf: 60
      },
      {
        hostId: 'runtime:env-saved',
        generation: 'g',
        revision: 1,
        source: 'window',
        state: 'stale',
        asOf: 80
      }
    ]
    const closed = runtime(() => {
      throw new Error('No renderer window available')
    })
    await expect(readOwnerLedgerStates(closed)).resolves.toEqual(expected)
    // An older window answers a request it does not know with nothing.
    await expect(readOwnerLedgerStates(runtime(() => undefined))).resolves.toEqual(expected)
  })

  it('reads the parity population only when the window sends one', async () => {
    const population = { rows: [], countsByHost: [], ownerLedgers: [] }
    await expect(
      readSessionParityPopulation(
        runtime((kind) => (kind === 'readParityPopulation' ? population : null))
      )
    ).resolves.toEqual(population)
    await expect(readSessionParityPopulation(runtime(() => null))).resolves.toBeNull()
    await expect(
      readSessionParityPopulation(
        runtime(() => {
          throw new Error('No renderer window available')
        })
      )
    ).resolves.toBeNull()
  })

  it("puts each owner's ledger state on its own computer's line only", () => {
    const hosts = withOwnerLedgers(
      [host('runtime:env-studio'), host('runtime:env-other'), { ...host('ssh:box'), kind: 'ssh' }],
      [READY, { ...READY, hostId: 'runtime:env-gone' }]
    )
    expect(hosts.map((entry) => entry.ledger?.hostId ?? null)).toEqual([
      'runtime:env-studio',
      null,
      null
    ])
    expect(hosts[1]).not.toHaveProperty('ledger')
  })
})
