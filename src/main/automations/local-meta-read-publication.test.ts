import { constants, closeSync, fstatSync, openSync, readSync, type Stats } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdvertisingRoutinePolicy } from '../../shared/typesafe-advertising'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { rememberConsoleWorkflowCredential } from '../backoffice/console-workflow-credential-memory'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { resolveAcmeMetaCredential } from '../structured-decisions/decision-credential'
import { prepareLocalMetaReadPublication } from './local-meta-read-authority'
import {
  OLDACS_ACCOUNT_ID,
  OLDACS_COMPANY,
  OLDACS_ROUTINE_ID
} from './typesafe-advertising-local-scope'

vi.mock('node:fs', async (original) => ({
  ...(await original<typeof NodeFs>()),
  closeSync: vi.fn(),
  fstatSync: vi.fn(),
  openSync: vi.fn(),
  readSync: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ open: vi.fn() }))
vi.mock('../backoffice/console-workflow-person', () => ({ captureConsoleWorkflowPerson: vi.fn() }))
vi.mock('../backoffice/console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))
vi.mock('../backoffice/console-workflow-credential-memory', () => ({
  rememberConsoleWorkflowCredential: vi.fn()
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../structured-decisions/decision-credential', () => ({
  resolveAcmeMetaCredential: vi.fn()
}))

const PROFILE = join('fixture-profile', 'private-data')
const DESCRIPTOR = 42
const grant = {
  version: 1,
  enabled: true,
  origin: 'https://app.omnisi.ai',
  clerkUserId: 'user_reviewed123',
  employeeId: 'emp_sal',
  company: OLDACS_COMPANY,
  accountId: OLDACS_ACCOUNT_ID,
  routineId: OLDACS_ROUTINE_ID
}
const policy: AdvertisingRoutinePolicy = {
  company: OLDACS_COMPANY,
  accountId: OLDACS_ACCOUNT_ID,
  allowedObjectTypes: ['adset', 'ad'],
  minConfidence: 0.8,
  maxEvidenceAgeSeconds: 300
}
let contents: string
let personCurrent: boolean
let scope: { routineId: string; runId: string; isCurrent(): boolean }
const metadata = (patch: Partial<Stats> = {}) =>
  ({
    isFile: () => true,
    mode: 0o100600,
    size: Buffer.byteLength(contents),
    ...patch
  }) as Stats

beforeEach(() => {
  vi.resetAllMocks()
  contents = JSON.stringify(grant)
  personCurrent = true
  scope = { routineId: OLDACS_ROUTINE_ID, runId: 'run-1', isCurrent: () => true }
  vi.mocked(open).mockResolvedValue({
    stat: async () => metadata(),
    read: async (buffer: Buffer) => ({ bytesRead: Buffer.from(contents).copy(buffer), buffer }),
    close: async () => undefined
  } as unknown as FileHandle)
  vi.mocked(openSync).mockReturnValue(DESCRIPTOR)
  vi.mocked(fstatSync).mockImplementation(() => metadata())
  vi.mocked(readSync).mockImplementation((_fd, buffer) =>
    Buffer.from(contents).copy(buffer as Buffer)
  )
  vi.mocked(getProfileUserDataPath).mockReturnValue(PROFILE)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      baseUrl: grant.origin,
      bearer: 'fixture-session-token',
      clerkUserId: grant.clerkUserId,
      principal: 'principal-1',
      isCurrent: () => personCurrent
    }
  })
  vi.mocked(requestConsoleWorkflow).mockResolvedValue({
    ok: true,
    data: {
      ok: true,
      mode: 'clerk',
      company_scope: 'all',
      user: { id: grant.clerkUserId, employee_id: grant.employeeId, role: 'admin' }
    }
  })
})
afterEach(() => {
  expect(resolveAcmeMetaCredential).not.toHaveBeenCalled()
  expect(rememberConsoleWorkflowCredential).not.toHaveBeenCalled()
})

describe('synchronous local Meta publication admission', () => {
  it('prepares signed proof then checks the same private bytes without an async gap', async () => {
    const publish = await prepareLocalMetaReadPublication(scope, policy)
    expect(requestConsoleWorkflow).toHaveBeenCalledOnce()
    expect(openSync).not.toHaveBeenCalled()
    expect(publish()).toBeUndefined()
    expect(openSync).toHaveBeenCalledWith(
      join(PROFILE, 'local-meta-read-authority.json'),
      constants.O_RDONLY | constants.O_NONBLOCK
    )
    expect(readSync).toHaveBeenCalledWith(DESCRIPTOR, expect.any(Buffer), 0, 4096, 0)
    expect(fstatSync).toHaveBeenCalledTimes(2)
    expect(closeSync).toHaveBeenCalledExactlyOnceWith(DESCRIPTOR)
    expect(requestConsoleWorkflow).toHaveBeenCalledOnce()
  })

  it.each([
    JSON.stringify({ ...grant, enabled: false }),
    JSON.stringify({ ...grant, clerkUserId: 'user_another123' }),
    `${JSON.stringify(grant)}\n`,
    '{broken-json'
  ])(
    'refuses grant revocation or revision changes after preparation and stays invalid',
    async (changed) => {
      const publish = await prepareLocalMetaReadPublication(scope, policy)
      contents = changed
      expect(publish).toThrow('not authorized')
      contents = JSON.stringify(grant)
      expect(publish).toThrow('not authorized')
      expect(openSync).toHaveBeenCalledOnce()
      expect(closeSync).toHaveBeenCalledOnce()
    }
  )

  it.each(['scope', 'person', 'profile', 'run'] as const)(
    'refuses a changed %s before file access',
    async (change) => {
      const publish = await prepareLocalMetaReadPublication(scope, policy)
      if (change === 'scope') {
        scope.isCurrent = () => false
      }
      if (change === 'person') {
        personCurrent = false
      }
      if (change === 'profile') {
        vi.mocked(getProfileUserDataPath).mockReturnValue('other-profile')
      }
      if (change === 'run') {
        scope.runId = 'other-run'
      }
      expect(publish).toThrow('not authorized')
      expect(openSync).not.toHaveBeenCalled()
    }
  )

  it('rechecks the signed session after the bounded file read', async () => {
    const publish = await prepareLocalMetaReadPublication(scope, policy)
    vi.mocked(readSync).mockImplementation((_fd, buffer) => {
      personCurrent = false
      return Buffer.from(contents).copy(buffer as Buffer)
    })
    expect(publish).toThrow('not authorized')
    expect(closeSync).toHaveBeenCalledOnce()
    personCurrent = true
    expect(publish).toThrow('not authorized')
  })

  it.each([{ isFile: () => false }, { size: 4097 }])(
    'refuses special or oversized files before reading',
    async (patch) => {
      const publish = await prepareLocalMetaReadPublication(scope, policy)
      vi.mocked(fstatSync).mockReturnValue(metadata(patch))
      expect(publish).toThrow('not authorized')
      expect(readSync).not.toHaveBeenCalled()
      expect(closeSync).toHaveBeenCalledOnce()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'refuses non-private file permissions before reading',
    async () => {
      const publish = await prepareLocalMetaReadPublication(scope, policy)
      vi.mocked(fstatSync).mockReturnValue(metadata({ mode: 0o100644 }))
      expect(publish).toThrow('not authorized')
      expect(readSync).not.toHaveBeenCalled()
      expect(closeSync).toHaveBeenCalledOnce()
    }
  )

  it('refuses an incomplete read rather than accepting a truncated prefix', async () => {
    const publish = await prepareLocalMetaReadPublication(scope, policy)
    vi.mocked(readSync).mockReturnValue(1)
    expect(publish).toThrow('not authorized')
    expect(closeSync).toHaveBeenCalledOnce()
  })

  it('refuses growth after the first stat without reading beyond 4096 bytes', async () => {
    const publish = await prepareLocalMetaReadPublication(scope, policy)
    vi.mocked(fstatSync)
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce(metadata({ size: 4097 }))
    expect(publish).toThrow('not authorized')
    expect(readSync).toHaveBeenCalledWith(DESCRIPTOR, expect.any(Buffer), 0, 4096, 0)
    expect(closeSync).toHaveBeenCalledOnce()
  })

  it.each(['open', 'stat', 'read', 'close'] as const)(
    'contains %s failures and never leaks I/O error details',
    async (operation) => {
      const publish = await prepareLocalMetaReadPublication(scope, policy)
      const failure = () => {
        throw new Error('sensitive fixture I/O details')
      }
      if (operation === 'open') {
        vi.mocked(openSync).mockImplementationOnce(failure)
      }
      if (operation === 'stat') {
        vi.mocked(fstatSync).mockImplementationOnce(failure)
      }
      if (operation === 'read') {
        vi.mocked(readSync).mockImplementationOnce(failure)
      }
      if (operation === 'close') {
        vi.mocked(closeSync).mockImplementationOnce(failure)
      }
      expect(publish).toThrow(
        'Local Meta reporting is not authorized for this routine and signed-in person.'
      )
      if (operation !== 'open') {
        expect(closeSync).toHaveBeenCalledOnce()
      }
      expect(publish).toThrow('not authorized')
      expect(openSync).toHaveBeenCalledOnce()
    }
  )
})
