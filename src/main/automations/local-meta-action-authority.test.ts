import { constants, type Stats } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdvertisingRoutinePolicy, AdvertisingTarget } from '../../shared/typesafe-advertising'
import { rememberConsoleWorkflowCredential } from '../backoffice/console-workflow-credential-memory'
import {
  captureConsoleWorkflowPerson,
  currentConsolePublicationScope
} from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { resolveAcmeMetaCredential } from '../structured-decisions/decision-credential'
import {
  assertLocalMetaActionAuthorized,
  authorizeLocalMetaAction,
  type LocalMetaActionScope
} from './local-meta-action-authority'
import {
  OLDACS_ACCOUNT_ID,
  OLDACS_COMPANY,
  OLDACS_ROUTINE_ID
} from './typesafe-advertising-local-scope'

const filesystem = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  openSync: vi.fn(),
  fstatSync: vi.fn(),
  readSync: vi.fn(),
  closeSync: vi.fn()
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFs>()),
  ...filesystem
}))
vi.mock('../backoffice/console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  currentConsolePublicationScope: vi.fn()
}))
vi.mock('../backoffice/console-workflow-transport', () => ({ requestConsoleWorkflow: vi.fn() }))
vi.mock('../backoffice/console-workflow-credential-memory', () => ({
  rememberConsoleWorkflowCredential: vi.fn()
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({ getProfileUserDataPath: vi.fn() }))
vi.mock('../structured-decisions/decision-credential', () => ({
  resolveAcmeMetaCredential: vi.fn()
}))

const PROFILE = join('fixture-profile', 'private-data')
const PRINCIPAL = 'a'.repeat(64)
const PROFILE_KEY = 'b'.repeat(64)
const TOKEN = 'local_action_fixture_token_123456789'
const grant = {
  version: 1,
  enabled: true,
  origin: 'https://console.example.com',
  clerkUserId: 'user_reviewed123',
  employeeId: 'emp_sal',
  company: OLDACS_COMPANY,
  accountId: OLDACS_ACCOUNT_ID,
  routineId: OLDACS_ROUTINE_ID,
  policy: 'oldacs-human-status-v1'
}
const self = {
  ok: true,
  mode: 'clerk',
  company_scope: 'all',
  user: { id: grant.clerkUserId, employee_id: 'emp_sal', role: 'admin' }
}
const target: AdvertisingTarget = {
  company: OLDACS_COMPANY,
  accountId: OLDACS_ACCOUNT_ID,
  objectType: 'ad',
  nativeId: '12345',
  campaignId: '34567',
  adsetId: '23456'
}
const policy: AdvertisingRoutinePolicy = {
  company: OLDACS_COMPANY,
  accountId: OLDACS_ACCOUNT_ID,
  allowedObjectTypes: ['adset', 'ad'],
  minConfidence: 0.8,
  maxEvidenceAgeSeconds: 300
}
let contents: Buffer
let sessionCurrent: boolean
let scope: LocalMetaActionScope

function metadata(patch: Partial<Stats> = {}): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100600,
    uid: process.getuid?.() ?? 0,
    dev: 1,
    ino: 2,
    size: contents.length,
    mtimeMs: 1,
    ctimeMs: 1,
    ...patch
  } as Stats
}

function setGrant(patch: Record<string, unknown> = {}) {
  contents = Buffer.from(JSON.stringify({ ...grant, ...patch }))
}

beforeEach(() => {
  vi.resetAllMocks()
  setGrant()
  sessionCurrent = true
  scope = {
    routineId: OLDACS_ROUTINE_ID,
    runId: 'run-1',
    target: { ...target },
    isCurrent: () => true
  }
  filesystem.lstatSync.mockImplementation(() => metadata())
  filesystem.openSync.mockReturnValue(7)
  filesystem.fstatSync.mockImplementation(() => metadata())
  filesystem.readSync.mockImplementation(
    (_fd: number, buffer: Buffer, offset: number, length: number, position: number) =>
      contents.copy(buffer, offset, position, position + length)
  )
  vi.mocked(getProfileUserDataPath).mockReturnValue(PROFILE)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      baseUrl: grant.origin,
      bearer: 'fixture-session-token',
      clerkUserId: grant.clerkUserId,
      principal: PRINCIPAL,
      profileKey: PROFILE_KEY,
      isCurrent: () => sessionCurrent
    }
  })
  vi.mocked(currentConsolePublicationScope).mockReturnValue({
    principal: PRINCIPAL,
    baseUrl: grant.origin,
    profileKey: PROFILE_KEY
  })
  vi.mocked(requestConsoleWorkflow).mockResolvedValue({ ok: true, data: self })
  vi.mocked(resolveAcmeMetaCredential).mockResolvedValue(TOKEN)
})

function authorize() {
  return authorizeLocalMetaAction(scope, policy, PRINCIPAL)
}

function expectNoCredential() {
  expect(resolveAcmeMetaCredential).not.toHaveBeenCalled()
  expect(rememberConsoleWorkflowCredential).not.toHaveBeenCalled()
}

describe.skipIf(process.platform === 'win32')(
  'explicit private local Meta action authority',
  () => {
    it.each(['admin', 'member'])(
      'requires signed self proof before releasing the local credential for an approved %s',
      async (role) => {
        vi.mocked(requestConsoleWorkflow).mockResolvedValue({
          ok: true,
          data: { ...self, user: { ...self.user, role } }
        })
        const authority = await authorize()
        expect(authority.token).toBe(TOKEN)
        expect(authority.revision).toMatch(/^[a-f0-9]{64}$/)
        expect(authority.isCurrent()).toBe(true)
        expect(requestConsoleWorkflow).toHaveBeenCalledWith(
          '/api/me',
          'GET',
          expect.anything(),
          undefined,
          15_000,
          true,
          PRINCIPAL,
          expect.any(Function)
        )
        expect(vi.mocked(requestConsoleWorkflow).mock.invocationCallOrder[0]).toBeLessThan(
          vi.mocked(resolveAcmeMetaCredential).mock.invocationCallOrder[0]!
        )
        expect(rememberConsoleWorkflowCredential).toHaveBeenCalledWith(TOKEN)
        await expect(authority.assertCurrent()).resolves.toBeUndefined()
        expect(() => authority.assertCurrentSync()).not.toThrow()
        expect(requestConsoleWorkflow).toHaveBeenCalledOnce()
      }
    )

    it('checks cached authorization without reading or remembering the provider credential', async () => {
      await expect(
        assertLocalMetaActionAuthorized(scope, policy, PRINCIPAL)
      ).resolves.toBeUndefined()
      expect(requestConsoleWorkflow).toHaveBeenCalledOnce()
      expectNoCredential()
    })

    it('opens only the explicit action grant without following links', async () => {
      await authorize()
      expect(filesystem.openSync).toHaveBeenCalledWith(
        join(PROFILE, 'local-meta-action-authority.json'),
        expect.any(Number)
      )
      const flags = filesystem.openSync.mock.calls[0]![1] as number
      if (constants.O_NONBLOCK !== undefined) {
        expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK)
      }
      if (constants.O_NOFOLLOW !== undefined) {
        expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
      }
      expect(filesystem.closeSync.mock.calls.length).toBe(filesystem.openSync.mock.calls.length)
    })

    it.each([
      { routineId: 'another-routine' },
      { runId: '' },
      { runId: 'r'.repeat(201) },
      { isCurrent: () => false }
    ])('refuses an unbound run before profile or identity access: %j', async (patch) => {
      scope = { ...scope, ...patch }
      await expect(authorize()).rejects.toThrow('not authorized')
      expect(filesystem.openSync).not.toHaveBeenCalled()
      expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
      expectNoCredential()
    })

    it.each([
      { accountId: 'act_1000000000000002' },
      { company: 'betacorp' as const },
      { allowedObjectTypes: ['adset'] as AdvertisingRoutinePolicy['allowedObjectTypes'] },
      { allowedObjectTypes: ['campaign', 'ad'] as AdvertisingRoutinePolicy['allowedObjectTypes'] }
    ])('refuses policy mismatches before reading the private grant: %j', async (patch) => {
      await expect(
        authorizeLocalMetaAction(scope, { ...policy, ...patch }, PRINCIPAL)
      ).rejects.toThrow('not authorized')
      expect(filesystem.openSync).not.toHaveBeenCalled()
      expectNoCredential()
    })

    it.each([
      { company: 'betacorp' as const },
      { accountId: 'act_1000000000000002' },
      { objectType: 'campaign' as const, nativeId: '34567', adsetId: null },
      { objectType: 'adset' as const, adsetId: '23456' },
      { nativeId: 'invalid' },
      { adsetId: null }
    ])('does not confer authority on an unsafe or different target: %j', async (patch) => {
      scope.target = { ...target, ...patch }
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it('allows a valid ad-set target without broadening the policy', async () => {
      scope.target = { ...target, objectType: 'adset', nativeId: '23456' }
      await expect(authorize()).resolves.toMatchObject({ token: TOKEN })
    })

    it.each(['', 'p'.repeat(201)])('requires a bounded expected principal', async (principal) => {
      await expect(authorizeLocalMetaAction(scope, policy, principal)).rejects.toThrow(
        'not authorized'
      )
      expect(filesystem.openSync).not.toHaveBeenCalled()
      expectNoCredential()
    })

    it.each([
      { version: 2 },
      { enabled: false },
      { employeeId: 'emp_other' },
      { routineId: 'another-routine' },
      { accountId: 'act_1000000000000002' },
      { company: 'betacorp' },
      { origin: 'https://untrusted.invalid' },
      { clerkUserId: 'user_other123' },
      { policy: 'oldacs-read-v1' },
      { unknown: true }
    ])(
      'never substitutes enrollment or read-only grants for exact action authority: %j',
      async (patch) => {
        setGrant(patch)
        await expect(authorize()).rejects.toThrow('not authorized')
        expect(requestConsoleWorkflow).not.toHaveBeenCalled()
        expectNoCredential()
      }
    )

    it('requires the action-specific policy field even when the read grant otherwise matches', async () => {
      const { policy: _actionPolicy, ...readGrant } = grant
      contents = Buffer.from(JSON.stringify(readGrant))
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it.each(['lstatSync', 'openSync', 'fstatSync', 'readSync'] as const)(
      'sanitizes %s failures and never falls back to credential presence',
      async (operation) => {
        filesystem[operation].mockImplementation(() => {
          throw new Error(`private-provider-detail ${TOKEN}`)
        })
        await expect(authorize()).rejects.toThrow('not authorized')
        await expect(authorize()).rejects.not.toThrow(TOKEN)
        expectNoCredential()
        if (operation === 'fstatSync' || operation === 'readSync') {
          expect(filesystem.closeSync).toHaveBeenCalledWith(7)
        }
      }
    )

    it.each([
      { isFile: () => false },
      { isFile: () => false, isSymbolicLink: () => true },
      { size: 4097 },
      { size: -1 }
    ])('refuses nonregular, linked, or invalid-sized configuration: %j', async (patch) => {
      filesystem.lstatSync.mockImplementation(() => metadata(patch))
      await expect(authorize()).rejects.toThrow('not authorized')
      expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
      expectNoCredential()
    })

    it
      .skipIf(process.platform === 'win32')
      .each([0o100644, 0o100640, 0o100700, 0o100400, 0o104600])(
      'requires exact owner-only read/write mode instead of %o',
      async (mode) => {
        filesystem.lstatSync.mockImplementation(() => metadata({ mode }))
        filesystem.fstatSync.mockImplementation(() => metadata({ mode }))
        await expect(authorize()).rejects.toThrow('not authorized')
        expect(filesystem.readSync).not.toHaveBeenCalled()
        expectNoCredential()
      }
    )

    it.skipIf(process.platform === 'win32' || process.getuid === undefined)(
      'requires the current file owner',
      async () => {
        const uid = (process.getuid?.() ?? 0) + 1
        filesystem.lstatSync.mockImplementation(() => metadata({ uid }))
        filesystem.fstatSync.mockImplementation(() => metadata({ uid }))
        await expect(authorize()).rejects.toThrow('not authorized')
        expectNoCredential()
      }
    )

    it.each(['dev', 'ino', 'mode', 'uid', 'size', 'mtimeMs', 'ctimeMs'] as const)(
      'refuses a changed %s between lstat and descriptor inspection',
      async (field) => {
        const first = metadata()
        filesystem.fstatSync.mockReturnValue(metadata({ [field]: first[field] + 1 }))
        await expect(authorize()).rejects.toThrow('not authorized')
        expect(filesystem.closeSync).toHaveBeenCalledWith(7)
        expectNoCredential()
      }
    )

    it('refuses descriptor changes during the bounded read', async () => {
      filesystem.fstatSync.mockImplementationOnce(() => metadata())
      filesystem.fstatSync.mockImplementation(() => metadata({ mtimeMs: 2 }))
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it('refuses path replacement after reading a still-valid open descriptor', async () => {
      filesystem.lstatSync.mockImplementationOnce(() => metadata())
      filesystem.lstatSync.mockImplementation(() => metadata({ ino: 3 }))
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it('refuses incomplete reads instead of parsing a shorter successful-looking grant', async () => {
      filesystem.readSync.mockImplementation((_fd: number, buffer: Buffer) => {
        contents.copy(buffer)
        return contents.length - 1
      })
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it.each(['empty', 'json', 'utf8'] as const)('refuses malformed %s content', async (kind) => {
      contents =
        kind === 'empty'
          ? Buffer.alloc(0)
          : kind === 'json'
            ? Buffer.from('{')
            : Buffer.concat([contents, Buffer.from([0xff])])
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it.each([
      { ...self, ok: false },
      { ...self, mode: 'local' },
      { ...self, company_scope: undefined },
      { ...self, company_scope: 'omnirogue' },
      { ...self, user: { ...self.user, id: 'user_other123' } },
      { ...self, user: { ...self.user, employee_id: 'emp_other' } },
      { ...self, user: { ...self.user, role: 'pending' } },
      { ok: true }
    ])('refuses an unproven or mismatched signed self response', async (identity) => {
      vi.mocked(requestConsoleWorkflow).mockResolvedValue({ ok: true, data: identity })
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it.each([
      { baseUrl: 'https://untrusted.invalid' },
      { principal: 'another-principal' },
      { profileKey: undefined },
      { clerkUserId: 'user_other123' }
    ])('pins captured principal, profile and origin before introspection: %j', async (patch) => {
      const captured = await captureConsoleWorkflowPerson()
      if (!captured.ok) {
        throw new Error('fixture')
      }
      vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
        ok: true,
        data: { ...captured.data, ...patch }
      })
      await expect(authorize()).rejects.toThrow('not authorized')
      expect(requestConsoleWorkflow).not.toHaveBeenCalled()
      expectNoCredential()
    })

    it('rejects signed-out or revoked sessions without reading a provider credential', async () => {
      vi.mocked(requestConsoleWorkflow).mockResolvedValue({
        ok: false,
        error: { code: 'not_authorized', message: 'Expired' }
      })
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it('refuses failed person capture before signed introspection', async () => {
      vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
        ok: false,
        error: { code: 'signed_in_required', message: 'Sign in' }
      })
      await expect(authorize()).rejects.toThrow('not authorized')
      expect(requestConsoleWorkflow).not.toHaveBeenCalled()
      expectNoCredential()
    })

    it('rechecks grant revocation after signed introspection before the vault read', async () => {
      vi.mocked(requestConsoleWorkflow).mockImplementation(async () => {
        setGrant({ enabled: false })
        return { ok: true, data: self }
      })
      await expect(authorize()).rejects.toThrow('not authorized')
      expectNoCredential()
    })

    it('does not release a token if scope authority changes during the vault read', async () => {
      vi.mocked(resolveAcmeMetaCredential).mockImplementation(async () => {
        scope.isCurrent = () => false
        return TOKEN
      })
      await expect(authorize()).rejects.toThrow('not authorized')
      expect(rememberConsoleWorkflowCredential).toHaveBeenCalledWith(TOKEN)
    })

    it('fails closed when the locally approved credential is absent', async () => {
      vi.mocked(resolveAcmeMetaCredential).mockResolvedValue(undefined)
      await expect(authorize()).rejects.toThrow()
      expect(rememberConsoleWorkflowCredential).not.toHaveBeenCalled()
    })

    it('does not expose credential-resolver failures', async () => {
      vi.mocked(resolveAcmeMetaCredential).mockRejectedValue(new Error(`credential ${TOKEN}`))
      await expect(authorize()).rejects.toThrow('credential is unavailable')
      await expect(authorize()).rejects.not.toThrow(TOKEN)
    })

    it.each(['sync', 'async'] as const)(
      'latches a detected private grant revocation across restoration through %s checks',
      async (check) => {
        const authority = await authorize()
        setGrant({ enabled: false })
        if (check === 'sync') {
          expect(() => authority.assertCurrentSync()).toThrow('not authorized')
        } else {
          await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
        }
        setGrant()
        expect(authority.isCurrent()).toBe(false)
        expect(() => authority.assertCurrentSync()).toThrow('not authorized')
        await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
      }
    )

    it('treats changed grant bytes as a revision change even when the decoded grant is equivalent', async () => {
      const authority = await authorize()
      contents = Buffer.from(JSON.stringify(grant, null, 2))
      expect(() => authority.assertCurrentSync()).toThrow('not authorized')
      expect(authority.isCurrent()).toBe(false)
    })

    it.each([
      'session',
      'profile',
      'principal',
      'profileKey',
      'run',
      'target',
      'hierarchy'
    ] as const)('fences a changed %s before any later write', async (change) => {
      const authority = await authorize()
      if (change === 'session') {
        sessionCurrent = false
      }
      if (change === 'profile') {
        vi.mocked(getProfileUserDataPath).mockReturnValue('other-profile')
      }
      if (change === 'run') {
        scope.runId = 'another-run'
      }
      if (change === 'target') {
        scope.target.nativeId = '45678'
      }
      if (change === 'hierarchy') {
        scope.target.campaignId = '45678'
      }
      if (change === 'principal' || change === 'profileKey') {
        vi.mocked(currentConsolePublicationScope).mockReturnValue({
          principal: change === 'principal' ? 'c'.repeat(64) : PRINCIPAL,
          baseUrl: grant.origin,
          profileKey: change === 'profileKey' ? 'c'.repeat(64) : PROFILE_KEY
        })
      }
      expect(() => authority.assertCurrentSync()).toThrow('not authorized')
      expect(authority.isCurrent()).toBe(false)
      expect(requestConsoleWorkflow).toHaveBeenCalledOnce()
    })

    it('runs the asynchronous source guard and rechecks the grant after it resolves', async () => {
      const guard = vi.fn(async () => undefined)
      scope.assertCurrent = guard
      const authority = await authorize()
      guard.mockImplementation(async () => {
        setGrant({ enabled: false })
      })
      await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
      expect(authority.isCurrent()).toBe(false)
    })

    it('does not start an asynchronous source check after synchronous revocation', async () => {
      const guard = vi.fn(async () => undefined)
      scope.assertCurrent = guard
      const authority = await authorize()
      guard.mockClear()
      setGrant({ enabled: false })
      await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
      expect(guard).not.toHaveBeenCalled()
    })

    it('latches a detected session change even if its current predicate later recovers', async () => {
      const authority = await authorize()
      sessionCurrent = false
      expect(authority.isCurrent()).toBe(false)
      sessionCurrent = true
      expect(authority.isCurrent()).toBe(false)
      expect(() => authority.assertCurrentSync()).toThrow('not authorized')
    })

    it('latches policy changes after capture even when the target remains permitted', async () => {
      const mutablePolicy = { ...policy, allowedObjectTypes: [...policy.allowedObjectTypes] }
      const authority = await authorizeLocalMetaAction(scope, mutablePolicy, PRINCIPAL)
      mutablePolicy.minConfidence = 0.9
      expect(() => authority.assertCurrentSync()).toThrow('not authorized')
      expect(authority.isCurrent()).toBe(false)
    })

    it('latches asynchronous source failure instead of accepting a subsequent recovery', async () => {
      const guard = vi.fn(async () => undefined)
      scope.assertCurrent = guard
      const authority = await authorize()
      guard.mockRejectedValueOnce(new Error('source is no longer current'))
      await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
      await expect(authority.assertCurrent()).rejects.toThrow('not authorized')
      expect(authority.isCurrent()).toBe(false)
    })
  }
)

it.runIf(process.platform === 'win32')(
  'refuses Windows action authority until equivalent native ACL proof exists',
  async () => {
    await expect(authorize()).rejects.toThrow('not authorized')
    await expect(assertLocalMetaActionAuthorized(scope, policy, PRINCIPAL)).rejects.toThrow(
      'not authorized'
    )
    expect(filesystem.lstatSync).not.toHaveBeenCalled()
    expect(filesystem.openSync).not.toHaveBeenCalled()
    expect(getProfileUserDataPath).not.toHaveBeenCalled()
    expect(captureConsoleWorkflowPerson).not.toHaveBeenCalled()
    expect(requestConsoleWorkflow).not.toHaveBeenCalled()
    expectNoCredential()
  }
)
