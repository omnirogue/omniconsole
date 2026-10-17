import { z } from 'zod'
import { LEDGER_ID_PATTERN } from '../../shared/session-ledger-contract'
import type { ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import { ledgerSourceForSession } from '../session-ledger/ledger-lookup'
import { failure, requestConsoleWorkflow as request } from './console-workflow-transport'

const answer = z.object({
  session: z.object({
    ledger_id: z.string().regex(LEDGER_ID_PATTERN),
    app: z.literal('omni-ide'),
    card_id: z.string().nullable()
  })
})

export type ConsoleSourceSessionBinding = {
  id: string
  board_task_id: string | null
  session_ref: string
}

/** The signed person's durable pane identity selects one canonical row, never a bounded feed. */
export async function readConsoleLedgerSessionBinding(
  sessionId: string,
  principal: string,
  isCurrent: () => boolean = () => true
): Promise<ConsoleWorkflowResult<ConsoleSourceSessionBinding>> {
  const source = ledgerSourceForSession(sessionId, principal)
  if (!source || source.ledgerId !== sessionId) {
    return failure('binding_changed', 'This session is not owned by the signed-in person.')
  }
  const sourceIsCurrent = () =>
    isCurrent() &&
    JSON.stringify(ledgerSourceForSession(sessionId, principal)) === JSON.stringify(source)
  const result = await request(
    `/api/sessions/${sessionId}`,
    'GET',
    answer,
    undefined,
    15_000,
    false,
    principal,
    sourceIsCurrent
  )
  if (!result.ok) {
    return result
  }
  if (!sourceIsCurrent() || result.data.session.ledger_id !== sessionId) {
    return failure('binding_changed', 'The source conversation changed while reading its task.')
  }
  return {
    ok: true,
    data: {
      id: sessionId,
      board_task_id: result.data.session.card_id,
      session_ref: source.paneKey
    }
  }
}
