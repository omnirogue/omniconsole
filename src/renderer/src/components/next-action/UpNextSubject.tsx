import { useId, useMemo, useState } from 'react'
import { upNextSurface } from './up-next-surface'
import { SessionDetailsConnected } from './advanced/SessionDetailsConnected'
import { AdvancedSessionContext } from './advanced/advanced-session-context'
import { UpNextOutcomeContext } from './up-next-outcome-context'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NextStepSubject } from '@/components/next-step/next-step-subject'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { upNextAddressForSession } from '@/lib/up-next-address'
import { buildCompiledSessionChain } from '@/lib/session-chain-build'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  useSessionChainForRow,
  setSessionChainEntry,
  publishSessionChains
} from '@/lib/session-chain-registry'
import { useUpNext } from './use-up-next'
import { UpNextChainView, UpNextChain } from './UpNextChain'
import { OutcomeLine } from './OutcomeLine'
import { useSessionDetailsFacts } from './use-session-details-facts'
import { SessionFactsLine } from './SessionFactsLine'

function SessionComposer({
  session,
  onChanged,
  compactAdd = false
}: {
  session: SidebarSession
  onChanged?: () => void
  compactAdd?: boolean
}) {
  const chain = useSessionChainForRow(session.rowKey)
  const facts = useSessionDetailsFacts(session, chain)
  const address = upNextAddressForSession(session)
  const host = parseExecutionHostId(session.hostId ?? 'local')
  // Why component state: the disclosure is per mount (brief 78 #3 allows it), and the sidebar
  // view store is another seat's file this round.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const detailsId = useId()
  return (
    <div className="@container/composer min-w-0 space-y-3">
      <OutcomeLine
        chain={chain}
        onChainChanged={(next) => {
          setSessionChainEntry(next)
          publishSessionChains()
        }}
        // "Set outcome" on a conversation with no chain yet: the same unregistered record the
        // work-plan door builds (`LiveWorkPlanQuestions`), which the host adopts on first commit.
        // `end` is left unset — stating what is pursued does not decide how the session ends.
        startChain={() => {
          const built = buildCompiledSessionChain({
            session,
            chainId: crypto.randomUUID(),
            steps: [],
            auto: true,
            end: 'done'
          })
          if (!built) {
            return null
          }
          const { end: _end, ...fresh } = built
          return fresh
        }}
      />
      <SessionFactsLine
        facts={facts}
        open={detailsOpen}
        controls={detailsId}
        onToggle={() => setDetailsOpen((open) => !open)}
      />
      {/* Why minmax(0,1fr): a bare 1fr track's minimum is its content's min-content width, so one
          row with a long nowrap summary widened the whole column past the pane (Sal's screenshot,
          2026-09-18). A zero minimum keeps the column at the pane and lets the rows truncate.
          Why a container query, not `md:`: the composer mounts in a 48rem popover and in chat
          panes of any width, so the COMPOSER's width decides the split. 50rem keeps ≥28rem of
          row beside the 280px Session details card — the rows' own one-line threshold. The split
          exists only while the card is open; folded, the chain has the whole width. */}
      <div
        className={cn(
          'grid min-w-0 grid-cols-1 gap-3',
          detailsOpen && '@min-[50rem]/composer:grid-cols-[minmax(0,1fr)_280px]'
        )}
      >
        <AdvancedSessionContext value={session}>
          <UpNextOutcomeContext value={chain?.id ?? null}>
            {host?.kind !== 'local' && host?.kind !== 'runtime' ? (
              <p role="status" className="p-3 text-xs text-muted-foreground">
                {translate(
                  'upNext.pairedHostRequired',
                  'Connect to the paired runtime on {{host}} to use Up next for this conversation.',
                  { host: facts.runsOn || session.hostId }
                )}
              </p>
            ) : (
              <UpNextChain
                {...(compactAdd ? { compactAdd: true } : {})}
                source={address?.source ?? null}
                {...(address?.owner.kind === 'environment' ? { owner: address.owner } : {})}
                {...(onChanged ? { onChanged } : {})}
              />
            )}
          </UpNextOutcomeContext>
        </AdvancedSessionContext>
        {detailsOpen && (
          <div
            id={detailsId}
            className="min-w-0 space-y-2 rounded-xl border border-border bg-card p-3"
            data-next-action-session-details-card
          >
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {translate('nextAction.sessionDetails', 'Session details')}
            </h4>
            <SessionDetailsConnected facts={facts} chain={chain} />
          </div>
        )}
      </div>
    </div>
  )
}

function SubjectComposer({
  subject,
  onChanged
}: {
  subject: Exclude<NextStepSubject, { kind: 'session' }>
  onChanged?: () => void
}) {
  const surface = useMemo(() => upNextSurface(subject), [subject])
  const controller = useUpNext(
    subject.kind === 'thread'
      ? { kind: 'thread', threadId: subject.detail.thread.id }
      : subject.kind === 'card'
        ? { kind: 'card', taskId: subject.item.task_id }
        : null,
    undefined,
    surface
  )
  return (
    <UpNextChainView
      controller={{
        ...controller,
        commit: async () => {
          const committed = await controller.commit()
          if (committed) {
            onChanged?.()
          }
          return committed
        }
      }}
    />
  )
}

/** Drafts keep their subject identity until its existing launch door returns a pane. */
export function UpNextSubject({
  subject,
  onChanged,
  compactAdd = false
}: {
  subject: NextStepSubject
  onChanged?: () => void
  compactAdd?: boolean
}) {
  return subject.kind === 'session' ? (
    <SessionComposer
      key={subject.session.rowKey}
      session={subject.session}
      onChanged={onChanged}
      compactAdd={compactAdd}
    />
  ) : (
    <SubjectComposer subject={subject} onChanged={onChanged} />
  )
}
