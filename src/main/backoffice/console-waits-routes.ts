/**
 * omnios wait facts (CONTRACT.md §1 of the conversational-waits plan): who can be waited on, a
 * posted ask, and "has it happened yet?". Split out of `console-workflow-routes.ts` like the other
 * satellite allowlists. The facts query is built by `console-waits-client.ts` in this exact order.
 */
import { route, type AllowedRoute } from './console-workflow-route-helper'

const ENCODED = '[A-Za-z0-9%._~*-]'

export const waitRoutes: { GET: readonly AllowedRoute[]; POST: readonly AllowedRoute[] } = {
  GET: [
    route('/api/waits/people', /^\/api\/waits\/people$/),
    route(
      '/api/waits/facts',
      new RegExp(
        `^\\/api\\/waits\\/facts\\?source=(?:slack|email|jira|signin)&person_id=emp_[A-Za-z0-9_-]{1,120}&ref=${ENCODED}{1,1536}&since=${ENCODED}{1,64}&match=(?:approve|reply|signin)$`
      )
    )
  ],
  POST: [route('/api/waits/ask', /^\/api\/waits\/ask$/)]
}
