import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'

/** Poll evidence, never elapsed time: unknown status and quiet output cannot authorize a send. */
export function watchInterruptedSessionReadiness(options: {
  runtime: OrcaRuntimeService
  paneKey: string
  ownsPane: () => boolean
  enabled: () => boolean
  event: AgentHookEventPayload
  observe: (event: AgentHookEventPayload) => void
}): () => void {
  let stopped = false
  let expectedIncarnation: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
  const probe = async (): Promise<void> => {
    if (stopped || !options.enabled() || !options.ownsPane()) {
      stop()
      return
    }
    try {
      const { runtime, paneKey } = options
      const handle = runtime.getTerminalHandleForPaneKey(paneKey)
      if (!handle) {
        stop()
        return
      }
      const incarnation = runtime.getTerminalProcessIncarnation(handle)
      if (expectedIncarnation && incarnation !== expectedIncarnation) {
        stop()
        return
      }
      if (incarnation) {
        expectedIncarnation = incarnation
      }
      // These are the same prompt/status observations used by session-outcome-source-quiet-pane.
      const wait = await runtime.getTerminalInteractiveWait(handle)
      const status = await runtime.getTerminalAgentStatus(handle)
      if (runtime.getTerminalProcessIncarnation(handle) !== incarnation) {
        stop()
        return
      }
      if (
        !stopped &&
        options.enabled() &&
        options.ownsPane() &&
        incarnation &&
        runtime.getTerminalProcessIncarnation(handle) === incarnation &&
        wait === null &&
        status.isRunningAgent &&
        status.status === 'idle'
      ) {
        stop()
        options.observe(options.event)
        return
      }
    } catch {
      // An unavailable observation is not readiness.
    }
    if (!stopped) {
      timer = setTimeout(() => void probe(), 250)
      timer.unref?.()
    }
  }
  void Promise.resolve().then(probe)
  return stop
}
