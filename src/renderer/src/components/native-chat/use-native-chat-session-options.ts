import { readCodexSessionOptionsFromTerminalScreen } from './codex-terminal-session-options'
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  getAgentSessionOptionCatalog,
  type CatalogModel
} from '../../../../shared/agent-session-option-catalog'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from './native-chat-pty-session-options'
import type {
  NativeChatSessionOptionDispatchCommand,
  NativeChatSessionOptionRelaunch
} from './native-chat-session-option-command-dispatch'
import { codexResumeRelaunchUnavailableCopy } from './codex-resume-relaunch-copy'
import {
  isCodexResumeRelaunchInFlight,
  isCodexResumeRelaunchStatusInFlight,
  type CodexResumeRelaunchStatus
} from './codex-resume-relaunch-state'
import { useCodexResumeRelaunch } from './use-codex-resume-relaunch'
import {
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'
import {
  discoverNativeChatCatalogModels,
  resolveNativeChatModelDiscoveryContext
} from './native-chat-session-option-discovery'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

function readReportedOptions(
  agent: AgentType,
  screen: string | null | undefined,
  models?: readonly CatalogModel[]
) {
  return agent === 'codex'
    ? readCodexSessionOptionsFromTerminalScreen(screen, models)
    : agent === 'claude'
      ? readClaudeSessionOptionsFromTerminalScreen(screen, models)
      : null
}

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT
const CLIENT_SETTINGS_TARGET = { kind: 'local' } as const

/**
 * Why: the picker drops a retired model, but the persisted default is what launches
 * become `-m <id>` — every launch site reads it, including the ones that never show
 * the picker. Left alone the id is invisible and still fatal, so an authoritative
 * probe that no longer lists it must retire it here too.
 */
export async function retirePersistedModelMissingFromDiscovery(
  agent: AgentType,
  models: readonly CatalogModel[]
): Promise<void> {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog?.discoveredModelsAreAuthoritative || catalog.preserveExplicitModelSelection) {
    return
  }
  // An empty list means the probe failed, not that the account has no models.
  if (models.length === 0) {
    return
  }
  await enqueueSessionOptionSettingsWrite(CLIENT_SETTINGS_TARGET, {
    type: 'clear-model-if-missing',
    agent,
    availableModelIds: models.map((model) => model.id)
  })
}

export function useNativeChatSessionOptions(args: {
  agent: AgentType
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
  isWorking: boolean
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  readTerminalScreen?: () => string | null
  reportedModel?: string
}): {
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  relaunchStatus: CodexResumeRelaunchStatus | null
} {
  const {
    agent,
    terminalTabId,
    paneKey,
    targetPtyId,
    isWorking,
    dispatchCommand,
    onAgentPicker,
    readTerminalScreen,
    reportedModel
  } = args
  // The screen text that last parsed into reported values, so a later model
  // discovery can re-resolve it against the host's real ids.
  const reportedScreenRef = useRef<string | null>(null)
  // Why a ref: the relaunch hook needs the surface this memo builds, and the
  // surface needs the relaunch — a stable trampoline breaks the cycle without
  // rebuilding the surface (and its record) on every render.
  const relaunchRef = useRef<NativeChatSessionOptionRelaunch | null>(null)
  const relaunchSessionOptions = useMemo<NativeChatSessionOptionRelaunch | undefined>(
    () =>
      agent === 'codex'
        ? (relaunchArgs) =>
            relaunchRef.current
              ? relaunchRef.current(relaunchArgs)
              : Promise.reject(new Error(codexResumeRelaunchUnavailableCopy()))
        : undefined,
    [agent]
  )
  const discoveryContext = useMemo(
    () => resolveNativeChatModelDiscoveryContext(terminalTabId),
    [terminalTabId]
  )
  const surface = useMemo(() => {
    // Why: native chat currently attaches only after startup is already queued;
    // exposing a draft picker here would claim it can still mutate that command.
    if (!targetPtyId) {
      return null
    }
    const scopeKey = targetPtyId ?? terminalTabId
    const discoveredModels = discoveryContext
      ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
      : null
    // Why not while a relaunch is in flight: the killed TUI's frozen footer is
    // still on screen when the PTY id flips, and reading it here would overwrite
    // the `dispatched` values mirrored onto the tab scope with the old ones as
    // "reported". The relaunch verifier is the only writer until it settles.
    const reportedValues = isCodexResumeRelaunchInFlight(paneKey)
      ? null
      : readReportedOptions(agent, readTerminalScreen?.(), discoveredModels ?? undefined)
    return createNativeChatPtySessionOptions({
      agent,
      scopeKey,
      ...(targetPtyId ? { fallbackScopeKey: terminalTabId } : {}),
      // Why: the catalog seed carries version-neutral family labels, so it is
      // safe on every host while the once-per-host probe runs or after it fails
      // — without it the whole picker would pop in late or never appear.
      ...(discoveryContext ? { initialModels: discoveredModels ?? undefined } : {}),
      mode: targetPtyId ? 'live' : 'draft',
      reportedValues,
      dispatchCommand,
      relaunchSessionOptions,
      onAgentPicker,
      persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault }) =>
        // Paired PTY launches still assemble their launch preferences from client settings.
        enqueueSessionOptionSettingsWrite(CLIENT_SETTINGS_TARGET, {
          type: 'apply-picks',
          agent,
          picks: [{ modelId, optionId, value, adoptModelAsLaunchDefault }]
        })
    })
  }, [
    agent,
    dispatchCommand,
    discoveryContext,
    onAgentPicker,
    paneKey,
    readTerminalScreen,
    relaunchSessionOptions,
    targetPtyId,
    terminalTabId
  ])

  useEffect(() => {
    if (agent === 'omp' && reportedModel) {
      surface?.reportSessionOptions({ model: reportedModel })
    }
  }, [agent, reportedModel, surface])

  const relaunch = useCodexResumeRelaunch({
    agent,
    paneKey,
    terminalTabId,
    targetPtyId,
    isWorking,
    surface,
    readTerminalScreen
  })
  useLayoutEffect(() => {
    relaunchRef.current = relaunch.relaunchSessionOptions ?? null
  }, [relaunch.relaunchSessionOptions])
  const relaunchPhase = relaunch.status?.phase
  const relaunchInFlight = isCodexResumeRelaunchStatusInFlight(relaunch.status)

  // Why the relaunch gate: this runs at surface build, when the new PTY's main
  // buffer is empty and the mounted xterm still shows the killed TUI's footer —
  // scraping now would report the pre-relaunch values over the dispatched ones.
  // The relaunch poll owns the truth until it settles; the phase is a dependency
  // so the scrape runs again on the first frame after that.
  useEffect(() => {
    if (!surface || (agent !== 'claude' && agent !== 'codex') || relaunchInFlight) {
      return
    }
    let cancelled = false
    let reading = false
    const deadline = Date.now() + 60_000
    reportedScreenRef.current = null
    const reportCurrentValues = async (): Promise<void> => {
      if (cancelled || reading) {
        return
      }
      reading = true
      try {
        let authoritativeScreen: string | null = null
        if (targetPtyId && window.api?.pty?.getMainBufferSnapshot) {
          try {
            const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
              scrollbackRows: 0
            })
            // Why: the API snapshots the main buffer, which is stale while a TUI
            // owns the alternate screen. The mounted xterm is authoritative then.
            authoritativeScreen = snapshot?.alternateScreen ? null : (snapshot?.data ?? null)
          } catch {
            // The mounted renderer buffer remains a transport-neutral fallback.
          }
        }
        const models = discoveryContext
          ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
          : null
        for (const screen of [authoritativeScreen, readTerminalScreen?.() ?? null]) {
          const reportedValues = readReportedOptions(agent, screen, models ?? undefined)
          if (!reportedValues) {
            continue
          }
          // Why: discovery can land after this read. Keeping the screen that
          // parsed lets it re-resolve against the host's real ids later, when the
          // frame itself may have already scrolled out of the buffer.
          if (cancelled) {
            return
          }
          reportedScreenRef.current = screen
          clearInterval(retryTimer)
          surface.reportSessionOptions(reportedValues)
          return
        }
      } finally {
        reading = false
      }
    }
    // A resumed CLI may draw its first header after the Chat surface mounts.
    const retryTimer = setInterval(() => {
      if (Date.now() >= deadline) {
        clearInterval(retryTimer)
        return
      }
      void reportCurrentValues()
    }, 250)
    void reportCurrentValues()
    return () => {
      cancelled = true
      clearInterval(retryTimer)
    }
  }, [
    agent,
    discoveryContext,
    readTerminalScreen,
    relaunchInFlight,
    relaunchPhase,
    surface,
    targetPtyId
  ])

  useEffect(() => {
    if (!surface || !discoveryContext) {
      return
    }
    const unsubscribe = subscribeNativeChatEnrichedModels(
      agent,
      discoveryContext.hostKey,
      (models) => {
        surface.replaceModels(models)
        const screen = reportedScreenRef.current
        const reportedValues = screen ? readReportedOptions(agent, screen, models) : null
        if (reportedValues) {
          surface.reportSessionOptions(reportedValues)
        }
        // A failed settings write must not surface as an unhandled rejection.
        void retirePersistedModelMissingFromDiscovery(agent, models).catch(() => undefined)
      }
    )
    // Why: the subscription never replays, so a probe that settled before this
    // pane mounted would leave a retired persisted model in place forever.
    const cached = readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
    if (cached) {
      void retirePersistedModelMissingFromDiscovery(agent, cached).catch(() => undefined)
    }
    ensureNativeChatModelEnrichment({
      agent,
      hostKey: discoveryContext.hostKey,
      discover: () => discoverNativeChatCatalogModels(agent, discoveryContext.runtime)
    })
    return unsubscribe
  }, [agent, discoveryContext, surface])

  const snapshot = useSyncExternalStore(
    surface?.subscribe ?? subscribeEmpty,
    surface?.getSnapshot ?? getEmptySnapshot,
    surface?.getSnapshot ?? getEmptySnapshot
  )
  return { surface, snapshot, relaunchStatus: relaunch.status }
}
