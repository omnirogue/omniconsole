import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'

/** Display only: the chain keeps its original error for diagnostics and recovery. */
export function sessionChainErrorMessage(error: string | null | undefined): string {
  const message = extractIpcErrorMessage(new Error(error ?? ''), '').trim()
  if (
    /\b(?:terminal_gone|terminal_handle_stale|no_active_terminal|no_connected_pty|terminal_pane_owner_unverified)\b/.test(
      message
    ) ||
    message === 'The session this step waits on is no longer known.'
  ) {
    return translate(
      'components.sessionChain.errorConnectionLost',
      'The connection to this conversation is no longer available. Reopen it to check the work before trying Add Next again.'
    )
  }
  if (
    /\b(?:timeout|ETIMEDOUT|ECONNREFUSED|runtime_unavailable|runtime_disconnected|host_unreachable)\b/i.test(
      message
    ) ||
    /SSH connection (?:is not active|failed|lost)/.test(message) ||
    message === 'Source connection unavailable' ||
    message === 'The source session completion could not be verified.'
  ) {
    return translate(
      'components.sessionChain.errorUnverifiable',
      'The work status could not be checked. Reconnect and review the conversation before trying again; the agent may still be working.'
    )
  }
  if (
    message.startsWith("The next session's agent exited before it started working") ||
    message === 'The next session could not be started.' ||
    /\b(?:agent_launch_failed|session_launch_failed|launch_failed)\b/.test(message)
  ) {
    return translate(
      'components.sessionChain.errorAgentStart',
      'The next agent could not begin work. Check the selected agent’s connection and sign-in, then try Add Next again.'
    )
  }
  if (message === 'The next session started, but its instruction could not be sent.') {
    return translate(
      'components.sessionChain.errorInstructionNotSent',
      'The next agent opened, but did not receive the instruction. Open that conversation and send the instruction there.'
    )
  }
  if (
    message.startsWith("The session's agent is no longer running (") ||
    /^The source session exited with code -?\d+;/.test(message) ||
    message === 'terminal_exited'
  ) {
    return translate(
      'components.sessionChain.errorSourceStopped',
      'The previous agent stopped before this step could continue. Open the conversation to review its result before trying Add Next again.'
    )
  }
  if (message === 'The source workspace is no longer available.') {
    return translate(
      'components.sessionChain.errorFilesUnavailable',
      'The work location is no longer available. Reopen its folder before trying Add Next again.'
    )
  }
  if (!message || /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/i.test(message)) {
    return translate(
      'components.sessionChain.errorUnknown',
      'This step needs attention. Open the conversation to review what happened before trying Add Next again.'
    )
  }
  return message
}
