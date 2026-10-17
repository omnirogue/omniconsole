import { normalizeAutomaticSessionCleanupProtection } from '../../shared/automatic-session-cleanup-protection'
import { readAutomaticWorkerCleanupHold } from '../runtime/automatic-worker-cleanup-hold'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'

/**
 * Why automatic cleanup must keep a review session (its own publish lifts only the started-today
 * hold), or null. Why the explicit check: protections never set keep everything (PLAN section 7),
 * while the finite-worker hold treats an unset policy as its empty baseline.
 */
export async function readReviewSessionCleanupHold(
  runtime: OrcaRuntimeService,
  target: { worktreeId: string; paneKey: string }
): Promise<string | null> {
  const settings = runtime.getHeadlessSleepSettings()
  if (!normalizeAutomaticSessionCleanupProtection(settings.automaticSessionCleanupProtection)) {
    return 'protection-unconfigured'
  }
  return readAutomaticWorkerCleanupHold(runtime, target)
}
