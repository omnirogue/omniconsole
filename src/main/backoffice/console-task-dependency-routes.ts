/**
 * Lane G (2026-09-15): one task's dependency edges, read, added and removed through the
 * console's hub relay, which runs the member task check on both tasks. btk ids only, no query.
 */
import { route, type AllowedRoute } from './console-workflow-route-helper'

const deps = route(
  '/api/gtd/hub/api/collab/board/{task_id}/deps',
  /^\/api\/gtd\/hub\/api\/collab\/board\/btk_[A-Za-z0-9]{4,64}\/deps$/
)

export const taskDependencyRoutes: Record<'GET' | 'POST' | 'DELETE', AllowedRoute[]> = {
  GET: [deps],
  POST: [deps],
  DELETE: [
    route(
      '/api/gtd/hub/api/collab/board/{task_id}/deps/{depends_on_task_id}',
      /^\/api\/gtd\/hub\/api\/collab\/board\/btk_[A-Za-z0-9]{4,64}\/deps\/btk_[A-Za-z0-9]{4,64}$/
    )
  ]
}
