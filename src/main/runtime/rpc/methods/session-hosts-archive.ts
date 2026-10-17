/** A person's archive click goes to the computer that owns the selected conversation. */
import { hostname } from 'node:os'
import { z } from 'zod'
import {
  SESSION_HOSTS_RPC,
  type SessionHostArchiveResult
} from '../../../../shared/session-hosts-status'
import { archiveRemoteSession } from '../../../session-host-remote/remote-session-archive'
import { readSidebarRows } from '../../../session-manage/session-manage-runtime-actions'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrganizationWindowCaller } from './session-organization'

export const SESSION_HOSTS_ARCHIVE_METHODS: RpcMethod[] = [
  defineMethod({
    name: SESSION_HOSTS_RPC.archive,
    params: z.object({ viewKey: z.string().min(1), archived: z.boolean() }).strict(),
    handler: async (params, context): Promise<SessionHostArchiveResult> => {
      // Origin is proven by the desktop transport, never by a payload's claimed executor.
      assertOrganizationWindowCaller(context)
      const rows = await readSidebarRows(context.runtime)
      const row = rows.find((entry) => entry.viewKey === params.viewKey && !entry.folded)
      if (!row) {
        throw new Error(
          'The owning computer of this session could not be verified. Nothing changed.'
        )
      }
      const outcome = await archiveRemoteSession(row, params.archived, {
        computer: hostname(),
        requester: { kind: 'person', via: 'sidebar' }
      })
      if (outcome.kind === 'pending') {
        return { status: 'pending', operationId: outcome.operationId }
      }
      if (outcome.kind !== 'completed') {
        throw new Error('The owning computer did not confirm the change.')
      }
      return { status: 'completed' }
    }
  })
]
