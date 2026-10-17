import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import type {
  AttentionLaunchBlocker,
  AttentionLaunchPlan
} from '../../../../shared/attention-launch-favorites'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type AttentionLaunchNotice = {
  key: string
  text: string
  action?: { label: string; run: () => void }
}

export type AttentionLaunchNoticeContext = {
  hasWorkspace: boolean
  /** Execution-host label; empty while it is not known. */
  host: string
  showAgent: (agent: TuiAgent) => void
  turnOnChat: () => void
  editFavorite: (favoriteId: string) => void
}

function noticeKey(blocker: AttentionLaunchBlocker, plan: AttentionLaunchPlan): string {
  switch (blocker.kind) {
    case 'no-workspace':
      return blocker.kind
    case 'account-missing':
    case 'account-local-only':
      return `${blocker.kind}:${plan.favorite.id}`
    case 'agent-disabled':
    case 'agent-not-detected':
    case 'invalid-preferences':
      return `${blocker.kind}:${plan.favorite.agent}`
  }
}

function blockerNotice(
  blocker: AttentionLaunchBlocker,
  plan: AttentionLaunchPlan,
  context: AttentionLaunchNoticeContext
): Omit<AttentionLaunchNotice, 'key'> | null {
  const { favorite } = plan
  const agent = getAgentLabel(favorite.agent)
  const { host } = context
  const editFavorite = {
    label: translate('attentionLauncher.editFavorite', 'Edit {{label}}', { label: favorite.label }),
    run: () => context.editFavorite(favorite.id)
  }
  switch (blocker.kind) {
    case 'no-workspace':
      // The target line already asks for a workspace.
      return null
    case 'agent-disabled':
      return {
        text: translate(
          'attentionLauncher.agentHidden',
          '{{agent}} is hidden in Settings › Agents.',
          {
            agent
          }
        ),
        action: {
          label: translate('attentionLauncher.showAgent', 'Show it'),
          run: () => context.showAgent(favorite.agent)
        }
      }
    case 'agent-not-detected':
      return {
        text: host
          ? translate('attentionLauncher.agentMissing', '{{agent}} is not installed on {{host}}.', {
              agent,
              host
            })
          : translate('attentionLauncher.agentMissingNoHost', '{{agent}} is not installed.', {
              agent
            })
      }
    case 'invalid-preferences':
      return { text: `${favorite.label}: ${blocker.message}` }
    case 'account-missing':
      return {
        text: translate(
          'attentionLauncher.accountMissing',
          '{{label}}: its saved account is no longer available.',
          { label: favorite.label }
        ),
        action: editFavorite
      }
    case 'account-local-only':
      return {
        text: host
          ? translate(
              'attentionLauncher.accountLocalOnly',
              "{{label}}: its account is saved on this computer and can't be used on {{host}}.",
              { label: favorite.label, host }
            )
          : translate(
              'attentionLauncher.accountLocalOnlyNoHost',
              "{{label}}: its account is saved on this computer and can't be used where this workspace runs.",
              { label: favorite.label }
            ),
        action: editFavorite
      }
  }
}

/**
 * Whether the host's agent availability is simply not checked. A launch waits on detection
 * only while a resolved host is being probed: a hostless folder that spans local and SSH
 * children never resolves one (the detection target's ambiguity gate), and a failed probe
 * never answers, so waiting on either would disable every launch for good.
 */
export function attentionDetectionUnchecked(args: {
  hasWorkspace: boolean
  targetResolved: boolean
  probeFailed: boolean
}): boolean {
  return args.probeFailed || (args.hasWorkspace && !args.targetResolved)
}

/** What the launch strip says about its buttons: one line per distinct cause, in plan order. */
export function buildAttentionLaunchNotices(
  plans: readonly AttentionLaunchPlan[],
  context: AttentionLaunchNoticeContext
): AttentionLaunchNotice[] {
  const notices: AttentionLaunchNotice[] = []
  if (context.hasWorkspace && plans.some((plan) => plan.detectionPending)) {
    notices.push({
      key: 'checking',
      text: context.host
        ? translate('attentionLauncher.checkingHost', 'Checking {{host}}…', { host: context.host })
        : translate('attentionLauncher.checking', 'Checking…')
    })
  }
  const seen = new Set<string>()
  for (const plan of plans) {
    for (const blocker of plan.blockers) {
      const key = noticeKey(blocker, plan)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      const notice = blockerNotice(blocker, plan, context)
      if (notice) {
        notices.push({ key, ...notice })
      }
    }
    if (plan.view.mode === 'terminal' && plan.view.reason === 'chat-ui-off' && !seen.has('chat')) {
      seen.add('chat')
      notices.push({
        key: 'chat',
        text: translate(
          'attentionLauncher.chatOff',
          'Chat UI is off, so sessions open in Terminal.'
        ),
        action: {
          label: translate('attentionLauncher.turnOnChat', 'Turn on Chat UI'),
          run: context.turnOnChat
        }
      })
    }
  }
  return notices
}
