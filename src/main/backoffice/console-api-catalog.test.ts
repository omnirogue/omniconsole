import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { routes } from './console-workflow-routes'
import {
  catalogEntryFor,
  catalogKey,
  CONSOLE_API_CATALOG_FILE,
  decodeApiCatalog,
  type ApiCatalogEntry
} from '../../shared/console-api-catalog'

// Read, not imported: the catalog is a contract file like the repo's others, so no
// tsconfig project has to carry a JSON file in its compiled graph.
const CONSOLE_API_CATALOG = decodeApiCatalog(
  JSON.parse(readFileSync(join(__dirname, '..', '..', 'shared', CONSOLE_API_CATALOG_FILE), 'utf8'))
)

/**
 * The gate that keeps the inert catalog honest.
 *
 * A catalog nobody checks rots into a document, and then the thing it was meant to
 * prevent — a route reachable from the renderer that no reviewer ever classified —
 * happens quietly. So the invariant runs both ways:
 *
 *   every path in the runtime allowlist has a catalog row marked activated, and
 *   every row marked activated is in the runtime allowlist.
 *
 * A dormant row is fine and expected; that is the whole point of a catalog. What
 * cannot happen is the two falling out of step.
 */

type AllowedPath = { method: string; path: string }

function allowedPaths(): AllowedPath[] {
  const found: AllowedPath[] = []
  for (const [method, entries] of Object.entries(routes)) {
    for (const entry of entries) {
      for (const template of entry.templates) {
        found.push({ method, path: template })
      }
    }
  }
  return found
}

describe('the console API catalog', () => {
  it('allows only the exact member-readable recipients GET', () => {
    expect(catalogEntryFor(CONSOLE_API_CATALOG, 'GET', '/api/work/recipients')).toMatchObject({
      activated: true,
      sensitivity: 'personnel'
    })
    expect(routes.GET.some((route) => route.test.test('/api/work/recipients'))).toBe(true)
    for (const path of [
      '/api/work/recipients?employee_id=emp_other',
      '/api/work/recipients/emp_other'
    ]) {
      expect(routes.GET.some((route) => route.test.test(path))).toBe(false)
    }
    expect(routes.POST.some((route) => route.test.test('/api/work/recipients'))).toBe(false)
  })

  it('leaves no route invisible to this gate', () => {
    // Why: the gate enumerates `templates` while the transport authorizes on `test`.
    // A route declared with no template would therefore be reachable at runtime and
    // contribute nothing to enumerate, so every check below would pass over it.
    const untemplated: string[] = []
    for (const [method, entries] of Object.entries(routes)) {
      for (const [index, entry] of entries.entries()) {
        if (entry.templates.length === 0) {
          untemplated.push(`${method}[${index}] ${String(entry.test)}`)
        }
      }
    }
    expect(untemplated, 'Every allowed route must declare at least one path template.').toEqual([])
  })

  it('declares templates its own pattern actually admits', () => {
    // Why: a template that does not match its pattern is a lie in both directions — the
    // catalog row describes a path the transport would refuse, and the path the
    // transport does permit goes unclassified.
    const mismatched: string[] = []
    for (const [method, entries] of Object.entries(routes)) {
      for (const entry of entries) {
        for (const template of entry.templates) {
          // A template stands for a family; substitute a plausible id per placeholder.
          const concrete = template
            .replaceAll('{task_id}', 'btk_aaaa1111')
            .replaceAll('{launch_id}', 'csl_0123456789abcdef0123456789abcdef')
            .replaceAll('{issue}', '10001')
            .replaceAll('{depends_on_task_id}', 'btk_bbbb2222')
            .replaceAll('{thread_id}', 'hth_aaaa1111')
            .replaceAll('{message_id}', 'pm_0123456789abcdef01234567')
            .replaceAll('{room_id}', 'room_aaaa1111')
            .replaceAll('{routine_id}', 'rtn_customer_service_daily')
            .replaceAll(
              '{file_id}',
              template.includes('/session-peers/')
                ? 'pf_0123456789abcdef0123456789abcdef'
                : 'hfv_aaaa1111'
            )
            .replaceAll('{graph_id}', 'wf_aaaa1111')
            .replaceAll('{job_id}', 'job_aaaa1111')
            .replaceAll('{action_id}', 'act_0123456789abcdef0123456789abcdef')
            .replaceAll('{entry_id}', 'agd_aaaa1111')
            .replaceAll('{project_id}', 'proj_aaaa1111')
            .replaceAll('{session_id}', 'ses_aaaa1111')
            .replaceAll('{ledger_id}', 'als_0123456789abcdef01234567')
            .replaceAll('{instance_id}', 'omnirogue-omnirogue-ad-monitor')
            .replaceAll('{decision_id}', 'dcn_0123456789abcdef0123')
            .replaceAll('{question_id}', '42')
            .replaceAll('{id}', 'omnirogue')
            // A Tool Shelf principal ref: a person, an agent role, or a bare alias.
            .replaceAll('{ref}', 'human:emp_shona')
          // Routes whose pattern requires a query string cannot be matched by a bare
          // path; their own client test asserts the full URL instead.
          const requiresQuery = String(entry.test).includes('\\?')
          if (!requiresQuery && !entry.test.test(concrete)) {
            mismatched.push(`${method} ${template}`)
          }
        }
      }
    }
    expect(mismatched, 'These templates do not match the pattern they are declared with.').toEqual(
      []
    )
  })

  it('holds every route the desktop can actually reach', () => {
    const missing = allowedPaths().filter(
      (route) => !catalogEntryFor(CONSOLE_API_CATALOG, route.method, route.path)
    )
    expect(
      missing.map((route) => catalogKey(route.method, route.path)),
      'Add a catalog row for each of these, with its sensitivity, and set activated: true.'
    ).toEqual([])
  })

  it('marks exactly the reachable routes as activated, and no others', () => {
    const reachable = new Set(allowedPaths().map((route) => catalogKey(route.method, route.path)))
    const claimed = CONSOLE_API_CATALOG.filter((entry) => entry.activated).map((entry) =>
      catalogKey(entry.method, entry.path)
    )
    const overclaimed = claimed.filter((key) => !reachable.has(key))
    expect(
      overclaimed,
      'These rows say activated but the transport allowlist does not permit them.'
    ).toEqual([])
    const underclaimed = [...reachable].filter((key) => !claimed.includes(key))
    expect(underclaimed, 'These routes are reachable but not marked activated.').toEqual([])
  })

  it('classifies every row, so no route reaches a reviewer unlabelled', () => {
    const unlabelled = CONSOLE_API_CATALOG.filter((entry) => entry.note.trim() === '')
    expect(unlabelled.map((entry) => catalogKey(entry.method, entry.path))).toEqual([])
  })

  it('names each route once', () => {
    const seen = new Map<string, ApiCatalogEntry>()
    const duplicates: string[] = []
    for (const entry of CONSOLE_API_CATALOG) {
      const key = catalogKey(entry.method, entry.path)
      if (seen.has(key)) {
        duplicates.push(key)
      }
      seen.set(key, entry)
    }
    expect(duplicates).toEqual([])
  })

  it('activates no write beyond the ones the transport already permits', () => {
    // Why this test and not a comment: "reads only" is the posture of every
    // advertising and finance surface added so far, and the way it would be lost
    // is a write quietly earning a catalog row that says activated.
    const activatedWrites = CONSOLE_API_CATALOG.filter(
      (entry) => entry.activated && entry.method !== 'GET'
    ).map((entry) => catalogKey(entry.method, entry.path))
    const permitted = new Set(
      allowedPaths()
        .filter((route) => route.method !== 'GET')
        .map((route) => catalogKey(route.method, route.path))
    )
    expect(activatedWrites.filter((key) => !permitted.has(key))).toEqual([])
  })

  it('activates no advertising write at all, because this phase reads only', () => {
    const adWrites = CONSOLE_API_CATALOG.filter(
      (entry) =>
        entry.activated &&
        entry.method !== 'GET' &&
        (entry.path.includes('/sales/') || entry.path.includes('/adops/'))
    )
    expect(adWrites.map((entry) => catalogKey(entry.method, entry.path))).toEqual([])
  })

  it('is mostly dormant, which is the point of keeping it', () => {
    const activated = CONSOLE_API_CATALOG.filter((entry) => entry.activated).length
    expect(CONSOLE_API_CATALOG.length).toBeGreaterThan(activated)
  })
})
