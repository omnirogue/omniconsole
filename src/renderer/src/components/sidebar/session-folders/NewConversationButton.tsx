import { toast } from 'sonner'
import { NeedSpeedDialog } from '@/components/work/NeedSpeedDialog'
import { NewWorkflowMenu } from '@/components/local-workflows/NewWorkflowMenu'
import { workflowOpensOutsideLocalWorkspace } from '@/components/local-workflows/workflow-presets'
import { createLocalWorkflowConversation } from '@/lib/local-workflow-conversation'
import { openBuildReview } from '@/lib/build-review-entry'
import { useCallback, useMemo, useState, useEffect, useRef } from 'react'
import { companiesApi, useCompaniesRead } from '@/components/companies/companies-client'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import {
  useHoverOpenPopover,
  type HoverOpenAnchorProps
} from '@/components/next-step/use-hover-open-popover'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import { useLauncherAccountRows } from './new-conversation/use-launcher-account-rows'
import { selectedComputerWorkspace } from './new-conversation/selected-computer-workspace'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useHoverRearmOnMove } from './new-conversation/use-hover-rearm-on-move'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { translate } from '@/i18n/i18n'
import { NewConversationTrigger } from './NewConversationTrigger'
import { RoutineDropTarget } from '../routines/RoutineDropTarget'
import { LauncherPalette } from './LauncherPalette'
import { NewConversationMenu } from './new-conversation/NewConversationMenu'
import { useLaunchContext } from './new-conversation/launch-context'
import { reviewedLaunchStart } from './new-conversation/reviewed-launch'
import { useOwnedPaletteDrop, useStartOwnedPaletteDrop } from './use-palette-drop-launch'
import type { LaunchTarget } from './new-conversation/LaunchTargetColumn'
import { useConversationLaunch } from './new-conversation/use-conversation-launch'
import { fileLaunchInFolder } from '@/lib/pending-folder-launches'
import { useLauncherTargets } from './new-conversation/launcher-target'
import {
  launchProjectIn,
  projectWorkspaceIn,
  useActiveLaunchProject,
  useLaunchProject
} from '@/lib/project-launch'
import { useSessionFolders } from '@/store/session-folders'
import { useLaunchSkills } from '@/lib/project-launch-skills'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'

/**
 * The sidebar "+". Given a folder, it is that folder's own "+": the same launcher, and the new
 * conversation is filed in the folder. Filing is only a sidebar label — the session runs in the
 * same workspace either way, so moving it out later changes nothing about its files or context.
 */
export function NewConversationButton({
  folder,
  palette = false
}: {
  folder?: { id: string; name: string }
  /** The toolbar "+" only: show the provider palette beside it and start session-row drops. */
  palette?: boolean
} = {}): React.JSX.Element {
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeTarget = useAgentDetectionTargetForWorktree(worktreeId)
  // Why (measured live on c39b7cf81): a restored active worktree whose execution host has
  // not resolved yet has no detection target, and the shared hooks rightly never probe an
  // unknown host — so the launcher sat on "Checking available agents…" forever. The
  // launcher alone treats such a worktree as no target: it lists this machine's agents and
  // launches through the company path, never into the unresolved worktree.
  const effectiveWorktreeId = worktreeId !== null && activeTarget === undefined ? null : worktreeId
  const runtimeId = useAppStore((state) => state.settings?.activeRuntimeEnvironmentId)
  const computerWorkspace = useAppStore((state) =>
    selectedComputerWorkspace(state, state.settings?.activeRuntimeEnvironmentId)
  )
  const folderId = folder?.id
  const owned = useOwnedPaletteDrop(folderId, palette)
  // Why: the launcher's own target row wins over the sidebar selection while the menu is used.
  const sharedTarget = useLaunchContext((state) => state.target)
  const targetOverride = owned.drop ? owned.drop.target : sharedTarget
  const resetTarget = useLaunchContext((state) => state.setTarget)
  const folderMetadata = useSessionFolders((state) => state.metadata)
  // Why: a project's "+" starts in one of the project's workspaces unless the target row says otherwise.
  const projectWorkspace = useAppStore((state) =>
    folder ? projectWorkspaceIn(state, launchProjectIn(folderMetadata, folder.id)) : null
  )
  const defaultToWorkRoot =
    !runtimeId && (targetOverride ? targetOverride.kind === 'work-root' : !projectWorkspace)
  // Fresh desktop conversations must not inherit a company or domain from the open tab.
  const launchWorktreeId = targetOverride
    ? targetOverride.kind === 'workspace'
      ? targetOverride.worktreeId
      : computerWorkspace
    : (projectWorkspace ??
      (defaultToWorkRoot ? null : runtimeId ? computerWorkspace : effectiveWorktreeId))
  const [open, setOpen] = useState(false)
  const [needSpeedOpen, setNeedSpeedOpen] = useState(false)
  const [needSpeedSource, setNeedSpeedSource] = useState<string | undefined>()
  const [reviewing, setReviewing] = useState(false)
  // Why `open`: the menu is when someone is about to choose a model, so that is when it re-lists.
  const availability = useWorkAgentCapabilities(
    launchWorktreeId,
    undefined,
    'workspace-launch',
    true,
    open
  )
  const target = useAgentDetectionTargetForWorktree(launchWorktreeId)
  const launchHostId = useAppStore((state) =>
    getExecutionHostIdForWorktree(state, launchWorktreeId)
  )
  const local = target?.kind === 'local' && !isWebRuntimeSessionActive(runtimeId)
  const accountEnvironmentId =
    target?.kind === 'runtime'
      ? target.environmentId
      : runtimeId && !launchWorktreeId
        ? runtimeId
        : null
  const { claude, codex, error: accountsError } = useLauncherAccountRows(accountEnvironmentId)
  const missingComputerWorkspace = Boolean(runtimeId && !launchWorktreeId)
  // Why: the target row is a choice for this opening of the menu, not a sticky mode; only a
  // menu that was open clears it, so mounting another "+" never wipes a live choice.
  const hover = useHoverOpenPopover({ open, onOpenChange: setOpen })
  // Why (measured live): a click-launch closes the menu while the pointer still rests on "+";
  // hover-open stays off until the pointer really moves (see useHoverRearmOnMove).
  const rearm = useHoverRearmOnMove()
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        rearm.suppress()
      }
      hover.onOpenChange(next)
    },
    [hover, rearm]
  )
  const anchorProps = useMemo<HoverOpenAnchorProps>(
    () => ({
      ...hover.anchorProps,
      onPointerEnter: () => {
        if (rearm.isSuppressed()) {
          return
        }
        hover.anchorProps.onPointerEnter()
      }
    }),
    [hover.anchorProps, rearm]
  )
  const scope = useHandoffScope()
  const company = useLauncherTargets((state) => state.companies[scope])
  const companies = useCompaniesRead(
    () => companiesApi().folders(),
    scope,
    open && !launchWorktreeId && !defaultToWorkRoot
  )
  const launch = useConversationLaunch({
    worktreeId: launchWorktreeId,
    defaultToWorkRoot,
    open,
    loading: availability.loading,
    refreshCapabilities: availability.refresh,
    company: runtimeId ? undefined : company,
    scope,
    local,
    accountEnvironmentId,
    rows: { claude, codex },
    readCapabilities: missingComputerWorkspace ? () => [] : availability.readCurrent,
    setOpen: handleOpenChange,
    onLaunched: folder ? (tabId) => fileLaunchInFolder(tabId, folder.id) : undefined
  })
  // Why also `starting`: closing the menu is how a click launches, and the launch still
  // verifies against the chosen target; clear it once the launch has settled. Only a menu that
  // was open, and only while the target is still the one that menu showed: a launch this "+"
  // started without its menu (a click, a drop) never clears a target someone else chose.
  const wasActive = useRef(false)
  const menuTarget = useRef<{ target: LaunchTarget | undefined } | null>(null)
  useEffect(() => {
    if (open) {
      menuTarget.current = { target: sharedTarget }
    }
  }, [open, sharedTarget])
  const active = open || launch.starting || reviewing
  useEffect(() => {
    if (wasActive.current && !active) {
      const shown = menuTarget.current
      menuTarget.current = null
      if (shown && useLaunchContext.getState().target === shown.target) {
        resetTarget(undefined)
      }
    }
    if (open) {
      // Why on open: a folder's "+" launches inside its project and inherits its settings.
      useLaunchProject.getState().open(folder?.id ?? null)
    }
    wasActive.current = active
  }, [active, open, resetTarget, folder?.id])
  const projectSkills = useActiveLaunchProject()?.settings.attachments.some(
    (item) => item.kind === 'skill'
  )
  useLaunchSkills(launchWorktreeId, launchHostId, open && !!projectSkills)
  useEffect(
    () => () => {
      const shown = menuTarget.current
      if (wasActive.current && shown && useLaunchContext.getState().target === shown.target) {
        resetTarget(undefined)
      }
    },
    [resetTarget]
  )
  // Why provider starts go through here: review what the launcher adds before sending it.
  const reviewed = reviewedLaunchStart({
    launch,
    worktreeId: launchWorktreeId,
    local,
    folder,
    onReviewChange: setReviewing
  })
  useStartOwnedPaletteDrop({
    owned,
    folderId,
    palette,
    loading: availability.loading,
    starting: launch.starting || reviewing,
    start: (pick) => reviewed(pick)
  })
  const menu = (
    <>
      <NeedSpeedDialog
        open={needSpeedOpen}
        onOpenChange={setNeedSpeedOpen}
        sourceWorktreeId={needSpeedSource}
        project={folder ? { folderId: folder.id, name: folder.name } : undefined}
        unavailableReason={
          runtimeId
            ? translate(
                'needSpeed.localRequired',
                'Need Speed is available from this computer’s Work folder or a local or SSH project. Select this computer to continue.'
              )
            : undefined
        }
      />
      <DropdownMenu open={open} onOpenChange={handleOpenChange} modal={false}>
        <NewConversationTrigger
          starting={launch.starting}
          onStart={() => {
            handleOpenChange(false)
            useLaunchProject.getState().open(folder?.id ?? null)
            reviewed(undefined)
          }}
          hover={anchorProps}
          folderName={folder?.name}
        />
        <DropdownMenuContent
          side="right"
          align="start"
          className="w-80"
          {...hover.contentProps}
          onCloseAutoFocus={(event) => {
            if (needSpeedOpen) {
              event.preventDefault()
            } else {
              hover.contentProps.onCloseAutoFocus(event)
            }
          }}
        >
          <NewWorkflowMenu
            onNeedSpeed={() => {
              setNeedSpeedSource(launchWorktreeId ?? undefined)
              handleOpenChange(false)
              setNeedSpeedOpen(true)
            }}
            hover={hover.contentProps}
            onRoutine={() => {
              handleOpenChange(false)
              // Why: the routine dialog picks an eligible workspace itself; a seeded one could be unsavable.
              const state = useAppStore.getState()
              state.setPendingRoutineDraftSeed({ cron: '*/30 * * * *' })
              state.setActiveView('automations')
            }}
            unavailableReason={
              folder
                ? translate(
                    'conversations.folderWorkflowsUnavailable',
                    'Workflows cannot be kept in a folder yet. Start one from the + at the top.'
                  )
                : !local || activeTarget?.kind !== 'local' || !effectiveWorktreeId
                  ? translate(
                      'localWorkflow.menu.localOrSshBuildReview',
                      'Workflows need a local workspace. Build + Review also opens in an SSH workspace, and asks for a workspace anywhere else.'
                    )
                  : undefined
            }
            onWorkflow={(preset) => {
              const anywhere = workflowOpensOutsideLocalWorkspace(preset)
              if (folder && !anywhere) {
                return
              }
              if (!anywhere && (!effectiveWorktreeId || !local || activeTarget?.kind !== 'local')) {
                return
              }
              try {
                // Why: Build + Review decides for itself between a tab (local or SSH) and its dialog.
                if (preset === 'build-review') {
                  openBuildReview(effectiveWorktreeId)
                } else if (effectiveWorktreeId) {
                  createLocalWorkflowConversation(effectiveWorktreeId, preset)
                } else {
                  throw new Error(
                    translate(
                      'localWorkflow.chooseWorkspace',
                      'Open a workspace for this workflow.'
                    )
                  )
                }
                handleOpenChange(false)
              } catch (error) {
                toast.error(error instanceof Error ? error.message : String(error))
              }
            }}
          >
            <NewConversationMenu
              starting={launch.starting}
              launchError={
                missingComputerWorkspace
                  ? translate(
                      'computerPicker.needsWorkspace',
                      'Add a workspace on this computer to start a session.'
                    )
                  : launch.launchError || accountsError
              }
              refreshCapabilities={availability.refresh}
              capabilities={missingComputerWorkspace ? [] : availability.capabilities}
              rows={{ claude, codex }}
              local={local}
              accountEnvironmentId={accountEnvironmentId}
              hover={hover.contentProps}
              start={(pick, selectedCompany) =>
                // Why: a company chosen after "target required" must replay the pending pick untouched.
                pick === undefined && selectedCompany
                  ? void launch.start(undefined, selectedCompany)
                  : reviewed(pick, selectedCompany)
              }
              needsCompany={!runtimeId && !launchWorktreeId && !defaultToWorkRoot}
              company={company}
              loading={availability.loading}
              companies={
                companies.data?.companies.flatMap((entry) =>
                  entry.name ? [{ name: entry.name, slug: entry.slug }] : []
                ) ?? []
              }
              companiesLoading={companies.loading}
              companiesError={companies.error}
              onClose={() => handleOpenChange(false)}
              launchWorktreeId={launchWorktreeId}
              onLaunched={folder ? (tabId) => fileLaunchInFolder(tabId, folder.id) : undefined}
            />
          </NewWorkflowMenu>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
  // Why: dropping a conversation on the top + starts a routine from it. A folder's header is
  // already where a dropped conversation gets filed, so its + must not catch that drop.
  if (folder) {
    return menu
  }
  const routineTarget = <RoutineDropTarget className="shrink-0">{menu}</RoutineDropTarget>
  // Why a fragment: the "+" stays the toolbar's own item right after New folder; the icons
  // follow it as siblings in the same toolbar row.
  return palette ? (
    <>
      {routineTarget}
      <LauncherPalette
        capabilities={missingComputerWorkspace ? [] : availability.capabilities}
        rows={{ claude, codex }}
        local={local}
        starting={launch.starting}
        launchError={launch.launchError}
        start={(pick) => reviewed(pick)}
      />
    </>
  ) : (
    routineTarget
  )
}
