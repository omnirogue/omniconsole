/**
 * What this desktop publishes to OmniOS about its own sessions: Work feed posts, and Session
 * Questions (sync the questions its sessions ask, collect the answers the person gave on OmniOS,
 * acknowledge each after typing it in; `session-questions/omnios-question-runtime.ts`). Split
 * out to keep the main list under its line ceiling.
 */
import { route, type AllowedRoute } from './console-workflow-route-helper'

export const desktopPublicationRoutes: Record<'GET' | 'POST', readonly AllowedRoute[]> = {
  GET: [
    route(
      '/api/session-questions/answers',
      /^\/api\/session-questions\/answers\?host=[A-Za-z0-9%._~-]{1,600}$/
    )
  ],
  POST: [
    route('/api/team-feed/work-posts', /^\/api\/team-feed\/work-posts$/),
    route('/api/session-questions/sync', /^\/api\/session-questions\/sync$/),
    route('/api/session-questions/{question_id}/ack', /^\/api\/session-questions\/\d{1,19}\/ack$/)
  ]
}
