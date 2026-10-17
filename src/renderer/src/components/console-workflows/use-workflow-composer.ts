import { useEffect, useRef, useState } from 'react'
import {
  consoleWorkflowApi,
  isStaleWorkflowResponse,
  workflowData,
  workflowErrorMessage,
  WorkflowRequestError
} from '@/lib/console-workflow-client'
import {
  newWorkflowDraft,
  requireSequentialWorkflowPreview,
  sequentialWorkflowDraft,
  workflowDraftFingerprint,
  type WorkflowDraft
} from '@/lib/console-workflow-draft'
import type {
  ConsoleWorkflowInventory,
  ConsoleWorkflowPreview
} from '../../../../shared/console-workflow-types'
import type { ConsoleTaskAdmissionContext } from '../../../../shared/console-workflow-task-types'
import { workflowAdmissionContext } from '@/lib/console-workflow-admission-draft'
import { workflowDraftPreview } from '@/lib/console-workflow-draft-preview'
import { useWorkflowRequest } from './use-workflow-request'

type ReviewedPreview = {
  result: ConsoleWorkflowPreview
  fingerprint: string
  revision: number
  taskId: string
  placement: 'local' | 'fleet'
  admission: ConsoleTaskAdmissionContext
}

async function observedTaskRevision(taskId: string): Promise<number> {
  const task = workflowData(await consoleWorkflowApi().getTask({ taskId }))
  if (task.id !== taskId) {
    throw new Error('The server returned a different task identity.')
  }
  if (task?.state_revision == null) {
    throw new Error('An observed server task revision is required. Refresh the task in Tasks.')
  }
  return task.state_revision
}

export function useWorkflowComposer(
  initialTaskId: string | null,
  onAdmitted: (workflowId: string) => void,
  /** Seed from another surface (a local-run graph being admitted); still a transient draft. */
  initialDraft?: WorkflowDraft
) {
  const [draft, setDraft] = useState(() => initialDraft ?? newWorkflowDraft(initialTaskId ?? ''))
  const draftRef = useRef(draft)
  const [preview, setPreview] = useState<ReviewedPreview | null>(null)
  const [consent, setConsent] = useState(false)
  const [inventory, setInventory] = useState<ConsoleWorkflowInventory | null>(null)
  const [catalogErrors, setCatalogErrors] = useState<string[]>([])
  const request = useWorkflowRequest()

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const offered = workflowData(await consoleWorkflowApi().inventory())
        if (!cancelled) {
          setInventory(offered)
        }
      } catch (error) {
        if (
          !cancelled &&
          !(error instanceof WorkflowRequestError && error.detail.code === 'capability_unavailable')
        ) {
          setCatalogErrors([workflowErrorMessage(error)])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const update = (next: WorkflowDraft) => {
    const ordered = sequentialWorkflowDraft(next)
    draftRef.current = ordered
    setDraft(ordered)
    setPreview(null)
    setConsent(false)
  }
  const previewDraft = () =>
    void request.run(async () => {
      setPreview(null)
      setConsent(false)
      const snapshot = draftRef.current
      const fingerprint = workflowDraftFingerprint(snapshot)
      const admission = workflowAdmissionContext(snapshot.admission)
      if (!snapshot.stages.some((stage) => stage.key === admission.adoptStage)) {
        throw new Error('Select the stage that will adopt this task.')
      }
      const revision = await observedTaskRevision(snapshot.taskId)
      const api = consoleWorkflowApi()
      if (!api.previewTask) {
        throw new Error(
          'Task-bound workflow preview with explicit placement is unavailable on this server.'
        )
      }
      const result = workflowData(await api.previewTask(workflowDraftPreview(snapshot, revision)))
      if (fingerprint !== workflowDraftFingerprint(draftRef.current)) {
        return
      }
      if (
        result.digest !== result.graph.digest ||
        result.workflow_id !== result.graph.dispatch_id
      ) {
        throw new Error('The server preview does not match its graph digest and workflow identity.')
      }
      requireSequentialWorkflowPreview(result)
      setPreview({
        result,
        fingerprint,
        revision,
        admission,
        taskId: snapshot.taskId,
        placement: snapshot.placement
      })
    })
  const approve = () =>
    void request.run(async () => {
      if (
        !preview ||
        !consent ||
        preview.fingerprint !== workflowDraftFingerprint(draftRef.current)
      ) {
        return
      }
      const reviewed = preview
      setConsent(false)
      const api = consoleWorkflowApi()
      if (!api.admitTask) {
        throw new Error(
          'Approval for an existing task with explicit placement is unavailable on this server.'
        )
      }
      try {
        const result = workflowData(
          await api.admitTask({
            taskId: reviewed.taskId,
            expectedRevision: reviewed.revision,
            graph: reviewed.result.graph,
            digest: reviewed.result.digest,
            placement: reviewed.placement,
            ...reviewed.admission
          })
        )
        setPreview(null)
        onAdmitted(result.workflow_id)
      } catch (error) {
        if (isStaleWorkflowResponse(error)) {
          setPreview(null)
          await observedTaskRevision(reviewed.taskId).catch(() => undefined)
        }
        throw error
      }
    })
  return {
    draft,
    update,
    preview,
    previewDraft,
    consent,
    setConsent,
    approve,
    inventory,
    catalogErrors,
    ...request
  }
}
