import { z } from 'zod'
import {
  sanitizeFleetAccountUsage,
  selectedAccountUsageRequestSchema,
  type SelectedAccountUsageRequest
} from '../../../../shared/fleet-account-usage'
import { probeSelectedAccountUsage } from '../../../rate-limits/selected-account-usage'
import { consumeCanonicalWorkerFile } from '../../orchestration/canonical-worker-record'
import { defineMethod, type RpcAnyMethod } from '../core'

export const SELECTED_ACCOUNT_USAGE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'accounts.probeSelectedUsage',
    params: z.object({ inputFile: z.string().min(1).max(4_096) }).strict(),
    handler: async ({ inputFile }, { clientKind }) => {
      if (clientKind !== undefined) {
        throw new Error('Selected account usage is only available on the local host runtime.')
      }
      let request: SelectedAccountUsageRequest
      try {
        request = selectedAccountUsageRequestSchema.parse(
          consumeCanonicalWorkerFile(inputFile, false)
        )
      } catch {
        throw new Error('Selected account usage input must be a valid private request file.')
      }
      try {
        return sanitizeFleetAccountUsage(await probeSelectedAccountUsage(request), request.provider)
      } catch {
        throw new Error('Selected account usage probe failed.')
      }
    }
  })
]
