import type { ReactNode } from 'react'
import { CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { nextStepRoundsAllowed, type NextStepDraft } from '../../../../../shared/next-step-draft'
import { NEXT_STEP_SHAPE_GLYPH } from '../../../../../shared/next-step-glyphs'
import { NextStepAgentCard } from '../NextStepAgentCard'
import { actionLabel, describeNextStepDraft, nextStepAgentName } from '../next-step-summary'
import type { MenuLevel } from './menu-levels'

/** "🤖 Claude ✨ Improve", "👤 Uma · review" — who and what, short enough for a crumb. */
function levelCrumb(level: MenuLevel): string {
  const [first, ...rest] = level.recipients
  if (!first) {
    return translate('nextStep.levelEmpty', '…')
  }
  const label =
    first.kind === 'agent'
      ? [
          `${NEXT_STEP_SHAPE_GLYPH.agent} ${nextStepAgentName(first.agent)}`,
          first.presetId ? actionLabel(first.presetId) : null
        ]
          .filter((part): part is string => !!part)
          .join(' ')
      : `${NEXT_STEP_SHAPE_GLYPH.person} ${first.name}${
          level.mode === 'review' ? translate('nextStep.crumbReview', ' · review') : ''
        }`
  return rest.length
    ? translate('nextStep.crumbMore', '{{label}} +{{count}}', { label, count: rest.length })
    : label
}

export function MenuPlan({
  levels,
  current,
  active,
  draft,
  worktreeSelector,
  destinationLabel,
  pending,
  sent = false,
  checking = false,
  oneClick = false,
  error,
  dispatch,
  fleetLabel = null,
  fanout = null,
  errorAction = null,
  note = null,
  plan = true,
  onEdit,
  onLevel,
  onDraft,
  onThen,
  onSend,
  chooser
}: {
  chooser?: ReactNode
  levels: MenuLevel[]
  current: number
  active: MenuLevel
  draft: NextStepDraft
  worktreeSelector: string | null
  /** The workspace the plan will actually run in, named before Send. */
  destinationLabel?: string | null
  /** The fleet target being previewed or chosen; it runs there, not in a local workspace. */
  fleetLabel?: string | null
  /**
   * Present only when this dispatch would start several agents at once. The console accepts
   * a fan-out solely on the operator's own tick, so Dispatch waits for it.
   */
  fanout?: {
    count: number
    acknowledged: boolean
    onChange: (acknowledged: boolean) => void
  } | null
  /** One line under Dispatch: what happens to the card, and any warning the review returned. */
  note?: string | null
  /**
   * Where a person fixes what the refusal names. Its presence also holds Dispatch back —
   * pressing again before the estate is fixed would fail in exactly the same way.
   */
  errorAction?: { label: string; href: string } | null
  pending: boolean
  /** The work already left; the button says so instead of inviting a second dispatch. */
  sent?: boolean
  /** The fleet has not said yet which agents it can run; Dispatch waits rather than refusing. */
  checking?: boolean
  /** Nothing else was chosen, so Dispatch runs the work this conversation is already doing. */
  oneClick?: boolean
  error: string
  dispatch: boolean
  /** False for a card or thread: one recipient, no later steps and no ending. */
  plan?: boolean
  onEdit: (index: number) => void
  onLevel: (level: MenuLevel) => void
  onDraft: (draft: NextStepDraft) => void
  onThen: (kind: 'agent' | 'person') => void
  onSend: () => void
}) {
  const first = active.recipients[0]
  return (
    <div className="w-96 shrink-0 space-y-3 border-l p-3" data-next-step-plan>
      <nav
        className="flex flex-wrap items-center gap-1 text-xs"
        aria-label={translate('nextStep.planLevels', 'Plan levels')}
      >
        <span>{translate('nextStep.stripCurrent', 'Current')}</span>
        {fleetLabel ? (
          <span data-next-step-fleet-target>
            {translate('nextStep.stripFleet', '→ 🚀 {{target}}', { target: fleetLabel })}
          </span>
        ) : null}
        {levels.map((level, index) => (
          <Button
            key={level.id}
            size="xs"
            variant={current === index ? 'secondary' : 'ghost'}
            onClick={() => onEdit(index)}
          >
            {translate('nextStep.levelCrumbStep', '→ {{step}}', { step: levelCrumb(level) })}
          </Button>
        ))}
        {plan ? (
          <span>
            →{' '}
            {draft.end === 'done'
              ? translate('nextStep.endSession', 'End session')
              : translate('nextStep.backToMe', 'Back to me')}
          </span>
        ) : null}
      </nav>
      {chooser}
      {first?.kind === 'agent' ? (
        <NextStepAgentCard
          recipient={first}
          worktreeSelector={worktreeSelector}
          roundsAllowed={active.mode === 'handoff' && nextStepRoundsAllowed(active, first)}
          problem={false}
          onChange={(next) =>
            onLevel({
              ...active,
              recipients: active.recipients.map((recipient) =>
                recipient.kind === 'agent'
                  ? recipient.agent === first.agent
                    ? { ...next, key: recipient.key, agent: recipient.agent }
                    : {
                        ...recipient,
                        presetId: next.presetId,
                        instructions: next.instructions,
                        rounds: 1
                      }
                  : recipient
              )
            })
          }
        />
      ) : null}
      {first?.kind === 'person' ? (
        <div className="space-y-2">
          <Input
            aria-label={translate('nextStep.personNote', 'Note for the person')}
            value={draft.note}
            onChange={(event) => {
              onLevel(active)
              onDraft({ ...draft, note: event.target.value })
            }}
          />
          <p className="text-xs text-muted-foreground">
            {active.mode === 'handoff'
              ? translate(
                  'nextStep.personOwnsTask',
                  'A task card is created. The person owns it from there.'
                )
              : translate(
                  'nextStep.personReviewsTask',
                  'A task card is created. Feedback comes back on the task.'
                )}
          </p>
        </div>
      ) : null}
      {plan ? (
        <div className="space-y-2 border-t pt-2">
          <p className="text-xs font-medium">{translate('nextStep.thenWhat', 'Then what?')}</p>
          <div className="flex flex-wrap gap-1">
            <Button
              size="xs"
              variant="outline"
              disabled={levels.length >= 5}
              onClick={() => onThen('agent')}
            >
              {translate('nextStep.thenAgent', '＋ 🤖 Agent')}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={levels.length >= 5}
              onClick={() => onThen('person')}
            >
              {translate('nextStep.thenPerson', '＋ 👤 Person')}
            </Button>
            <Button
              size="xs"
              variant={draft.end === 'done' ? 'secondary' : 'ghost'}
              aria-pressed={draft.end === 'done'}
              title={translate(
                'nextStep.endSessionOnSuccess',
                'End session upon successful completion'
              )}
              onClick={() => onDraft({ ...draft, end: 'done' })}
            >
              <CircleCheck className="size-3.5 text-emerald-500" aria-hidden />
              {translate('nextStep.endSession', 'End session')}
            </Button>
            <Button
              size="xs"
              variant={draft.end === 'me' ? 'secondary' : 'ghost'}
              aria-pressed={draft.end === 'me'}
              onClick={() => onDraft({ ...draft, end: 'me' })}
            >
              {translate('nextStep.endMe', '↩ Back to me')}
            </Button>
          </div>
          {levels.length >= 5 ? (
            <p className="text-xs text-muted-foreground">
              {translate('nextStep.levelCap', 'Five steps deep. End it here.')}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
          {errorAction ? (
            <>
              {' '}
              <a className="underline" href={errorAction.href} target="_blank" rel="noreferrer">
                {errorAction.label}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {destinationLabel ? (
        <p className="text-xs text-muted-foreground" data-next-step-destination>
          {translate('nextStep.runsIn', 'Runs in {{workspace}}', { workspace: destinationLabel })}
        </p>
      ) : null}
      {fanout ? (
        <div className="space-y-1 border-t pt-2">
          <Label className="flex items-start gap-2 text-xs font-normal">
            <Checkbox
              checked={fanout.acknowledged}
              onCheckedChange={(checked) => fanout.onChange(checked === true)}
            />
            {translate(
              'nextStep.fleetFanoutConsentCount',
              'Run these {{count}} agents in parallel on the fleet',
              { count: fanout.count }
            )}
          </Label>
          {!fanout.acknowledged ? (
            <p className="text-xs text-muted-foreground">
              {translate('nextStep.fleetFanoutHint', 'Tick to run {{count}} agents in parallel', {
                count: fanout.count
              })}
            </p>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <p className="text-xs text-muted-foreground" data-next-step-note>
          {note}
        </p>
      ) : null}
      <div className="flex items-center gap-2 border-t pt-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {oneClick && levels.length === 0
            ? draft.end === 'done'
              ? translate(
                  'nextStep.oneClickEndsSession',
                  'Continues the current work on the fleet, then ends the session.'
                )
              : translate(
                  'nextStep.oneClickBackToMe',
                  'Continues the current work on the fleet, then comes back to you.'
                )
            : describeNextStepDraft(draft)}
        </p>
        <Button
          size="sm"
          disabled={
            pending ||
            sent ||
            checking ||
            errorAction !== null ||
            (levels.length === 0 && !oneClick) ||
            (dispatch && !draft.placement && !fleetLabel) ||
            (fanout !== null && !fanout.acknowledged)
          }
          onClick={onSend}
        >
          {pending
            ? translate('nextStep.sending', 'Sending…')
            : checking
              ? translate('nextStep.checkingFleet', 'Checking the fleet…')
              : sent
                ? translate('nextStep.dispatched', 'Dispatched')
                : dispatch
                  ? translate('nextStep.dispatch', 'Dispatch')
                  : translate('nextStep.send', 'Send')}
        </Button>
      </div>
    </div>
  )
}
