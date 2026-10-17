import { z } from 'zod'

/**
 * Where each conversation files its work (company → department), chosen by hand in Next
 * actions, plus the folders recently chosen there. Per device, like the task links: the
 * folder a workspace sits in stays the default; this only records the person's override.
 */
export const SESSION_PLACE_STORAGE_KEY = 'omni.session-places.v1'
export const SESSION_PLACE_RECENT_FOLDERS_MAX = 3

const choice = z
  .object({
    companyId: z.string().min(1).max(200),
    unitId: z.string().min(1).max(200),
    companyName: z.string().max(500),
    unitName: z.string().max(500)
  })
  .strict()

const places = z
  .object({
    places: z.record(z.string().min(1).max(400), choice),
    recentFolders: z.array(z.string().min(1).max(4096)).max(SESSION_PLACE_RECENT_FOLDERS_MAX)
  })
  .strict()

export type SessionPlaceChoice = z.infer<typeof choice>
export type SessionPlaces = z.infer<typeof places>

export function emptySessionPlaces(): SessionPlaces {
  return { places: {}, recentFolders: [] }
}

/** A drifted store (older build, hand edit) keeps every row that still parses; it never throws. */
export function parseSessionPlaces(value: unknown): SessionPlaces {
  const parsed = places.safeParse(value)
  if (parsed.success) {
    return parsed.data
  }
  if (!value || typeof value !== 'object') {
    return emptySessionPlaces()
  }
  const raw = value as { places?: unknown; recentFolders?: unknown }
  const kept: SessionPlaces = emptySessionPlaces()
  if (raw.places && typeof raw.places === 'object') {
    for (const [key, row] of Object.entries(raw.places as Record<string, unknown>)) {
      const one = choice.safeParse(row)
      if (one.success && key.trim()) {
        kept.places[key] = one.data
      }
    }
  }
  if (Array.isArray(raw.recentFolders)) {
    kept.recentFolders = raw.recentFolders
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .slice(0, SESSION_PLACE_RECENT_FOLDERS_MAX)
  }
  return kept
}

export function setSessionPlace(
  current: SessionPlaces,
  sourceKey: string,
  next: SessionPlaceChoice | null
): SessionPlaces {
  const key = sourceKey.trim()
  if (!key) {
    return current
  }
  const rest = { ...current.places }
  delete rest[key]
  return { ...current, places: next ? { ...rest, [key]: next } : rest }
}

/** The newest folder first, once, and no more than the last three. */
export function rememberRecentFolder(current: SessionPlaces, path: string): SessionPlaces {
  const folder = path.trim()
  if (!folder) {
    return current
  }
  return {
    ...current,
    recentFolders: [folder, ...current.recentFolders.filter((entry) => entry !== folder)].slice(
      0,
      SESSION_PLACE_RECENT_FOLDERS_MAX
    )
  }
}

/** The Select value for a place: the two ids the hub files by. */
export function sessionPlaceKey(place: Pick<SessionPlaceChoice, 'companyId' | 'unitId'>): string {
  return `${place.companyId}/${place.unitId}`
}
