import type { RuntimeCapability } from '../../../shared/protocol-version'
import {
  peekRuntimeEnvironmentCompatibility,
  RUNTIME_CAPABILITY_STATUS_TTL_MS
} from './runtime-rpc-client'

/** Optional metadata uses existing status evidence and never initiates or waits on a probe. */
export function runtimeEnvironmentHasCachedCapability(
  environmentId: string,
  capability: RuntimeCapability
): boolean {
  const cached = peekRuntimeEnvironmentCompatibility(environmentId)
  return Boolean(
    cached?.provenCompatible &&
    cached.failedAt === null &&
    cached.statusCheckedAt !== null &&
    Date.now() - cached.statusCheckedAt < RUNTIME_CAPABILITY_STATUS_TTL_MS &&
    cached.status?.capabilities?.includes(capability)
  )
}
