import { route } from './console-workflow-route-helper'

export const advertisingActionRoutes = {
  GET: [
    route(
      '/api/gtd/hub/api/actions/capabilities',
      /^\/api\/gtd\/hub\/api\/actions\/capabilities\?domain=advertising&company=(?:omnirogue|betacorp)$/
    ),
    route(
      '/api/gtd/hub/api/actions/{action_id}',
      /^\/api\/gtd\/hub\/api\/actions\/act_[a-f0-9]{32}$/
    )
  ],
  POST: [
    route('/api/gtd/hub/api/actions/preview', /^\/api\/gtd\/hub\/api\/actions\/preview$/),
    route(
      [
        '/api/gtd/hub/api/actions/{action_id}/execute',
        '/api/gtd/hub/api/actions/{action_id}/verify'
      ],
      /^\/api\/gtd\/hub\/api\/actions\/act_[a-f0-9]{32}\/(?:execute|verify)$/
    )
  ]
}
