import { Button } from '@/components/ui/button'
import { UpNextPopover } from '@/components/next-action/UpNextPopover'
import {
  runUpNextAttentionAction,
  upNextAttentionDoors
} from '@/components/next-action/up-next-attention-actions'
import { openDoneWhenList } from '@/components/next-action/use-done-when-list'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { HumanAttentionRequest } from '../../../../../shared/session-human-attention'

// Why a no-op: the composer's add bar exists only inside Up next, which this row opens instead.
const DOORS = upNextAttentionDoors(() => {})

function RequestAction({
  request,
  session,
  chainId
}: {
  request: HumanAttentionRequest
  session: SidebarSession
  chainId: string
}): React.JSX.Element | null {
  const action = request.action
  if (!action) {
    return null
  }
  if (action.kind === 'review-outcome' || action.kind === 'open-up-next') {
    return (
      <span
        className="shrink-0"
        data-session-request-action={action.kind}
        // A review is answered in the Done When checklist, so Up next opens with it showing.
        onClickCapture={() => {
          if (action.kind === 'review-outcome') {
            openDoneWhenList(chainId)
          }
        }}
      >
        <UpNextPopover
          subject={{ kind: 'session', session }}
          triggerContent={action.label}
          className="border border-border"
        />
      </span>
    )
  }
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="shrink-0"
      data-session-request-action={action.kind}
      onClick={(event) => {
        event.stopPropagation()
        runUpNextAttentionAction(request, { ownPaneKey: session.paneKey, chainId }, DOORS)
      }}
    >
      {action.label}
    </Button>
  )
}

/**
 * What the run asks of its owner, in full, each with the direct way to meet it: the same asks
 * and the same doors as the line under UP NEXT. Going there resolves nothing; only the
 * requirement being met does (`docs/reference/session-run-lifecycle.md`).
 */
export function SessionRowRunRequests({
  requests,
  session,
  chainId
}: {
  requests: readonly HumanAttentionRequest[]
  session: SidebarSession
  chainId: string
}): React.JSX.Element | null {
  if (!requests.length) {
    return null
  }
  return (
    <ul className="min-w-0 space-y-1" data-session-requests="">
      {requests.map((request) => (
        <li
          key={request.id}
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
          data-session-request={request.id}
          title={request.why}
        >
          <span className="min-w-0 flex-1 whitespace-normal break-words font-medium text-agent-question-text">
            {request.ask}
          </span>
          <RequestAction request={request} session={session} chainId={chainId} />
        </li>
      ))}
    </ul>
  )
}
