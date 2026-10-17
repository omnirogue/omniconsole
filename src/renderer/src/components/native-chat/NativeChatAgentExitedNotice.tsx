import { isTuiAgent } from '../../../../shared/tui-agent-config'
import {
  restartExitedNativeChatAgent,
  resumeExitedNativeChatSession
} from '@/lib/native-chat-exited-session-relaunch'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatSession } from '../../../../shared/native-chat-types'

const AGENT_DISPLAY_NAMES: Partial<Record<NativeChatSession['agent'], string>> = {
  codex: 'Codex',
  claude: 'Claude Code'
}

function agentDisplayName(agent: NativeChatSession['agent']): string {
  return AGENT_DISPLAY_NAMES[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1)
}

/**
 * Shown in place of the composer once the agent process is gone: the history
 * above stays readable, and the next step is explicit instead of a shell prompt
 * quietly swallowing the next message.
 */
export function NativeChatAgentExitedNotice({
  agent,
  canResume,
  hasUndeliveredPrompt,
  onResume,
  onRestart,
  onOpenTerminal
}: {
  agent: NativeChatSession['agent']
  canResume: boolean
  hasUndeliveredPrompt: boolean
  onResume?: () => void
  onRestart?: () => void
  onOpenTerminal?: () => void
}): React.JSX.Element {
  const name = agentDisplayName(agent)
  return (
    <div
      role="status"
      data-native-chat-agent-exited="true"
      className="space-y-2 border-t border-status-warning-border bg-status-warning-background px-3 py-2 text-xs"
    >
      <p className="font-medium text-status-warning">
        {translate(
          'conversations.agentExited.title',
          "{{agent}} exited — this conversation's history is kept.",
          { agent: name }
        )}
      </p>
      <p className="text-muted-foreground">
        {canResume
          ? translate(
              'conversations.agentExited.detailResumable',
              'Resume to continue the same {{agent}} session in a new tab, or start over.',
              { agent: name }
            )
          : translate(
              'conversations.agentExited.detailFresh',
              '{{agent}} stopped before it reported a session to continue. Start it again to keep going.',
              { agent: name }
            )}
        {hasUndeliveredPrompt
          ? ` ${translate(
              'conversations.agentExited.pendingCarried',
              'Your unsent message will be carried over as a draft.'
            )}`
          : ''}
      </p>
      <div className="flex flex-wrap gap-2">
        {canResume && onResume ? (
          <Button size="sm" onClick={onResume}>
            {translate('conversations.agentExited.action.resume', 'Resume conversation')}
          </Button>
        ) : null}
        {onRestart ? (
          <Button size="sm" variant={canResume ? 'ghost' : 'default'} onClick={onRestart}>
            {translate('conversations.agentExited.action.restart', 'Start {{agent}} again', {
              agent: name
            })}
          </Button>
        ) : null}
        {onOpenTerminal ? (
          <Button size="sm" variant="ghost" onClick={onOpenTerminal}>
            {translate('conversations.agentExited.action.terminal', 'Open Terminal')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function NativeChatResumeNotice({
  agent
}: Pick<NativeChatResolvedViewProps, 'agent'>): React.JSX.Element {
  return (
    <p role="status" className="px-4 py-3 text-sm text-status-info">
      {translate('conversations.resumeStarting', 'Waiting for {{agent}} to resume…', {
        agent: agentDisplayName(agent)
      })}
    </p>
  )
}

export function NativeChatAgentExitActions({
  agent,
  agentExit,
  terminalTabId,
  onSwitchToTerminal
}: Pick<NativeChatResolvedViewProps, 'agent' | 'terminalTabId' | 'onSwitchToTerminal'> & {
  agentExit: NativeChatResolvedViewProps['agentExit']
}): React.JSX.Element | null {
  if (!agentExit) {
    return null
  }
  return (
    <NativeChatAgentExitedNotice
      agent={agent}
      canResume={agentExit.resumeRecord !== null}
      hasUndeliveredPrompt={agentExit.hasUndeliveredPrompt}
      onResume={
        agentExit.resumeRecord
          ? () =>
              resumeExitedNativeChatSession({
                terminalTabId,
                record: agentExit.resumeRecord!
              })
          : undefined
      }
      onRestart={
        agentExit.worktreeId && isTuiAgent(agent)
          ? () =>
              restartExitedNativeChatAgent({
                terminalTabId,
                agent,
                worktreeId: agentExit.worktreeId!
              })
          : undefined
      }
      onOpenTerminal={onSwitchToTerminal}
    />
  )
}
