import { join } from 'node:path'
import { ConversationFleetJournal } from './conversation-fleet-journal'
import { captureConsoleFleetReceiptScope } from './console-workflow-person'
import { getProfileUserDataPath } from '../omni-profiles/profile-storage-paths'
import { failure } from './console-workflow-transport'
import type {
  ConversationFleetReceipt,
  StoredConversationFleetReceipt
} from '../../shared/conversation-fleet-receipt'
import type { ConsoleConversationFleetAdmitRequest } from '../../shared/console-conversation-fleet-types'
import type {
  ConsoleWorkflowAdmission,
  ConsoleWorkflowProgress,
  ConsoleWorkflowResult
} from '../../shared/console-workflow-types'

function captureJournal(rendererScope?: string) {
  const scope = captureConsoleFleetReceiptScope(rendererScope)
  if (!scope) {
    throw new Error('Sign in before recovering fleet dispatch receipts.')
  }
  return {
    journal: new ConversationFleetJournal(
      join(getProfileUserDataPath(), 'fleet-admissions', `${scope.key}.json`)
    ),
    isCurrent: scope.isCurrent
  }
}

export async function readFleetReceipts(
  legacy: ConversationFleetReceipt[] = [],
  reconcile?: (workflowId: string) => Promise<ConsoleWorkflowResult<ConsoleWorkflowProgress>>,
  rendererScope?: string,
  resume?: (
    request: ConsoleConversationFleetAdmitRequest
  ) => Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>>
): Promise<ConsoleWorkflowResult<StoredConversationFleetReceipt[]>> {
  try {
    const { journal, isCurrent } = captureJournal(rendererScope)
    if (legacy.length) {
      journal.importLegacy(legacy)
    }
    if (resume) {
      for (const request of journal.pendingRequests()) {
        if (!isCurrent()) {
          return failure('connection_changed', 'The signed-in person changed.')
        }
        await resume(request)
      }
    }
    if (reconcile) {
      for (const receipt of journal.unresolved()) {
        if (!isCurrent()) {
          return failure('connection_changed', 'The signed-in person changed.')
        }
        try {
          const progress = await reconcile(receipt.workflowId)
          if (progress.ok && isCurrent()) {
            journal.observe(progress.data)
          }
        } catch {
          /* An unreachable owner leaves the same pending intent in place. */
        }
      }
    }
    if (!isCurrent()) {
      return failure('connection_changed', 'The signed-in person changed.')
    }
    return { ok: true as const, data: journal.list() }
  } catch {
    return failure(
      'durability_unavailable',
      'Fleet dispatch receipts could not be recovered. Dispatch is blocked until storage is available.'
    )
  }
}

export async function beginFleetAdmission(
  receipt: ConversationFleetReceipt,
  rendererScope?: string
): Promise<ConsoleWorkflowResult<boolean>> {
  try {
    return { ok: true as const, data: captureJournal(rendererScope).journal.begin(receipt) }
  } catch {
    return failure(
      'durability_unavailable',
      'The dispatch intent could not be committed. No admission request was sent.'
    )
  }
}

export async function durableFleetAdmission(
  request: ConsoleConversationFleetAdmitRequest,
  send: (isCurrent: () => boolean) => Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>>,
  reconcile: (isCurrent: () => boolean) => Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>>
): Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>> {
  try {
    const { journal, isCurrent } = captureJournal()
    const action = journal.claim(request)
    if (!isCurrent()) {
      return failure('connection_changed', 'The signed-in person changed.')
    }
    if (action === 'reconcile') {
      const result = await reconcile(isCurrent)
      if (!isCurrent()) {
        return failure('connection_changed', 'The signed-in person changed.')
      }
      if (!result.ok) {
        return result
      }
      journal.observe(result.data, result.data)
      return result
    }
    const result = await send(isCurrent)
    if (result.ok) {
      journal.observe(result.data, result.data)
    }
    return result
  } catch {
    return failure(
      'admission_unverifiable',
      'Admission is unverifiable. Check the saved workflow; do not create another dispatch.'
    )
  }
}

export async function observeDurableFleetWorkflow(
  read: () => Promise<ConsoleWorkflowResult<ConsoleWorkflowProgress>>
): Promise<ConsoleWorkflowResult<ConsoleWorkflowProgress>> {
  const scope = captureConsoleFleetReceiptScope()
  if (!scope) {
    return read()
  }
  const { journal, isCurrent } = captureJournal()
  const result = await read()
  if (result.ok && isCurrent()) {
    try {
      journal.observe(result.data)
    } catch {
      return failure(
        'admission_unverifiable',
        'The saved dispatch could not be reconciled with this workflow.'
      )
    }
  }
  return result
}
