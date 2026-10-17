import { BuildReviewModelEffortFields } from '@/components/build-review/BuildReviewAgentFields'
import { useUsageProviders } from '@/components/status-bar/use-usage-providers'
import { useSessionSourceActor } from '@/components/session-team/use-session-source-actor'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { translate as t } from '@/i18n/i18n'
import type { UpNextAgentBlock, UpNextView } from '../../../../../shared/up-next-types'
import { useAdvancedSession } from './advanced-session-context'

export function AgentModelFields({
  block,
  view,
  onChange
}: {
  block: UpNextAgentBlock
  view: UpNextView
  onChange: (choice: { model?: string; effort?: string }) => void
}) {
  const session = useAdvancedSession()
  const actor = useSessionSourceActor(session)
  const { providers } = useUsageProviders()
  const agent = actor?.agent ?? (view.now.kind === 'current-work' ? view.now.agent : '')
  // Usage snapshots are not model catalogs; reuse the host-scoped discovery used by NextStepAgentCard.
  const provider = providers.find((entry) => entry.provider === agent)
  return (
    <div className="space-y-2">
      <BuildReviewModelEffortFields
        capabilityMode="task-continuation"
        role={block.id}
        agent={agent}
        worktree={toRuntimeWorktreeSelector(
          'worktreeId' in view.conversationId ? view.conversationId.worktreeId : ''
        )}
        model={block.advanced.model}
        effort={block.advanced.effort}
        defaultLabel={t('upNext.agentDefault', 'Agent default')}
        onChange={onChange}
      />
      {session?.hostId === 'local' && provider?.error && <p role="status">{provider.error}</p>}
      {block.n > 1 && (
        <p className="text-xs text-muted-foreground">
          {t(
            'upNext.uniformStageSeats',
            'Applies to every seat in this stage. Per-seat model and effort are not authored here yet.'
          )}
        </p>
      )}
    </div>
  )
}
