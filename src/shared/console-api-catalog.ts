import { z } from 'zod'

/**
 * The reviewed, INERT catalog of IDE candidate API routes.
 *
 * Why it exists: rediscovering a route's path and shape every time a feature needs
 * one is the repeated cost this removes. The complete source-contract inventory
 * lives in `contracts/console-api-source-catalog.json`, with BFF OpenAPI and hub
 * type snapshots alongside it. A future view selects and reviews an operation
 * from there, then records its IDE activation status here.
 *
 * Why it grants nothing: a dormant definition is not access. Nothing in this file
 * is callable. A route becomes reachable only by being added to the transport's
 * allowlist in `src/main/backoffice/console-workflow-routes.ts`, as a typed client
 * operation with a validated request and response — and `activated: true` here
 * records that it was, so the two cannot drift apart. The accompanying test fails
 * if a route is reachable but uncatalogued, or catalogued as activated but not
 * reachable.
 *
 * The BFF remains the identity, role, company-scope and audit authority for every
 * row. Sensitivity here is a reviewer's label, never an enforcement point.
 *
 * **A dormant row is a definition, not a promise.** It records that a route exists
 * somewhere in the console's surface; it does NOT assert that the BFF would serve it
 * to a signed-in person today. Exposure through the hub relay needs both an entry in
 * the BFF's own allowlist AND a matching write builder, and the two are maintained
 * separately — a route present in the BFF's generated mutation list is blocked by
 * default, which is exactly what its parametrized test asserts. So before activating
 * any dormant row, re-verify against the BFF that the route is reachable at all, and
 * add it here as activated only once a typed client operation exists for it.
 */

export const API_SENSITIVITIES = [
  'public-internal',
  'money',
  'customer',
  'personnel',
  'credential',
  'admin',
  'execution'
] as const
export type ApiSensitivity = (typeof API_SENSITIVITIES)[number]

export const catalogEntry = z
  .object({
    method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
    /** The canonical client-facing path template, `{param}` per variable segment. */
    path: z.string().min(1),
    /** Served by the console itself, or relayed to the hub on the person's behalf. */
    kind: z.enum(['bff-native', 'hub-relay']),
    sensitivity: z.enum(API_SENSITIVITIES),
    /** True exactly when this route is in the desktop's runtime allowlist. */
    activated: z.boolean(),
    note: z.string().default('')
  })
  .strict()

export const apiCatalog = z.array(catalogEntry)
export type ApiCatalogEntry = z.infer<typeof catalogEntry>

/**
 * Where the catalog lives, relative to this folder. It is DATA rather than a module
 * on purpose: the repo's contract files are read at use, not imported, so the
 * compiled graph of four tsconfig projects never has to carry a JSON file.
 */
export const CONSOLE_API_CATALOG_FILE = 'contracts/console-api-catalog.json'

export function catalogKey(method: string, path: string): string {
  return `${method} ${path}`
}

/** Decode a catalog read from disk. A malformed row fails here, loudly and by name. */
export function decodeApiCatalog(value: unknown): readonly ApiCatalogEntry[] {
  return apiCatalog.parse(value)
}

export function catalogEntryFor(
  entries: readonly ApiCatalogEntry[],
  method: string,
  path: string
): ApiCatalogEntry | undefined {
  return entries.find((entry) => entry.method === method && entry.path === path)
}

/** Routes the desktop has actually activated, which is a small subset by design. */
export function activatedRoutes(entries: readonly ApiCatalogEntry[]): readonly ApiCatalogEntry[] {
  return entries.filter((entry) => entry.activated)
}

export function catalogCounts(entries: readonly ApiCatalogEntry[]): {
  total: number
  activated: number
  bySensitivity: Record<ApiSensitivity, number>
} {
  const bySensitivity = Object.fromEntries(API_SENSITIVITIES.map((value) => [value, 0])) as Record<
    ApiSensitivity,
    number
  >
  for (const entry of entries) {
    bySensitivity[entry.sensitivity] += 1
  }
  return {
    total: entries.length,
    activated: entries.filter((entry) => entry.activated).length,
    bySensitivity
  }
}
