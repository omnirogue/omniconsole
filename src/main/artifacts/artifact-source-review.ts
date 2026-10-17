export type ArtifactSourceReview = {
  ledgerId: string
  nativeSessionId: string
  paneKey: string
  worktreeId: string
  account: string
  revision: number
  receipt?: {
    decisionId: string
    entryId: string
    attempt: number
    /** `delivered` and `failed` mirror the prompt-queue entry once it settles. */
    status: 'prepared' | 'sending' | 'queued' | 'uncertain' | 'delivered' | 'failed'
    /** With `failed`: the entry proved that no byte of it reached the conversation. */
    unsent?: true
    transport?: 'codex-queue'
    nativeItemId?: string
    nativeNonce?: string
    reason?: string
  }
}

export function validArtifactSourceReview(value: unknown): value is ArtifactSourceReview {
  if (!value || typeof value !== 'object') {
    return false
  }
  const v = value as ArtifactSourceReview
  return (
    /^als_[a-f0-9]{24}$/.test(v.ledgerId ?? '') &&
    ['nativeSessionId', 'paneKey', 'worktreeId', 'account'].every((key) => {
      const item = v[key as keyof ArtifactSourceReview]
      return typeof item === 'string' && item.length > 0 && item.length <= 4096
    }) &&
    Number.isSafeInteger(v.revision) &&
    v.revision > 0 &&
    (v.receipt === undefined ||
      (v.receipt !== null &&
        typeof v.receipt === 'object' &&
        typeof v.receipt.decisionId === 'string' &&
        typeof v.receipt.entryId === 'string' &&
        Number.isSafeInteger(v.receipt.attempt) &&
        v.receipt.attempt >= 0 &&
        ['prepared', 'sending', 'queued', 'uncertain', 'delivered', 'failed'].includes(
          v.receipt.status
        ) &&
        (v.receipt.unsent === undefined ||
          (v.receipt.unsent === true && v.receipt.status === 'failed')) &&
        (v.receipt.transport === undefined || v.receipt.transport === 'codex-queue') &&
        (v.receipt.nativeItemId === undefined || /^[\da-f-]{36}$/i.test(v.receipt.nativeItemId)) &&
        (v.receipt.nativeNonce === undefined || /^[\da-f-]{36}$/i.test(v.receipt.nativeNonce)) &&
        (v.receipt.reason === undefined ||
          (typeof v.receipt.reason === 'string' && v.receipt.reason.length <= 500))))
  )
}
