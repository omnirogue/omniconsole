import type { PreloadApi } from '../../../../preload/api-types'
import type {
  SessionSearchArgs,
  SessionSearchResult
} from '../../../../shared/session-search-types'
import { callRuntimeResult } from './web-runtime-calls'

export function createWebSessionSearchApi(): NonNullable<Partial<PreloadApi>['sessionSearch']> {
  return {
    // Why: the browser has no transcripts of its own; the paired runtime searches its host.
    query: (args: SessionSearchArgs) =>
      callRuntimeResult<SessionSearchResult>('sessionSearch.query', {
        query: args.query,
        limit: args.limit,
        includeRemote: false
      })
  }
}
