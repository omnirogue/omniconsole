import { setTimeout as delay } from 'node:timers/promises'
import type {
  Automation,
  AutomationLaunchProvenanceRequest,
  AutomationOutputBindingRequest,
  AutomationRun,
  AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import { createAutomationLaunchProvenanceGrant } from './dispatch-tokens'
import type { AutomationRunTargetResult } from './run-target-resolution'
import { decideAutomationThreadResume } from '../../shared/automation-thread-resume'
import type { AutomationRunResume } from '../../shared/automation-run-resume-types'
import {
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes,
  getAgentPromptSubmitDelayMs
} from '../../shared/agent-prompt-injection'
import type { RuntimeTerminalCreate } from '../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { ClaudeResumeTranscriptMissingError } from '../claude/claude-resume-launch'
import { UnverifiedCodexResumeError } from '../codex/codex-unverified-resume-launch'
import { AutomationLaunchUnverifiableError } from '../../shared/automation-launch-outcome'

const MAX_HEADLESS_OUTPUT_SNAPSHOT_CHARS = 256 * 1024

export type HeadlessAutomationDispatchLaunch = {
  ownsTerminal?: boolean
  resume?: AutomationRunResume | null
  workspaceId: string
  workspaceDisplayName?: string | null
  terminalSessionId: string | null
  terminalPaneKey?: string | null
  terminalPtyId?: string | null
  completion?: Promise<{
    status: 'completed' | 'dispatch_failed'
    outputSnapshot?: AutomationRunOutputSnapshot | null
    error?: string | null
  }>
}

export type HeadlessAutomationDispatcher = (request: {
  automation: Automation
  launchProvenance?: AutomationLaunchProvenanceRequest
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
}) => Promise<HeadlessAutomationDispatchLaunch>

type HeadlessAutomationLaunchArgs = {
  runtime: Pick<
    OrcaRuntimeService,
    'launchAgentTerminal' | 'getTerminalHandleForPaneKey' | 'showTerminal' | 'sendAutomationInput'
  >
  automation: Automation
  run: AutomationRun
  runs: readonly AutomationRun[]
  localWorkspace: boolean
  openThreadIds?: ReadonlySet<string>
  /** Pane key per open thread whose agent is idle, so a Claude routine types its prompt there. */
  idleThreadPaneKeys?: ReadonlyMap<string, string>
  outputBinding?: AutomationOutputBindingRequest
  launch: Parameters<OrcaRuntimeService['launchAgentTerminal']>[1]
}

/**
 * The headless half of the renderer's pane reuse: Claude keeps a thread usable from any
 * process, so a routine whose recorded thread is open in a live idle pane of its workspace
 * types the prompt there instead of starting a thread with no memory. Returns null when
 * the pane is not usable, and the dispatch launches fresh exactly as before.
 */
async function deliverIntoIdleThreadPane(
  args: HeadlessAutomationLaunchArgs,
  threadId: string
): Promise<RuntimeTerminalCreate | null> {
  const paneKey =
    args.automation.agentId === 'claude' ? args.idleThreadPaneKeys?.get(threadId) : undefined
  const handle = paneKey ? args.runtime.getTerminalHandleForPaneKey(paneKey) : null
  const workspaceId = args.automation.workspaceId
  if (!paneKey || !handle || !workspaceId) {
    return null
  }
  const shown = await args.runtime.showTerminal(handle)
  if (!shown.connected || !shown.ptyId || shown.worktreeId !== workspaceId) {
    return null
  }
  const input = {
    workspaceId,
    paneKey,
    ptyId: shown.ptyId,
    ...(args.outputBinding ? { automationOutputBinding: args.outputBinding } : {})
  }
  const paste = buildAgentPromptPasteBytes(args.launch.prompt)
  const terminal = {
    workspaceId: shown.worktreeId,
    terminalSessionId: shown.tabId ?? null,
    terminalPaneKey: paneKey,
    terminalPtyId: shown.ptyId,
    ownsTerminal: false
  }
  try {
    await args.runtime.sendAutomationInput({ ...input, text: paste })
  } catch (error) {
    // A rejected write can follow accepted bytes; never send the same prompt to another worker.
    throw new AutomationLaunchUnverifiableError(error, terminal)
  }
  // Why: Enter must not overtake a paste the host is still ingesting (agent-prompt-injection).
  await delay(getAgentPromptSubmitDelayMs(process.platform, Buffer.byteLength(paste, 'utf8')))
  try {
    await args.runtime.sendAutomationInput({ ...input, text: AGENT_PROMPT_SUBMIT })
  } catch (error) {
    throw new AutomationLaunchUnverifiableError(error, terminal)
  }
  return {
    handle,
    worktreeId: shown.worktreeId,
    tabId: shown.tabId,
    paneKey,
    ptyId: shown.ptyId,
    title: shown.title ?? null
  }
}

export async function launchHeadlessAutomationTerminal(
  args: HeadlessAutomationLaunchArgs
): Promise<{
  terminal: RuntimeTerminalCreate
  resume: AutomationRunResume | null
  /** The prompt went into an earlier run's live pane, which this run does not own. */
  reused?: true
}> {
  const { launchCause } = args.launch
  const fresh = () =>
    args.runtime.launchAgentTerminal(`id:${args.automation.workspaceId}`, {
      ...args.launch,
      launchCause
    })
  const decision =
    args.automation.reuseSession && args.localWorkspace
      ? decideAutomationThreadResume({
          automationId: args.automation.id,
          agentId: args.automation.agentId,
          worktreeId: args.automation.workspaceId!,
          currentRunId: args.run.id,
          runs: args.runs,
          openThreadIds: args.openThreadIds
        })
      : null
  if (!decision) {
    return { terminal: await fresh(), resume: null }
  }
  if (decision.kind === 'fresh') {
    const delivered = args.openThreadIds?.has(decision.requested)
      ? await deliverIntoIdleThreadPane(args, decision.requested)
      : null
    if (delivered) {
      return {
        terminal: delivered,
        resume: { requested: decision.requested, outcome: 'resumed' } satisfies AutomationRunResume,
        // Why: the pane belongs to the earlier run; this run must not retire it.
        reused: true as const
      }
    }
    return {
      terminal: await fresh(),
      resume: {
        requested: decision.requested,
        outcome: 'fresh',
        reason: decision.reason
      } satisfies AutomationRunResume
    }
  }
  const requested = decision.providerSession.id
  let resume: AutomationRunResume = {
    requested,
    outcome: 'fresh',
    reason: 'The execution host did not confirm the prepared resume selector.'
  }
  try {
    const terminal = await args.runtime.launchAgentTerminal(`id:${args.automation.workspaceId}`, {
      ...args.launch,
      launchCause,
      resumeProviderSession: decision.providerSession,
      onResumePrepared: (prepared) => {
        resume =
          prepared?.id === requested
            ? { requested, outcome: 'resumed' }
            : {
                requested,
                outcome: 'fresh',
                reason: 'Resume preparation could not retain the recorded conversation selector.'
              }
      }
    })
    return { terminal, resume }
  } catch (error) {
    // These transcript refusals precede spawn; other failures may leave a live process.
    if (
      !(error instanceof ClaudeResumeTranscriptMissingError) &&
      !(error instanceof UnverifiedCodexResumeError)
    ) {
      throw error
    }
    const reason = error instanceof Error ? error.message : String(error)
    return {
      terminal: await fresh(),
      resume: { requested, outcome: 'fresh', reason } satisfies AutomationRunResume
    }
  }
}

export function withHeadlessAutomationLaunchProvenance(
  store: object,
  dispatcher: HeadlessAutomationDispatcher
): HeadlessAutomationDispatcher {
  return (request) =>
    dispatcher({
      ...request,
      launchProvenance: createAutomationLaunchProvenanceGrant(
        store,
        request.automation,
        request.run
      )
    })
}

export function createHeadlessAutomationOutputSnapshotBuffer(): {
  append: (chunk: string) => void
  snapshot: () => AutomationRunOutputSnapshot | null
} {
  const chunks: string[] = []
  let totalChars = 0
  let truncated = false

  return {
    append(chunk): void {
      if (!chunk) {
        return
      }
      chunks.push(chunk)
      totalChars += chunk.length
      let overflowChars = totalChars - MAX_HEADLESS_OUTPUT_SNAPSHOT_CHARS
      while (overflowChars > 0 && chunks.length > 0) {
        const firstChunk = chunks[0]!
        if (firstChunk.length <= overflowChars) {
          chunks.shift()
          totalChars -= firstChunk.length
          overflowChars -= firstChunk.length
          truncated = true
          continue
        }
        chunks[0] = firstChunk.slice(overflowChars)
        totalChars -= overflowChars
        truncated = true
        overflowChars = 0
      }
    },
    snapshot(): AutomationRunOutputSnapshot | null {
      const content = chunks.join('').trim()
      if (!content) {
        return null
      }
      return {
        format: 'plain_text',
        content,
        capturedAt: Date.now(),
        truncated,
        provenance: 'terminal_capture'
      }
    }
  }
}
