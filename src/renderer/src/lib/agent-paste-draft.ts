import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveDraftPasteReadyTimeoutMs } from '../../../shared/draft-paste-ready-timeout'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START
} from '@/components/terminal-pane/terminal-bracketed-paste'
import { waitForAgentReady } from './agent-ready-wait'
import { getSettingsForWorktreeRuntimeOwner } from './worktree-runtime-owner'
import { sendBracketedPasteToAgent } from './agent-bracketed-paste-transaction'
import { agentDeliversDraftViaNativePrefill } from './agent-native-draft-prefill'
import { waitForAgentDraftInputReady } from './agent-draft-readiness'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import { waitForAgentStartupReview } from './agent-startup-review'
import { isAgentStartInFlightForTab } from './agent-start-in-flight'
export {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  chunkAgentDraftPasteContent,
  iterateAgentDraftPasteContentChunks,
  sendAgentDraftPasteContent
} from './agent-draft-paste-content'

// Why: bracketed paste markers let modern TUIs (Claude Code / Codex / Pi /
// OpenCode / Gemini / cursor-agent / copilot) treat the inserted text as a
// single atomic paste instead of echoing character-by-character or triggering
// line-edit shortcuts. Callers choose whether to append Enter after the paste.
export const BRACKETED_PASTE_BEGIN = BRACKETED_PASTE_START
export { BRACKETED_PASTE_END }
export { POST_PASTE_SUBMIT_DELAY_MS } from './agent-bracketed-paste-transaction'

// Why: "the tab has a PTY" and "the agent's composer accepts input" are separate
// states with separate failure modes, so they get separate budgets. A PTY that
// hasn't appeared in 8s means the launch itself failed — waiting the (longer)
// composer budget on top would only delay that verdict. Keeping them distinct
// also stops one slow step from spending the other's budget (STA-3367).
const PTY_SPAWN_TIMEOUT_MS = 8000
// Why: an agent start can wait in main's app-wide admission queue (3 per 10 s) before its PTY
// exists; that wait is not a failed launch, so the spawn budget restarts while the tab's start
// is still in flight. The ceiling bounds a start that never settles.
const MAX_QUEUED_AGENT_START_WAIT_MS = 5 * 60_000

export function getSettingsForAgentTabRuntimeOwner(
  tabId: string
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  const store = useAppStore.getState()
  for (const [worktreeId, tabs] of Object.entries(store.tabsByWorktree ?? {})) {
    if (tabs?.some((tab) => tab.id === tabId)) {
      // Why: legacy remote PTY ids may not embed their runtime owner. The tab's
      // worktree still identifies which host should receive readiness/send RPCs.
      return getSettingsForWorktreeRuntimeOwner(store, worktreeId)
    }
  }
  return store.settings
}

/**
 * Wait until the agent on `tabId` has rendered its input-accepting TUI,
 * then bracketed-paste `content` into its input buffer. By default the
 * draft stays editable; `submit: true` appends Enter after the paste.
 *
 * Returns true when the paste was issued, false on timeout or missing
 * PTY. `onTimeout` lets the caller surface a UI hint (e.g. toast) when
 * the agent doesn't reach a ready state. `timeoutMs` overrides the
 * readiness budget only; waiting for the PTY to spawn keeps its own budget.
 *
 * Readiness combines DECSET 2004 with one agent-specific follow-up signal:
 *   1. `\x1b[?2004h` (DECSET 2004 — bracketed-paste-enable) on the PTY
 *      output. This is the protocol-level "I accept bracketed paste"
 *      handshake.
 *   2. Either ≥`BRACKETED_PASTE_QUIET_MS` of silence after the last byte of
 *      the post-handshake render burst, or Codex's composer prompt glyph.
 */
export async function pasteDraftWhenAgentReady(args: {
  tabId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: () => void
  beforeWrite?: () => void
}): Promise<boolean> {
  const { tabId, content, agent, submit, forcePaste, timeoutMs, onTimeout, beforeWrite } = args
  beforeWrite?.()

  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  // Why: agents with a native draft prefill mechanism (flag or env var)
  // launch with the URL already in their input box. Pasting again would
  // duplicate it. Callers should not invoke this helper for those agents;
  // the early return guards against accidental double-injection if a stale
  // call slips through.
  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }

  const readySignal = agentConfig?.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  const settings = getSettingsForAgentTabRuntimeOwner(tabId)
  const readinessTimeoutMs = resolveDraftPasteReadyTimeoutMs(agent, timeoutMs)
  const readiness = await waitForAgentDraftInputReadyOnTab({
    tabId,
    spawnTimeoutMs: PTY_SPAWN_TIMEOUT_MS,
    readinessTimeoutMs,
    readySignal,
    settings
  })
  if (!readiness) {
    onTimeout?.()
    return false
  }

  const { ptyId } = readiness
  if (!readiness.ready) {
    // Why: fast-starting TUIs can emit the paste-ready escape sequence before
    // this sidecar subscription attaches. If process/title inspection says the
    // launched agent owns the PTY, fall back to a best-effort paste instead of
    // silently dropping generated prompts.
    const fallbackReady = agentConfig
      ? await waitForAgentReady(tabId, agentConfig.expectedProcess, { timeoutMs: 1000 })
      : { ready: false }
    if (!fallbackReady.ready) {
      onTimeout?.()
      return false
    }
  }

  if (!(await waitForAgentStartupReview({ ptyId, agent, beforeWrite }))) {
    onTimeout?.()
    return false
  }
  return await sendBracketedPasteToAgent({
    settings,
    ptyId,
    content,
    submit: submit === true,
    agent,
    beforeWrite
  })
}

export async function pasteDraftToAgentPtyWhenReady(args: {
  tabId: string
  ptyId: string
  content: string
  agent?: TuiAgent
  submit?: boolean
  forcePaste?: boolean
  timeoutMs?: number
  onTimeout?: () => void
  beforeWrite?: () => void
}): Promise<boolean> {
  const { tabId, ptyId, content, agent, submit, forcePaste, timeoutMs, onTimeout, beforeWrite } =
    args
  beforeWrite?.()
  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null

  if (agentDeliversDraftViaNativePrefill(agent, forcePaste)) {
    return false
  }

  const settings = getSettingsForAgentTabRuntimeOwner(tabId)
  const readySignal = agentConfig?.draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  const budget = resolveDraftPasteReadyTimeoutMs(agent, timeoutMs)
  const ready = await waitForAgentDraftInputReady(ptyId, budget, readySignal, settings)
  if (!ready) {
    const fallbackReady = agentConfig
      ? await waitForExpectedAgentOnPty(ptyId, agentConfig.expectedProcess, 1000, settings)
      : false
    if (!fallbackReady) {
      onTimeout?.()
      return false
    }
  }

  if (!(await waitForAgentStartupReview({ ptyId, agent, beforeWrite }))) {
    onTimeout?.()
    return false
  }
  return await sendBracketedPasteToAgent({
    settings,
    ptyId,
    content,
    submit: submit === true,
    agent,
    beforeWrite
  })
}

export async function submitPromptToAgentPty(args: {
  tabId: string
  ptyId: string
  content: string
  beforeWrite?: () => void
  writePty?: (data: string) => Promise<boolean>
}): Promise<boolean> {
  args.beforeWrite?.()
  return await sendBracketedPasteToAgent({
    settings: getSettingsForAgentTabRuntimeOwner(args.tabId),
    ptyId: args.ptyId,
    content: args.content,
    submit: true,
    beforeWrite: args.beforeWrite,
    writePty: args.writePty
  })
}

export async function sendBracketedPasteToRunningAgent(args: {
  ptyId: string
  content: string
}): Promise<boolean> {
  return await sendBracketedPasteToAgent({ ptyId: args.ptyId, content: args.content, submit: true })
}

function waitForAgentDraftInputReadyOnTab(args: {
  tabId: string
  spawnTimeoutMs: number
  readinessTimeoutMs: number
  readySignal: Parameters<typeof waitForAgentDraftInputReady>[2]
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
}): Promise<{ ptyId: string; ready: boolean } | null> {
  return new Promise((resolve) => {
    let selectedPtyId: string | null = null
    let settled = false
    let spawnTimer: number | null = null
    let unsubscribeStore: (() => void) | null = null

    const finish = (result: { ptyId: string; ready: boolean } | null): void => {
      if (settled) {
        return
      }
      settled = true
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      resolve(result)
    }
    const bindPty = (ptyId: string): void => {
      if (selectedPtyId || settled) {
        return
      }
      selectedPtyId = ptyId
      if (spawnTimer !== null) {
        window.clearTimeout(spawnTimer)
      }
      unsubscribeStore?.()
      // Why: Zustand subscribers run inside updateTabPtyId. Registering the
      // sidecar here precedes the transport's immediate pre-handler drain.
      void waitForAgentDraftInputReady(
        ptyId,
        args.readinessTimeoutMs,
        args.readySignal,
        args.settings
      ).then((ready) => finish({ ptyId, ready }))
    }
    const bindFromState = (state: ReturnType<typeof useAppStore.getState>): void => {
      const ptyId = state.ptyIdsByTabId[args.tabId]?.[0]
      if (ptyId) {
        bindPty(ptyId)
      }
    }

    const queuedWaitDeadline = Date.now() + MAX_QUEUED_AGENT_START_WAIT_MS
    const onSpawnTimeout = (): void => {
      if (isAgentStartInFlightForTab(args.tabId) && Date.now() < queuedWaitDeadline) {
        spawnTimer = window.setTimeout(onSpawnTimeout, args.spawnTimeoutMs)
        return
      }
      finish(null)
    }
    spawnTimer = window.setTimeout(onSpawnTimeout, args.spawnTimeoutMs)
    unsubscribeStore = useAppStore.subscribe(bindFromState)
    bindFromState(useAppStore.getState())
  })
}

async function waitForExpectedAgentOnPty(
  ptyId: string,
  expectedProcess: string,
  timeoutMs: number,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const process = await withDeadline(
        inspectRuntimeTerminalProcess(settings, ptyId),
        Math.max(0, deadline - Date.now())
      )
      if (!process) {
        return false
      }
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
    const delayMs = Math.min(120, Math.max(0, deadline - Date.now()))
    if (delayMs > 0) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
    }
  }
  return false
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) {
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      }
    )
  })
}
