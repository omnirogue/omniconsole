import { z } from 'zod'

export const handoffVersionId = z.string().regex(/^hfv_[A-Za-z0-9_-]{1,128}$/)

export const handoffReview = z.object({
  id: z.string(),
  decision: z.enum(['approve', 'request_changes']),
  version_ids: z.array(handoffVersionId),
  current: z.boolean(),
  /** The reply entry holding the reviewer's words; the hub keeps no note on the review row itself. */
  entry_id: z.string().optional(),
  note: z.string().optional()
})

/**
 * The hub keeps a reviewer's words on the reply entry the review points at, never on the review
 * row. Read without them, a "needs changes" told the sender's agent "they did not write a note".
 */
export function withReviewWords<
  Review extends { entry_id?: string; note?: string },
  Detail extends { reviews: Review[]; entries: { id: string; body: string }[] }
>(detail: Detail): Detail {
  return {
    ...detail,
    reviews: detail.reviews.map((review) => {
      const words =
        review.note ?? detail.entries.find((entry) => entry.id === review.entry_id)?.body
      return words?.trim() ? { ...review, note: words } : review
    })
  }
}
