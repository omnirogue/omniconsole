/**
 * Carry per-device preferences across the orca -> omni rename.
 *
 * The rename (2026-08-31) changed ~37 localStorage keys from `orca.*` to `omni.*` with no
 * migration, so on first launch of a renamed build every one of them read empty: the feature
 * tour's progress, GitHub project column widths and hidden columns, the Linear issue view,
 * dismissed hints and banners, the web client's own settings and session. Nothing was corrupt;
 * the app was simply reading a different drawer.
 *
 * This copies each legacy key to its new name once, and only when the new name has no value —
 * a person who has already set a preference on the new build keeps it. The legacy keys are left
 * in place: they cost a few KB, they make the copy idempotent, and they mean rolling back to an
 * older build still finds its own state.
 */

const LEGACY_PREFIX = 'orca.'
const CURRENT_PREFIX = 'omni.'

export type LegacyStorageMigrationResult = {
  /** Keys copied to their new name. */
  migrated: string[]
  /** Legacy keys skipped because the new name already had a value. */
  skipped: string[]
}

const EMPTY: LegacyStorageMigrationResult = { migrated: [], skipped: [] }

/**
 * Runs before anything reads a preference, so it has to be cheap and total: a throwing or
 * absent storage (private window, blocked site data, a test environment) is not an error here,
 * it just means there is nothing to carry over.
 */
export function migrateLegacyStorageKeys(storage?: Storage): LegacyStorageMigrationResult {
  const store = storage ?? safeLocalStorage()
  if (!store) {
    return EMPTY
  }
  let legacyKeys: string[]
  try {
    legacyKeys = Object.keys(store).filter((key) => key.startsWith(LEGACY_PREFIX))
  } catch {
    return EMPTY
  }
  const migrated: string[] = []
  const skipped: string[] = []
  for (const legacyKey of legacyKeys) {
    const currentKey = `${CURRENT_PREFIX}${legacyKey.slice(LEGACY_PREFIX.length)}`
    try {
      // Why getItem and not a key list: an empty string is a value someone stored, and a key
      // present with '' must not be overwritten by the legacy one.
      if (store.getItem(currentKey) !== null) {
        skipped.push(legacyKey)
        continue
      }
      const value = store.getItem(legacyKey)
      if (value === null) {
        continue
      }
      store.setItem(currentKey, value)
      migrated.push(legacyKey)
    } catch {
      // A quota or security error on one key must not stop the rest from carrying over.
      skipped.push(legacyKey)
    }
  }
  return { migrated, skipped }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
