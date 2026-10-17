import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { ConversationSource } from '../../../../shared/conversation-source'
import {
  NEXT_STEP_KEEP_GOING_MAX_ROUNDS,
  NEXT_STEP_KEEP_GOING_MIN_ROUNDS,
  normalizeKeepGoingPushPrompt,
  type NextStepKeepGoingMode,
  type NextStepKeepGoingState,
  type NextStepKeepGoingStopReason
} from '../../../../shared/next-step-keep-going'
import {
  keepGoingDefaultRounds,
  normalizeNextStepSuggestionSettings
} from '../../../../shared/next-step-suggestion-settings'
import { setNextStepKeepGoing } from './next-steps-client'
import {
  noteNextStepKeepGoing,
  refreshPendingNextSteps,
  useNextStepKeepGoing,
  useNextStepKeepGoingStopShown,
  useNextStepsUnknown
} from './next-steps-pending-store'
import { keepGoingModeLabel, useKeepGoingRunChoice } from './next-steps-keep-going-mode'
import { KeepGoingModeSelect, KeepGoingPushPromptField } from './NextStepsKeepGoingMode'
import { KeepGoingAdPauseLine, KeepGoingAdPausesSelect } from './NextStepsKeepGoingAdPauses'

const ROUND_CHOICES = Array.from(
  { length: NEXT_STEP_KEEP_GOING_MAX_ROUNDS - NEXT_STEP_KEEP_GOING_MIN_ROUNDS + 1 },
  (_, at) => NEXT_STEP_KEEP_GOING_MIN_ROUNDS + at
)

export function keepGoingStopWords(reason: NextStepKeepGoingStopReason): string {
  // A newer host's reason this version has no words for still reads as a stop.
  return (
    knownStopWords(reason) ?? translate('nextSteps.keepGoing.stop.other', 'the host stopped it')
  )
}

function knownStopWords(reason: NextStepKeepGoingStopReason): string | undefined {
  switch (reason) {
    case 'person-stopped':
      return translate('nextSteps.keepGoing.stop.personStopped', 'you turned it off')
    case 'restarted':
      return translate('nextSteps.keepGoing.stop.restarted', 'OmniConsole restarted')
    case 'cap-reached':
      return translate('nextSteps.keepGoing.stop.capReached', 'it ran all its rounds')
    case 'needs-you-risky':
      return translate('nextSteps.keepGoing.stop.risky', 'the next step is risky and needs you')
    case 'needs-you-ad-spend':
      return translate(
        'nextSteps.keepGoing.stop.adSpend',
        'the next step changes ad spend — needs you'
      )
    case 'needs-you-ad-pause':
      return translate(
        'nextSteps.keepGoing.stop.adPause',
        'the next step pauses ads — you asked to approve pauses'
      )
    case 'needs-you-ad-campaign-pause':
      return translate(
        'nextSteps.keepGoing.stop.adCampaignPause',
        'the next step pauses a whole campaign — campaigns stay on; pause ad sets instead'
      )
    case 'needs-you-ad-enterprise':
      return translate(
        'nextSteps.keepGoing.stop.adEnterprise',
        'the next step pauses Enterprise ads — Enterprise ads are flagged for Sal, not paused'
      )
    case 'needs-you-deploy':
      return translate('nextSteps.keepGoing.stop.deploy', 'the next step deploys — needs you')
    case 'needs-you-shared-branch':
      return translate(
        'nextSteps.keepGoing.stop.sharedBranch',
        'the next step pushes or merges to a shared branch — needs you'
      )
    case 'needs-you-delete-data':
      return translate(
        'nextSteps.keepGoing.stop.deleteData',
        'the next step deletes data — needs you'
      )
    case 'needs-you-history':
      return translate(
        'nextSteps.keepGoing.stop.history',
        'the next step rewrites git history — needs you'
      )
    case 'needs-you-send':
      return translate(
        'nextSteps.keepGoing.stop.send',
        'the next step sends something to people — needs you'
      )
    case 'needs-you-payment':
      return translate(
        'nextSteps.keepGoing.stop.payment',
        'the next step involves a payment — needs you'
      )
    case 'needs-you-credentials':
      return translate(
        'nextSteps.keepGoing.stop.credentials',
        'the next step touches credentials or permissions — needs you'
      )
    case 'no-safe-suggestion':
      return translate('nextSteps.keepGoing.stop.noSafe', 'there was no next step to run')
    case 'needs-you-question':
      return translate('nextSteps.keepGoing.stop.question', 'the next step is a question for you')
    case 'set-failed':
      return translate('nextSteps.keepGoing.stop.setFailed', 'no suggestions could be written')
    case 'person-decided':
      return translate('nextSteps.keepGoing.stop.personDecided', 'you answered the suggestions')
    case 'person-message':
      return translate('nextSteps.keepGoing.stop.personMessage', 'you sent your own message')
    case 'agent-waiting':
      return translate('nextSteps.keepGoing.stop.agentWaiting', 'the agent is waiting for you')
    case 'turn-failed':
      return translate('nextSteps.keepGoing.stop.turnFailed', 'the agent’s turn failed')
    case 'turn-skipped':
      return translate('nextSteps.keepGoing.stop.turnSkipped', 'the turn did not finish')
    case 'capacity-recovery':
      return translate('nextSteps.keepGoing.stop.capacity', 'the agent hit a usage limit')
    case 'chain-bound':
      return translate('nextSteps.keepGoing.stop.chainBound', 'a running plan took over')
    case 'pane-closed':
      return translate('nextSteps.keepGoing.stop.paneClosed', 'the conversation was closed')
    case 'setting-off':
      return translate('nextSteps.keepGoing.stop.settingOff', 'suggested next steps are off')
    case 'not-queued':
      return translate('nextSteps.keepGoing.stop.notQueued', 'the next step could not be queued')
    case 'round-refused':
      return translate('nextSteps.keepGoing.stop.roundRefused', 'the next step was refused')
    case 'evicted':
      return translate('nextSteps.keepGoing.stop.evicted', 'too many conversations used it')
    case 'needs-you-command':
      return translate(
        'nextSteps.keepGoing.stop.command',
        'the next step runs a command or needs your judgement'
      )
    case 'person-acted':
      return translate('nextSteps.keepGoing.stop.personActed', 'you acted on the suggestions')
    case 'person-typing':
      return translate('nextSteps.keepGoing.stop.personTyping', 'you started typing')
    case 'turn-unknown':
      return translate('nextSteps.keepGoing.stop.turnUnknown', 'the current turn is unknown')
    case 'done':
      return translate('nextSteps.keepGoing.stop.done', 'the work reads as done')
    case 'no-more-improvement':
      return translate(
        'nextSteps.keepGoing.stop.noMoreImprovement',
        'another round wasn’t making it better (JEV)'
      )
  }
}

/**
 * The person acted in the tray: Keep going stops on the host FIRST, before the action's own async
 * work, so the autopilot can never race it. Throws, and the action does not run, if it could not.
 */
export function stopKeepGoingForPersonAction(conversation: ConversationSource): Promise<void> {
  // Always asked of the host, never read from the cache: a stale "off" must not let a person's
  // answer race a round the host is about to send. Stopping what is off is cheap and idempotent.
  return stopOnHost(conversation)
}

async function stopOnHost(conversation: ConversationSource): Promise<void> {
  try {
    noteNextStepKeepGoing(
      await setNextStepKeepGoing(conversation, false, undefined, 'person-acted')
    )
  } catch (error) {
    // A host that has no Keep going cannot be running it; any other failure stops the action.
    if (!(error instanceof RuntimeRpcCallError && error.code === 'method_not_found')) {
      throw error
    }
  }
  refreshPendingNextSteps()
}

function useDefaultRounds(): number {
  const settings = useAppStore((state) => state.settings?.nextStepSuggestions)
  return keepGoingDefaultRounds(normalizeNextStepSuggestionSettings(settings))
}

function useKeepGoingSwitch(conversation: ConversationSource) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const change = async (
    enabled: boolean,
    maxRounds?: number,
    run?: { mode: NextStepKeepGoingMode; pushPrompt: string }
  ): Promise<void> => {
    setPending(true)
    setError(null)
    try {
      noteNextStepKeepGoing(
        await setNextStepKeepGoing(conversation, enabled, maxRounds, undefined, run)
      )
      refreshPendingNextSteps()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setPending(false)
    }
  }
  return { error, pending, change }
}

/**
 * The tray header's switch, mode and rounds: turning it on runs the top step, or sends the
 * person's push prompt, by itself after each finished turn.
 */
export function NextStepsKeepGoingControl({ conversation }: { conversation: ConversationSource }) {
  const state = useNextStepKeepGoing(conversation)
  const defaultRounds = useDefaultRounds()
  const [rounds, setRounds] = useState<number | null>(null)
  const run = useKeepGoingRunChoice(state)
  const { error, pending, change } = useKeepGoingSwitch(conversation)
  const push = run.mode === 'push-for-better'
  const noPrompt = push && normalizeKeepGoingPushPrompt(run.pushPrompt) === null
  // A failed read shows the last known state and refuses to turn anything on from it.
  const unknown = useNextStepsUnknown()
  const on = state?.enabled === true
  const chosen = on ? state.maxRounds : (rounds ?? defaultRounds)
  const label = translate('nextSteps.keepGoing.label', 'Keep going')
  return (
    <span className="flex items-center gap-1.5 font-normal" title={error ?? undefined}>
      <Switch
        className="h-3.5 w-6 border-0 p-0.5"
        thumbClassName="size-2.5 data-[state=checked]:translate-x-2.5"
        checked={on}
        disabled={pending || unknown || (!on && noPrompt)}
        aria-label={
          unknown ? translate('nextSteps.keepGoing.labelUnknown', 'Keep going (unknown)') : label
        }
        data-next-steps-keep-going-switch
        onCheckedChange={(checked) =>
          void change(
            checked,
            checked ? chosen : undefined,
            checked ? { mode: run.mode, pushPrompt: run.pushPrompt } : undefined
          )
        }
      />
      <span className={error ? 'text-destructive' : 'text-muted-foreground'}>
        {unknown ? translate('nextSteps.keepGoing.labelUnknown', 'Keep going (unknown)') : label}
      </span>
      <KeepGoingModeSelect
        mode={on ? (state.mode ?? 'next-step') : run.mode}
        disabled={pending || on || unknown}
        onChange={run.setMode}
      />
      <KeepGoingAdPausesSelect conversation={conversation} state={state} disabled={unknown} />
      {push ? (
        <KeepGoingPushPromptField
          prompt={on ? (state.pushPrompt ?? run.pushPrompt) : run.pushPrompt}
          disabled={pending || on}
          onChange={run.setPushPrompt}
        />
      ) : null}
      <Select
        value={String(chosen)}
        disabled={pending || on || unknown}
        onValueChange={(value) => setRounds(Number(value))}
      >
        <SelectTrigger
          size="sm"
          className="h-6 px-1.5 text-xs"
          aria-label={translate('nextSteps.keepGoing.rounds', 'Rounds')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="end">
          {ROUND_CHOICES.map((choice) => (
            <SelectItem key={choice} value={String(choice)}>
              {translate('nextSteps.keepGoing.roundsChoice', '{{n}} rounds', { n: choice })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  )
}

function stopLineText(state: NextStepKeepGoingState): string {
  if (state.stopReason === 'done') {
    return state.stopPercent === undefined
      ? translate('nextSteps.keepGoing.doneLine', 'Done — nothing required is missing (checked)')
      : translate(
          'nextSteps.keepGoing.doneLinePercent',
          'Done — nothing required is missing ({{percent}}% resolved, checked)',
          { percent: state.stopPercent }
        )
  }
  return translate('nextSteps.keepGoing.stopped', 'Stopped: {{reason}}', {
    reason: keepGoingStopWords(state.stopReason!)
  })
}

function StopLine({ state }: { state: NextStepKeepGoingState }) {
  return (
    <p
      className="truncate px-3 py-1 text-xs text-muted-foreground"
      title={state.stopDetail}
      role="status"
      data-next-steps-keep-going-stopped={state.stopReason}
    >
      {stopLineText(state)}
    </p>
  )
}

/**
 * "Keep going · round 2 of 3 · Stop" while it runs; once it stops, why, in one muted line until
 * the person acts. Shown even while the agent works, when the rest of the tray is hidden.
 */
export function NextStepsKeepGoingStatus({
  conversation,
  className
}: {
  conversation: ConversationSource
  /** Frames the line when it is all the tray shows. */
  className?: string
}) {
  const state = useNextStepKeepGoing(conversation)
  const stopShown = useNextStepKeepGoingStopShown(conversation)
  const unknown = useNextStepsUnknown()
  const { error, pending, change } = useKeepGoingSwitch(conversation)
  if (!state) {
    return null
  }
  if (!state.enabled) {
    return stopShown && state.stopReason && state.stopReason !== 'person-stopped' ? (
      <div className={className}>
        <StopLine state={state} />
        {state.lastAdPause ? (
          <p className="truncate px-3 pb-1 text-xs text-muted-foreground">
            <KeepGoingAdPauseLine state={state} />
          </p>
        ) : null}
      </div>
    ) : null
  }
  return (
    <div
      className={cn('flex items-center gap-1 px-3 py-1 text-xs text-muted-foreground', className)}
      role="status"
      data-next-steps-keep-going-running
    >
      <span>
        {unknown
          ? translate('nextSteps.keepGoing.runningUnknown', 'Keep going · status unknown')
          : state.mode
            ? translate(
                'nextSteps.keepGoing.runningMode',
                'Keep going · {{mode}} · round {{n}} of {{max}}',
                {
                  mode: keepGoingModeLabel(state.mode),
                  n: Math.max(1, state.roundsUsed),
                  max: state.maxRounds
                }
              )
            : translate('nextSteps.keepGoing.running', 'Keep going · round {{n}} of {{max}}', {
                n: Math.max(1, state.roundsUsed),
                max: state.maxRounds
              })}
      </span>
      {state.lastAdPause ? (
        <>
          <span aria-hidden>·</span>
          <KeepGoingAdPauseLine state={state} />
        </>
      ) : null}
      <span aria-hidden>·</span>
      <Button
        size="xs"
        variant="ghost"
        className="h-5 px-1 text-xs"
        disabled={pending}
        onClick={() => void change(false)}
      >
        {translate('nextSteps.keepGoing.stopAction', 'Stop')}
      </Button>
      {error ? <span className="truncate text-destructive">{error}</span> : null}
    </div>
  )
}
