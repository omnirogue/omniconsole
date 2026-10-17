import { useLaunchTarget, describeTarget } from './attention-launch-target'
import { useWorkAgentCapabilities } from '@/hooks/useWorkAgentCapabilities'
import React, { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { translate } from '@/i18n/i18n'
import { AgentIcon, getAgentLabel } from '@/lib/agent-catalog'
import { getConnectionIdFromState } from '@/lib/connection-context'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { useAppStore } from '@/store'
import {
  ATTENTION_LAUNCH_PROVIDERS,
  planAttentionLaunch,
  resolveAttentionLaunchFavorites,
  type AttentionLaunchPlan
} from '../../../../shared/attention-launch-favorites'
import { isNativeChatTeamLeadAgent } from '../../../../shared/native-chat-agent-support'
import { nativeChatEnabledByPreference } from '../../../../shared/native-chat-preference'
import { DEFAULT_DISABLED_TUI_AGENTS } from '../../../../shared/tui-agent-selection'
import { launchAttentionFavorite } from './attention-favorite-launch'
import {
  attentionDetectionUnchecked,
  buildAttentionLaunchNotices,
  type AttentionLaunchNotice,
  type AttentionLaunchNoticeContext
} from './attention-launch-notices'
import { AttentionFavoriteEditor } from './AttentionFavoriteEditor'
import { AttentionNextStepArm } from './AttentionNextStepArm'
import { AttentionRequestField } from './AttentionRequestField'
import { CompanyPlaceCrumb } from '@/components/companies/CompanyPlaceCrumb'
import { AttentionWorkSummary } from './AttentionWorkSummary'
import { AssistedBriefControl } from './assisted-brief/AssistedBriefControl'

function describeAccount(plan: AttentionLaunchPlan): string {
  if (plan.account) {
    return plan.account.kind === 'managed'
      ? translate('components.agentAccountSelect.managedAccount', '{{email}} (managed)', {
          email: plan.account.label
        })
      : plan.account.label
  }
  return plan.favorite.accountChoiceId
    ? translate('attentionLauncher.accountUnavailable', 'saved account unavailable')
    : translate('attentionLauncher.currentSignIn', 'current sign-in')
}

function describeRequestedActor(plan: AttentionLaunchPlan): string {
  const { favorite } = plan
  const model = favorite.model
    ? favorite.effort
      ? translate('attentionLauncher.requestedModelEffort', 'Requested {{model}} at {{effort}}', {
          model: favorite.model,
          effort: favorite.effort
        })
      : translate('attentionLauncher.requestedModel', 'Requested {{model}}', {
          model: favorite.model
        })
    : translate('attentionLauncher.requestedDefaultModel', "The CLI's default model")
  return `${model} · ${describeAccount(plan)}`
}

function LaunchButton({
  plan,
  worktreeId,
  editorOpen,
  onEditorOpenChange,
  onLaunch
}: {
  plan: AttentionLaunchPlan
  worktreeId: string | null
  editorOpen?: boolean
  /** Only saved favourites are editable; the plain provider buttons leave this unset. */
  onEditorOpenChange?: (open: boolean) => void
  onLaunch: (plan: AttentionLaunchPlan) => void
}): React.JSX.Element {
  const { favorite } = plan
  const viewLabel =
    plan.view.mode === 'chat'
      ? translate('attentionLauncher.viewChat', 'Chat')
      : translate('attentionLauncher.viewTerminal', 'Terminal')
  // Why: while detection runs the CLI may be missing on the host, so a click could only fail.
  const launchable = plan.blockers.length === 0 && !plan.detectionPending
  return (
    <div className="inline-flex items-center rounded-md border border-border">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={!launchable}
            data-attention-launch={favorite.id}
            onClick={() => onLaunch(plan)}
          >
            <AgentIcon agent={favorite.agent} size={14} />
            <span>{favorite.label}</span>
            <span className="rounded-full bg-muted px-1.5 text-[10px] leading-4 text-muted-foreground">
              {viewLabel}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {describeRequestedActor(plan)}
        </TooltipContent>
      </Tooltip>
      {onEditorOpenChange ? (
        <AttentionFavoriteEditor
          favorite={favorite}
          worktreeId={worktreeId}
          open={editorOpen === true}
          onOpenChange={onEditorOpenChange}
        />
      ) : null}
    </div>
  )
}

function useLaunchNotices(
  plans: readonly AttentionLaunchPlan[],
  context: Pick<AttentionLaunchNoticeContext, 'hasWorkspace' | 'host' | 'editFavorite'>
): AttentionLaunchNotice[] {
  const updateSettings = useAppStore((state) => state.updateSettings)
  const disabledAgents = useAppStore(
    (state) => state.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  return buildAttentionLaunchNotices(plans, {
    ...context,
    showAgent: (agent) =>
      void updateSettings({
        disabledTuiAgents: disabledAgents.filter((candidate) => candidate !== agent)
      }),
    turnOnChat: () => void updateSettings({ experimentalNativeChat: true })
  })
}

/**
 * The launch strip at the top of Attention: saved favourites and the four providers,
 * aimed at the workspace shown on the left. Launching only creates a tab through the
 * shared path; the new session appears in "Working on" like any other.
 */
export function AttentionLaunchBar({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element {
  const [request, setRequest] = useState('')
  const [editingFavoriteId, setEditingFavoriteId] = useState<string | null>(null)
  const target = useLaunchTarget(worktreeId)
  const detectionTarget = useAgentDetectionTargetForWorktree(worktreeId)
  const { detectedIds, detectionFailed } = useDetectedAgents(detectionTarget)
  const availability = useWorkAgentCapabilities(worktreeId)
  const refreshAvailability = availability.refresh
  const refreshModels = availability.refreshModels
  // Why: nothing lists on a timer and the strip stays open, so reaching for it (pointer or
  // keyboard) re-lists agents whose listing has expired; the last listing shows until then.
  const relistExpired = useCallback(() => void refreshModels(), [refreshModels])
  const inputs = useAppStore(
    useShallow((state) => ({
      favorites: resolveAttentionLaunchFavorites(state.settings),
      disabledAgents: state.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS,
      experimentalNativeChat: nativeChatEnabledByPreference(state.settings),
      chatByDefault: state.settings?.openAgentTabsInChatByDefault === true,
      transcriptLocalReadable: worktreeId
        ? isNativeChatTranscriptLocalReadable(getConnectionIdFromState(state, worktreeId))
        : true,
      accountSettings: state.settings
    }))
  )
  const planInput = useMemo(
    () => ({
      hasWorkspace: Boolean(worktreeId),
      detectedAgents: detectedIds,
      detectionFailed: attentionDetectionUnchecked({
        hasWorkspace: Boolean(worktreeId),
        targetResolved: detectionTarget !== undefined,
        probeFailed: detectionFailed
      }),
      disabledAgents: inputs.disabledAgents,
      experimentalNativeChat: inputs.experimentalNativeChat,
      transcriptLocalReadable: inputs.transcriptLocalReadable,
      accountSettings: inputs.accountSettings,
      targetIsRemote: target?.remote === true
    }),
    [detectedIds, detectionFailed, detectionTarget, inputs, target, worktreeId]
  )
  const favoritePlans = useMemo(
    () =>
      inputs.favorites.flatMap((favorite) => {
        const available = availability.usable.find((entry) => entry.id === favorite.agent)
        if (
          !available ||
          favorite.accountChoiceId ||
          (favorite.model && !available.models.some((model) => model.id === favorite.model))
        ) {
          return []
        }
        const model =
          favorite.model ??
          (available.models.find((model) => model.isDefault) ?? available.models[0])?.id
        return [planAttentionLaunch({ ...planInput, favorite: { ...favorite, model } })]
      }),
    [inputs.favorites, planInput, availability.usable]
  )
  const providerPlans = useMemo(
    () =>
      ATTENTION_LAUNCH_PROVIDERS.filter((agent) =>
        availability.usable.some((entry) => entry.id === agent)
      ).map((agent) =>
        planAttentionLaunch({
          ...planInput,
          favorite: {
            id: `provider-${agent}`,
            label: getAgentLabel(agent),
            agent,
            model: (
              availability.usable
                .find((entry) => entry.id === agent)
                ?.models.find((model) => model.isDefault) ??
              availability.usable.find((entry) => entry.id === agent)?.models[0]
            )?.id,
            viewMode: 'chat'
          }
        })
      ),
    [planInput, availability.usable]
  )
  const notices = useLaunchNotices([...favoritePlans, ...providerPlans], {
    hasWorkspace: Boolean(worktreeId),
    host: target?.host ?? '',
    editFavorite: setEditingFavoriteId
  })
  const showsTeamLeadNote = favoritePlans.some(
    (plan) => plan.view.mode === 'chat' && isNativeChatTeamLeadAgent(plan.favorite.agent)
  )

  const launch = useCallback(
    async (plan: AttentionLaunchPlan) => {
      if (!worktreeId) {
        return
      }
      const available = (await refreshAvailability([plan.favorite.agent])).find(
        (entry) => entry.id === plan.favorite.agent && entry.status === 'usable'
      )
      if (!available || !available.models.some((model) => model.id === plan.favorite.model)) {
        toast.error(
          translate(
            'conversations.agentBecameUnavailable',
            'This agent or model is no longer available. Refresh and choose another.'
          )
        )
        return
      }
      const result = launchAttentionFavorite({ plan, worktreeId, request })
      const label = plan.favorite.label
      if (result.ok) {
        setRequest('')
        toast.success(translate('attentionLauncher.started', 'Started {{label}}', { label }))
      } else if (result.reason === 'repeat') {
        toast.message(
          translate(
            'attentionLauncher.justStarted',
            '{{label}} just started. Click again in a moment to start another.',
            { label }
          )
        )
      } else if (result.reason === 'launch-failed') {
        toast.error(
          translate(
            'attentionLauncher.launchFailed',
            'Could not build the launch command for {{label}}.',
            { label }
          )
        )
      }
    },
    [request, worktreeId, refreshAvailability]
  )

  return (
    <section
      data-attention-launcher=""
      className="shrink-0 space-y-1.5 border-b border-border px-3 py-2"
      onPointerEnter={relistExpired}
      onFocus={relistExpired}
    >
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {translate('attentionLauncher.title', 'Start work')}
        </span>
        <CompanyPlaceCrumb worktreeId={worktreeId} className="max-w-[40%]" />
        <span className="truncate" data-attention-launch-target="">
          {describeTarget(target)}
        </span>
        <AttentionWorkSummary />
      </div>
      <div className="flex items-start gap-1.5">
        <div className="min-w-0 flex-1">
          <AttentionRequestField value={request} onChange={setRequest} />
        </div>
        <AttentionNextStepArm />
      </div>
      <AssistedBriefControl
        worktreeId={worktreeId}
        request={request}
        favoritePlans={favoritePlans}
        providerPlans={providerPlans}
        onStarted={() => setRequest('')}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {favoritePlans.map((plan) => (
          <LaunchButton
            key={plan.favorite.id}
            plan={plan}
            worktreeId={worktreeId}
            editorOpen={editingFavoriteId === plan.favorite.id}
            onEditorOpenChange={(open) => setEditingFavoriteId(open ? plan.favorite.id : null)}
            onLaunch={launch}
          />
        ))}
        {favoritePlans.length > 0 ? (
          <Separator orientation="vertical" className="mx-1 h-5" />
        ) : null}
        {providerPlans.map((plan) => (
          <LaunchButton
            key={plan.favorite.id}
            plan={plan}
            worktreeId={worktreeId}
            onLaunch={launch}
          />
        ))}
      </div>
      {showsTeamLeadNote ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'attentionLauncher.teamLeadChatNote',
            'Team chat shows the lead; teammates stay in their terminal panes.'
          )}
        </p>
      ) : null}
      {notices.map((notice) => (
        <p key={notice.key} className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{notice.text}</span>
          {notice.action ? (
            <Button
              variant="link"
              size="xs"
              className="h-auto p-0 text-[11px]"
              onClick={notice.action.run}
            >
              {notice.action.label}
            </Button>
          ) : null}
        </p>
      ))}
    </section>
  )
}
