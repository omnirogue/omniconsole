import type { Socket } from 'node:net'
import type { DaemonRequestRouter } from './daemon-request-router'
import type { DaemonServerLifecycle } from './daemon-server-lifecycle'
import { NOTIFY_PREFIX, type DaemonRequest } from './types'
import { encodeNdjson } from './ndjson'

export async function respondToDaemonRequest(
  socket: Socket,
  clientId: string,
  request: DaemonRequest,
  router: DaemonRequestRouter,
  lifecycle: DaemonServerLifecycle
): Promise<void> {
  const isNotify = request.id.startsWith(NOTIFY_PREFIX)
  try {
    const result = await router.route(clientId, request)
    if (!isNotify) {
      socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }), () => {
        lifecycle.startPendingShutdownReply(clientId, request.id)
      })
    }
  } catch (error) {
    if (!isNotify) {
      socket.write(
        encodeNdjson({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      )
    }
  }
}
