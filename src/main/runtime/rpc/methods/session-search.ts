import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { getProfileUserDataPath } from '../../../omni-profiles/profile-storage-paths'
import { searchSessionsOnHosts } from '../../../session-search/session-search-hosts'
import {
  SESSION_SEARCH_MAX_LIMIT,
  SESSION_SEARCH_QUERY_MAX_CHARS
} from '../../../../shared/session-search-types'

export const SessionSearchQueryParams = z.object({
  query: z.string().trim().min(1).max(SESSION_SEARCH_QUERY_MAX_CHARS),
  limit: z.number().int().min(1).max(SESSION_SEARCH_MAX_LIMIT).optional(),
  // Why: a paired host answers for itself only, so a fan-out can never loop between hosts.
  includeRemote: z.boolean().optional(),
  includeOwnedSsh: z.boolean().optional()
})

export const SESSION_SEARCH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'sessionSearch.query',
    params: SessionSearchQueryParams,
    handler: (params, { clientKind }) =>
      searchSessionsOnHosts(getProfileUserDataPath(), {
        query: params.query,
        limit: params.limit,
        includeRemote: clientKind === undefined ? params.includeRemote !== false : false,
        includeOwnedSsh: params.includeOwnedSsh === true
      })
  })
]
