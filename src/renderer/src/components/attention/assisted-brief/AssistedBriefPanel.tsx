import React, { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { briefActorChoices } from '../../../../../shared/assisted-brief-actors'
import type { AttentionLaunchPlan } from '../../../../../shared/attention-launch-favorites'
import { AssistedBriefCompose } from './AssistedBriefCompose'
import { AssistedBriefReview } from './AssistedBriefReview'
import type { BriefWorkspace } from './assisted-brief-workspace'
import { useAssistedBrief } from './use-assisted-brief'
import { useBriefGeneration } from './use-brief-generation'

/**
 * The briefing flow for one person and workspace: compose and draft, then review and Start.
 * `startFresh` composes a new brief beside a started one, which stays saved until it is replaced.
 */
export function AssistedBriefPanel({
  scope,
  workspace,
  request,
  startFresh,
  favoritePlans,
  providerPlans,
  onStarted
}: {
  scope: string
  workspace: BriefWorkspace
  request: string
  startFresh: boolean
  favoritePlans: readonly AttentionLaunchPlan[]
  providerPlans: readonly AttentionLaunchPlan[]
  onStarted: () => void
}): React.JSX.Element {
  const brief = useAssistedBrief(scope, workspace)
  const generation = useBriefGeneration(workspace)
  const [replacingBriefId] = useState(() => (startFresh ? (brief.record?.briefId ?? null) : null))
  const choices = useMemo(
    () => briefActorChoices(favoritePlans.map((plan) => plan.favorite)),
    [favoritePlans]
  )
  const plans = useMemo(() => [...favoritePlans, ...providerPlans], [favoritePlans, providerPlans])

  if (brief.unreadable) {
    return (
      <div className="space-y-2 px-4 pb-4">
        <p role="alert" className="text-sm text-destructive">
          {translate(
            'assistedBrief.unreadable',
            'The saved brief for this workspace could not be read safely, so it cannot be started.'
          )}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={brief.discard}>
          {translate('assistedBrief.discardUnreadable', 'Discard it and draft a new brief')}
        </Button>
      </div>
    )
  }
  if (!brief.record || brief.record.briefId === replacingBriefId) {
    return (
      <AssistedBriefCompose
        workspace={workspace}
        initialRequest={request}
        choices={choices}
        generation={generation}
        saveError={brief.saveError}
        onDrafted={brief.save}
      />
    )
  }
  return (
    <AssistedBriefReview
      scope={scope}
      brief={brief}
      record={brief.record}
      workspace={workspace}
      generation={generation}
      choices={choices}
      plans={plans}
      onStarted={onStarted}
    />
  )
}
