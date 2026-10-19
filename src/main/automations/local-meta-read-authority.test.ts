import { open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdvertisingRoutinePolicy } from '../../shared/typesafe-advertising'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { rememberConsoleWorkflowCredential } from '../backoffice/console-workflow-credential-memory'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { resolveAcmeMetaCredential } from '../structured-decisions/decision-credential'
import { assertLocalMetaReadAuthorized, authorizeLocalMetaRead } from './local-meta-read-authority'
import {
  OLDACS_ACCOUNT_ID,
  OLDACS_COMPANY,
  OLDACS_ROUTINE_ID
} from './typesafe-advertising-local-scope'

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
const TOKEN = 'acme_meta_fixture_token_123456789'
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
const self = {
  ok: true,
  mode: 'clerk',
  company_scope: 'all',
  user: { id: grant.clerkUserId, employee_id: 'emp_sal', role: 'admin' }
}
let contents: string
let sessionCurrent: boolean
let scope: { routineId: string; runId: string; isCurrent: () => boolean }
const policy: AdvertisingRoutinePolicy = {
  company: OLDACS_COMPANY,
  accountId: OLDACS_ACCOUNT_ID,
  allowedObjectTypes: ['adset', 'ad'],
  minConfidence: 0.8,
  maxEvidenceAgeSeconds: 300
}
const file = {
  stat: vi.fn(),
  read: vi.fn(async (buffer: Buffer) => ({
    bytesRead: Buffer.from(contents).copy(buffer),
    buffer
  })),
  close: vi.fn(async () => undefined)
}

beforeEach(() => {
  vi.clearAllMocks()
  contents = JSON.stringify(grant)
  sessionCurrent = true
  scope = { routineId: OLDACS_ROUTINE_ID, runId: 'run-1', isCurrent: () => true }
  file.stat.mockImplementation(async () => ({
    isFile: () => true,
    mode: 0o100600,
    size: Buffer.byteLength(contents)
  }))
  vi.mocked(open).mockResolvedValue(file as unknown as FileHandle)
  vi.mocked(getProfileUserDataPath).mockReturnValue(PROFILE)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      baseUrl: grant.origin,
      bearer: 'fixture-session-token',
      clerkUserId: grant.clerkUserId,
      principal: 'principal-1',
      isCurrent: () => sessionCurrent
    }
  })
  vi.mocked(requestConsoleWorkflow).mockResolvedValue({ ok: true, data: self })
  vi.mocked(resolveAcmeMetaCredential).mockResolvedValue(TOKEN)
})

function expectNoCredential() {
  expect(resolveAcmeMetaCredential).not.toHaveBeenCalled()
  expect(rememberConsoleWorkflowCredential).not.toHaveBeenCalled()
}

describe('explicit private local Meta read authority', () => {
  it('requires the trusted signed self proof before reading the exact local credential', async () => {
    const authority = await authorizeLocalMetaRead(scope, policy)
    expect(authority.token).toBe(TOKEN)
    expect(authority.isCurrent()).toBe(true)
    expect(requestConsoleWorkflow).toHaveBeenCalledWith(
      '/api/me',
      'GET',
      expect.anything(),
      undefined,
      15_000,
      true,
      'principal-1',
      expect.any(Function)
    )
    expect(vi.mocked(requestConsoleWorkflow).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(resolveAcmeMetaCredential).mock.invocationCallOrder[0]!
    )
    expect(open).toHaveBeenCalledWith(
      join(PROFILE, 'local-meta-read-authority.json'),
      expect.any(Number)
    )
    expect(rememberConsoleWorkflowCredential).toHaveBeenCalledWith(TOKEN)
    await expect(authority.assertCurrent()).resolves.toBeUndefined()
  })

  it('authorizes cached visibility with signed proof but without opening the provider credential', async () => {
    await expect(assertLocalMetaReadAuthorized(scope, policy)).resolves.toBeUndefined()
    expect(requestConsoleWorkflow).toHaveBeenCalledOnce()
    expectNoCredential()
  })

  it.each([{ routineId: 'another-routine' }, { runId: '' }, { isCurrent: () => false }])(
    'refuses an unbound run before profile, identity, or credential reads: %j',
    async (patch) => {
      await expect(authorizeLocalMetaRead({ ...scope, ...patch }, policy)).rejects.toThrow(
        'not authorized'
      )
      expect(open).not.toHaveBeenCalled()
      expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
      expectNoCredential()
    }
  )

  it.each([{ accountId: 'act_1000000000000002' }, { company: 'betacorp' as const }])(
    'refuses a different policy account or company: %j',
    async (patch) => {
      await expect(authorizeLocalMetaRead(scope, { ...policy, ...patch })).rejects.toThrow(
        'not authorized'
      )
      expect(open).not.toHaveBeenCalled()
      expectNoCredential()
    }
  )

  it.each([
    { enabled: false },
    { employeeId: 'emp_other' },
    { routineId: 'another-routine' },
    { accountId: 'act_1000000000000002' },
    { company: 'betacorp' },
    { origin: 'https://untrusted.invalid' },
    { clerkUserId: 'user_other123' },
    { unknown: true }
  ])(
    'never auto-enrolls the current subject over a missing or mismatched grant: %j',
    async (patch) => {
      contents = JSON.stringify({ ...grant, ...patch })
      await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
      expect(requestConsoleWorkflow).not.toHaveBeenCalled()
      expectNoCredential()
    }
  )

  it('refuses an absent private grant without creating or falling back to one', async () => {
    vi.mocked(open).mockRejectedValueOnce(new Error('ENOENT'))
    await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expectNoCredential()
  })

  it.each([
    { isFile: () => false, mode: 0o100600, size: 1 },
    { isFile: () => true, mode: 0o100600, size: 4097 },
    { isFile: () => true, mode: 0o100600, size: 4096 }
  ])(
    'refuses nonregular, oversized, or incomplete private configuration reads',
    async (metadata) => {
      file.stat.mockResolvedValue(metadata)
      await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
      expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
      expectNoCredential()
    }
  )

  it.skipIf(process.platform === 'win32')('requires owner-private POSIX permissions', async () => {
    file.stat.mockResolvedValue({ isFile: () => true, mode: 0o100644, size: 1 })
    await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
    expect(file.read).not.toHaveBeenCalled()
    expectNoCredential()
  })

  it.each([
    { ...self, ok: false },
    { ...self, mode: 'local' },
    { ...self, company_scope: undefined },
    { ...self, company_scope: null },
    { ...self, company_scope: 'omnirogue' },
    { ...self, company_scope: 'scoped' },
    { ...self, user: { ...self.user, id: 'user_other123' } },
    { ...self, user: { ...self.user, employee_id: 'emp_other' } },
    { ...self, user: { ...self.user, role: 'pending' } },
    { ok: true }
  ])('refuses an unproven or mismatched authenticated self response', async (identity) => {
    vi.mocked(requestConsoleWorkflow).mockResolvedValue({ ok: true, data: identity })
    await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
    expectNoCredential()
  })

  it('pins the trusted origin before sending the identity request', async () => {
    const captured = await captureConsoleWorkflowPerson()
    if (!captured.ok) {
      throw new Error('fixture')
    }
    vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
      ok: true,
      data: { ...captured.data, baseUrl: 'https://untrusted.invalid' }
    })
    await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
    expect(requestConsoleWorkflow).not.toHaveBeenCalled()
    expectNoCredential()
  })

  it('refuses a revoked bearer without treating profile metadata as proof', async () => {
    vi.mocked(requestConsoleWorkflow).mockResolvedValue({
      ok: false,
      error: { code: 'not_authorized', message: 'Expired' }
    })
    await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
    expectNoCredential()
  })

  it('rechecks the private grant after signed identity resolves and before the vault', async () => {
    vi.mocked(requestConsoleWorkflow).mockImplementation(async () => {
      contents = JSON.stringify({ ...grant, enabled: false })
      return { ok: true, data: self }
    })
    await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
    expectNoCredential()
  })

  it('does not release a token if the run loses authority during the vault read', async () => {
    vi.mocked(resolveAcmeMetaCredential).mockImplementation(async () => {
      scope.isCurrent = () => false
      return TOKEN
    })
    await expect(authorizeLocalMetaRead(scope, policy)).rejects.toThrow('not authorized')
    expect(rememberConsoleWorkflowCredential).not.toHaveBeenCalled()
  })

  it('permanently invalidates a read after config revocation, including when restored', async () => {
    const authority = await authorizeLocalMetaRead(scope, policy)
    contents = JSON.stringify({ ...grant, enabled: false })
    await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
    contents = JSON.stringify(grant)
    expect(authority.isCurrent()).toBe(false)
    await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
  })

  it.each(['session', 'profile', 'run'] as const)(
    'fences a changed %s after provider reads',
    async (change) => {
      const authority = await authorizeLocalMetaRead(scope, policy)
      if (change === 'session') {
        sessionCurrent = false
      }
      if (change === 'profile') {
        vi.mocked(getProfileUserDataPath).mockReturnValue('different-profile')
      }
      if (change === 'run') {
        scope.runId = 'another-run'
      }
      expect(authority.isCurrent()).toBe(false)
      await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
    }
  )
})
