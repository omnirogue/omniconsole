import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ConversationFleetView } from '@/store/conversation-fleet-store'
import { conversationFleetSource } from './conversation-fleet-sidebar'
import type { SidebarSession } from './sidebar-sessions'

type Host = { id: ExecutionHostId; label: string }

/** Fleet execution belongs to its destination; account-wide discovery never proves local ownership. */
export function conversationFleetHosts(
  run: ConversationFleetView,
  sessions: readonly SidebarSession[],
  hosts: readonly Host[]
): ExecutionHostId[] {
  const machines = [
    ...new Set((run.jobs ?? []).flatMap((job) => (job.machine ? [job.machine] : [])))
  ]
  if (!machines.length && run.machine) {
    machines.push(run.machine)
  }
  if (machines.length) {
    return hosts
      .filter((host) =>
        machines.some(
          (machine) =>
            machine === host.id || machine.trim().toLowerCase() === host.label.trim().toLowerCase()
        )
      )
      .map((host) => host.id)
  }
  const source = conversationFleetSource(run, sessions)
  return source ? [source.hostId ?? 'local'] : []
}
