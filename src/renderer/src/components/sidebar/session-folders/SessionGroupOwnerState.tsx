import { useAppStore } from '@/store'
import { mirroredConversationOwnerStateText } from '@/lib/mirrored-conversation-labels'
import { sessionRowHostName } from '@/lib/session-row-host'
import { parseExecutionHostId } from '../../../../../shared/execution-host'

/**
 * G2 (session parity, step 6): under a paired computer's heading (Group by: Computer), what this
 * computer knows of that owner's conversation ledger when its rows are not the owner's live list —
 * restored "as of", an older OmniConsole that lists no paused or archived conversations, or out of
 * reach. Silent while the owner's list is current. Step 8's counts sit in the heading itself.
 */
export function SessionGroupOwnerState({
  hostId
}: {
  hostId: string | null
}): React.JSX.Element | null {
  const host = parseExecutionHostId(hostId)
  const runtime = host?.kind === 'runtime' ? host : null
  const owner = useAppStore((state) =>
    runtime ? state.mirroredConversationOwnersByEnvironment?.[runtime.environmentId] : undefined
  )
  const computer = useAppStore((state) =>
    runtime ? sessionRowHostName(runtime.id, state.sshTargetLabels, state.runtimeEnvironments) : ''
  )
  const text = mirroredConversationOwnerStateText(owner, computer)
  if (!owner || !text) {
    return null
  }
  return (
    <div
      className="truncate px-2 pb-0.5 text-[11px] text-muted-foreground"
      data-owner-ledger-state={owner.state}
      title={text}
    >
      {text}
    </div>
  )
}
