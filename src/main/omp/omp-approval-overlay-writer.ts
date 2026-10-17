import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  OMP_APPROVAL_OVERLAY_YAML,
  getOmpApprovalOverlayConfigPath
} from '../../shared/omp-approval-overlay'

/**
 * Materialize the IDE-managed OMP approval overlay (`tools.approvalMode: write`)
 * at the deterministic path `applyOmpApprovalOverlayArgs` already points
 * `--config` at. Idempotent — a no-op once the file matches, and safe to call
 * before every non-Bypass OMP launch.
 */
export function writeOmpApprovalOverlayConfig(
  overlayConfigPath: string = getOmpApprovalOverlayConfigPath()
): string {
  const dir = dirname(overlayConfigPath)
  mkdirSync(dir, { recursive: true })

  if (existsSync(overlayConfigPath)) {
    try {
      if (readFileSync(overlayConfigPath, 'utf-8') === OMP_APPROVAL_OVERLAY_YAML) {
        return overlayConfigPath
      }
    } catch {
      // Fall through to the atomic write path.
    }
  }

  const tmpPath = `${overlayConfigPath}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmpPath, OMP_APPROVAL_OVERLAY_YAML, 'utf-8')
    renameSync(tmpPath, overlayConfigPath)
  } finally {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // best effort
      }
    }
  }
  return overlayConfigPath
}
