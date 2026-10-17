import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { activateSidebarSession } from '@/lib/activate-sidebar-session'
import { buildPaneSessions } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import type { ConversationCapacityRecovery } from '../../../../shared/conversation-capacity-recovery'

function recoveryLabel(phase: ConversationCapacityRecovery['phase']): string {
  switch (phase) {
    case 'waiting-capacity':
      return translate('capacityRecovery.waitingCapacity', 'Waiting for account capacity')
    case 'prepared':
      return translate('capacityRecovery.prepared', 'Preparing account handoff')
    case 'stopped':
      return translate('capacityRecovery.stopped', 'Starting replacement agent')
    case 'created':
      return translate('capacityRecovery.created', 'Sending saved context')
    case 'delivered':
      return translate('capacityRecovery.delivered', 'Context delivered to replacement agent')
    case 'held':
      return translate('capacityRecovery.held', 'Account handoff paused')
    case 'cancelled':
      return translate('capacityRecovery.cancelled', 'Account handoff cancelled')
  }
}

function accountLabel(agent: string, home: string): string {
  const name = agent === 'claude' ? 'Claude' : 'Codex'
  return `${name} · ${home.split(/[\\/]/).findLast(Boolean) ?? home}`
}

export function CapacityRecoveryNotice({
  recovery,
  worktreeId
}: {
  recovery: ConversationCapacityRecovery
  worktreeId: string
}): React.JSX.Element {
  const [navigationError, setNavigationError] = useState(false)
  const successorTabId = recovery.successor?.tabId
  const openContinuation = async (): Promise<void> => {
    try {
      const successor = buildPaneSessions(useAppStore.getState()).find(
        (session) =>
          session.hostId === 'local' &&
          session.worktreeId === worktreeId &&
          session.tabId === successorTabId
      )
      setNavigationError(!successor || !(await activateSidebarSession(successor)))
    } catch {
      setNavigationError(true)
    }
  }
  return (
    <section
      className="w-full min-w-0 space-y-1"
      data-capacity-recovery={recovery.phase}
      aria-label={translate('capacityRecovery.label', 'Account handoff')}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{recoveryLabel(recovery.phase)}</span>
        <span className="text-muted-foreground" data-capacity-recovery-accounts>
          {accountLabel(recovery.sourceAgent, recovery.sourceAccountHome)}
          {recovery.target
            ? ` → ${accountLabel(recovery.target.agent, recovery.target.accountHome)}`
            : null}
        </span>
        {successorTabId && (recovery.phase === 'created' || recovery.phase === 'delivered') ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1 text-xs"
            onClick={() => void openContinuation()}
          >
            {translate('capacityRecovery.openContinuation', 'Open continuation')}
          </Button>
        ) : null}
      </div>
      {recovery.reason ? <p className="text-muted-foreground">{recovery.reason}</p> : null}
      {navigationError ? (
        <p className="text-destructive">
          {translate(
            'capacityRecovery.unavailable',
            'The continuation is not currently available.'
          )}
        </p>
      ) : null}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="group h-6 px-1 text-xs">
            <ChevronDown className="size-3 group-data-[state=open]:rotate-180" aria-hidden />
            {translate('capacityRecovery.savedContext', 'Saved handoff context')}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-1">
          <p className="text-muted-foreground">
            {translate(
              'capacityRecovery.contextExplanation',
              'Context for continuing the work. Delivery does not mean the work is complete. The original history remains in this conversation.'
            )}
          </p>
          <pre className="max-h-64 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-xs">
            {recovery.brief}
          </pre>
          {recovery.sourceWorkspacePath ? (
            <p className="break-all font-mono text-muted-foreground">
              {recovery.sourceWorkspacePath}
            </p>
          ) : null}
          <p className="break-all text-muted-foreground">
            {translate('capacityRecovery.originalHistory', 'Original history: {{path}}', {
              path: recovery.sourceTranscriptPath
            })}
          </p>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
