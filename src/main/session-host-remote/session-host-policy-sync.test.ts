import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionHostSyncEntry } from '../../shared/session-host-sync-doc'
import { FIXTURE_HOST, FIXTURE_OTHER_HOST_ID } from '../../shared/session-host-wire-fixtures'
import {
  configureSessionHostSwitches,
  hostAutomationRefusal
} from '../session-host-owner/session-host-switches'
import { configureStewardSwitches } from '../session-steward/steward-switches'
import { SessionHostPolicySync } from './session-host-policy-sync'

let dir: string
const restore: (() => void)[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'host-policies-'))
  restore.push(configureStewardSwitches({ readSettings: () => ({}), environment: {} }))
})
afterEach(() => {
  for (const undo of restore.splice(0).toReversed()) {
    undo()
  }
  rmSync(dir, { recursive: true, force: true })
})

/** One Mac's side: its own published entries stand in for its `t` documents. */
function mac(name: string, hostId: string, clock: { now: number }) {
  const own: SessionHostSyncEntry[] = []
  const sync = new SessionHostPolicySync({
    file: join(dir, name, 'policies.json'),
    now: () => clock.now,
    publish: (entries) => {
      own.push(...entries)
    },
    ownHostId: () => hostId
  })
  return { sync, own }
}

describe('a switch set on another computer’s host', () => {
  it('stops that host’s automatic actions and reads pending until it confirms', async () => {
    const clock = { now: 1_000 }
    const studio = mac('studio', FIXTURE_HOST.hostId, clock)
    const buildBox = mac('build-box', FIXTURE_OTHER_HOST_ID, clock)
    // The Studio switches automatic actions off on the build box.
    studio.sync.onSettings({ hostPolicies: { [FIXTURE_OTHER_HOST_ID]: { automation: 'off' } } })
    expect(studio.sync.hostSwitches()).toEqual([
      {
        hostId: FIXTURE_OTHER_HOST_ID,
        automation: 'off',
        at: 1_000,
        state: 'pending',
        setHere: true
      }
    ])
    // The build box is unreachable for a while: the switch stays visibly pending.
    studio.sync.ingest([])
    expect(studio.sync.hostSwitches()[0]!.state).toBe('pending')
    // Its next sync pass hears it: its host refuses new automatic admissions.
    buildBox.sync.ingest(studio.own)
    restore.push(
      configureSessionHostSwitches({
        readSettings: () => buildBox.sync.effective({}),
        environment: {}
      })
    )
    expect(hostAutomationRefusal(null)).toMatch(/does not take automatic actions/)
    // …and confirms it; the Studio's next pass reads it applied.
    studio.sync.ingest(buildBox.own)
    expect(studio.sync.hostSwitches()[0]!.state).toBe('applied')
    // Switching it back on is a newer entry; the build box admits automation again.
    clock.now += 1_000
    studio.sync.onSettings({ hostPolicies: {} })
    buildBox.sync.ingest(studio.own)
    expect(hostAutomationRefusal(null)).toBeNull()
    await Promise.all([studio.sync.flush(), buildBox.sync.flush()])
  })

  it('applies another Mac’s folder override here, and keeps what it read across a restart', async () => {
    const clock = { now: 5 }
    const laptop = mac('laptop', FIXTURE_OTHER_HOST_ID, clock)
    laptop.sync.onSettings({ folderPolicies: { 'folder-cs': { automation: 'off' } } })
    const studio = mac('studio', FIXTURE_HOST.hostId, clock)
    studio.sync.ingest(laptop.own)
    restore.push(
      configureSessionHostSwitches({
        readSettings: () => studio.sync.effective({}),
        environment: {}
      })
    )
    expect(hostAutomationRefusal('folder-cs')).toMatch(/folder admits no automatic actions/)
    expect(hostAutomationRefusal('folder-eng')).toBeNull()
    await studio.sync.flush()
    const restarted = new SessionHostPolicySync({
      file: join(dir, 'studio', 'policies.json'),
      now: () => clock.now,
      publish: () => {},
      ownHostId: () => FIXTURE_HOST.hostId
    })
    expect(restarted.effective({}).folderPolicies).toEqual({ 'folder-cs': { automation: 'off' } })
  })
})
