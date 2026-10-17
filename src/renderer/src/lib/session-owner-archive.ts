import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../shared/execution-host'
import {
  SESSION_HOSTS_RPC,
  type SessionHostArchiveResult
} from '../../../shared/session-hosts-status'
import type { OrganizationRpc } from './session-organization-change-contract'

/** Folder/view keys carry the execution owner, including panes without a provider session yet. */
export function hasRemoteSessionOwner(key: string): boolean {
  try {
    const identity: unknown = JSON.parse(key)
    const host =
      Array.isArray(identity) && typeof identity[0] === 'string'
        ? parseExecutionHostId(identity[0])
        : null
    return host !== null && host.kind !== 'local'
  } catch {
    return false
  }
}

const pending = new Map<string, { archived: boolean; request: Promise<boolean> }>()

/** Nothing is changed locally on refusal, disconnection, or an unconfirmed owner operation. */
export function archiveOnSessionOwner(
  viewKey: string,
  archived: boolean,
  rpc: OrganizationRpc = (method, params) => callRuntimeRpc({ kind: 'local' }, method, params)
): Promise<boolean> {
  // A repeated click while the owner is answering must not create another operation.
  const existing = pending.get(viewKey)
  if (existing) {
    if (existing.archived === archived) {
      return existing.request
    }
    toast.message(
      translate(
        'sessionHosts.archiveWaitForOwner',
        'Wait for the owning computer to confirm the current archive change.'
      )
    )
    return Promise.resolve(false)
  }
  const request = (async () => {
    try {
      const result = await rpc<SessionHostArchiveResult>(SESSION_HOSTS_RPC.archive, {
        viewKey,
        archived
      })
      if (result.status !== 'completed') {
        toast.message(
          translate(
            'sessionHosts.archiveUnconfirmed',
            'The owning computer has not confirmed the archive change yet.'
          )
        )
        return false
      }
      return true
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'sessionHosts.archiveFailed',
              'The session could not be changed on its owning computer.'
            )
      )
      return false
    }
  })()
  pending.set(viewKey, { archived, request })
  void request.finally(() => {
    if (pending.get(viewKey)?.request === request) {
      pending.delete(viewKey)
    }
  })
  return request
}
