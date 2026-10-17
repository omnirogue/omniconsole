/**
 * Chain step launches (and any other generated-prompt paste with no caller-owned
 * write path) delivered as ONE queued item by the host.
 *
 * The paste, the 50 ms gap and Enter — plus the retry Enter for agents that render
 * their composer before Enter is live — belong to the same item, so a chat send or
 * a worker prompt on this session can no longer land between them. Their bytes are
 * identical to the direct path: the same normalize-and-sanitize framing, and the
 * host chunks a paste-sized body exactly as the renderer did.
 */

import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  buildSessionInputProgram,
  isSessionInputDeliveredStatus
} from '../../../shared/session-input-program'
import { wrapTerminalBracketedPasteText } from '@/components/terminal-pane/terminal-bracketed-paste'
import {
  canSubmitRuntimeSessionInput,
  submitRuntimeSessionInput
} from '@/runtime/runtime-session-input'
import { AGENT_DRAFT_PASTE_MAX_BYTES } from './agent-draft-paste-content'

/** Submit bytes are written separately from the paste body; see native-chat-send. */
const AGENT_PASTE_SUBMIT = '\r'

let nextAgentPasteSequence = 1

/**
 * False when this client must do the writes itself: a PTY owned by a remote
 * runtime, or a caller that re-checks its authority before every single write and
 * would lose that check by handing the sequence over.
 */
export function canSendAgentPasteThroughSessionQueue(args: {
  ptyId: string
  beforeWrite?: () => void
  writePty?: (data: string) => Promise<boolean>
}): boolean {
  if (args.beforeWrite || args.writePty) {
    return false
  }
  return canSubmitRuntimeSessionInput(args.ptyId)
}

export async function sendAgentPasteThroughSessionQueue(args: {
  ptyId: string
  content: string
  submit: boolean
  agent?: TuiAgent
  postPasteSubmitDelayMs: number
  clientMessageId?: string
  force?: boolean
}): Promise<boolean> {
  if (args.content.length > AGENT_DRAFT_PASTE_MAX_BYTES) {
    return false
  }
  const submitRetryDelayMs = args.agent
    ? TUI_AGENT_CONFIG[args.agent]?.submitRetryDelayMs
    : undefined
  const program = buildSessionInputProgram({
    body: wrapTerminalBracketedPasteText(args.content),
    submitDelayMs: args.submit ? args.postPasteSubmitDelayMs : 0,
    submit: args.submit ? AGENT_PASTE_SUBMIT : '',
    ...(args.submit && submitRetryDelayMs !== undefined
      ? { submitRetry: { delayMs: submitRetryDelayMs, data: AGENT_PASTE_SUBMIT } }
      : {})
  })
  const receipt = await submitRuntimeSessionInput({
    ptyId: args.ptyId,
    clientMessageId: args.clientMessageId ?? `chain:${Date.now()}:${nextAgentPasteSequence++}`,
    origin: 'chain',
    body: args.content,
    ...(args.force ? { force: true } : {}),
    program
  })
  // Why nothing else counts: a refused duplicate did not write, and this caller
  // must not report a delivery it cannot account for. A chain step that is told
  // "not sent" parks for a person; one told a false "sent" waits on silence.
  return receipt !== null && isSessionInputDeliveredStatus(receipt.status)
}
