import { createSessionSearchEngine } from './session-search-engine'
import {
  SESSION_SEARCH_SERVICE_PROTOCOL,
  type SessionSearchServiceParentMessage
} from './session-search-service-protocol'

if (!process.send) {
  throw new Error('Session search service requires a parent IPC channel.')
}
let engine: ReturnType<typeof createSessionSearchEngine> | null = null
function shutdown(): void {
  engine?.shutdown()
  engine = null
  process.disconnect?.()
}
process.on('message', (message: SessionSearchServiceParentMessage) => {
  if (message?.type === 'init') {
    if (engine || message.protocol !== SESSION_SEARCH_SERVICE_PROTOCOL) {
      shutdown()
      return
    }
    engine = createSessionSearchEngine(message)
    process.send?.({ type: 'ready', protocol: SESSION_SEARCH_SERVICE_PROTOCOL })
    return
  }
  if (message?.type === 'shutdown') {
    shutdown()
    return
  }
  if (message?.type === 'request') {
    try {
      if (!engine) {
        throw new Error('Session search service is not initialized.')
      }
      process.send?.({ type: 'result', id: message.id, value: engine.execute(message) })
    } catch (error) {
      process.send?.({
        type: 'error',
        id: message.id,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
})
process.on('disconnect', () => engine?.shutdown())
