/**
 * What the host organization service's parts share: the ledger (the one source of truth), the
 * values folded from it, the outbox, and the window relay when this host has a window.
 */

import { randomUUID } from 'node:crypto'
import { localKeyDigest } from '../../shared/account-sync-session-keys'
import type { SessionHostRefusal, SessionHostRefusalCode } from '../../shared/session-host-refusal'
import type { HostOrganizationValues } from '../../shared/session-organization-host'
import type { OrganizationChangeLedger } from './organization-change-ledger'
import type { OrganizationRelay } from './organization-relayed-mutation'
import type { HostOrganizationOutbox } from './host-organization-outbox'
import type { HostOrganizationView } from './host-organization-view'

export type SessionOrganizationHostDeps = {
  ledger: OrganizationChangeLedger
  view: HostOrganizationView
  outbox: HostOrganizationOutbox
  /** Relays a change to this host's window; absent where there never is one (an SSH relay). */
  relay?: OrganizationRelay
  /** Whether a window is attached now; without it a relay is tried and "no window" falls back. */
  windowAttached?: () => boolean
  /** Package A's host id, carried on published entries. */
  hostId?: string
  mintOpId?: () => string
  now?: () => Date
}

export type HostOrganizationContext = SessionOrganizationHostDeps & {
  now: () => Date
  mintOpId: () => string
  /** The key's account-sync digest: as a window or Mac named it, else from its canonical key. */
  digestOf: (key: string) => string | undefined
}

export function hostOrganizationContext(
  deps: SessionOrganizationHostDeps
): HostOrganizationContext {
  return {
    ...deps,
    now: deps.now ?? (() => new Date()),
    mintOpId: deps.mintOpId ?? randomUUID,
    digestOf: (key) => deps.view.entry(key)?.digest ?? localKeyDigest(key) ?? undefined
  }
}

export const HOST_ORGANIZATION_DEFAULTS: HostOrganizationValues = {
  placement: null,
  archived: false,
  title: null,
  tags: [],
  hidden: false,
  snooze: null,
  deleted: false
}

export function hostOrganizationValuesOf(
  context: HostOrganizationContext,
  key: string
): HostOrganizationValues {
  return { ...HOST_ORGANIZATION_DEFAULTS, ...context.view.entry(key)?.values }
}

export function hostRefusal(
  code: SessionHostRefusalCode,
  message: string,
  current?: string
): SessionHostRefusal {
  return { code, message, ...(current ? { current: { organizationRevision: current } } : {}) }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
