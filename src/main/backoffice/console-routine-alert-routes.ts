import { route } from './console-workflow-route-helper'
export const routineAlertRoutes = {
  GET: [
    route(
      [
        '/api/gtd/hub/api/routine-alerts/slack/status',
        '/api/gtd/hub/api/routine-alerts/slack/channels'
      ],
      /^\/api\/gtd\/hub\/api\/routine-alerts\/slack\/(?:status|channels)$/
    )
  ],
  POST: [
    route(
      '/api/gtd/hub/api/routine-alerts/slack/send',
      /^\/api\/gtd\/hub\/api\/routine-alerts\/slack\/send$/
    )
  ]
}
