import { useSessionWorkDraft } from './use-session-work-draft'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { consoleWorkflowApi, workflowData } from '@/lib/console-workflow-client'
import { useFleetInventory } from '../fleet/use-fleet-inventory'
import { conversationFleetAgents } from '@/lib/conversation-fleet-inventory'
import type { ConversationFleetInputSelection } from '@/lib/conversation-fleet-inputs'
import { pauseConversationAfterFleetDispatch } from '@/lib/conversation-fleet-pause'
import {
  conversationFleetScope,
  useConversationFleetStore,
  type ConversationFleetReceipt
} from '@/store/conversation-fleet-store'
import type { NextStepDraft } from '../../../../shared/next-step-draft'
import { translate } from '@/i18n/i18n'
import {
  useNextStepPeople,
  type NextStepLoad,
  type NextStepRecipientSource
} from './use-next-step-recipients'
import type { FleetDispatchMachine, FleetDispatchReview } from './fleet-dispatch-types'
import type { NextStepSubject } from './next-step-subject'
import { prepareFleetDispatch, type FrozenDispatch } from './prepare-fleet-dispatch'

type Subject = Extract<NextStepSubject, { kind: 'session' }>

export function useFleetDispatch(subject: Subject) {
  const [selection, setSelection, clearSelection] = useSessionWorkDraft<{
    operationId: string
    machineId?: string
    sourceSelection: ConversationFleetInputSelection
  }>(subject, 'fleet-source', () => ({
    operationId: crypto.randomUUID(),
    sourceSelection: { paths: [], includeDirtyTracked: true }
  }))
  const { machineId, sourceSelection } = selection
  const captureRequest = useRef<AbortController | null>(null)
  const current = useRef(true)
  const sourceIdentity = JSON.stringify([
    subject.session.hostId,
    subject.session.worktreeId,
    subject.session.rowKey,
    subject.session.sessionKey,
    subject.session.paneKey
  ])
  const frozen = useRef<(FrozenDispatch & { sourceIdentity: string; operationId: string }) | null>(
    null
  )
  const roster = useNextStepPeople()
  const scope = useAppStore(() => conversationFleetScope())
  const { inventory, refresh, reload } = useFleetInventory()
  useEffect(() => {
    current.current = true
    // Why: a plan frozen for one signed-in person may never be dispatched for another.
    frozen.current = null
    return () => {
      current.current = false
      captureRequest.current?.abort()
    }
  }, [scope, sourceIdentity])
  const refreshAgents = useCallback(
    async () => conversationFleetAgents(await refresh(), machineId),
    [refresh, machineId]
  )
  const recipients = useMemo<NextStepRecipientSource>(() => {
    const source = { people: roster.people, reload, refreshAgents }
    if (inventory.phase !== 'ready') {
      return { ...source, agents: inventory }
    }
    const agents = conversationFleetAgents(inventory.value, machineId)
    return {
      ...source,
      agents: agents.length
        ? { phase: 'ready', value: agents }
        : {
            phase: 'error',
            message: translate(
              'conversationFleet.agentReadinessUnverified',
              'Fleet agent sign-in and usage could not be verified. Refresh or choose an available agent in this conversation.'
            )
          }
    }
  }, [inventory, machineId, roster.people, reload, refreshAgents])
  const machines: NextStepLoad<FleetDispatchMachine[]> =
    inventory.phase === 'ready'
      ? {
          phase: 'ready',
          value: inventory.value.machines.map((machine) => ({
            id: machine.host,
            label: machine.host,
            available: machine.allowed,
            ...(!machine.allowed
              ? {
                  reason: translate(
                    'conversationFleet.machineUnavailable',
                    'This machine is not currently ready for new work.'
                  )
                }
              : {})
          }))
        }
      : inventory
  const sourceGitWorkspace = useAppStore((state) => {
    const workspace = state.getKnownWorktreeById(
      subject.session.worktreeId,
      subject.session.hostId ?? 'local'
    )
    return (
      !subject.session.worktreeId.startsWith('folder:') &&
      state.repos.find((repo) => repo.id === workspace?.repoId)?.kind !== 'folder'
    )
  })
  const onSourceSelectionChange = useCallback(
    (selection: ConversationFleetInputSelection) => {
      frozen.current = null
      captureRequest.current?.abort()
      setSelection((previous) => ({ ...previous, sourceSelection: selection }))
    },
    [setSelection]
  )
  const onMachineChange = useCallback(
    (machine?: string) => {
      frozen.current = null
      captureRequest.current?.abort()
      setSelection((previous) => ({ ...previous, machineId: machine }))
    },
    [setSelection]
  )

  const onPrepare = async (
    draft: NextStepDraft,
    selectedMachine?: string,
    fanoutAcknowledged = false
  ): Promise<FleetDispatchReview> => {
    frozen.current = null
    captureRequest.current?.abort()
    const capture = new AbortController()
    captureRequest.current = capture
    const requestScope = conversationFleetScope()
    const assertCurrent = () => {
      capture.signal.throwIfAborted()
      if (!current.current || requestScope !== conversationFleetScope()) {
        throw new Error('The signed-in person changed. Review the dispatch again.')
      }
    }
    await useConversationFleetStore.getState().load(requestScope)
    assertCurrent()
    setSelection(selection)
    const prepared = await prepareFleetDispatch({
      subject,
      draft,
      selectedMachine,
      fanoutAcknowledged,
      sourceSelection,
      operationId: selection.operationId,
      requestScope,
      signal: capture.signal,
      refresh,
      assertCurrent
    })
    frozen.current = { ...prepared, sourceIdentity, operationId: selection.operationId }
    return prepared.review
  }

  const onDispatch = async (review: FleetDispatchReview) => {
    const prepared = frozen.current
    if (
      !prepared ||
      prepared.review !== review ||
      prepared.scope !== conversationFleetScope() ||
      prepared.sourceIdentity !== sourceIdentity
    ) {
      throw new Error('The reviewed dispatch changed. Prepare it again.')
    }
    const { graph, digest, admission } = prepared.admitted
    const receipt: ConversationFleetReceipt = {
      workflowId: prepared.admitted.workflow_id,
      taskId: admission.task_id,
      rowKey: subject.session.rowKey,
      sessionKey: subject.session.sessionKey,
      title: subject.session.label.slice(0, 500),
      createdAt: new Date().toISOString(),
      capturedAt: prepared.capturedAt,
      machine: prepared.machine,
      digest,
      intent: {
        operationId: prepared.operationId,
        source: prepared.captured,
        request: {
          taskId: admission.task_id,
          expectedRevision: admission.expected_revision,
          graph,
          digest,
          contextDigest: admission.context_digest,
          adoptStage: admission.adopt_stage
        }
      }
    }
    await useConversationFleetStore.getState().load(prepared.scope)
    if (!(await useConversationFleetStore.getState().beginAdmission(prepared.scope, receipt))) {
      throw new Error(
        'The pending dispatch could not be committed or already exists. Check its saved workflow before dispatching again.'
      )
    }
    frozen.current = null
    if (prepared.scope !== conversationFleetScope()) {
      throw new Error('The source or signed-in person changed. Check the saved dispatch.')
    }
    const admitted = await consoleWorkflowApi()
      .admitFleetTask({
        taskId: admission.task_id,
        expectedRevision: admission.expected_revision,
        graph,
        digest,
        contextDigest: admission.context_digest,
        adoptStage: admission.adopt_stage
      })
      .catch((error: unknown) => {
        useConversationFleetStore
          .getState()
          .recordJobs(
            prepared.scope,
            receipt.workflowId,
            null,
            error instanceof Error ? error.message : String(error)
          )
        throw error
      })
    if (!admitted.ok) {
      useConversationFleetStore
        .getState()
        .recordJobs(prepared.scope, receipt.workflowId, null, admitted.error.message)
    }
    const result = workflowData(admitted)
    if (result.workflow_id !== receipt.workflowId) {
      throw new Error(
        'The server returned a different workflow. Check its status before dispatching again.'
      )
    }
    frozen.current = null
    if (prepared.scope !== conversationFleetScope()) {
      return
    }
    useConversationFleetStore.getState().remember(prepared.scope, receipt, result.jobs)
    clearSelection()
    const pause = await pauseConversationAfterFleetDispatch(
      subject.session,
      prepared.captured,
      result
    ).catch((error: unknown) => ({
      state: 'unverifiable' as const,
      message: error instanceof Error ? error.message : 'The source pause could not be verified.'
    }))
    if (prepared.scope !== conversationFleetScope()) {
      return
    }
    if (pause.state === 'paused' || pause.state === 'already-idle') {
      toast.success(
        translate(
          'conversationFleet.dispatched',
          'Dispatched. Follow this conversation in Waiting.'
        )
      )
    } else {
      toast.warning(
        translate(
          'conversationFleet.dispatchedSourceActive',
          'Dispatched. The source conversation may still be running.'
        ),
        { description: pause.message }
      )
    }
  }
  return {
    recipients,
    /** The raw reply, so a surface can show machine health the summary does not carry. */
    inventory,
    machines,
    machineId,
    onMachineChange,
    sourceSelection,
    onSourceSelectionChange,
    sourceGitWorkspace,
    onPrepare,
    onDispatch
  }
}
