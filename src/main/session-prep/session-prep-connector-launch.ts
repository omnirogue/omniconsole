import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import type { TuiAgent } from '../../shared/tui-agent'

export type SessionPrepNativeReceipt = {
  operationId: string
  provider: TuiAgent
  terminal: { handle: string; paneKey?: string | null; tabId?: string }
  [key: string]: unknown
}

export function sessionPrepConnectorPrompt(
  prompt: string,
  launch?: SessionPrepConnectorLaunch
): string {
  if (!launch) {
    return prompt
  }
  const instructions = `Save finished deliverable files in this session's results folder: ${launch.resultsFolder}.\nOnly files in that folder are downloadable through this conversation. Do not place credentials, authentication stores or private configuration there.`
  return prompt.endsWith(instructions) ? prompt : `${prompt}\n\n${instructions}`
}
