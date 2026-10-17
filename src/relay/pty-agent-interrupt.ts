import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import type { TerminalAgentProcessProof } from '../shared/pty-agent-process-evidence'
import { ptyAgentInterruptRequest } from '../shared/pty-agent-interrupt'
import { guardedPtyWrite, type GuardedWriteOutcome } from '../main/pty/guarded-pty-write'
import { readPtsName } from '../main/pty/node-pty-pts-name'
import { readPosixReceiverRowSync } from '../main/pty/posix-pty-foreground-group'
import { recognizeAgentProcessFromCommandLine } from '../shared/agent-process-recognition'
import type { RelayPtyProcessRoot } from './pty-agent-process-evidence'

export type InterruptOwner = {
  id: string
  incarnationId: string
  disposed?: boolean
  pty: Pick<IPty, 'pid' | 'process'>
  agentProcessRoot?: RelayPtyProcessRoot | null
  inputGeneration?: number
}
type Ticket = {
  root: RelayPtyProcessRoot
  proof: TerminalAgentProcessProof
  inputGeneration: number
  issuedAt: number
  outcome?: GuardedWriteOutcome
}
const TICKET_TTL_MS = 15_000
const RECEIPT_TTL_MS = 120_000
const MAX_TICKETS = 32

/** A stop ticket grants only Ctrl+C to one observed receiver, never general prompt delivery. */
export class RelayAgentInterrupts {
  private tickets = new WeakMap<InterruptOwner, Map<string, Ticket>>()

  constructor(private now: () => number = () => performance.now()) {}

  issue(owner: InterruptOwner, proof: TerminalAgentProcessProof): string | undefined {
    const root = owner.agentProcessRoot
    if (!root || owner.disposed || !Number.isSafeInteger(owner.inputGeneration)) {
      return undefined
    }
    let tickets = this.tickets.get(owner)
    if (!tickets) {
      tickets = new Map()
      this.tickets.set(owner, tickets)
    }
    for (const [token, ticket] of tickets) {
      if (this.now() - ticket.issuedAt > RECEIPT_TTL_MS) {
        tickets.delete(token)
      }
    }
    while (tickets.size >= MAX_TICKETS) {
      tickets.delete(tickets.keys().next().value!)
    }
    const token = randomUUID()
    tickets.set(token, {
      root,
      proof,
      inputGeneration: owner.inputGeneration!,
      issuedAt: this.now()
    })
    return token
  }

  interrupt(
    input: unknown,
    getOwner: (id: string) => InterruptOwner | undefined,
    isCurrent: () => boolean,
    write: (owner: InterruptOwner) => void
  ) {
    const request = ptyAgentInterruptRequest.parse(input)
    const owner = getOwner(request.id)
    const ticket = owner && this.tickets.get(owner)?.get(request.interruptToken)
    const reply = (outcome: GuardedWriteOutcome) => ({ ...request, outcome })
    // An evicted receipt may already have written: absence is never a negative acknowledgement.
    if (!ticket || owner?.incarnationId !== request.incarnationId) {
      return reply('unknown')
    }
    if (ticket.outcome) {
      return reply(ticket.outcome)
    }
    const { proof, root } = ticket
    const unchanged = () =>
      isCurrent() &&
      getOwner(request.id) === owner &&
      !owner.disposed &&
      owner.incarnationId === request.incarnationId &&
      owner.agentProcessRoot === root &&
      owner.pty.pid === root.pid &&
      owner.inputGeneration === ticket.inputGeneration &&
      this.now() - ticket.issuedAt <= TICKET_TTL_MS
    ticket.outcome = 'refused'
    if (!unchanged()) {
      return reply(ticket.outcome)
    }
    const rootRow = readPosixReceiverRowSync(root.pid)
    const row = readPosixReceiverRowSync(proof.pid)
    if (
      rootRow?.startTimeMs !== root.startTimeMs ||
      rootRow.tty !== root.tty ||
      rootRow.tpgid !== proof.pgid ||
      row?.startTimeMs !== proof.startTimeMs ||
      !row.command ||
      recognizeAgentProcessFromCommandLine(row.command)?.agent !== proof.agent ||
      !row.stat?.includes('+') ||
      /[TXZ]/.test(row.stat)
    ) {
      return reply(ticket.outcome)
    }
    try {
      ticket.outcome = guardedPtyWrite({
        ptsName: readPtsName(owner.pty),
        receiver: proof,
        fenceRevoked: () => !unchanged(),
        readLeaderName: () => owner.pty.process,
        write: () => {
          ticket.outcome = 'unknown'
          write(owner)
        }
      })
    } catch {
      // A throwing writer may already have accepted input.
      ticket.outcome = 'unknown'
    }
    return reply(ticket.outcome)
  }
}
