import { resolveBackofficeBaseUrl, type BackofficeEnv } from '../../shared/backoffice-connection'
import { createHash } from 'node:crypto'
import { ensureActiveOrcaProfile } from '../omni-profiles/profile-index-store'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import {
  captureCloudSessionMutation,
  cloudSessionIdentity,
  isCloudSessionMutationCurrent
} from '../omni-profiles/profile-cloud-session-mutation'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { currentBearerToken } from './backoffice-auth'
import { getBackofficeSnapshot } from './backoffice-config'
import {
  redactConsoleWorkflowMemory,
  rememberConsoleWorkflowCredential
} from './console-workflow-credential-memory'

export { redactConsoleWorkflowMemory }

type ConsolePerson = {
  baseUrl: string
  bearer: string
  principal: string
  clerkUserId?: string
  profileKey?: string
  isCurrent(): boolean
}

export function consolePublicationPrincipal(baseUrl: string, userId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([new URL(baseUrl).origin, userId]))
    .digest('hex')
}

function context() {
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return null
  }
  const userDataPath = getProfileUserDataPath()
  const { profile } = ensureActiveOrcaProfile(userDataPath)
  if (!profile.cloud?.userId) {
    return null
  }
  const identity = cloudSessionIdentity(profile.id, profile.cloud)
  return {
    baseUrl: snapshot.baseUrl,
    userDataPath,
    profileId: profile.id,
    profileKey: createHash('sha256')
      .update(JSON.stringify([userDataPath, profile.id]))
      .digest('hex'),
    identity,
    clerkUserId: profile.cloud.userId,
    key: JSON.stringify([snapshot.baseUrl, userDataPath, identity]),
    principal: consolePublicationPrincipal(snapshot.baseUrl, profile.cloud.userId)
  }
}

/** Main-only session capture; the same credential and person fence must cover the request. */
export async function captureConsoleWorkflowPerson(): Promise<
  ConsoleWorkflowResult<ConsolePerson>
> {
  try {
    if (!getBackofficeSnapshot().configured) {
      return {
        ok: false,
        error: {
          code: 'backoffice_unconfigured',
          message: 'Configure the backoffice connection in Settings.'
        }
      }
    }
    const before = context()
    if (!before) {
      return signedOut()
    }
    const mutation = captureCloudSessionMutation(before.identity, before.userDataPath)
    const bearer = await currentBearerToken()
    if (!bearer) {
      return signedOut()
    }
    rememberConsoleWorkflowCredential(bearer)
    const isCurrent = () =>
      context()?.key === before.key &&
      isCloudSessionMutationCurrent(before.profileId, before.userDataPath, mutation)
    if (!isCurrent()) {
      return {
        ok: false,
        error: {
          code: 'connection_changed',
          message:
            'The signed-in person or backoffice connection changed; refresh before continuing.'
        }
      }
    }
    return {
      ok: true,
      data: {
        baseUrl: before.baseUrl,
        bearer,
        principal: before.principal,
        clerkUserId: before.clerkUserId,
        profileKey: before.profileKey,
        isCurrent
      }
    }
  } catch {
    return signedOut()
  }
}

function signedOut(): ConsoleWorkflowResult<never> {
  return {
    ok: false,
    error: { code: 'signed_in_required', message: 'Sign in to OmniConsole before using workflows.' }
  }
}

export async function getConsolePublicationPrincipal(): Promise<string | null> {
  const person = await captureConsoleWorkflowPerson()
  return person.ok ? person.data.principal : null
}

/** Captured credentials stay only in memory, including earlier sessions whose output may arrive late. */
export function sanitizeConsoleWorkflowText(value: string): string {
  try {
    const safe = redactConsoleWorkflowMemory(value)
    return typeof safe === 'string' ? safe : '[redacted]'
  } catch {
    return '[redacted]'
  }
}

/** Identity only: local durability must not wait for a credential refresh or network. */
export function currentConsolePublicationScope(): {
  principal: string
  baseUrl: string
  profileKey: string
  organizationId?: string
} | null {
  try {
    const current = context()
    return current
      ? {
          principal: current.principal,
          baseUrl: current.baseUrl,
          profileKey: current.profileKey,
          organizationId: current.identity.organizationId
        }
      : null
  } catch {
    return null
  }
}

/** Stable storage identity plus a process-session fence, without refreshing credentials. */
export function captureConsoleFleetReceiptScope(
  rendererScope?: string
): { key: string; isCurrent(): boolean } | null {
  const current = context()
  if (!current) {
    return null
  }
  if (rendererScope !== undefined) {
    const prefix = 'omni.conversation-fleet.v1:'
    if (!rendererScope.startsWith(prefix)) {
      return null
    }
    const [profileId, userId, orgId, env, productionUrl, localUrl] = JSON.parse(
      rendererScope.slice(prefix.length)
    )
    const backend = resolveBackofficeBaseUrl({
      backofficeEnv: env as BackofficeEnv,
      backofficeProductionUrl: productionUrl ?? undefined,
      backofficeLocalUrl: localUrl ?? undefined
    })
    if (
      profileId !== current.profileId ||
      userId !== current.clerkUserId ||
      (orgId ?? '') !== current.identity.organizationId ||
      !backend.configured ||
      backend.baseUrl !== current.baseUrl
    ) {
      return null
    }
  }
  const mutation = captureCloudSessionMutation(current.identity, current.userDataPath)
  return {
    key: createHash('sha256').update(current.key).digest('hex'),
    isCurrent: () =>
      context()?.key === current.key &&
      isCloudSessionMutationCurrent(current.profileId, current.userDataPath, mutation)
  }
}
