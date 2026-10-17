import type { OrchestrationCaller } from './build-review-rpc-call'
import type { WorkerUnitLike } from './build-review-worker-registry'

/** A worker-start receipt that did not end ready. */
export type FailedWorkerStart = {
  dispatchId: string
  state: string
  lastError?: string
  /** The runtime's own id for a startup prompt only a person may answer. */
  startupBlocker?: string
}

export const CLAUDE_FOLDER_TRUST_BLOCKER = 'claude-folder-trust'
export const AGENT_PROMPT_STALLED_BLOCKER = 'agent-prompt-stalled'
// Why: the runtime files every folder-trust dialog under this id, Claude's "Yes, I trust this
// folder" included, so for a Claude worker it is Claude asking.
const TRUST_WORKSPACE_BLOCKER = 'codex-trust-workspace'

const STALLED_PROMPT = /\bagent_prompt_(?:stalled|blocked)\b/
const LEGACY_BLOCKER = /^Agent startup blocked: ([a-z-]+)$/
// Claude Code's folder-trust dialog, current and earlier wordings.
const CLAUDE_TRUST_PROMPT =
  /(?:Yes, I trust this folder|Is this a project you (?:created or one you )?trust|Do you trust the files in this folder)/i

type WorkerShow = { worker: { agent_terminal_handle: string | null } }
type TerminalRead = { terminal?: { tail?: unknown } }

/** The blocker a failed start names, before the screen is read. */
export function startupBlockerFromReceipt(started: FailedWorkerStart): string | undefined {
  const lastError = started.lastError?.trim() ?? ''
  return (
    started.startupBlocker ??
    LEGACY_BLOCKER.exec(lastError)?.[1] ??
    (STALLED_PROMPT.test(lastError) ? AGENT_PROMPT_STALLED_BLOCKER : undefined)
  )
}

async function screenText(call: OrchestrationCaller, handle: string): Promise<string> {
  try {
    // Why screen: the stream stacks every repaint of the dialog; the rendered screen reads as shown.
    const read = await call<TerminalRead>('terminal.read', {
      terminal: handle,
      limit: 60,
      screen: true
    })
    const tail = read.terminal?.tail
    return Array.isArray(tail) ? tail.filter((line) => typeof line === 'string').join('\n') : ''
  } catch {
    return ''
  }
}

/**
 * After a start that did not end ready: keep the worker's terminal handle (so the person can open
 * it) and name the prompt it is waiting on. Claude's folder-trust dialog is not a runtime blocker
 * id; a stalled or approval-blocked Claude start is read off its screen. Best effort: a failed
 * read leaves the receipt's own answer.
 */
export async function noteWorkerStartFailure(
  call: OrchestrationCaller,
  worker: WorkerUnitLike,
  started: FailedWorkerStart
): Promise<void> {
  try {
    const shown = await call<WorkerShow>('orchestration.workerShow', {
      dispatch: started.dispatchId
    })
    worker.terminalHandle = shown.worker.agent_terminal_handle ?? worker.terminalHandle
  } catch {
    // The receipt's error still reaches the person; the terminal button stays unavailable.
  }
  const blocker = startupBlockerFromReceipt(started)
  if (!blocker) {
    return
  }
  const handle = worker.terminalHandle
  const claude = worker.choice.agent === 'claude' || worker.choice.agent === 'claude-agent-teams'
  worker.startupBlocker =
    claude &&
    (blocker === TRUST_WORKSPACE_BLOCKER ||
      (handle && CLAUDE_TRUST_PROMPT.test(await screenText(call, handle))))
      ? CLAUDE_FOLDER_TRUST_BLOCKER
      : blocker
}
