import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { useCompaniesRead } from '@/components/companies/companies-client'
import {
  WorkflowRequestError,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import type { ConsoleDriveFileRequest } from '../../../../shared/console-drive-contract'
import { driveApi } from './drive-client'
import { translate } from '@/i18n/i18n'
import {
  matchingDriveRequests,
  readDriveRequest,
  rememberDriveRequest,
  subscribeDriveRequests
} from './drive-request-journal'

export function useTaskDrivePanel(taskId: string, scope: string) {
  const drive = useCompaniesRead(() => driveApi().get({ taskId }), scope)
  const intakes = useCompaniesRead(() => driveApi().intakes({ taskId }), scope)
  const getPending = useCallback(() => readDriveRequest(scope), [scope])
  const pending = useSyncExternalStore(subscribeDriveRequests, getPending)
  const submitting = useRef(false)
  const [declaring, setDeclaring] = useState(false)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const refresh = () => {
    drive.reload()
    intakes.reload()
  }
  const data = drive.data
  const busy = declaring || pending?.phase === 'pending'
  const recorded =
    pending && intakes.data ? matchingDriveRequests(pending, intakes.data.intakes) : []

  const declare = async () => {
    if (submitting.current) {
      return
    }
    submitting.current = true
    setDeclaring(true)
    setError(null)
    try {
      workflowData(await driveApi().declare({ taskId }))
      setNote(translate('drive.folderReady', 'The Drive folder is ready.'))
      refresh()
    } catch (reason) {
      setError(workflowErrorMessage(reason))
    } finally {
      submitting.current = false
      setDeclaring(false)
    }
  }
  const requestFiles = async (
    fields: Pick<ConsoleDriveFileRequest, 'expected_from' | 'pattern' | 'expected_count'>
  ) => {
    if (
      submitting.current ||
      readDriveRequest(scope) ||
      !data ||
      !intakes.data ||
      data.destination.scope !== 'project'
    ) {
      return
    }
    submitting.current = true
    const entry = {
      phase: 'pending' as const,
      input: { taskId, expectedScopeKey: data.destination.scope_key, ...fields },
      beforeIds: intakes.data.intakes.map((row) => row.id)
    }
    setError(null)
    setNote(null)
    let submitted = false
    try {
      rememberDriveRequest(scope, entry)
      submitted = true
      const created = workflowData(await driveApi().requestFiles(entry.input))
      rememberDriveRequest(scope, null)
      setNote(
        translate(
          'drive.requestRecorded',
          'File request recorded for {{person}}. Send them the folder link.',
          { person: created.expected_from_email || created.expected_from }
        )
      )
      setAsking(false)
    } catch (reason) {
      const status = reason instanceof WorkflowRequestError ? reason.detail.status : undefined
      const refused =
        reason instanceof WorkflowRequestError &&
        ([
          'invalid_request',
          'drive_scope_changed',
          'signed_in_required',
          'backoffice_unconfigured',
          'capability_unavailable'
        ].includes(reason.detail.code) ||
          (status !== undefined && status >= 400 && status < 500 && status !== 408))
      if (submitted) {
        try {
          rememberDriveRequest(scope, refused ? null : { ...entry, phase: 'uncertain' })
        } catch {
          // The journal retains an uncertain entry in memory when storage fails.
        }
      }
      setError(workflowErrorMessage(reason))
    } finally {
      submitting.current = false
      refresh()
    }
  }

  const clearUncertain = () => {
    try {
      rememberDriveRequest(scope, null)
      setAsking(false)
      setError(null)
      setNote(
        translate(
          'drive.previousRequestChecked',
          'Previous request checked. Any new request will be a separate request.'
        )
      )
    } catch (reason) {
      setError(workflowErrorMessage(reason))
    }
  }
  return {
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
  }
}
