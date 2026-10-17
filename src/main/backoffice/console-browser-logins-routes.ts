import { route, type AllowedRoute } from './console-workflow-route-helper'

/**
 * Browser-login rail (Prompt 3, 2026-09-15): every shared AirTop profile, one
 * profile's live login status, adding a new site, and driving one profile's
 * re-login (open the live view, save once signed in, verify it stuck) — plus the
 * admins-only verify-all sweep. Kept out of `console-workflow-routes.ts` itself,
 * which is already at its `max-lines` budget; spliced into `routes` there.
 */
export const browserLoginGetRoutes: AllowedRoute[] = [
  route(
    ['/api/connections/browser-profiles', '/api/connections/browser-profiles/{id}'],
    /^\/api\/connections\/browser-profiles(?:\/[A-Za-z0-9_-]{1,128})?$/
  )
]

export const browserLoginPostRoutes: AllowedRoute[] = [
  route(
    [
      '/api/connections/browser-profiles',
      '/api/connections/browser-profiles/{id}/open',
      '/api/connections/browser-profiles/{id}/save',
      '/api/connections/browser-profiles/{id}/verify',
      '/api/admin/browser-profiles/verify-all'
    ],
    /^\/api\/connections\/browser-profiles(?:\/[A-Za-z0-9_-]{1,128}\/(?:open|save|verify))?$|^\/api\/admin\/browser-profiles\/verify-all$/
  )
]
