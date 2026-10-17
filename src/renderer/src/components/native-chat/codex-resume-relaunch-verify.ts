import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'
import { readLiveStartupHeader } from './codex-resume-relaunch-header'
import type { RelaunchLiveCapture } from './codex-resume-relaunch-live-capture'
import { codexResumeRelaunchLabel } from './codex-resume-relaunch-copy'
import {
  advanceCodexResumeRelaunch,
  readCodexResumeRelaunch,
  type CodexResumeRelaunchStatus
} from './codex-resume-relaunch-state'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'

export const CODEX_RELAUNCH_VERIFY_DEADLINE_MS = 30_000

/** Why: a pane proven back at its shell (OSC 133;D, no agent in front) means the
 *  resume command ran and Codex is gone — that is a failure, not "still loading". */
function paneProvenAtShell(paneKey: string): boolean {
  const foreground = useAppStore.getState().paneForegroundAgentByPaneKey?.[paneKey]
  return foreground?.shellForeground === true && foreground.agent === null
}

const requestedLabel = (requested: CodexResumeRelaunchStatus['requested']): string =>
  codexResumeRelaunchLabel(requested, CODEX_SESSION_OPTION_CATALOG.models)

export function failRelaunch(
  paneKey: string,
  surface: NativeChatPtySessionOptionsSurface | null,
  error: string
): void {
  advanceCodexResumeRelaunch(paneKey, { phase: 'failed', error })
  surface?.dropDispatchedSessionOptions()
  toast.error(error)
}

/** Why drop here too: unverified means nobody knows what Codex is on, so the
 *  requested values must not keep claiming "sent" forever — the picker falls
 *  back to what was last reported, and the header scrape (which re-runs once
 *  the phase settles) replaces that with the first frame that parses. */
export function settleRelaunchUnverified(
  paneKey: string,
  surface: NativeChatPtySessionOptionsSurface | null
): void {
  advanceCodexResumeRelaunch(paneKey, { phase: 'unverified' })
  surface?.dropDispatchedSessionOptions()
}

export const relaunchUnverifiedCopy = (): string =>
  translate(
    'components.native-chat.composer.relaunchUnverified',
    "Codex resumed but hasn't reported its model yet. Open Terminal to check."
  )

export const relaunchFailedCopy = (): string =>
  translate(
    'components.native-chat.composer.relaunchFailed',
    "Codex didn't come back after the restart. Open Terminal to see what happened."
  )

export type LatestArgs = {
  terminalTabId: string
  targetPtyId: string | null
  isWorking: boolean
  surface: NativeChatPtySessionOptionsSurface | null
  readTerminalScreen?: () => string | null
}

/** One verification tick; returns true once the record left `verifying`. The
 *  only evidence is the replacement pty's own live bytes (see the capture module),
 *  so a parsed header is always the resumed process's report. */
export function verifyCodexRelaunchTick(
  paneKey: string,
  latest: LatestArgs,
  capture: RelaunchLiveCapture | null
): boolean {
  const status = readCodexResumeRelaunch(paneKey)
  if (status?.phase !== 'verifying') {
    return true
  }
  const { surface, targetPtyId } = latest
  if (targetPtyId === null || (status.newPtyId !== undefined && targetPtyId !== status.newPtyId)) {
    failRelaunch(paneKey, surface, relaunchFailedCopy())
    return true
  }
  const observed =
    capture && capture.ptyId === targetPtyId ? readLiveStartupHeader(capture.text()) : null
  if (observed) {
    const { requested } = status
    const matches =
      observed.model === requested.model &&
      (!requested.effort || observed.effort === requested.effort)
    if (matches) {
      surface?.confirmRelaunchedSessionOptions({
        observed,
        requested,
        selectedOption: status.selectedOption
      })
      advanceCodexResumeRelaunch(paneKey, { phase: 'confirmed', observed })
      toast.success(
        translate(
          'components.native-chat.composer.relaunchConfirmed',
          'Codex is now on {{value0}}.',
          {
            value0: requestedLabel(requested)
          }
        )
      )
    } else {
      surface?.reportSessionOptions(observed)
      advanceCodexResumeRelaunch(paneKey, { phase: 'mismatch', observed })
      toast.warning(
        translate(
          'components.native-chat.composer.relaunchMismatch',
          'Codex came back with {{value0}}, not {{value1}}. Showing what Codex reported.',
          { value0: requestedLabel(observed), value1: requestedLabel(requested) }
        )
      )
    }
    return true
  }
  if (Date.now() - status.startedAt < CODEX_RELAUNCH_VERIFY_DEADLINE_MS) {
    return false
  }
  if (paneProvenAtShell(paneKey)) {
    failRelaunch(paneKey, surface, relaunchFailedCopy())
    return true
  }
  settleRelaunchUnverified(paneKey, surface)
  toast.warning(relaunchUnverifiedCopy())
  return true
}
