import { useCallback, useEffect, useState } from 'react'
import { PlayCircle, StopCircle } from 'lucide-react'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  CONSOLE_AUTO_ADVANCE_POLL_MS,
  type ConsoleAutoAdvancePreference,
  type ConsoleAutoAdvanceStatus
} from '../../../../shared/console-auto-advance'
import type { ConsoleLocalExecutionClientApi } from '../../../../shared/console-local-execution'
import { workflowData, workflowErrorMessage } from '@/lib/console-workflow-client'
import { WorkflowError, WorkflowSelect } from './WorkflowFields'
import { workflowWorkspaceOptions } from './workflow-workspace-options'
import { useWorkflowRequest } from './use-workflow-request'

function localApi(): ConsoleLocalExecutionClientApi {
  const api = window.api.consoleLocalExecution
  if (!api?.autoAdvanceGet) {
    throw new Error('Auto-advance is unavailable in this version of OmniConsole.')
  }
  return api
}

function statusLine(status: ConsoleAutoAdvanceStatus): string {
  if (status.state === 'off') {
    return translate(
      'consoleWorkflows.autoAdvanceOff',
      'Auto-advance is off — each local job is started by hand.'
    )
  }
  if (status.state === 'activated') {
    return translate('consoleWorkflows.autoAdvanceActivated', 'Auto-advance started a local job.')
  }
  if (status.state === 'waiting') {
    return translate(
      'consoleWorkflows.autoAdvanceWaiting',
      'Auto-advance on — waiting for the next local job.'
    )
  }
  switch (status.reason) {
    case 'human_decision':
      return translate('consoleWorkflows.autoAdvanceStoppedHuman', 'Stopped: human decision.')
    case 'fleet_placement':
      return translate('consoleWorkflows.autoAdvanceStoppedFleet', 'Stopped: fleet placement.')
    case 'folder_workspace':
      return translate(
        'consoleWorkflows.autoAdvanceStoppedFolder',
        'Stopped: folder workspace. Choose a Git workspace for this workflow.'
      )
    case 'no_workspace':
      return translate(
        'consoleWorkflows.autoAdvanceStoppedWorkspace',
        'Stopped: no workspace chosen.'
      )
    case 'workflow_complete':
      return translate(
        'consoleWorkflows.autoAdvanceStoppedComplete',
        'Stopped: no job is left to start.'
      )
    case 'timed_out':
      return translate(
        'consoleWorkflows.autoAdvanceStoppedTimeout',
        'Stopped: nothing became ready within ten minutes.'
      )
    case 'refused':
      return translate(
        'consoleWorkflows.autoAdvanceStoppedRefused',
        'Stopped: the job was refused.'
      )
    case 'turned_off':
      return translate(
        'consoleWorkflows.autoAdvanceStoppedTurnedOff',
        'Stopped: auto-advance was turned off.'
      )
    // Why a named case and no default: a stop the runtime could not attribute is a
    // different thing to report than a refusal, and a default here would have shown
    // every future reason as "the job was refused".
    case null:
      return translate('consoleWorkflows.autoAdvanceStoppedUnknown', 'Stopped.')
  }
  // Unreachable for the declared union; the status crosses IPC, so an unknown reason
  // still says the run stopped rather than rendering nothing.
  return translate('consoleWorkflows.autoAdvanceStoppedUnknown', 'Stopped.')
}

export function WorkflowAutoAdvance({ workflowId }: { workflowId: string }) {
  const worktrees = useAllWorktrees()
  const folders = useAppStore((state) => state.folderWorkspaces)
  const [preference, setPreference] = useState<ConsoleAutoAdvancePreference | null>(null)
  const [worktree, setWorktree] = useState('')
  const [readError, setReadError] = useState<string | null>(null)
  const request = useWorkflowRequest()
  const { run } = request
  const options = workflowWorkspaceOptions(worktrees, folders)
  const read = useCallback(async () => {
    try {
      const current = workflowData(await localApi().autoAdvanceGet({ workflowId }))
      setPreference(current)
      setWorktree((chosen) => chosen || current.worktree)
      setReadError(null)
    } catch (error) {
      setReadError(workflowErrorMessage(error))
    }
  }, [workflowId])
  useEffect(() => {
    void read()
  }, [read])
  const enabled = preference?.enabled === true
  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why polled: the status is written by the main-process runner, not by anything this view does.
    const timer = setInterval(() => void read(), CONSOLE_AUTO_ADVANCE_POLL_MS)
    return () => clearInterval(timer)
  }, [enabled, read])
  const toggle = () =>
    void run(async () => {
      setPreference(
        workflowData(
          await localApi().autoAdvanceSet({
            workflowId,
            enabled: !enabled,
            ...(enabled ? {} : { worktree })
          })
        )
      )
    })
  return (
    <section
      aria-label={translate('consoleWorkflows.autoAdvance', 'Auto-advance')}
      className="space-y-3 border-t border-border pt-3"
    >
      <h3 className="text-sm font-medium">
        {translate('consoleWorkflows.autoAdvance', 'Auto-advance')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'consoleWorkflows.autoAdvanceExplainer',
          'When a local job publishes its result, start the next ready local job of this workflow in the chosen Git workspace. Fleet jobs and human decisions always stop it.'
        )}
      </p>
      {!enabled && (
        <WorkflowSelect
          label={translate('consoleWorkflows.workspace', 'Workspace')}
          value={worktree}
          onChange={setWorktree}
          disabled={request.pending || !!readError}
          options={options}
        />
      )}
      <Button
        size="sm"
        variant={enabled ? 'outline' : 'default'}
        disabled={request.pending || !!readError || (!enabled && !worktree)}
        onClick={toggle}
      >
        {enabled ? <StopCircle /> : <PlayCircle />}
        {enabled
          ? translate('consoleWorkflows.autoAdvanceDisable', 'Turn auto-advance off')
          : translate('consoleWorkflows.autoAdvanceEnable', 'Turn auto-advance on')}
      </Button>
      <p className="text-xs text-muted-foreground">
        {preference ? statusLine(preference.status) : ''}
      </p>
      {preference?.status.detail && (
        <p className="text-xs text-muted-foreground">{preference.status.detail}</p>
      )}
      <WorkflowError message={request.error} />
      <WorkflowError message={readError} />
    </section>
  )
}
