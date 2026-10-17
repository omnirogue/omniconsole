import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_LAUNCH_CANCELLED_ERROR } from '../../../pty/agent-launch-admission'
import {
  awaitPaneSpawnUnlessCancelled,
  nextPaneSpawnReservation,
  paneSpawnReservationsByOwnerKey,
  rejectPaneSpawnReservation,
  reservePaneSpawn,
  resolvePaneSpawnReservation
} from './spawn-reservation'

// Why: a pane remount while its agent start waits for an admission slot destroys the old
// transport, which cancels that start; the remounted pane's spawn is already waiting on the old
// start's pane reservation and must go ahead with its own start instead of failing with the cancel.

afterEach(() => {
  paneSpawnReservationsByOwnerKey.clear()
})

describe('waiting on a pane spawn reservation', () => {
  it('returns null (go ahead) when the reserving start was cancelled while queued', async () => {
    const reservation = reservePaneSpawn('pane-a')
    const waiting = awaitPaneSpawnUnlessCancelled(reservation)
    rejectPaneSpawnReservation('pane-a', reservation, new Error(AGENT_LAUNCH_CANCELLED_ERROR))
    await expect(waiting).resolves.toBeNull()
    // The cancelled reservation is gone, so the waiter reserves the pane for itself.
    expect(nextPaneSpawnReservation('pane-a', reservation)).toBeUndefined()
    expect(paneSpawnReservationsByOwnerKey.has('pane-a')).toBe(false)
  })

  it('still reattaches to a start that ran, and still fails on any other spawn error', async () => {
    const ran = reservePaneSpawn('pane-b')
    const reattach = awaitPaneSpawnUnlessCancelled(ran)
    resolvePaneSpawnReservation('pane-b', ran, { id: 'pty-b' })
    await expect(reattach).resolves.toMatchObject({ id: 'pty-b' })

    const failed = reservePaneSpawn('pane-c')
    const failing = awaitPaneSpawnUnlessCancelled(failed)
    rejectPaneSpawnReservation('pane-c', failed, new Error('spawn failed'))
    await expect(failing).rejects.toThrow('spawn failed')
  })

  it('waits on a newer reservation another waiter took after the cancel', () => {
    const cancelled = reservePaneSpawn('pane-d')
    rejectPaneSpawnReservation('pane-d', cancelled, new Error(AGENT_LAUNCH_CANCELLED_ERROR))
    const successor = reservePaneSpawn('pane-d')
    expect(nextPaneSpawnReservation('pane-d', cancelled)).toBe(successor)
  })
})
