import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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

const credential = 'test-planning-person'
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
  vi.mocked(currentBearerToken).mockResolvedValue(credential)
  vi.mocked(getBackofficeSnapshot).mockReturnValue({ configured: true, env: 'production', baseUrl })
  vi.mocked(getProfileUserDataPath).mockReturnValue('/virtual/profile')
  vi.mocked(ensureActiveOrcaProfile).mockReturnValue({
    profile: { id: 'profile-a', cloud: { userId: 'person-a' } }
  } as never)
  vi.mocked(isCloudSessionMutationCurrent).mockReturnValue(true)
})

afterEach(() => vi.unstubAllGlobals())

it('confirms structured planning and refuses an old server that ignores it', async () => {
  const plan = {
    version: 1 as const,
    steps: [{ id: 'review', title: 'Review release', actor_ids: ['emp_gamma'] }],
    completion_mode: 'deployment' as const,
    deployment_target: 'Staging'
  }
  const saved = { id: 'btk_audit0001', title: 'Release', status: 'open', state_revision: 8 }
  reply({ ok: true })
  reply({ ...saved, task_plan: plan, acceptance_criteria: 'Verified release' })
  expect(
    await client.updateTask({
      taskId: saved.id,
      expectedRevision: 7,
      taskPlan: plan,
      acceptanceCriteria: 'Verified release'
    })
  ).toMatchObject({ ok: true })
  expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
    expected_revision: 7,
    task_plan: plan,
    acceptance_criteria: 'Verified release'
  })
  reply({ ok: true })
  reply(saved)
  expect(
    await client.updateTask({ taskId: saved.id, expectedRevision: 8, taskPlan: plan })
  ).toMatchObject({ ok: false, error: { code: 'task_save_unconfirmed' } })
})
