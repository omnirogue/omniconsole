import { useState } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { anchorBuildReviewRun } from '@/lib/build-review-entry'
import { WorkflowPresetIcon } from '../local-workflows/workflow-presets'
import { BuildReviewStartForm } from './BuildReviewStartForm'

/**
 * Build + Review for a workspace that could not open it as a tab: it asks which workspace, and the
 * started run opens as a conversation tab there. Only a workspace that cannot hold a tab leaves
 * the run on the Build + Review page.
 */
export default function BuildReviewStartDialog() {
  const [pending, setPending] = useState(false)
  const dialog = useAppStore((s) => s.buildReview.startDialog)
  const close = useAppStore((s) => s.buildReview.closeStartDialog)
  const start = useAppStore((s) => s.buildReview.start)
  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(open) => {
        if (!open && !pending) {
          close()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WorkflowPresetIcon preset="build-review" className="text-muted-foreground" />
            {translate(
              'auto.components.build-review.BuildReviewStartDialog.title',
              'New Build + Review'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'buildReview.descriptionShort',
              'One agent builds, others review, and the builder fixes what they find until everyone approves.'
            )}
          </DialogDescription>
        </DialogHeader>
        {dialog.open && (
          <BuildReviewStartForm
            initialWorktree={dialog.worktree}
            initialObjective={dialog.objective}
            pickWorktree
            pending={pending}
            setPending={setPending}
            onStart={async (request, worktreeId) => {
              anchorBuildReviewRun(worktreeId, await start(request, { reveal: false }))
            }}
            onCancel={close}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
