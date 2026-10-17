import { z } from 'zod'
import { isRuntimeOwnedSshTargetId, toSshExecutionHostId } from '../../shared/execution-host'
import {
  SSH_SESSION_SEARCH_METHOD,
  type SshSessionSearchParams
} from '../../shared/ssh-session-search'
import {
  SESSION_SEARCH_MAX_LIMIT,
  type SessionSearchHit,
  type SessionSearchHostStatus
} from '../../shared/session-search-types'
import { getActiveMultiplexer, getRegisteredSshState } from '../ssh/ssh-target-registry'
import { isMethodNotFoundError } from '../ssh/ssh-file-stream-contract'
import { remoteHitSchema } from './session-search-hit-schema'

const resultSchema = z.object({
  supported: z.literal(true),
  hits: z.array(z.unknown()).max(SESSION_SEARCH_MAX_LIMIT),
  indexedSessions: z.number().int().nonnegative(),
  pendingFiles: z.number().int().nonnegative(),
  passes: z.number().int().nonnegative()
})

async function requestConnectedSearch(
  targetId: string,
  params: SshSessionSearchParams
): Promise<unknown> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const mux = getActiveMultiplexer(targetId)
  if (!mux || mux.isDisposed()) {
    throw new Error('SSH relay is not ready')
  }
  const unchanged = () =>
    getActiveMultiplexer(targetId) === mux &&
    !mux.isDisposed() &&
    getRegisteredSshState(targetId)?.status === 'connected'
  try {
    const result = await mux.request(SSH_SESSION_SEARCH_METHOD, params, { timeoutMs: 8_000 })
    if (!unchanged()) {
      throw new Error('SSH relay changed during content search')
    }
    return result
  } catch (error) {
    if (unchanged() && isMethodNotFoundError(error)) {
      return null
    }
    throw error
  }
}

export async function searchSshSessions(
  target: { id: string; label: string },
  query: string,
  limit: number,
  coverageOnly = false
): Promise<{ hits: SessionSearchHit[]; host: SessionSearchHostStatus }> {
  const base = { hostLabel: target.label, executionHostId: toSshExecutionHostId(target.id) }
  if (getRegisteredSshState(target.id)?.status !== 'connected') {
    return {
      hits: [],
      host: {
        ...base,
        state: 'unreachable',
        message: 'This SSH target is not connected; its transcripts were not searched.'
      }
    }
  }
  if (coverageOnly) {
    return {
      hits: [],
      host: {
        ...base,
        state: 'unsupported',
        message:
          'Search this SSH target from its owning controller; nested content routing is unavailable.'
      }
    }
  }
  try {
    const raw = await requestConnectedSearch(target.id, { query, limit })
    if (raw === null || (raw as { supported?: unknown } | null)?.supported === false) {
      return {
        hits: [],
        host: {
          ...base,
          state: 'unsupported',
          message:
            'This SSH relay does not support content search. Update it when its active sessions can be preserved.'
        }
      }
    }
    const result = resultSchema.safeParse(raw)
    if (!result.success) {
      throw new Error('The SSH host returned an invalid search result.')
    }
    const hits = result.data.hits.flatMap((value) => {
      const parsed = remoteHitSchema.safeParse(value)
      return parsed.success &&
        (parsed.data.executionHostId === undefined || parsed.data.executionHostId === 'local')
        ? [{ ...parsed.data, ...base }]
        : []
    })
    return {
      hits,
      host: {
        ...base,
        state: result.data.passes === 0 || result.data.pendingFiles > 0 ? 'indexing' : 'searched',
        indexedSessions: result.data.indexedSessions,
        pendingFiles: result.data.pendingFiles
      }
    }
  } catch (error) {
    return {
      hits: [],
      host: {
        ...base,
        state: getRegisteredSshState(target.id)?.status === 'connected' ? 'failed' : 'unreachable',
        message: error instanceof Error ? error.message : 'SSH content search failed.'
      }
    }
  }
}
