/**
 * Side-effect entry for the rename's preference migration.
 *
 * Kept apart from the migration itself so the logic stays importable by tests without running
 * on import, and so main.tsx can place it before every module that reads a preference while
 * evaluating. Failure here is never fatal: losing a carried-over preference is a nuisance, a
 * renderer that refuses to boot is not.
 */
import { migrateLegacyStorageKeys } from './legacy-storage-key-migration'

try {
  const { migrated } = migrateLegacyStorageKeys()
  if (migrated.length > 0) {
    console.info(`[storage] carried ${migrated.length} preference(s) across the omni rename`)
  }
} catch (error) {
  console.warn('[storage] preference migration skipped:', error)
}
