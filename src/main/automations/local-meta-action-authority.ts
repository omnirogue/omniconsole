import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  advertisingRoutinePolicy,
  advertisingTarget,
  type AdvertisingRoutinePolicy,
  type AdvertisingTarget
} from '../../shared/typesafe-advertising'
import { rememberConsoleWorkflowCredential } from '../backoffice/console-workflow-credential-memory'
import {
  captureConsoleWorkflowPerson,
  currentConsolePublicationScope
} from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { resolveAcmeMetaCredential } from '../structured-decisions/decision-credential'
import {
  OLDACS_ACCOUNT_ID,
  OLDACS_COMPANY,
  OLDACS_ROUTINE_ID
} from './typesafe-advertising-local-scope'

const ORIGIN = 'https://console.example.com'
const REFUSAL =
  'Local Meta status actions are not authorized for this routine and signed-in person.'
const MAX_CONFIGURATION_BYTES = 4096
const clerkId = z.string().regex(/^user_[A-Za-z0-9]{5,128}$/)
const authorizationSchema = z
  .object({
    version: z.literal(1),
    enabled: z.literal(true),
    origin: z.literal(ORIGIN),
    clerkUserId: clerkId,
    employeeId: z.literal('emp_sal'),
    company: z.literal(OLDACS_COMPANY),
    accountId: z.literal(OLDACS_ACCOUNT_ID),
    routineId: z.literal(OLDACS_ROUTINE_ID),
    policy: z.literal('oldacs-human-status-v1')
  })
  .strict()
const signedPersonSchema = z.object({
  ok: z.literal(true),
  mode: z.literal('clerk'),
  company_scope: z.literal('all'),
  user: z.object({
    id: clerkId,
    employee_id: z.literal('emp_sal'),
    role: z.enum(['admin', 'member'])
  })
})

export type LocalMetaActionScope = {
  routineId: string
  runId: string
  target: AdvertisingTarget
  isCurrent(): boolean
  assertCurrent?(): Promise<void>
}

type LocalMetaActionAuthority = {
  revision: string
  isCurrent(): boolean
  assertCurrent(): Promise<void>
  assertCurrentSync(): void
}

function assertPrivateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_CONFIGURATION_BYTES ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o7777) !== 0o600 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())))
  ) {
    throw new Error(REFUSAL)
  }
}

function sameFile(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.uid === after.uid &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  )
}

function readAuthorization(path: string) {
  let file: number | undefined
  try {
    const before = lstatSync(path)
    assertPrivateFile(before)
    file = openSync(
      path,
      constants.O_RDONLY | (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0)
    )
    const opened = fstatSync(file)
    assertPrivateFile(opened)
    if (!sameFile(before, opened)) {
      throw new Error(REFUSAL)
    }
    const buffer = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1)
    const bytesRead = readSync(file, buffer, 0, buffer.length, 0)
    const after = fstatSync(file)
    const current = lstatSync(path)
    assertPrivateFile(after)
    assertPrivateFile(current)
    if (
      bytesRead !== opened.size ||
      bytesRead > MAX_CONFIGURATION_BYTES ||
      !sameFile(opened, after) ||
      !sameFile(after, current)
    ) {
      throw new Error(REFUSAL)
    }
    const bytes = buffer.subarray(0, bytesRead)
    return {
      configuration: authorizationSchema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      ),
      revision: createHash('sha256').update(bytes).digest('hex')
    }
  } catch {
    throw new Error(REFUSAL)
  } finally {
    if (file !== undefined) {
      try {
        closeSync(file)
      } catch {
        // Never expose filesystem details from the private authorization file.
      }
    }
  }
}

function captureScope(scope: LocalMetaActionScope, policy: AdvertisingRoutinePolicy) {
  const target = advertisingTarget.parse(scope.target)
  const parsedPolicy = advertisingRoutinePolicy.parse(policy)
  if (
    scope.routineId !== OLDACS_ROUTINE_ID ||
    typeof scope.runId !== 'string' ||
    scope.runId.length === 0 ||
    scope.runId.length > 200 ||
    parsedPolicy.company !== OLDACS_COMPANY ||
    parsedPolicy.accountId !== OLDACS_ACCOUNT_ID ||
    parsedPolicy.allowedObjectTypes.includes('campaign') ||
    !parsedPolicy.allowedObjectTypes.includes(target.objectType) ||
    target.company !== OLDACS_COMPANY ||
    target.accountId !== OLDACS_ACCOUNT_ID ||
    target.objectType === 'campaign'
  ) {
    throw new Error(REFUSAL)
  }
  const fingerprint = () => JSON.stringify([scope.routineId, scope.runId, scope.target, policy])
  const original = fingerprint()
  return () => scope.isCurrent() && fingerprint() === original
}

async function captureAuthority(
  scope: LocalMetaActionScope,
  policy: AdvertisingRoutinePolicy,
  expectedPrincipal: string
): Promise<LocalMetaActionAuthority> {
  let valid = true
  try {
    // Native Windows ACL verification is required before this capability can be enabled there.
    if (process.platform === 'win32') {
      throw new Error(REFUSAL)
    }
    const scopeCurrent = captureScope(scope, policy)
    if (
      !scopeCurrent() ||
      typeof expectedPrincipal !== 'string' ||
      expectedPrincipal.length === 0 ||
      expectedPrincipal.length > 200
    ) {
      throw new Error(REFUSAL)
    }
    const profilePath = getProfileUserDataPath()
    const path = join(profilePath, 'local-meta-action-authority.json')
    const saved = readAuthorization(path)
    await scope.assertCurrent?.()
    if (!scopeCurrent() || readAuthorization(path).revision !== saved.revision) {
      throw new Error(REFUSAL)
    }
    const captured = await captureConsoleWorkflowPerson()
    if (
      !captured.ok ||
      captured.data.baseUrl !== ORIGIN ||
      captured.data.clerkUserId !== saved.configuration.clerkUserId ||
      captured.data.principal !== expectedPrincipal ||
      !captured.data.profileKey
    ) {
      throw new Error(REFUSAL)
    }
    const profileKey = captured.data.profileKey
    const isCurrent = () => {
      try {
        const current = currentConsolePublicationScope()
        valid =
          valid &&
          scopeCurrent() &&
          captured.data.isCurrent() &&
          getProfileUserDataPath() === profilePath &&
          current?.baseUrl === ORIGIN &&
          current.principal === expectedPrincipal &&
          current.profileKey === profileKey
      } catch {
        valid = false
      }
      return valid
    }
    const assertCurrentSync = () => {
      try {
        if (!isCurrent() || readAuthorization(path).revision !== saved.revision || !isCurrent()) {
          throw new Error(REFUSAL)
        }
      } catch {
        valid = false
        throw new Error(REFUSAL)
      }
    }
    const assertCurrent = async () => {
      try {
        assertCurrentSync()
        await scope.assertCurrent?.()
        assertCurrentSync()
      } catch {
        valid = false
        throw new Error(REFUSAL)
      }
    }
    await assertCurrent()
    // The signed self response, not local profile metadata, proves the approved person.
    const response = await requestConsoleWorkflow(
      '/api/me',
      'GET',
      signedPersonSchema,
      undefined,
      15_000,
      true,
      expectedPrincipal,
      isCurrent
    )
    const person = signedPersonSchema.safeParse(response.ok ? response.data : null)
    if (!person.success || person.data.user.id !== saved.configuration.clerkUserId) {
      throw new Error(REFUSAL)
    }
    await assertCurrent()
    return { revision: saved.revision, isCurrent, assertCurrent, assertCurrentSync }
  } catch {
    valid = false
    throw new Error(REFUSAL)
  }
}

/** A separate action grant is mandatory; reporting authority never upgrades itself. */
export async function assertLocalMetaActionAuthorized(
  scope: LocalMetaActionScope,
  policy: AdvertisingRoutinePolicy,
  expectedPrincipal: string
): Promise<void> {
  const authority = await captureAuthority(scope, policy, expectedPrincipal)
  authority.assertCurrentSync()
}

export async function authorizeLocalMetaAction(
  scope: LocalMetaActionScope,
  policy: AdvertisingRoutinePolicy,
  expectedPrincipal: string
): Promise<LocalMetaActionAuthority & { token: string }> {
  const authority = await captureAuthority(scope, policy, expectedPrincipal)
  await authority.assertCurrent()
  let token: string | undefined
  try {
    token = await resolveAcmeMetaCredential()
  } catch {
    throw new Error('The approved local Meta status credential is unavailable.')
  }
  if (token) {
    rememberConsoleWorkflowCredential(token)
  }
  await authority.assertCurrent()
  if (!token) {
    throw new Error('The approved local Meta status credential is unavailable.')
  }
  authority.assertCurrentSync()
  return { token, ...authority }
}
