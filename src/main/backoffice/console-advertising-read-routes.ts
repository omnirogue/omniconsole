import { route } from './console-workflow-route-helper'

/** Exact bounded advertising reads; unlisted query parameters remain refused. */
export const advertisingReadRoutes = [
  route(
    '/api/gtd/hub/api/sales/ads',
    /^\/api\/gtd\/hub\/api\/sales\/ads\?company=(?:omnirogue|betacorp)&range_days=(?:1|7|30)&level=(?:campaign|adset|ad)&state=(?:active|inactive|all)$/
  ),
  route(
    '/api/gtd/hub/api/sales/daily',
    /^\/api\/gtd\/hub\/api\/sales\/daily\?company=(?:omnirogue|betacorp|all)&range_days=(?:1|7|30)&same_time=(?:true|false)$/
  ),
  route('/api/gtd/hub/api/adops', /^\/api\/gtd\/hub\/api\/adops$/),
  route(
    '/api/gtd/hub/api/adops/instances/{instance_id}',
    /^\/api\/gtd\/hub\/api\/adops\/instances\/[A-Za-z0-9_:-]{1,128}$/
  ),
  route(
    '/api/gtd/hub/api/adops/instances/{instance_id}/decision',
    /^\/api\/gtd\/hub\/api\/adops\/instances\/[A-Za-z0-9_:-]{1,128}\/decision\?section=(?:overview|decisions|cbo|statistics)(?:&offset=\d{1,5}&limit=(?:[1-9]|1\d|20)(?:&campaign_id=\d{5,30})?)?$/
  ),
  route(
    '/api/gtd/hub/api/adops/webinarjam/summary',
    /^\/api\/gtd\/hub\/api\/adops\/webinarjam\/summary\?company=omnirogue&window=(?:today|d7|d30)$/
  )
]
