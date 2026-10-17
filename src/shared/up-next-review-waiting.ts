/** What a person review has heard back, as the sender's status line reads it. */
export type UpNextReviewWaiting = {
  replied: number
  total: number
  sinceMs: number
  approved?: number
  round?: number
  fixing?: boolean
  answers?: { employeeId: string; name: string; decision: 'approve' | 'request_changes' }[]
  changes?: { employeeId: string; name: string; round: number; note?: string }[]
}
