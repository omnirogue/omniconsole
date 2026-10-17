import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrganizationRecord } from '../../shared/session-organization-change'
import {
  PARITY_A,
  PARITY_B,
  PARITY_EXPECTED_HISTORY,
  PARITY_EXPECTED_UNDO,
  PARITY_STEPS,
  parityRecord,
  type ParityUndo
} from '../../shared/session-organization-host-parity-fixture'
import { hostTestClock, openTestHost, type OpenedHost } from './host-organization-test-host'

// The window runs the same scenario in session-organization-host-parity.test.ts (renderer).

let dir: string
let opened: OpenedHost

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-organization-parity-'))
  opened = openTestHost(dir, hostTestClock())
})

afterEach(async () => {
  await opened.host.flush()
  rmSync(dir, { recursive: true, force: true })
})

describe('history and Undo with no window', () => {
  it('match the window’s path step for step', async () => {
    const { host, ledger } = opened
    await host.migrate({ entries: [], complete: true })
    const applied: OrganizationRecord[] = []
    ledger.onApplied((record) => applied.push(record))
    const undos: Record<string, ParityUndo> = {}
    for (const step of PARITY_STEPS) {
      if (step.do === 'change') {
        const outcome = await host.apply({ ...step.change, opId: step.id })
        expect(outcome, step.id).toMatchObject({ status: 'applied', mode: 'headless' })
        continue
      }
      const undo = await host.undo(step.of, { mintOpId: step.id })
      undos[step.id] = {
        undone: undo.undone,
        total: undo.total,
        skipped: undo.skipped.map((entry) => entry.status)
      }
    }
    expect(applied.map(parityRecord)).toEqual(PARITY_EXPECTED_HISTORY)
    expect(undos).toEqual(PARITY_EXPECTED_UNDO)
    // The person's Undo and re-file make both placements theirs, as in the window.
    expect(host.read([PARITY_A, PARITY_B]).sessions.map((session) => session.ownership)).toEqual([
      {
        ownership: {},
        revocations: {
          placement: expect.objectContaining({ opId: 'undo-file', why: 'person/notice' }),
          title: expect.objectContaining({ opId: 'undo-retitle', why: 'person/notice' })
        }
      },
      {
        ownership: {},
        revocations: {
          placement: expect.objectContaining({ opId: 'refile', why: 'person/sidebar' })
        }
      }
    ])
  })
})
