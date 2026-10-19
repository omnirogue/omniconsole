import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, openSync, readSync, type Stats } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { AdvertisingRoutinePolicy } from '../../shared/typesafe-advertising'
import { rememberConsoleWorkflowCredential } from '../backoffice/console-workflow-credential-memory'
import { captureConsoleWorkflowPerson } from '../backoffice/console-workflow-person'
import { requestConsoleWorkflow } from '../backoffice/console-workflow-transport'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { resolveAcmeMetaCredential } from '../structured-decisions/decision-credential'
import {
  OLDACS_ACCOUNT_ID,
  OLDACS_COMPANY,
  OLDACS_ROUTINE_ID,
  type AdvertisingEvidenceScope
} from './typesafe-advertising-local-scope'

const ORIGIN = 'https://app.omnisi.ai'
const REFUSAL = 'Local Meta reporting is not authorized for this routine and signed-in person.'
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
    routineId: z.literal(OLDACS_ROUTINE_ID)
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

function assertPrivateAuthorizationFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.size > MAX_CONFIGURATION_BYTES ||
    (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(REFUSAL)
  }
}

function decodeAuthorization(bytes: Buffer) {
  return {
    configuration: authorizationSchema.parse(JSON.parse(bytes.toString('utf8'))),
    revision: createHash('sha256').update(bytes).digest('hex')
  }
}

async function readAuthorization(path: string) {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await file.stat()
    assertPrivateAuthorizationFile(stat)
    const buffer = Buffer.alloc(MAX_CONFIGURATION_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_CONFIGURATION_BYTES || bytesRead < stat.size) {
      throw new Error(REFUSAL)
    }
    return decodeAuthorization(buffer.subarray(0, bytesRead))
  } catch {
    throw new Error(REFUSAL)
  } finally {
    await file?.close().catch(() => undefined)
  }
}

function readAuthorizationSync(path: string) {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const before = fstatSync(descriptor)
    assertPrivateAuthorizationFile(before)
    const buffer = Buffer.alloc(MAX_CONFIGURATION_BYTES)
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    const after = fstatSync(descriptor)
    assertPrivateAuthorizationFile(after)
    if (bytesRead !== before.size || bytesRead !== after.size) {
      throw new Error(REFUSAL)
    }
    return decodeAuthorization(buffer.subarray(0, bytesRead))
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor)
    }
  }
}

async function captureAuthority(scope: AdvertisingEvidenceScope, policy: AdvertisingRoutinePolicy) {
  const routineId = scope.routineId
  const runId = scope.runId
  const scopeCurrent = () =>
    scope.isCurrent() &&
    scope.routineId === routineId &&
    scope.runId === runId &&
    routineId === OLDACS_ROUTINE_ID &&
    typeof runId === 'string' &&
    runId.length > 0 &&
    runId.length <= 200 &&
    policy.company === OLDACS_COMPANY &&
    policy.accountId === OLDACS_ACCOUNT_ID
  if (!scopeCurrent()) {
    throw new Error(REFUSAL)
  }
  const profilePath = getProfileUserDataPath()
  const path = join(profilePath, 'local-meta-read-authority.json')
  const saved = await readAuthorization(path)
  const captured = await captureConsoleWorkflowPerson()
  if (
    !captured.ok ||
    captured.data.baseUrl !== ORIGIN ||
    captured.data.clerkUserId !== saved.configuration.clerkUserId
  ) {
    throw new Error(REFUSAL)
  }
  let valid = true
  const isCurrent = () =>
    valid && scopeCurrent() && captured.data.isCurrent() && getProfileUserDataPath() === profilePath
  if (!isCurrent()) {
    throw new Error(REFUSAL)
  }
  // HTTPS introspection authenticates the opaque bearer; profile metadata alone is not proof.
  const response = await requestConsoleWorkflow(
    '/api/me',
    'GET',
    signedPersonSchema,
    undefined,
    15_000,
    true,
    captured.data.principal,
    isCurrent
  )
  const person = signedPersonSchema.safeParse(response.ok ? response.data : null)
  if (!person.success || person.data.user.id !== saved.configuration.clerkUserId || !isCurrent()) {
    throw new Error(REFUSAL)
  }
  const assertCurrent = async () => {
    try {
      if (
        !isCurrent() ||
        (await readAuthorization(path)).revision !== saved.revision ||
        !isCurrent()
      ) {
        throw new Error(REFUSAL)
      }
    } catch {
      valid = false
      throw new Error(REFUSAL)
    }
  }
  const assertPublication = () => {
    try {
      if (!isCurrent() || readAuthorizationSync(path).revision !== saved.revision || !isCurrent()) {
        throw new Error(REFUSAL)
      }
    } catch {
      valid = false
      throw new Error(REFUSAL)
    }
  }
  await assertCurrent()
  return { isCurrent, assertCurrent, assertPublication }
}

/** The private reviewed grant is read-only here; no current subject is auto-enrolled. */
export async function assertLocalMetaReadAuthorized(
  scope: AdvertisingEvidenceScope,
  policy: AdvertisingRoutinePolicy
): Promise<void> {
  await captureAuthority(scope, policy)
}

/** No awaits may separate this returned check from the caller's final publication. */
export async function prepareLocalMetaReadPublication(
  scope: AdvertisingEvidenceScope,
  policy: AdvertisingRoutinePolicy
): Promise<() => void> {
  return (await captureAuthority(scope, policy)).assertPublication
}

export async function authorizeLocalMetaRead(
  scope: AdvertisingEvidenceScope,
  policy: AdvertisingRoutinePolicy
): Promise<{ token: string; isCurrent(): boolean; assertCurrent(): Promise<void> }> {
  const authority = await captureAuthority(scope, policy)
  const token = await resolveAcmeMetaCredential()
  await authority.assertCurrent()
  if (!token) {
    throw new Error('The approved local Meta read credential is unavailable.')
  }
  rememberConsoleWorkflowCredential(token)
  return { token, isCurrent: authority.isCurrent, assertCurrent: authority.assertCurrent }
}
