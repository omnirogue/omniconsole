import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { readTaskConversations } from './console-task-conversations'

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
  isCloudSessionMutationCurrent: vi.fn(() => true)
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
})

describe('the task-holds-conversations read', () => {
  it('reads every conversation attached to one card, normalised', async () => {
    reply({
      ok: true,
      rows: [
        {
          ledger_id: 'als_0123456789abcdef01234567',
          employee_id: 'emp_sal',
          employee_name: 'Sal',
          app: 'omni-ide',
          agent: 'claude',
          model: 'opus',
          state: 'running',
          started_at: '2026-09-15T10:00:00.000Z',
          last_activity_at: '2026-09-15T10:05:00.000Z',
          card_id: 'btk_1234abcd',
          last_action: { kind: 'tool_call', target: 'edit' },
          activity_summary: { edits: 3, commits: 1 }
        },
        { not: 'a valid row' }
      ],
      overflow: 3,
      server_time: '2026-09-15T10:06:00.000Z'
    })
    const result = await readTaskConversations({ taskId: 'btk_1234abcd' })
    expect(result).toMatchObject({
      ok: true,
      data: {
        overflow: 3,
        rows: [
          {
            ledgerId: 'als_0123456789abcdef01234567',
            employeeName: 'Sal',
            agent: 'claude',
            model: 'opus',
            state: 'running',
            lastActivityAt: '2026-09-15T10:05:00.000Z',
            lastAction: { kind: 'tool_call', target: 'edit' },
            activitySummary: { edits: 3, commits: 1 }
          }
        ]
      }
    })
    const call = fetchMock.mock.calls.at(-1)!
    expect(String(call[0])).toBe(`${baseUrl}/api/agent-sessions/by-card/btk_1234abcd`)
    expect(call[1]?.method).toBe('GET')
  })

  it('defaults overflow to zero when the envelope omits it', async () => {
    reply({
      rows: [
        {
          ledger_id: 'als_0123456789abcdef01234568',
          employee_id: 'emp_sal',
          app: 'omni-ide',
          state: 'idle',
          started_at: '2026-09-15T09:00:00.000Z',
          last_activity_at: '2026-09-15T09:05:00.000Z'
        }
      ]
    })
    const result = await readTaskConversations({ taskId: 'btk_1234abcd' })
    expect(result).toMatchObject({ ok: true, data: { overflow: 0 } })
    expect(result.ok && result.data.rows).toHaveLength(1)
  })

  it('refuses a malformed task id before any request', async () => {
    const result = await readTaskConversations({ taskId: 'not-a-task-id' })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
