import { route, type AllowedRoute } from './console-workflow-route-helper'

/**
 * The Tool Shelf's own corner of the transport allowlist.
 *
 * Its own module for the same reason the shelf's contract is: the routes that
 * carry standing ACCESS are the ones a reviewer opens first, and they should not
 * have to be found among sixty unrelated reads. `console-workflow-routes.ts`
 * spreads these into the tables, so the deny-by-default posture and the catalog
 * gate are unchanged — a path here is still reachable only by being in the table,
 * and still needs an activated catalog row and a client test naming it.
 *
 * The row shape and its builder come from `console-workflow-route-helper.ts`, not
 * from the routes file itself: these entries are built at module load, and a
 * runtime cycle between the two would let import order decide which table wins.
 */

const PRINCIPAL_REF =
  '(?:human:emp_[a-z0-9_-]{1,64}|agent:[a-z0-9][a-z0-9_-]{0,63}|[a-z0-9][a-z0-9_-]{0,63})'

export const accessRoutes: { GET: AllowedRoute[]; PATCH: AllowedRoute[] } = {
  GET: [
    // The Tool Shelf (2026-09-12): my own effective grant (optionally searched by
    // intent), and for the super admins everybody's reach and one principal's shelf.
    // The BFF carries the signed-in person; the hub decides who may look at whom.
    route('/api/access/mine', /^\/api\/access\/mine(?:\?q=[A-Za-z0-9%._~*+-]{1,600})?$/),
    route('/api/admin/access/people', /^\/api\/admin\/access\/people$/),
    // The matrix columns: the derived sections, their capabilities and the named
    // templates. No per-person data, so it is read on the same footing as the
    // policy itself — the hub still decides who may see it.
    route('/api/admin/access/sections', /^\/api\/admin\/access\/sections$/),
    route(
      '/api/admin/access/people/{ref}',
      new RegExp(`^/api/admin/access/people/${PRINCIPAL_REF}$`)
    )
  ],
  PATCH: [
    // Several shelves in one all-or-nothing change: explicit rows, a template, or
    // one column of the matrix. No ref in the path — the principals are named in
    // the body, which the client validates before it is ever sent.
    route('/api/admin/access/people', /^\/api\/admin\/access\/people$/),
    // One standing-access change (grant / deny / remove) on one principal's shelf.
    route(
      '/api/admin/access/people/{ref}',
      new RegExp(`^/api/admin/access/people/${PRINCIPAL_REF}$`)
    )
  ]
}
