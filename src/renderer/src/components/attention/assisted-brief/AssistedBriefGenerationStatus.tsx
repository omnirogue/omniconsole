import React from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { describeBriefActor } from '../../../../../shared/assisted-brief-actors'
import type { BriefGeneration } from './use-brief-generation'

/** Stage label for the multi-second draft or review, with Cancel; errors stay inline to re-read. */
export function AssistedBriefGenerationStatus({
  generation
}: {
  generation: BriefGeneration
}): React.JSX.Element | null {
  const { running, error } = generation
  if (running) {
    const actor = describeBriefActor(running.actor)
    return (
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span className="min-w-0 flex-1">
          {running.purpose === 'draft'
            ? translate(
                'assistedBrief.drafting',
                'Drafting with {{actor}}. It can read the workspace but changes nothing.',
                { actor }
              )
            : translate('assistedBrief.reviewing', 'Getting a second opinion from {{actor}}.', {
                actor
              })}
        </span>
        <Button type="button" variant="ghost" size="xs" onClick={generation.cancel}>
          {translate('assistedBrief.cancel', 'Cancel')}
        </Button>
      </div>
    )
  }
  return error ? (
    <p role="alert" className="text-xs text-destructive">
      {error}
    </p>
  ) : null
}
