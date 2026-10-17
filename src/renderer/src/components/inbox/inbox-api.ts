import { z } from 'zod'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import { peerSendRequest } from '../../../../shared/peer-action-contract'
import { readPeerFeed } from '@/lib/peer-messages'

const currentScope = () => selectConsoleAccountScope(useAppStore.getState())
function assertScope(scope: string): void {
  if (scope !== currentScope()) {
    throw new Error('The signed-in account changed. Reopen Inbox before continuing.')
  }
}

const Employee = peerSendRequest.shape.to
const Person = z.object({
  employee_id: Employee,
  name: z.string(),
  enrolled: z.boolean()
})
export type InboxPerson = z.infer<typeof Person>

export async function inboxPeople(): Promise<InboxPerson[]> {
  const scope = currentScope()
  const result = await window.api.backoffice.feed({ path: '/api/peer/people' })
  assertScope(scope)
  if (!result.ok) {
    throw new Error(result.message)
  }
  return z.object({ people: z.array(Person) }).parse(result.body).people
}

export async function inboxSend(args: {
  to: string
  text: string
  purpose?: 'question' | 'status' | 'dependency'
  idempotencyKey: string
  references?: string[]
}): Promise<unknown> {
  const scope = currentScope()
  const request = peerSendRequest.parse({
    to: args.to,
    text: args.text,
    purpose: args.purpose ?? 'question',
    operationId: args.idempotencyKey,
    references: args.references ?? []
  })
  const result = await window.api.backoffice.inboxSend({
    to: request.to,
    text: request.text,
    purpose: request.purpose,
    references: request.references,
    idempotencyKey: request.operationId
  })
  assertScope(scope)
  if (!result.ok) {
    throw new Error(result.message)
  }
  return result.body
}

const AgentId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const Agent = z.object({
  session_id: z.string(),
  employee_id: z.string(),
  employee_name: z.string(),
  project_id: AgentId,
  provider: z.string(),
  availability: z.string(),
  endpoint_kind: z.string().optional(),
  session_heartbeat_at: z.number().finite().nonnegative().nullable().optional(),
  conversation_label: z.string().nullable().optional()
})
export type InboxAgent = z.infer<typeof Agent>

/** Enrolled AI conversations in one project, for room participant pickers. */
export async function inboxDirectory(project: string): Promise<InboxAgent[]> {
  const scope = currentScope()
  const result = await readPeerFeed(
    `/directory?project_id=${AgentId.parse(project)}`,
    z.object({ agents: z.array(Agent) })
  )
  assertScope(scope)
  if (result.agents.some((agent) => agent.project_id !== project)) {
    throw new Error('Agent directory scope mismatch.')
  }
  return result.agents
}
