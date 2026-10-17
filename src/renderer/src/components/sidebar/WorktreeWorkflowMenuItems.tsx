import { Network } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { openBuildReview } from '@/lib/build-review-entry'
import { openLocalRunCanvasForWorkspace } from '@/lib/local-run-navigation'
import { WorkflowPresetIcon } from '../local-workflows/workflow-presets'

/** The workspace row's ways to start multi-agent work in that workspace. */
export function WorktreeWorkflowMenuItems({
  worktree,
  disabled
}: {
  worktree: { id: string; path: string }
  disabled: boolean
}) {
  return (
    <>
      <DropdownMenuItem onSelect={() => openBuildReview(worktree.id)} disabled={disabled}>
        <WorkflowPresetIcon preset="build-review" className="size-3.5" />
        {translate('auto.components.build-review.WorktreeContextMenu.start', 'Build + Review…')}
      </DropdownMenuItem>
      {/* A graph runs in a folder: seed the canvas from the workspace the
          person right-clicked, git or not. */}
      <DropdownMenuItem
        onSelect={() => openLocalRunCanvasForWorkspace(worktree.path)}
        disabled={disabled}
      >
        <Network className="size-3.5" />
        {translate('auto.components.local-run.WorktreeContextMenu.run', 'Run a graph…')}
      </DropdownMenuItem>
    </>
  )
}
