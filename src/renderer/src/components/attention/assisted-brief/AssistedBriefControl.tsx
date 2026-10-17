import React, { useMemo, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import type { AttentionLaunchPlan } from '../../../../../shared/attention-launch-favorites'
import { AssistedBriefPanel } from './AssistedBriefPanel'
import {
  parseSavedBriefText,
  readSavedBriefText,
  savedBriefLaunchState
} from './assisted-brief-memory'
import { useBriefWorkspace } from './assisted-brief-workspace'

/**
 * "Help me shape this" beside the Attention request box. Optional: the launch buttons still
 * send directly in one click; this opens a drawer where a brief is drafted, reviewed and started.
 */
export function AssistedBriefControl({
  worktreeId,
  request,
  favoritePlans,
  providerPlans,
  onStarted
}: {
  worktreeId: string | null
  request: string
  favoritePlans: readonly AttentionLaunchPlan[]
  providerPlans: readonly AttentionLaunchPlan[]
  onStarted: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [startFresh, setStartFresh] = useState(false)
  const workspace = useBriefWorkspace(worktreeId)
  const scope = useAppStore(selectConsoleAccountScope)
  // Why: the strip re-renders on every keystroke; the saved text only changes through the drawer.
  const savedText = worktreeId ? readSavedBriefText(window.localStorage, scope, worktreeId) : null
  const saved = useMemo(() => savedBriefLaunchState(parseSavedBriefText(savedText)), [savedText])
  const openDrawer = (fresh: boolean): void => {
    setStartFresh(fresh)
    setOpen(true)
  }
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
          disabled={!workspace}
          data-assisted-brief-open=""
          onClick={() => openDrawer(saved === 'started')}
        >
          <Sparkles className="size-3.5" />
          {saved === 'saved'
            ? translate('assistedBrief.openBrief', 'Open brief')
            : translate('assistedBrief.helpMeShape', 'Help me shape this')}
        </Button>
        {saved === 'started' ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto p-0 text-[11px] text-muted-foreground"
            disabled={!workspace}
            onClick={() => openDrawer(false)}
          >
            {translate('assistedBrief.openLastBrief', 'Open last brief')}
          </Button>
        ) : null}
        {saved === 'none' ? (
          <span className="truncate text-[11px] text-muted-foreground">
            {translate(
              'assistedBrief.controlHint',
              'Optional: review a short brief before anything starts.'
            )}
          </span>
        ) : null}
      </div>
      <Sheet open={open && workspace !== null} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
          <SheetHeader className="shrink-0">
            <SheetTitle>{translate('assistedBrief.title', 'Shape the request')}</SheetTitle>
            <SheetDescription>
              {translate(
                'assistedBrief.description',
                'For {{workspace}}. Drafting only reads; no work starts until you press Start.',
                {
                  workspace: workspace?.label ?? ''
                }
              )}
            </SheetDescription>
          </SheetHeader>
          {open && workspace ? (
            <AssistedBriefPanel
              key={`${scope}\n${workspace.workspaceKey}`}
              scope={scope}
              workspace={workspace}
              request={request}
              startFresh={startFresh}
              favoritePlans={favoritePlans}
              providerPlans={providerPlans}
              onStarted={() => {
                setOpen(false)
                onStarted()
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
