import { describe, expect, it, vi } from 'vitest'
import type { SessionManageActor } from '../../shared/session-manage-types'
import { transferSession } from './session-manage-transfer-fixtures'

const serviceIfPresent = vi.fn()
vi.mock('../session-host/session-host-runtime', () => ({
  activeRuntimeSessionHost: () => ({ serviceIfPresent, service: serviceIfPresent })
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/omni-transfer-test-profile'
}))

const { localTransferActor, runtimeTransferHostedDeps } =
  await import('./session-transfer-runtime-hosted')

describe('which actor may act on this computer’s own session host', () => {
  it('keeps a pane or the CLI, and never relabels another computer’s actor as local', async () => {
    const pane: SessionManageActor = { kind: 'pane', paneKey: 'tab-1:leaf-1', title: 'Coordinator' }
    expect(localTransferActor(pane)).toBe(pane)
    expect(localTransferActor({ kind: 'cli' })).toEqual({ kind: 'cli' })
    // Another computer's actor (B1's `remote` kind) must never get a hosted (local) authority.
    const remote: SessionManageActor = {
      kind: 'remote',
      title: 'person on Laptop',
      computer: 'Laptop',
      peer: 'device-7',
      requester: 'person'
    }
    expect(localTransferActor(remote)).toBeNull()
    const deps = runtimeTransferHostedDeps(remote)
    expect(await deps.hostedFor!(transferSession('adopted-pane'))).toBeNull()
    expect(serviceIfPresent).not.toHaveBeenCalled()
  })
})
