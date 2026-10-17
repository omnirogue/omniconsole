import { route } from './console-workflow-route-helper'

export const taskFileRoutes = {
  GET: [
    route(
      '/api/gtd/task-continuation/capabilities',
      /^\/api\/gtd\/task-continuation\/capabilities(?:\?task_id=btk_[A-Za-z0-9]{4,64})?$/
    ),
    route(
      '/api/gtd/hub/api/board/{task_id}/files/download',
      /^\/api\/gtd\/hub\/api\/board\/btk_[A-Za-z0-9]{4,64}\/files\/download\?path=[A-Za-z0-9%._~!*'()+-]{1,12288}$/
    ),
    route(
      '/api/gtd/hub/api/handoffs/{thread_id}/files/{file_id}',
      /^\/api\/gtd\/hub\/api\/handoffs\/hth_[A-Za-z0-9_-]{1,128}\/files\/hfv_[A-Za-z0-9_-]{1,128}$/
    )
  ]
}
