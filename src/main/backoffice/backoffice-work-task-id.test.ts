import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { archiveBackofficeTask, completeBackofficeTask } from './backoffice-work'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'

vi.mock('./backoffice-auth', () => ({ currentBearerToken: vi.fn() }))
vi.mock('./backoffice-config', () => ({ getBackofficeSnapshot: vi.fn() }))
vi.mock('../omni-profiles/profile-index-store', () => ({ ensureActiveOrcaProfile: vi.fn() }))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-auth-config', () => ({ getOrcaCloudAuthConfig: vi.fn() }))
vi.mock('../omni-profiles/profile-cloud-session-refresh', () => ({
  runWithFreshOrcaCloudSession: vi.fn()
}))
vi.mock('../omni-profiles/profile-cloud-client', () => ({ OrcaCloudRequestError: class {} }))

const CONFIGURED = { configured: true as const, baseUrl: 'https://omnios.example.com', message: '' }
const REFUSED = { ok: false, message: 'That is not a backoffice card id.' }

describe('complete and archive accept the one board card id spelling', () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
  beforeEach(() => {
    vi.mocked(getBackofficeSnapshot).mockReturnValue(CONFIGURED as never)
    vi.mocked(currentBearerToken).mockResolvedValue('signed-person-token')
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('completes and archives a mixed-case id the hub minted', async () => {
    await expect(completeBackofficeTask('btk_AbC123', 3)).resolves.toEqual({ ok: true })
    await expect(archiveBackofficeTask('btk_AbC123')).resolves.toEqual({ ok: true })
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]))
    expect(urls).toEqual([
      'https://omnios.example.com/api/collab/board/btk_AbC123',
      'https://omnios.example.com/api/board/btk_AbC123/archive'
    ])
  })

  it.each(['btk_x', 'btk_ab-cd', 'BTK_abcd', 'btk_abcd/../other'])(
    'refuses %s before any request is made',
    async (id) => {
      await expect(completeBackofficeTask(id, 3)).resolves.toEqual(REFUSED)
      await expect(archiveBackofficeTask(id)).resolves.toEqual(REFUSED)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )
})
