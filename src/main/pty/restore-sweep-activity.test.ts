import { afterEach, describe, expect, it } from 'vitest'
import { gatePtySpawnAgentLaunch } from '../ipc/pty/agent-launch-admission-gate'
import {
  _resetRestoreSweepActivityForTests,
  lastRestoreSweepAgentStartAt
} from './restore-sweep-activity'

// Guard off: the gate returns without queueing, so these calls never wait for a slot.
const base = {
  launchCommand: 'claude --resume abc',
  liveReattach: false,
  getSettings: () => ({ restoreFloodGuard: false })
}

afterEach(() => {
  _resetRestoreSweepActivityForTests()
})

describe('restore sweep activity', () => {
  it('notes a background resume nobody asked for on screen', async () => {
    await gatePtySpawnAgentLaunch({ ...base, resumeProviderSession: { id: 'abc' } })
    expect(lastRestoreSweepAgentStartAt()).not.toBeNull()
  })

  it('ignores a resume a person asked for and a fresh background start', async () => {
    await gatePtySpawnAgentLaunch({
      ...base,
      resumeProviderSession: { id: 'abc' },
      launchPriority: 'person'
    })
    await gatePtySpawnAgentLaunch({ ...base, launchCommand: 'claude', launchAgent: 'claude' })
    expect(lastRestoreSweepAgentStartAt()).toBeNull()
  })
})
