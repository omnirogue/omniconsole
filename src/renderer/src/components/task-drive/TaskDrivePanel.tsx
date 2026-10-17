import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { workflowErrorMessage } from '@/lib/console-workflow-client'
import { DriveRequestForm } from './DriveRequestForm'
import { DriveIntakeList } from './DriveIntakeList'
import { useTaskDrivePanel } from './use-task-drive-panel'
import { translate } from '@/i18n/i18n'

export function TaskDrivePanel({ taskId }: { taskId: string }) {
  const scope = useHandoffScope()
  return (
    <ScopedTaskDrivePanel key={`${scope}:${taskId}`} taskId={taskId} scope={`${scope}:${taskId}`} />
  )
}

function ScopedTaskDrivePanel({ taskId, scope }: { taskId: string; scope: string }) {
  const {
    drive,
    intakes,
    data,
    busy,
    recorded,
    pending,
    asking,
    setAsking,
    error,
    note,
    declaring,
    declare,
    requestFiles,
    refresh,
    clearUncertain
  } = useTaskDrivePanel(taskId, scope)

  return (
    <section
      className="space-y-3 border-t border-border pt-3"
      aria-label={translate('auto.components.task.drive.TaskDrivePanel.f2c6b85523', 'Google Drive')}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('auto.components.task.drive.TaskDrivePanel.f2c6b85523', 'Google Drive')}
        </h3>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={refresh}>
          {translate('auto.components.task.drive.TaskDrivePanel.698f6a1f0a', 'Refresh')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.task.drive.TaskDrivePanel.2a4ff8013d',
          'Upload large files in Google Drive. Google handles upload progress and cancellation; received-file details appear here. File requests accept files up to 2 GiB each.'
        )}
      </p>
      {drive.loading && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.task.drive.TaskDrivePanel.b7b90c38ba',
            'Reading the Drive folder…'
          )}
        </p>
      )}
      {Boolean(error || drive.error || intakes.error) && (
        <p role="alert" className="text-xs text-destructive">
          {error || workflowErrorMessage(drive.error || intakes.error)}
        </p>
      )}
      {note && (
        <p role="status" className="text-xs text-muted-foreground">
          {note}
        </p>
      )}
      {data && (
        <>
          <p className="text-xs text-muted-foreground">
            {translate('drive.destination', '{{scope}} folder · {{name}}', {
              scope: data.destination.scope,
              name: data.destination.display
            })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {data.folder ? (
              <Button variant="outline" size="sm" asChild>
                <a href={data.folder.link} target="_blank" rel="noreferrer">
                  <ExternalLink aria-hidden="true" />
                  {translate(
                    'auto.components.task.drive.TaskDrivePanel.92044dd49a',
                    'Open Drive folder'
                  )}
                </a>
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => void declare()}>
                {declaring
                  ? translate(
                      'auto.components.task.drive.TaskDrivePanel.2ac355d8dd',
                      'Creating folder…'
                    )
                  : translate(
                      'auto.components.task.drive.TaskDrivePanel.ba7fa04b9b',
                      'Create Drive folder'
                    )}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={
                busy ||
                !!pending ||
                data.destination.scope !== 'project' ||
                !data.supports_project_intake_precondition ||
                !intakes.data
              }
              onClick={() => setAsking((value) => !value)}
            >
              {translate('auto.components.task.drive.TaskDrivePanel.6ab1b19291', 'Request files')}
            </Button>
          </div>
          {!data.supports_project_intake_precondition && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'drive.requestsUnavailable',
                'File requests are not available on this server yet.'
              )}
            </p>
          )}
          {data.destination.scope !== 'project' && (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.task.drive.TaskDrivePanel.e31d65de00',
                'File requests are available for project folders. This folder has'
              )}{' '}
              {data.destination.scope}{' '}
              {translate('auto.components.task.drive.TaskDrivePanel.ebb041ecee', 'scope.')}
            </p>
          )}
          {asking &&
            !pending &&
            data.destination.scope === 'project' &&
            data.supports_project_intake_precondition && (
              <DriveRequestForm
                busy={busy}
                destination={data.destination.display}
                onSubmit={(fields) => void requestFiles(fields)}
                onCancel={() => setAsking(false)}
              />
            )}
        </>
      )}
      {pending?.phase === 'pending' && (
        <p role="status" className="text-xs text-muted-foreground">
          {translate(
            'auto.components.task.drive.TaskDrivePanel.db180fd787',
            'Sharing the folder and recording the file request…'
          )}
        </p>
      )}
      {pending?.phase === 'uncertain' && (
        <div className="space-y-2 text-xs">
          <p role="status">
            {translate(
              'auto.components.task.drive.TaskDrivePanel.5e9ec831a0',
              'The result of the last file request is uncertain. Refresh to check recorded requests before starting another.'
            )}
          </p>
          {recorded.length > 0 && (
            <p>
              {recorded.length}{' '}
              {translate(
                'auto.components.task.drive.TaskDrivePanel.7be2dde1ca',
                'matching request(s) appeared below. Review their sender and file pattern.'
              )}
            </p>
          )}
          <Button
            size="xs"
            variant="outline"
            disabled={!intakes.data || intakes.loading || !!intakes.error}
            onClick={clearUncertain}
          >
            {translate(
              'auto.components.task.drive.TaskDrivePanel.3130fa05b3',
              'I checked the requests'
            )}
          </Button>
        </div>
      )}
      {intakes.loading && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.task.drive.TaskDrivePanel.3501dc21b1',
            'Reading file requests…'
          )}
        </p>
      )}
      {intakes.data && <DriveIntakeList rows={intakes.data.intakes} />}
    </section>
  )
}
