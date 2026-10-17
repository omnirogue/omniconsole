import { route } from './console-workflow-route-helper'
export const boardDeliveryPostRoutes = [
  // Board files and deliveries: how produced artifacts of any MIME type reach a
  // person or a card. Same signed person transport, same allowlist posture.
  route(
    '/api/gtd/hub/api/board/{task_id}/files/upload',
    /^\/api\/gtd\/hub\/api\/board\/btk_[A-Za-z0-9]{4,64}\/files\/upload$/
  ),
  route(
    '/api/gtd/hub/api/board/{task_id}/deliver',
    /^\/api\/gtd\/hub\/api\/board\/btk_[A-Za-z0-9]{4,64}\/deliver$/
  )
]
