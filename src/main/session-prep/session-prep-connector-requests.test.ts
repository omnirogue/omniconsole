import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  SessionPrepRequests,
  type ConnectorRegistration,
  type RequestParams
} from './session-prep-requests'
import { SessionPrepStore } from './session-prep-store'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
const params: RequestParams = {
  text: '  Research the topic.\nKeep my words.  ',
  requestId: 'connector:emp_sal:operation-1',
  source: { worktreeId: 'folder:work', paneKey: 'connector:emp_sal:operation-1', agent: 'codex' },
  context: ''
}
const registration: ConnectorRegistration = {
  operator: 'emp_sal',
  digest: 'signed-request-digest',
  nonce: 'e2b79bdd-907a-4f4e-ae34-a5f75c0ad520',
  expiresAt: 1300,
  statusOnly: false,
  launch: {
    managedToolsFile: '/state/descriptor.json',
    nativeOperationId: `1760400000000-${'a'.repeat(32)}`,
    resultsFolder: '/state/results',
    title: 'Research'
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'connector-prep-'))
  directories.push(directory)
  const store = new SessionPrepStore(directory)
  const schedule = vi.fn()
  const requests = new SessionPrepRequests(
    store,
    () => 1000000,
    () => 'batch-1',
    schedule
  )
  return { directory, store, schedule, requests }
}
it('consumes a nonce durably, rejects concurrent and restarted replays, and permits status without scheduling', async () => {
  const { directory, requests, schedule } = await fixture()
  const results = await Promise.allSettled([
    requests.requestDurable(params, registration),
    requests.requestDurable(params, registration)
  ])
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((x) => x.status === 'rejected')).toHaveLength(1)
  expect(schedule).toHaveBeenCalledTimes(1)
  const restarted = new SessionPrepRequests(
    new SessionPrepStore(directory),
    () => 1000000,
    () => 'wrong',
    schedule
  )
  await expect(restarted.requestDurable(params, registration)).rejects.toThrow('already consumed')
  await expect(
    restarted.requestDurable(params, { ...registration, statusOnly: true })
  ).resolves.toEqual({ batchId: 'batch-1' })
  expect(schedule).toHaveBeenCalledTimes(1)
  await expect(
    restarted.requestDurable(params, {
      ...registration,
      nonce: '330db0ca-2762-4685-926e-ae316f1af34d'
    })
  ).rejects.toThrow('already accepted')
})
it('status cannot create work, change authority, or use an expired assertion', async () => {
  const { requests, schedule } = await fixture()
  await expect(
    requests.requestDurable(params, { ...registration, statusOnly: true })
  ).rejects.toThrow('not been accepted')
  await requests.requestDurable(params, registration)
  await expect(
    requests.requestDurable(params, { ...registration, statusOnly: true, digest: 'other' })
  ).rejects.toThrow('different work')
  await expect(
    requests.requestDurable(params, { ...registration, statusOnly: true, expiresAt: 1000 })
  ).rejects.toThrow('expired')
  expect(schedule).toHaveBeenCalledTimes(1)
})
it('refuses a corrupt nonce ledger and never schedules after a failed acceptance write', async () => {
  const { directory, requests, store, schedule } = await fixture()
  await writeFile(join(directory, 'connector-nonces.json'), 'corrupt')
  await expect(requests.requestDurable(params, registration)).rejects.toThrow()
  expect(schedule).not.toHaveBeenCalled()
  await writeFile(join(directory, 'connector-nonces.json'), '[]')
  vi.spyOn(store, 'persist').mockRejectedValueOnce(new Error('disk full'))
  await expect(requests.requestDurable(params, registration)).rejects.toThrow('disk full')
  await expect(requests.requestDurable(params, registration)).rejects.toThrow('already consumed')
  expect(schedule).not.toHaveBeenCalled()
})
