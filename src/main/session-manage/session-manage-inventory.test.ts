import { describe, expect, it } from 'vitest'
import { listSessionManageEntries, toSessionManageEntry } from './session-manage-inventory'
import { observeSession } from './session-manage-observe'
import { observeSources, sidebarRow } from './session-manage-test-fixtures'

describe('session list agent template', () => {
  it('reports the template a session recorded at launch', async () => {
    const agentTemplate = { id: 'advertising', name: 'Advertising', digest: 'd30fc78b9495' }
    const entry = toSessionManageEntry(
      await observeSession(sidebarRow({ agentTemplate }), observeSources())
    )
    expect(entry.agentTemplate).toEqual(agentTemplate)
  })

  it('says null when the launch recorded none, and omits it for an older window', async () => {
    const unrecorded = toSessionManageEntry(
      await observeSession(sidebarRow({ agentTemplate: null }), observeSources())
    )
    expect(unrecorded.agentTemplate).toBeNull()
    const older = toSessionManageEntry(await observeSession(sidebarRow(), observeSources()))
    expect(older).not.toHaveProperty('agentTemplate')
  })
})

describe('session list --project', () => {
  const thread = (status: 'reviewReady' | null, coordinator = false) => ({
    projectThread: { status, coordinator }
  })

  it('keeps only the project threads the window marked, with their status', async () => {
    const entries = await listSessionManageEntries(
      [
        sidebarRow({ rowKey: 'a', paneKey: 'tab-1:a', ...thread('reviewReady') }),
        sidebarRow({ rowKey: 'b', paneKey: 'tab-1:b' }),
        sidebarRow({ rowKey: 'c', paneKey: 'tab-1:c', ...thread(null, true) })
      ],
      observeSources(),
      { projectThreads: true }
    )
    expect(entries.map((entry) => [entry.paneKey, entry.projectStatus])).toEqual([
      ['tab-1:a', 'reviewReady'],
      ['tab-1:c', null]
    ])
    expect(entries[0]).not.toHaveProperty('projectCoordinator')
    expect(entries[1]?.projectCoordinator).toBe(true)
  })

  it('keeps an archived project chat but not an archived thread', async () => {
    const entries = await listSessionManageEntries(
      [
        sidebarRow({ rowKey: 'a', paneKey: 'tab-1:a', archived: true, ...thread(null) }),
        sidebarRow({ rowKey: 'c', paneKey: 'tab-1:c', archived: true, ...thread(null, true) })
      ],
      observeSources(),
      { projectThreads: true }
    )
    expect(entries.map((entry) => entry.paneKey)).toEqual(['tab-1:c'])
  })

  it('adds nothing to a list that named no project', async () => {
    const [entry] = await listSessionManageEntries([sidebarRow()], observeSources())
    expect(entry).not.toHaveProperty('projectStatus')
    expect(entry).not.toHaveProperty('projectCoordinator')
  })
})

describe('session list parity fields (session parity, step 8)', () => {
  it("carries the row's bucket fields under sidebar-counts' names, and nothing from an older window", async () => {
    const entry = toSessionManageEntry(
      await observeSession(
        sidebarRow({
          bucket: 'heldByOwner',
          ownerListed: false,
          verification: 'stale',
          identity: 'c:a1b2c3d4e5f60718293a4b5c',
          conversation: 'a1b2c3d4e5f60718293a4b5c',
          paneIdentity: 'pane:tab-1:leaf-1',
          rest: 'asleep',
          stale: true
        }),
        observeSources()
      )
    )
    expect(entry).toMatchObject({
      bucket: 'heldByOwner',
      verification: 'stale',
      identity: 'c:a1b2c3d4e5f60718293a4b5c',
      conversation: 'a1b2c3d4e5f60718293a4b5c',
      paneIdentity: 'pane:tab-1:leaf-1',
      rest: 'asleep',
      stale: true
    })
    // The relay-only convenience stays on the row.
    expect(entry).not.toHaveProperty('ownerListed')
    const older = toSessionManageEntry(await observeSession(sidebarRow(), observeSources()))
    for (const field of ['bucket', 'verification', 'identity', 'conversation', 'rest', 'stale']) {
      expect(older).not.toHaveProperty(field)
    }
  })
})
