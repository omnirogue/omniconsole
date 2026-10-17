import { route } from './console-workflow-route-helper'

const calendarGetRoutes = [
  route(
    '/api/gtd/hub/api/agenda/calendar',
    /^\/api\/gtd\/hub\/api\/agenda\/calendar\?frm=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&include=entries%2Ctasks%2Cprojects&include_cancelled=true(?:&company=[A-Za-z0-9_-]{1,100})?(?:&employee=emp_[A-Za-z0-9_-]{1,128})?$/
  )
]
const calendarPostRoutes = [
  route('/api/gtd/hub/api/agenda', /^\/api\/gtd\/hub\/api\/agenda$/),
  route(
    ['/api/gtd/hub/api/agenda/{entry_id}/cancel', '/api/gtd/hub/api/agenda/{entry_id}/complete'],
    /^\/api\/gtd\/hub\/api\/agenda\/agd_[A-Za-z0-9]{4,64}\/(?:cancel|complete)$/
  )
]
const calendarPatchRoutes = [
  route(
    '/api/gtd/hub/api/agenda/{entry_id}',
    /^\/api\/gtd\/hub\/api\/agenda\/agd_[A-Za-z0-9]{4,64}$/
  ),
  route(
    '/api/gtd/hub/api/projects/{project_id}',
    /^\/api\/gtd\/hub\/api\/projects\/[A-Za-z0-9_-]{1,128}$/
  )
]

export const calendarRoutes = {
  GET: calendarGetRoutes,
  POST: calendarPostRoutes,
  PATCH: calendarPatchRoutes
}
