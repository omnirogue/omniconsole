import { useAppStore } from '@/store'

/** Authentication refreshes must not change a person's saved presentation. */
export function personalViewStorageKey(key: string): string {
  const state = useAppStore.getState()
  const cloud = state.orcaProfileAuthStatus?.cloud
  return `${key}:${JSON.stringify([
    state.activeOrcaProfileId,
    cloud?.userId ?? null,
    cloud?.activeOrgId ?? null,
    state.settings?.backofficeEnv,
    state.settings?.backofficeProductionUrl,
    state.settings?.backofficeLocalUrl
  ])}`
}

/** Claim pre-account presentation once, when a signed-in owner is known. */
export function readPersonalView(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  key: string
): string | null {
  const scoped = personalViewStorageKey(key)
  const saved = storage.getItem(scoped)
  if (saved !== null) {
    return saved
  }
  const state = useAppStore.getState()
  if (state.orcaProfileAuthStatus?.state !== 'connected') {
    return null
  }
  const claim = `${key}:legacy-owner`
  const owner = storage.getItem(claim)
  if (owner && owner !== scoped) {
    return null
  }
  const legacy = storage.getItem(key)
  if (legacy !== null) {
    storage.setItem(claim, scoped)
    storage.setItem(scoped, legacy)
  }
  return legacy
}
