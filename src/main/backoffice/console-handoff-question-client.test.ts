import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'
import { consoleWorkflowClient as client } from './console-workflow-client'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { isCloudSessionMutationCurrent } from '../omni-profiles/profile-cloud-session-mutation'

vi.mock('./backoffice-auth', () => ({ currentBearerToken: vi.fn() }))
vi.mock('./backoffice-config', () => ({ getBackofficeSnapshot: vi.fn() }))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-mutation', () => ({
  cloudSessionIdentity: (id: string, cloud: { userId: string }) => ({
    localProfileId: id,
    cloudUserId: cloud.userId
  }),
  captureCloudSessionMutation: vi.fn(() => ({ epoch: 1, identityKey: 'audit' })),
  isCloudSessionMutationCurrent: vi.fn()
}))

const baseUrl = 'https://console.example.test'
const fetchMock = vi.fn<typeof fetch>()
function reply(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  vi.mocked(currentBearerToken).mockResolvedValue('opaque-person-credential-sentinel')
  vi.mocked(getBackofficeSnapshot).mockReturnValue({ configured: true, env: 'production', baseUrl })
  vi.mocked(getProfileUserDataPath).mockReturnValue('/virtual/profile')
  vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
    profile: { id: 'profile-a', cloud: { userId: 'person-a' } }
  } as never)
  vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(true)
})

describe("an agent's handoff question from Work", () => {
  it("answers an agent's handoff question through the hub's decide route", async () => {
    reply({ id: 'dcn_0123abcd', status: 'done_verified' })
    expect(
      await client.decideHandoffQuestion({
        decisionId: 'dcn_0123abcd',
        action: 'reply',
        value: 'keep'
      })
    ).toMatchObject({ ok: true, data: { id: 'dcn_0123abcd', status: 'done_verified' } })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${baseUrl}/api/gtd/hub/api/decisions/dcn_0123abcd/decide`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'reply', params: { value: 'keep' } })
      })
    )
    reply({ id: 'dcn_0123abcd', status: 'denied' })
    await client.decideHandoffQuestion({
      decisionId: 'dcn_0123abcd',
      action: 'deny',
      note: 'Not needed'
    })
    expect(fetchMock).toHaveBeenLastCalledWith(
      `${baseUrl}/api/gtd/hub/api/decisions/dcn_0123abcd/decide`,
      expect.objectContaining({ body: JSON.stringify({ action: 'deny', note: 'Not needed' }) })
    )
    fetchMock.mockClear()
    // A reply names one option, Not needed names none, and the id never carries a path.
    for (const bad of [
      { decisionId: 'dcn_0123abcd', action: 'reply' },
      { decisionId: 'dcn_0123abcd', action: 'deny', value: 'keep' },
      { decisionId: '../board/btk_1', action: 'deny' },
      { decisionId: 'dcn_0123abcd', action: 'approve' }
    ]) {
      expect(
        await client.decideHandoffQuestion(
          bad as Parameters<typeof client.decideHandoffQuestion>[0]
        )
      ).toMatchObject({ ok: false })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
