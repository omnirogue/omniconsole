import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import type { ConversationFleetInputSelection } from '@/lib/conversation-fleet-inputs'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { NextStepWorkFiles } from './NextStepWorkFiles'

export function FleetSourceFiles({
  worktreeId,
  executionHostId,
  workspacePath,
  gitWorkspace,
  selection,
  onChange
}: {
  worktreeId: string
  executionHostId?: ExecutionHostId
  workspacePath: string
  gitWorkspace: boolean
  selection: ConversationFleetInputSelection
  onChange: (selection: ConversationFleetInputSelection) => void
}): React.JSX.Element {
  const id = useId()
  const included = gitWorkspace
    ? selection.includeDirtyTracked
      ? translate(
          'conversationFleet.sourceWithTracked',
          'Conversation + current tracked changes included'
        )
      : translate(
          'conversationFleet.sourceWithoutTracked',
          'Conversation included; tracked changes excluded'
        )
    : translate('conversationFleet.sourceConversationOnly', 'Conversation included')
  return (
    <details className="text-xs" data-fleet-source-files>
      <summary className="cursor-pointer">
        <span className="font-medium">
          {translate('conversationFleet.conversationAndFiles', 'Conversation and files')}
        </span>
        <span className="mt-1 block text-muted-foreground" data-fleet-source-summary>
          {included}
          {' · '}
          {translate('conversationFleet.selectedFileCount', '{{count}} chosen files', {
            count: selection.paths.length
          })}
        </span>
      </summary>
      <div className="space-y-3 pt-3">
        <p className="text-xs text-muted-foreground">
          {translate(
            'conversationFleet.sourceTranscriptIncluded',
            'The complete readable conversation is included. Saved source logs are included when available.'
          )}
        </p>
        {gitWorkspace ? (
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={selection.includeDirtyTracked}
                onCheckedChange={(checked) =>
                  onChange({ ...selection, includeDirtyTracked: checked === true })
                }
              />
              <Label htmlFor={id}>
                {translate(
                  'conversationFleet.includeDirtyTracked',
                  'Include current tracked changes'
                )}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {selection.includeDirtyTracked
                ? translate(
                    'conversationFleet.dirtyTrackedIncluded',
                    'Use this commit and capture tracked edits, deletions and renames. Choose new untracked files below.'
                  )
                : translate(
                    'conversationFleet.dirtyTrackedExcluded',
                    'Use this commit and only the files selected below. Other uncommitted changes are excluded.'
                  )}
            </p>
          </div>
        ) : null}
        <NextStepWorkFiles
          worktreeId={worktreeId}
          executionHostId={executionHostId}
          workspacePath={workspacePath}
          deliverables={{ kind: 'files', paths: selection.paths }}
          defaults={null}
          timing="dispatch"
          maxFiles={30}
          onChange={(value) =>
            onChange({ ...selection, paths: value?.kind === 'files' ? value.paths : [] })
          }
        />
      </div>
    </details>
  )
}
