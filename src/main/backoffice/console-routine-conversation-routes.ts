import { route } from './console-workflow-route-helper'

export const routineConversationRoutes = {
  GET: [
    route(
      '/api/work/card/{task_id}/conversation',
      /^\/api\/work\/card\/btk_[A-Za-z0-9]{4,64}\/conversation$/
    )
  ],
  POST: [route('/api/board/{task_id}/message', /^\/api\/board\/btk_[A-Za-z0-9]{4,64}\/message$/)]
}
