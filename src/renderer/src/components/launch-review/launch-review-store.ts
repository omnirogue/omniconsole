import { create } from 'zustand'
import type { LaunchManifest } from '../../../../shared/launch-manifest'

export type LaunchReviewRequest = {
  manifest: LaunchManifest
  /** Where the attachment pickers read files and skills from. */
  worktreeId: string | null
  /** Starts exactly the reviewed list; `removed` names project items left out. */
  onClose?: () => void
  onStart: (manifest: LaunchManifest, removed: string[]) => void
}

/** The one launch waiting for review. A second request replaces nothing: it is refused. */
export const useLaunchReview = create<{
  request: LaunchReviewRequest | null
  open: (request: LaunchReviewRequest) => boolean
  close: () => void
}>()((set, get) => ({
  request: null,
  open: (request) => {
    if (get().request) {
      return false
    }
    set({ request })
    return true
  },
  close: () => {
    const request = get().request
    set({ request: null })
    request?.onClose?.()
  }
}))
