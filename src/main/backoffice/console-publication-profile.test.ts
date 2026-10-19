import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import {
  captureConsoleWorkflowPerson,
  currentConsolePublicationScope
} from './console-workflow-person'
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-mutation', () => ({
  cloudSessionIdentity: (profileId: string) => ({ profileId }),
  captureCloudSessionMutation: () => 'mutation',
  isCloudSessionMutationCurrent: () => true
}))
vi.mock('./backoffice-auth', () => ({ currentBearerToken: async () => 'private-bearer' }))
vi.mock('./backoffice-config', () => ({
  getBackofficeSnapshot: () => ({ configured: true, baseUrl: 'https://console.example.com' })
}))
vi.mock('./console-workflow-credential-memory', () => ({
  rememberConsoleWorkflowCredential: () => undefined,
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
function profile(id: string) {
  vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
    profile: { id, cloud: { userId: 'same-person' } }
  } as never)
}
beforeEach(() => {
  profile('one')
  vi.mocked(getProfileUserDataPath).mockReturnValue('/private/profile-root')
})
describe('publication profile scope', () => {
  it('distinguishes IDE profiles while preserving the existing account principal', async () => {
    const first = currentConsolePublicationScope()!
    const captured = await captureConsoleWorkflowPerson()
    expect(captured.ok).toBe(true)
    if (captured.ok) {
      const data = captured.data as typeof captured.data & { organizationId?: string }
      expect({
        principal: data.principal,
        baseUrl: data.baseUrl,
        profileKey: data.profileKey,
        organizationId: data.organizationId
      }).toEqual(first)
    }
    profile('two')
    const second = currentConsolePublicationScope()!
    expect(second.principal).toBe(first.principal)
    expect(second.profileKey).not.toBe(first.profileKey)
    if (captured.ok) {
      expect(captured.data.isCurrent()).toBe(false)
    }
  })
  it('distinguishes alternate profile roots and exposes only a digest', () => {
    const first = currentConsolePublicationScope()!
    vi.mocked(getProfileUserDataPath).mockReturnValue('/private/alternate-root')
    const second = currentConsolePublicationScope()!
    expect(second.profileKey).toMatch(/^[a-f0-9]{64}$/)
    expect(second.profileKey).not.toBe(first.profileKey)
    expect(JSON.stringify(second)).not.toContain('/private/')
    expect(JSON.stringify(second)).not.toContain('private-bearer')
  })
})
