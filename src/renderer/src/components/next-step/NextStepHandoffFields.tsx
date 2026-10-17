import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'
import type { NextStepHandoffOptions } from '../../../../shared/next-step-draft'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'
import { CommunicationTypeSelect } from './CommunicationTypeSelect'
import { NextStepWorkFiles } from './NextStepWorkFiles'

/** The same message/files handoff as chat; only the capture time differs. */
export function NextStepHandoffFields({
  value,
  onChange,
  worktreeId,
  workspacePath,
  hostId,
  historyAvailable
}: {
  value: NextStepHandoffOptions
  onChange: (value: NextStepHandoffOptions) => void
  worktreeId?: string
  workspacePath: string
  hostId: string
  historyAvailable: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <div
      className="space-y-3 rounded-md border border-border/60 p-3"
      data-next-step-section="files"
    >
      <CommunicationTypeSelect
        value={value.communicationType}
        onChange={(communicationType) => onChange({ ...value, communicationType })}
      />
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-summary`}
          checked={value.includeSummary}
          onCheckedChange={(checked) => onChange({ ...value, includeSummary: checked === true })}
        />
        <label htmlFor={`${id}-summary`} className="text-xs">
          {translate('nextStep.includeFinalSummary', 'Include final summary')}
        </label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={`${id}-history`}
          checked={value.includeTranscript === true}
          disabled={!historyAvailable}
          onCheckedChange={(checked) => onChange({ ...value, includeTranscript: checked === true })}
        />
        <label htmlFor={`${id}-history`} className="text-xs">
          {translate('nextStep.includeCompleteHistory', 'Include complete session history')}
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {value.includeTranscript
          ? translate(
              'nextStep.completeHistoryTiming',
              'History is captured after completion. It includes messages, file contents and command output; protected data or incomplete history pauses delivery for you to review.'
            )
          : translate(
              'nextStep.messageOnlyAvailable',
              'The finish instructions are your message. Summary, files and session history are optional.'
            )}
      </p>
      {worktreeId ? (
        <NextStepWorkFiles
          worktreeId={worktreeId}
          workspacePath={workspacePath}
          executionHostId={normalizeExecutionHostId(hostId) ?? undefined}
          deliverables={value.deliverables}
          defaults={null}
          maxFiles={32 - Number(value.includeSummary) - Number(value.includeTranscript === true)}
          onChange={(deliverables) => onChange({ ...value, deliverables })}
        />
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'nextStep.deferredDeliveryOnly',
          'Sends when this session finishes. Use chat to send immediately.'
        )}
      </p>
    </div>
  )
}
