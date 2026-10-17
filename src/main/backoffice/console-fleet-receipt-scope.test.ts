import { beforeEach, expect, it, vi } from 'vitest'
import { captureConsoleFleetReceiptScope } from './console-workflow-person'

const state = vi.hoisted(() => ({ user: 'user-a', org: 'org-a', epoch: 1 }))
vi.mock('./backoffice-config', () => ({
  getBackofficeSnapshot: () => ({ configured: true, baseUrl: 'https://console.example.test' })
}))
vi.mock('./backoffice-auth', () => ({ currentBearerToken: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/profile'
}))
vi.mock('../omni-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: () => ({
    profile: {
      id: 'local-profile',
      cloud: { userId: state.user, activeOrgId: state.org, cloudProfileId: 'cloud-profile' }
    }
  })
}))
vi.mock('../omni-profiles/profile-cloud-session-mutation', () => ({
  cloudSessionIdentity: (
    localProfileId: string,
    cloud: { userId: string; activeOrgId: string }
  ) => ({ localProfileId, cloudUserId: cloud.userId, organizationId: cloud.activeOrgId }),
  captureCloudSessionMutation: () => ({ epoch: state.epoch }),
  isCloudSessionMutationCurrent: (_profile: string, _path: string, mutation: { epoch: number }) =>
    mutation.epoch === state.epoch
}))

function rendererScope(user = 'user-a', org = 'org-a', backend = 'https://console.example.test') {
  return `omni.conversation-fleet.v1:${JSON.stringify(['local-profile', user, org, 'production', backend, null])}`
}

beforeEach(() => {
  state.user = 'user-a'
  state.org = 'org-a'
  state.epoch = 1
})

it('refuses legacy migration and pending writes arriving from a stale renderer identity', () => {
  expect(captureConsoleFleetReceiptScope(rendererScope())).not.toBeNull()
  expect(captureConsoleFleetReceiptScope(rendererScope('user-b'))).toBeNull()
  expect(captureConsoleFleetReceiptScope(rendererScope('user-a', 'org-b'))).toBeNull()
  expect(
    captureConsoleFleetReceiptScope(rendererScope('user-a', 'org-a', 'https://other.example.test'))
  ).toBeNull()
  expect(captureConsoleFleetReceiptScope('')).toBeNull()
})

it('keeps the durable storage key stable across login epochs but fences stale operations', () => {
  const previous = captureConsoleFleetReceiptScope(rendererScope())!
  state.epoch++
  const current = captureConsoleFleetReceiptScope(rendererScope())!
  expect(previous.key).toBe(current.key)
  expect(previous.isCurrent()).toBe(false)
  expect(current.isCurrent()).toBe(true)
  state.org = 'org-b'
  expect(current.isCurrent()).toBe(false)
  expect(captureConsoleFleetReceiptScope(rendererScope('user-a', 'org-b'))!.key).not.toBe(
    current.key
  )
})
