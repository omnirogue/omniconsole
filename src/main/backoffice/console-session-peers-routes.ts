/**
 * Peer messaging reads: one message, its files, the projects list and the directory.
 * Split out of `console-workflow-routes.ts` to keep that file under the line ceiling,
 * the same way task dependencies and browser logins already live in their own modules.
 */
import { route, type AllowedRoute } from './console-workflow-route-helper'

export const sessionPeerRoutes: readonly AllowedRoute[] = [
  route(
    '/api/gtd/hub/api/session-peers/messages/{message_id}',
    /^\/api\/gtd\/hub\/api\/session-peers\/messages\/pm_[a-f0-9]{24}$/
  ),
  route(
    '/api/gtd/hub/api/session-peers/messages/{message_id}/files',
    /^\/api\/gtd\/hub\/api\/session-peers\/messages\/pm_[a-f0-9]{24}\/files$/
  ),
  route(
    '/api/gtd/hub/api/session-peers/messages/{message_id}/files/{file_id}',
    /^\/api\/gtd\/hub\/api\/session-peers\/messages\/pm_[a-f0-9]{24}\/files\/pf_[a-f0-9]{32}$/
  ),
  route(
    '/api/gtd/hub/api/session-peers/projects',
    /^\/api\/gtd\/hub\/api\/session-peers\/projects$/
  ),
  route(
    '/api/gtd/hub/api/session-peers/directory',
    /^\/api\/gtd\/hub\/api\/session-peers\/directory\?project_id=[A-Za-z0-9_-]{1,128}$/
  )
]
