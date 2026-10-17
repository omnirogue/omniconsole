import {
  conversationFleetReceipt,
  type ConversationFleetReceipt,
  type StoredConversationFleetReceipt
} from './conversation-fleet-receipt'

export function readLegacyFleetReceipts(scope: string): StoredConversationFleetReceipt[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(scope)
  } catch {
    return []
  }
  return conversationFleetReceipt.array().parse(JSON.parse(raw ?? '[]'))
}

/** Presentation cache only; transcripts and admission authority remain in main. */
export function saveFleetReceiptCache(scope: string, runs: ConversationFleetReceipt[]): boolean {
  try {
    localStorage.setItem(
      scope,
      JSON.stringify(
        runs.map((run) => ({ ...conversationFleetReceipt.parse(run), intent: undefined }))
      )
    )
    return true
  } catch {
    return false
  }
}
