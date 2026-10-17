import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import { toast } from 'sonner'
import type { QuickLaunchOptions } from '@/hooks/composer-state/quick-launch-options'
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import AgentSettingsDialog from '@/components/agent/AgentSettingsDialog'
import type { AddRepoDialogHostedController } from '@/components/sidebar/use-add-repo-hosted-controller'
import { useComposerState } from '@/hooks/useComposerState'
import { pickQuickWorkspaceAgent } from '@/lib/quick-workspace-agent-selection'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { shouldAllowComposerEnterSubmitTarget } from '@/lib/new-workspace-enter-guard'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../shared/workspace-source'
import type { WorkspaceStatus } from '../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace-composer-initial-focus'
import { getFolderWorkspacePrimaryActionLabel } from '@/components/sidebar/folder-workspace-composer-helpers'
import {
  ComposerProjectLine,
  composerProjectLaunch,
  type ComposerProject
} from '@/components/projects/composer-project'

// Why: match App-level AddRepoDialog loading — the add flow is off the hot
// path for the composer, so keep its clone/SSH machinery out of the entry render.
const HostedAddRepoDialog = lazyWithRetry(() => import('@/components/sidebar/AddRepoDialog'), {
  reloadKey: 'composer-add-repo'
})

type ComposerModalData = {
  onCancelled?: () => void
  prefilledName?: string
  initialAgent?: TuiAgent
  launchOptions?: QuickLaunchOptions
  /** Seeds the note; quick-create folds it into the agent's draft prompt. */
  prefilledNote?: string
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  taskSourceContext?: TaskSourceContext | null
  initialBaseBranch?: string
  initialWorkspaceStatus?: WorkspaceStatus
  enableIssueAutomation?: boolean
  /** Telemetry surface that opened the composer. Set by each
   *  `openModal('new-workspace-composer', ...)` site so
   *  `workspace_created.source` carries the right value. Falls back to
   *  `unknown` when omitted. */
  telemetrySource?: WorkspaceCreateTelemetrySource
  contextualTourSource?: string
  setupGuideTourRequestId?: string
  /** Made from a project: its first session is filed there and inherits it (plan §8 F5). */
  project?: ComposerProject
}

export default function NewWorkspaceComposerModal(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'new-workspace-composer')
  const modalData = useAppStore((s) => s.modalData as ComposerModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)

  if (!visible) {
    return null
  }

  return <ComposerModalBody modalData={modalData ?? {}} onClose={closeModal} />
}

function ComposerModalBody({
  modalData,
  onClose
}: {
  modalData: ComposerModalData
  onClose: () => void
}): React.JSX.Element {
  const submitCancelledRef = useRef(false)
  const handleDismiss = useCallback(() => {
    modalData.onCancelled?.()
    submitCancelledRef.current = true
    onClose()
  }, [onClose, modalData])
  const isSubmissionCancelled = useCallback(() => submitCancelledRef.current, [])

  return (
    <Dialog open onOpenChange={(open) => !open && handleDismiss()}>
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-lg"
        onOpenAutoFocus={(event) => {
          // Why: Radix's FocusScope fires this once the dialog has mounted.
          // preventDefault stops it from focusing whatever first-tabbable it
          // picks (close button), and we instead focus the name/source field
          // so users can start typing immediately.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          getWorkspaceComposerInitialFocusTarget(content)?.focus({ preventScroll: true })
        }}
      >
        <QuickTabBody
          modalData={modalData}
          onClose={onClose}
          isSubmissionCancelled={isSubmissionCancelled}
          active
        />
      </DialogContent>
    </Dialog>
  )
}

function QuickTabBody({
  modalData,
  onClose,
  isSubmissionCancelled,
  active
}: {
  modalData: ComposerModalData
  onClose: () => void
  isSubmissionCancelled: () => boolean
  active: boolean
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const {
    cardProps,
    composerRef,
    onComposerNodeChange,
    nameInputRef,
    submitQuick,
    createDisabled,
    selectAddedProjectRepo
  } = useComposerState({
    initialName: modalData.prefilledName ?? '',
    // Why: the modal is quick-create only now, so prompt-prefill state is
    // intentionally ignored even if older callers still send it.
    initialPrompt: '',
    initialNote: modalData.prefilledNote ?? '',
    initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
    initialGitHubWorkItem: modalData.initialGitHubWorkItem ?? null,
    initialTaskSourceContext: modalData.taskSourceContext ?? null,
    initialRepoId: modalData.initialRepoId,
    initialEphemeralVmRecipeId: modalData.initialEphemeralVmRecipeId,
    initialProjectGroupId: modalData.initialProjectGroupId,
    initialWorkspaceStatus: modalData.initialWorkspaceStatus,
    ...(modalData.initialBaseBranch ? { initialBaseBranch: modalData.initialBaseBranch } : {}),
    persistDraft: false,
    onCreated: onClose,
    isSubmissionCancelled,
    ...(modalData.telemetrySource ? { telemetrySource: modalData.telemetrySource } : {}),
    enableIssueAutomation: modalData.enableIssueAutomation === true,
    createGateMode: 'quick'
  })
  const launchWorktreeId = useAppStore((state) => {
    const known = state.worktreesByRepo[cardProps.repoId]?.[0]?.id
    if (known) {
      return known
    }
    const host = cardProps.selectedRepoExecutionHostId
    return cardProps.selectedRepoIsRemote || (host && host !== 'local')
      ? 'unverified-work-location'
      : null
  })
  // Why open: this composer only mounts while it is open, so mounting is its opening.
  const availability = useWorkAgentCapabilities(
    launchWorktreeId,
    modalData.linkedWorkItem?.hubTaskId,
    'workspace-launch',
    false,
    true
  )
  const refreshAvailability = availability.refresh
  const availableIds = useMemo(
    () => new Set(availability.usable.map((agent) => agent.id)),
    [availability.usable]
  )
  // Why: the composer's built-in `onOpenAgentSettings` handler navigates to
  // the settings page and closes the modal. For the quick-create flow we want
  // a less disruptive affordance — a nested dialog layered over the composer
  // so the user can tweak agents without losing their in-progress workspace
  // name/repo selection.
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  // Why: once the user picks an agent, their choice wins and must not be
  // overwritten when the derived "preferred" value changes (e.g. detection
  // finishes and adds more installed agents to the set). Track that with an
  // override rather than an effect that mirrors a prop into state — deriving
  // during render keeps the selection in sync with the detected set without
  // triggering an extra commit.
  const [quickAgentOverride, setQuickAgentOverride] = useState<TuiAgent | null | undefined>(
    modalData.initialAgent
  )
  const preferredQuickAgent = useMemo<TuiAgent | null>(() => {
    const pref = settings?.defaultTuiAgent
    // Why: detection can still be pending when quick-create submits; keep the
    // prior catalog fallback while filtering disabled agents out of that choice.
    return pickQuickWorkspaceAgent(pref, availableIds, settings?.disabledTuiAgents)
  }, [availableIds, settings?.defaultTuiAgent, settings?.disabledTuiAgents])
  // Keep the requested agent while evidence reloads; never replace a handoff recipient silently.
  const requestedQuickAgent =
    quickAgentOverride === undefined ? preferredQuickAgent : quickAgentOverride
  const quickAgent =
    requestedQuickAgent && availableIds.has(requestedQuickAgent) ? requestedQuickAgent : null
  const agentUnavailable = Boolean(requestedQuickAgent && !quickAgent)

  const handleQuickAgentChange = useCallback((agent: TuiAgent | null) => {
    setQuickAgentOverride(agent)
  }, [])
  const [agentTemplateId, setAgentTemplateId] = useState<string | null>(
    modalData.launchOptions?.agentTemplateId ?? null
  )
  const [project, setProject] = useState<ComposerProject | null>(modalData.project ?? null)
  const projectHostId = cardProps.selectedRepoExecutionHostId ?? 'local'

  const handleCreate = useCallback(async (): Promise<void> => {
    if (!quickAgent) {
      if (modalData.initialAgent) {
        toast.error(
          translate(
            'conversations.chooseAvailableAgent',
            'Choose an available agent to continue this work.'
          )
        )
        return
      }
      await submitQuick(null)
      return
    }
    // Why only this agent: it lists ahead of any queued listing and the check waits for its own
    // answer, not the placeholder a listing still waiting its turn reads as.
    const available = (await refreshAvailability([quickAgent])).find(
      (entry) => entry.id === quickAgent && entry.status === 'usable'
    )
    const saved =
      quickAgent === modalData.initialAgent ? modalData.launchOptions?.preferences : undefined
    const model =
      saved?.model ??
      (available?.models.find((entry) => entry.isDefault) ?? available?.models[0])?.id
    if (!available || !model || !available.models.some((entry) => entry.id === model)) {
      toast.error(
        translate(
          'conversations.workLocationAgentUnavailable',
          'This agent or model is no longer available for this work location. Refresh and choose another.'
        )
      )
      return
    }
    const fromProject = project
      ? await composerProjectLaunch(project, projectHostId, agentTemplateId)
      : null
    const onLaunched = modalData.launchOptions?.onLaunched
    await submitQuick(quickAgent, {
      preferences: { model, ...(saved?.effort ? { effort: saved.effort } : {}) },
      submitPrompt: modalData.launchOptions?.submitPrompt,
      onLaunched: fromProject
        ? (worktreeId, tabId) => {
            fromProject.onLaunched(worktreeId, tabId)
            onLaunched?.(worktreeId, tabId)
          }
        : onLaunched,
      ...(agentTemplateId ? { agentTemplateId } : {}),
      ...(fromProject ? { project: fromProject.project } : {})
    })
  }, [
    project,
    projectHostId,
    agentTemplateId,
    quickAgent,
    submitQuick,
    modalData.initialAgent,
    modalData.launchOptions,
    refreshAvailability
  ])
  // Why: Add Project layers over the composer as a nested dialog instead of
  // replacing it in the activeModal slot — closing the composer mid-flow (and
  // losing the typed name/prompt) was the old, abrupt behavior. Once opened it
  // stays mounted so cancel/complete plays the close animation and the
  // dialog's close effects can abort in-flight clone/scan work. (Folder/non-git
  // outcomes still navigate away and tear the whole modal down.)
  const [addProjectOpen, setAddProjectOpen] = useState(false)
  const [addProjectMounted, setAddProjectMounted] = useState(false)
  const [setLocationOpen, setSetLocationOpen] = useState(false)
  const handleOpenAddProject = useCallback((): void => {
    setAddProjectMounted(true)
    setAddProjectOpen(true)
  }, [])
  const handleProjectAdded = useCallback(
    (repoId: string): void => {
      selectAddedProjectRepo(repoId)
    },
    [selectAddedProjectRepo]
  )
  const handleAddProjectCloseAutoFocus = useCallback(
    (event: Event): void => {
      // Why: after adding a project the next step is naming the worktree.
      // Radix would try to restore focus to the (unmounted) combobox row that
      // opened the dialog; send it to the name field instead — the same place
      // picking a project from the combobox lands.
      event.preventDefault()
      nameInputRef?.current?.focus()
    },
    [nameInputRef]
  )
  const addProjectController = useMemo<AddRepoDialogHostedController>(
    () => ({
      open: addProjectOpen,
      onOpenChange: setAddProjectOpen,
      onProjectAdded: handleProjectAdded,
      onCloseAutoFocus: handleAddProjectCloseAutoFocus
    }),
    [addProjectOpen, handleAddProjectCloseAutoFocus, handleProjectAdded]
  )
  const selectedProjectOption = cardProps.projectOptions.find(
    (option) => option.id === cardProps.selectedProjectId
  )
  const isFolderWorkspaceTarget = selectedProjectOption?.kind === 'project-group'
  const primaryActionLabel = isFolderWorkspaceTarget
    ? getFolderWorkspacePrimaryActionLabel()
    : cardProps.selectedRepoIsGit
      ? translate('auto.components.NewWorkspaceComposerModal.createWorktree', 'Create worktree')
      : translate('auto.components.NewWorkspaceComposerModal.createWorkspace', 'Create workspace')

  // Cmd/Ctrl+Enter submits. Escape belongs to the dialog's dismissable layer:
  // the page-style "blur the focused field first" rule assumes the user chose
  // that field, but this dialog auto-focuses the name input on open, so handling
  // Escape here swallowed every first press and left the composer stuck open.
  // Radix also closes only the topmost layer, so nested popovers/selects/dialogs
  // keep their own Escape without needing a guard here.
  const nestedDialogOpen = agentSettingsOpen || addProjectOpen || setLocationOpen
  useEffect(() => {
    if (!active || nestedDialogOpen) {
      // Why: while a nested dialog (Add Project / Agents / Set location) is layered
      // on top, this capture-phase handler must not fire composer submit underneath it.
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      // Why: workspace creation is screen-local submit behavior, not a
      // user-configurable app command.
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (!shouldAllowComposerEnterSubmitTarget(target, composerRef.current)) {
        return
      }
      if (createDisabled || agentUnavailable || availability.loading) {
        return
      }
      event.preventDefault()
      void handleCreate()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [
    active,
    composerRef,
    createDisabled,
    handleCreate,
    nestedDialogOpen,
    agentUnavailable,
    availability.loading
  ])

  return (
    <>
      <DialogHeader className="gap-1">
        <DialogTitle className="text-base font-semibold">
          {isFolderWorkspaceTarget
            ? translate(
                'auto.components.sidebar.FolderWorkspaceComposerDialog.title',
                'Create Folder Workspace'
              )
            : primaryActionLabel}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {translate(
            'auto.components.NewWorkspaceComposerModal.fa90f739a5',
            'Choose the project, workspace name, and agent before creating the workspace.'
          )}
        </DialogDescription>
      </DialogHeader>
      {project ? (
        <ComposerProjectLine
          project={project}
          hostId={projectHostId}
          onClear={() => setProject(null)}
        />
      ) : null}
      <NewWorkspaceComposerCard
        contextualTourSource={modalData.contextualTourSource}
        // Why: the scroll container clips children (overflow-y-auto forces overflow-x to auto),
        // while OmniConsole's standard field focus ring paints 3px outside the control and the ghost
        // "Advanced" disclosure pulls its padded hover highlight ~8px left to align its label with
        // the field labels. Inset px-2 so both stay fully visible instead of clipped at the edge.
        containerClassName="min-h-0 flex-1 overflow-y-auto px-2 scrollbar-sleek"
        composerRef={composerRef}
        onComposerNodeChange={onComposerNodeChange}
        nameInputRef={nameInputRef}
        quickAgent={quickAgent}
        onQuickAgentChange={handleQuickAgentChange}
        agentTemplateId={agentTemplateId}
        onAgentTemplateChange={setAgentTemplateId}
        {...cardProps}
        detectedAgentIds={availableIds}
        createDisabled={createDisabled || agentUnavailable || availability.loading}
        primaryActionLabel={primaryActionLabel}
        onOpenAgentSettings={() => setAgentSettingsOpen(true)}
        onCreate={() => void handleCreate()}
        onAddProjectOverride={handleOpenAddProject}
        onNestedDialogOpenChange={setSetLocationOpen}
      />
      <AgentSettingsDialog open={agentSettingsOpen} onOpenChange={setAgentSettingsOpen} />
      {addProjectMounted ? (
        <Suspense fallback={null}>
          <HostedAddRepoDialog hosted={addProjectController} />
        </Suspense>
      ) : null}
    </>
  )
}
