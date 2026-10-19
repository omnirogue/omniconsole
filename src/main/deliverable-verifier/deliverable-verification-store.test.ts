import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DeliverableVerificationRecord } from '../../shared/deliverable-verification-types'
import {
  DELIVERABLE_VERIFICATIONS_FILE,
  DELIVERABLE_VERIFICATIONS_MAX,
  DeliverableVerificationStore
} from './deliverable-verification-store'

function record(
  id: string,
  extra: Partial<DeliverableVerificationRecord> = {}
): DeliverableVerificationRecord {
  return {
    id,
    paneKey: 'pane-1',
    worktreeId: 'wt-1',
    conversationKey: 'conv-1',
    host: 'local',
    turnKey: `turn-${id}`,
    requestId: 'req-1',
    requestStartedAt: 1,
    checkedAt: 2,
    checks: [
      {
        target: 'a.md',
        kind: 'file',
        source: 'request',
        claim: 'named',
        verdict: 'missing',
        detail: 'no file on this computer'
      }
    ],
    overall: 'incomplete',
    mode: 'shadow',
    action: 'would-repair',
    repairsSent: 0,
    maxRepairs: 2,
    ...extra
  }
}

describe('DeliverableVerificationStore', () => {
  it('persists, reloads and drops unreadable records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dv-store-'))
    const store = new DeliverableVerificationStore({ directory })
    store.add(record('r1'))
    store.add(record('r2', { action: 'repair-sent', promptId: 'p', token: 'abcd1234' }))
    await store.flush()
    const file = join(directory, DELIVERABLE_VERIFICATIONS_FILE)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { records: unknown[] }
    writeFileSync(file, JSON.stringify({ version: 1, records: [...saved.records, { id: 'bad' }] }))
    const reloaded = new DeliverableVerificationStore({ directory })
    reloaded.load()
    expect(reloaded.list().map((entry) => entry.id)).toEqual(['r1', 'r2'])
    expect(reloaded.repairsSent('conv-1', 'req-1')).toBe(1)
    expect(reloaded.byToken('conv-1', 'abcd1234')?.id).toBe('r2')
    expect(reloaded.forPane('pane-1').map((entry) => entry.id)).toEqual(['r2', 'r1'])
  })

  it('caps the records and marks a false alarm', () => {
    const store = new DeliverableVerificationStore({
      directory: mkdtempSync(join(tmpdir(), 'dv-cap-'))
    })
    for (let index = 0; index < DELIVERABLE_VERIFICATIONS_MAX + 5; index += 1) {
      store.add(record(`r${index}`))
    }
    expect(store.list()).toHaveLength(DELIVERABLE_VERIFICATIONS_MAX)
    expect(store.markFalseAlarm('r10', 99)?.falseAlarmAt).toBe(99)
    expect(store.markFalseAlarm('r0', 99)).toBeNull()
  })

  it('claims a repair exactly once, across instances', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dv-claim-'))
    expect(new DeliverableVerificationStore({ directory }).claimRepair('k')).toBe(true)
    expect(new DeliverableVerificationStore({ directory }).claimRepair('k')).toBe(false)
  })
})
