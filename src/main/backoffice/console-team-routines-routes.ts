import { route } from './console-workflow-route-helper'

export const teamRoutineRoutes = {
  GET: [
    route('/api/routines', /^\/api\/routines$/),
    route('/api/routines/{routine_id}', /^\/api\/routines\/rtn_[A-Za-z0-9_]{1,128}$/),
    route('/api/routines/{routine_id}/runs', /^\/api\/routines\/rtn_[A-Za-z0-9_]{1,128}\/runs$/)
  ],
  POST: [
    route('/api/routines/{routine_id}/share', /^\/api\/routines\/rtn_[A-Za-z0-9_]{1,128}\/share$/),
    route(
      '/api/routines/{routine_id}/enable',
      /^\/api\/routines\/rtn_[A-Za-z0-9_]{1,128}\/enable$/
    ),
    route(
      '/api/routines/{routine_id}/disable',
      /^\/api\/routines\/rtn_[A-Za-z0-9_]{1,128}\/disable$/
    ),
    // Local-to-team conversion.
    route('/api/routines', /^\/api\/routines$/)
  ]
}
