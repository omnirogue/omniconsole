import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  agentStartupInterventionAgent,
  detectAgentStartupIntervention,
  type AgentStartupIntervention,
  type AgentStartupInterventionAction
} from '../../../../shared/agent-startup-intervention'
import type { CodexInstallationDiagnostics } from '../../../../shared/codex-installation-diagnostics-types'
export { hasOptionalAutomationReview } from '../../../../shared/agent-setup-review'

/** Keystrokes for one choice are sent once; a second click inside this window is a bounce. */
const ACTION_SETTLE_MS = 1_500

function actionLabel(action: AgentStartupInterventionAction): string {
  switch (action.id) {
    case 'skip-update':
      return translate('conversations.startupIntervention.action.skipUpdate', 'Skip this time')
    case 'skip-update-until-next':
      return translate(
        'conversations.startupIntervention.action.skipUpdateUntilNext',
        'Skip until next version'
      )
    case 'update-now':
      return translate(
        'conversations.startupIntervention.action.updateNow',
        'Update now (Codex quits and must be restarted)'
      )
    case 'trust':
      return translate('conversations.startupIntervention.action.trust', 'Trust and continue')
    case 'quit':
      return translate('conversations.startupIntervention.action.quit', 'Quit the agent')
    case 'continue':
      return translate('conversations.startupIntervention.action.continue', 'Continue')
    case 'keep-permission-mode':
      return translate(
        'conversations.startupIntervention.action.keepPermissionMode',
        'Keep current permission mode'
      )
    case 'continue-without-automation':
      return translate('conversations.continueWithoutAutomation', 'Continue without it')
    case 'open-terminal':
      return translate('conversations.startupIntervention.action.openTerminal', 'Open Terminal…')
  }
}

function interventionTitle(intervention: AgentStartupIntervention): string {
  const agentName = intervention.agent === 'codex' ? 'Codex' : 'Claude Code'
  switch (intervention.kind) {
    case 'update-available':
      return translate(
        'conversations.startupIntervention.updateAvailable.title',
        'Codex is offering an update ({{current}} → {{latest}})',
        {
          current: intervention.update?.currentVersion ?? '?',
          latest: intervention.update?.latestVersion ?? '?'
        }
      )
    case 'automation-review':
      return translate(
        'conversations.optionalAutomationReview',
        'An optional automation needs review before it can run. You can continue working with it disabled.'
      )
    case 'trust-prompt':
      return translate(
        'conversations.startupIntervention.trustPrompt.title',
        '{{agent}} is asking whether to trust this folder',
        { agent: agentName }
      )
    case 'login-required':
      return translate(
        'conversations.startupIntervention.loginRequired.title',
        '{{agent}} needs you to sign in',
        { agent: agentName }
      )
    case 'onboarding':
      return translate(
        'conversations.startupIntervention.onboarding.title',
        'Claude Code is showing its first-run setup'
      )
    case 'permission-mode':
      return translate(
        'conversations.startupIntervention.permissionMode.title',
        'Claude Code is asking to change its default permission mode'
      )
    case 'model-migration':
      return translate(
        'conversations.startupIntervention.modelMigration.title',
        'Codex has a model change to confirm'
      )
    case 'cwd-prompt':
      return translate(
        'conversations.startupIntervention.cwdPrompt.title',
        'Codex is asking which working directory to use'
      )
  }
}

function updateTargetWarning(diagnostics: CodexInstallationDiagnostics): string | null {
  if (!diagnostics.updateTargetDiverges || !diagnostics.npmGlobalPrefix) {
    return null
  }
  return translate(
    'conversations.startupIntervention.updateTargetDiverges',
    'Codex {{version}} runs from {{realPath}}. Its updater installs into {{prefix}}{{present}}, so “Update now” will not change what OmniConsole launches. Point the PATH entry at that install or reinstall Codex in one place.',
    {
      version: diagnostics.version ?? '?',
      realPath: diagnostics.realPath ?? diagnostics.command,
      prefix: diagnostics.npmGlobalPrefix,
      present: diagnostics.npmGlobalCodexVersion
        ? ` (${diagnostics.npmGlobalCodexVersion} is already there)`
        : ''
    }
  )
}

/**
 * The startup screen currently covering the agent's composer, with the choices
 * it offers. Every keystroke goes through the pane's own input path and only
 * when the person clicks; nothing here grants trust, updates, or signs in on
 * their behalf. While shown, the composer is held so a chat prompt cannot be
 * read by the menu as an answer.
 */
export function NativeChatSetupNotice({
  enabled,
  agent,
  readScreen,
  canSend,
  sendRaw,
  onContinue,
  onReview,
  onBlockedChange,
  readInstallation
}: {
  enabled: boolean
  agent?: string | null
  readScreen?: () => string | null
  canSend: boolean
  /** Writes raw keys to the pane's PTY (the interactive-send path). */
  sendRaw?: (keys: string) => void
  /** Legacy hooks-review escape; used when `sendRaw` is absent. */
  onContinue: () => void
  onReview?: () => void
  onBlockedChange: (blocked: boolean) => void
  /** Codex install facts for the update offer; absent on hosts without the probe. */
  readInstallation?: () => Promise<CodexInstallationDiagnostics>
}) {
  const [intervention, setIntervention] = useState<AgentStartupIntervention | null>(null)
  const [diagnostics, setDiagnostics] = useState<CodexInstallationDiagnostics | null>(null)
  const [settling, setSettling] = useState(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interventionAgent = agentStartupInterventionAgent(agent ?? 'codex')
  useEffect(() => {
    if (!enabled || !readScreen || !interventionAgent) {
      setIntervention(null)
      return
    }
    const check = () => {
      const next = detectAgentStartupIntervention(interventionAgent, readScreen())
      setIntervention((previous) =>
        JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      )
    }
    check()
    const timer = setInterval(check, 1000)
    return () => clearInterval(timer)
  }, [enabled, readScreen, interventionAgent])
  const blocked = intervention !== null
  useEffect(() => {
    onBlockedChange(blocked)
    return () => onBlockedChange(false)
  }, [blocked, onBlockedChange])
  useEffect(() => {
    if (intervention?.kind !== 'update-available' || !readInstallation) {
      setDiagnostics(null)
      return
    }
    let cancelled = false
    readInstallation().then(
      (value) => {
        if (!cancelled) {
          setDiagnostics(value)
        }
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [intervention?.kind, readInstallation])
  useEffect(
    () => () => {
      if (settleTimer.current) {
        clearTimeout(settleTimer.current)
      }
    },
    []
  )
  if (!intervention) {
    return null
  }
  const choose = (action: AgentStartupInterventionAction): void => {
    if (action.requiresTerminal) {
      onReview?.()
      return
    }
    if (settling) {
      return
    }
    if (sendRaw) {
      sendRaw(action.keys)
    } else if (action.id === 'continue-without-automation' && action.keys === '\x1b') {
      onContinue()
    }
    setSettling(true)
    settleTimer.current = setTimeout(() => setSettling(false), ACTION_SETTLE_MS)
  }
  const canChoose = (action: AgentStartupInterventionAction): boolean =>
    action.requiresTerminal
      ? Boolean(onReview)
      : canSend &&
        !settling &&
        (Boolean(sendRaw) ||
          (action.id === 'continue-without-automation' && action.keys === '\x1b'))
  const warning = diagnostics ? updateTargetWarning(diagnostics) : null
  return (
    <div
      role="status"
      data-native-chat-startup-intervention={intervention.kind}
      className="space-y-2 border-b bg-muted/40 px-3 py-2 text-xs"
    >
      <p className="font-medium">{interventionTitle(intervention)}</p>
      <p className="text-muted-foreground">
        {translate(
          'conversations.startupIntervention.detail',
          'The agent is showing a startup prompt instead of its composer. Your message waits until you choose.'
        )}
      </p>
      {warning ? <p className="text-amber-700 dark:text-amber-400">{warning}</p> : null}
      <div className="flex flex-wrap gap-2">
        {intervention.actions.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant={action.recommended ? 'outline' : 'ghost'}
            disabled={!canChoose(action)}
            onClick={() => choose(action)}
          >
            {actionLabel(action)}
          </Button>
        ))}
        {onReview && !intervention.actions.some((action) => action.requiresTerminal) ? (
          <Button size="sm" variant="ghost" onClick={onReview}>
            {translate('conversations.reviewSetup', 'Review setup…')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
