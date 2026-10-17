import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_ORGANIZATION_RPC,
  type OrganizationRecord
} from '../../../shared/session-organization-change'
import { ORGANIZATION_MAX_TARGETS } from '../../../shared/session-organization-change-schema'
import {
  SESSION_ORGANIZATION_OWNERSHIP_RPC,
  type OwnershipKeyMove,
  type OwnershipSyncStamp
} from '../../../shared/session-organization-ownership'
import type { OrganizationRpc } from './session-organization-change'
import type { OwnershipMirror } from '@/store/session-organization-ownership'

export type OrganizationOwnershipOutbox = {
  stamps: (stamps: readonly OwnershipSyncStamp[]) => void
  /** Records sync applied (another device's changes), each recorded after it happened. */
  records: (records: readonly OrganizationRecord[]) => void
  migrations: (moves: readonly OwnershipKeyMove[]) => void
  /** Settles once everything sent so far has been answered; for tests. */
  flush: () => Promise<void>
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += ORGANIZATION_MAX_TARGETS) {
    out.push(items.slice(start, start + ORGANIZATION_MAX_TARGETS))
  }
  return out
}

/**
 * What the window tells main about ownership, one call at a time and in order (a stamp before
 * the record that echoes it). Best effort: main's copy is read back at the next start.
 */
export function createOrganizationOwnershipOutbox(
  rpc: OrganizationRpc,
  adopt: (keys: OwnershipMirror) => void
): OrganizationOwnershipOutbox {
  let chain: Promise<void> = Promise.resolve()
  const send = (method: string, params: unknown, answer?: (result: unknown) => void): void => {
    chain = chain
      .then(async () => {
        const result = await rpc<unknown>(method, params)
        answer?.(result)
      })
      .catch((error: unknown) => {
        console.warn(`[session-organization] ${method} failed`, error)
      })
  }
  const adoptKeys = (result: unknown): void => {
    const keys = (result as { keys?: OwnershipMirror } | null)?.keys
    if (keys) {
      adopt(keys)
    }
  }
  return {
    stamps: (stamps) => {
      for (const part of chunks(stamps)) {
        send(SESSION_ORGANIZATION_OWNERSHIP_RPC.syncStamps, { stamps: part })
      }
    },
    records: (records) => {
      for (const record of records) {
        const {
          phase: _phase,
          ts: _ts,
          revision: _revision,
          error: _error,
          reconciled: _reconciled,
          revisionUnchecked: _unchecked,
          before,
          after,
          ...change
        } = record
        send(SESSION_ORGANIZATION_RPC.settle, {
          phase: 'applied',
          change,
          ...(before ? { before } : {}),
          ...(after ? { after } : {})
        })
      }
    },
    migrations: (moves) => {
      for (const part of chunks(moves)) {
        send(SESSION_ORGANIZATION_OWNERSHIP_RPC.migrateKeys, { moves: part }, adoptKeys)
      }
    },
    flush: () => chain
  }
}

export const localOrganizationRpc: OrganizationRpc = (method, params) =>
  callRuntimeRpc({ kind: 'local' }, method, params)
