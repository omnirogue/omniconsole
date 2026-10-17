import React, { useMemo, useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  describeBriefActor,
  type BriefActorChoice
} from '../../../../../shared/assisted-brief-actors'
import {
  applyBriefChallenge,
  chooseBriefReviewer,
  decideBriefFinding,
  recordBriefChallenge
} from '../../../../../shared/assisted-brief-challenge'
import { parseBriefChallenge } from '../../../../../shared/assisted-brief-draft-parse'
import { buildBriefChallengePrompt } from '../../../../../shared/assisted-brief-drafting-prompt'
import { buildBriefExecutionPrompt } from '../../../../../shared/assisted-brief-execution-prompt'
import {
  addPersonItem,
  answerBriefQuestions,
  applyBriefEdit,
  currentBriefRevision,
  removeBriefItem
} from '../../../../../shared/assisted-brief-revisions'
import {
  currentRevisionStart,
  releaseUnconfirmedStart
} from '../../../../../shared/assisted-brief-start'
import type { AssistedBriefRecord } from '../../../../../shared/assisted-brief-types'
import {
  buildAttentionLaunchPrompt,
  type AttentionLaunchPlan
} from '../../../../../shared/attention-launch-favorites'
import { AssistedBriefChallengePanel } from './AssistedBriefChallengePanel'
import { AssistedBriefAddLine, AssistedBriefEditForm } from './AssistedBriefEditor'
import { AssistedBriefGenerationStatus } from './AssistedBriefGenerationStatus'
import { AssistedBriefPromptView } from './AssistedBriefPromptView'
import { AssistedBriefQuestions } from './AssistedBriefQuestions'
import { AssistedBriefStartBar } from './AssistedBriefStartBar'
import { AssistedBriefSummary } from './AssistedBriefSummary'
import {
  briefRevisionCauseLabel,
  briefStartFailureLabel,
  briefStartRefusalLabel
} from './assisted-brief-labels'
import { startApprovedBrief, type BriefStartResult } from './assisted-brief-start-launch'
import type { BriefWorkspace } from './assisted-brief-workspace'
import type { AssistedBriefState } from './use-assisted-brief'
import type { BriefGeneration } from './use-brief-generation'

function defaultPlanId(plans: readonly AttentionLaunchPlan[], record: AssistedBriefRecord): string {
  const usable = plans.filter((plan) => plan.blockers.length === 0)
  const preferred = usable.find((plan) => plan.favorite.label === record.drafter.label)
  return (preferred ?? usable[0] ?? plans[0])?.favorite.id ?? ''
}

/** True when the work started; every other outcome is reported without claiming a start. */
function notifyBriefStart(result: BriefStartResult, label: string): boolean {
  switch (result.kind) {
    case 'started':
      toast.success(
        translate('assistedBrief.startedToast', 'Started {{label}} with the approved brief', {
          label
        })
      )
      return true
    case 'already-running':
      toast.info(
        translate(
          'assistedBrief.alreadyRunning',
          'This revision is already running, so nothing new started.'
        )
      )
      return false
    case 'not-started':
      toast.error(briefStartFailureLabel(currentRevisionStart(result.record)?.failure))
      return false
    case 'uncertain':
      toast.warning(
        translate(
          'assistedBrief.uncertainToast',
          'The start could not be confirmed. Check Working on before starting again.'
        )
      )
      return false
    case 'refused':
      toast.error(briefStartRefusalLabel(result.reason))
      return false
  }
}

/** Step two: the editable plain-language brief with Start, Add something and Edit brief. */
export function AssistedBriefReview({
  scope,
  brief,
  record,
  workspace,
  generation,
  choices,
  plans,
  onStarted
}: {
  scope: string
  brief: AssistedBriefState
  record: AssistedBriefRecord
  workspace: BriefWorkspace
  generation: BriefGeneration
  choices: readonly BriefActorChoice[]
  plans: readonly AttentionLaunchPlan[]
  onStarted: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'view' | 'add' | 'edit'>('view')
  const [selectedId, setSelectedId] = useState(() => defaultPlanId(plans, record))
  const sessionsReady = useAppStore((state) => state.workspaceSessionReady)
  const current = currentBriefRevision(record)
  const busy = generation.running !== null
  const reviewer = useMemo(
    () =>
      chooseBriefReviewer(
        record.drafter,
        choices.map((choice) => choice.actor)
      ),
    [choices, record.drafter]
  )
  const selectedPlan = plans.find((plan) => plan.favorite.id === selectedId) ?? plans[0]
  const executionPrompt = buildBriefExecutionPrompt(record)
  const fullPrompt = selectedPlan
    ? buildAttentionLaunchPrompt(selectedPlan.favorite, executionPrompt)
    : executionPrompt

  const runChallenge = async (): Promise<void> => {
    if (!reviewer) {
      return
    }
    const { prompt, lineIds } = buildBriefChallengePrompt(record)
    const text = await generation.run({ purpose: 'challenge', actor: reviewer }, prompt)
    if (text === null) {
      return
    }
    const parsed = parseBriefChallenge(text, { lineIds, newId: createBrowserUuid })
    if (!parsed.ok) {
      generation.setError(
        translate(
          'assistedBrief.challengeUnreadable',
          'The second opinion could not be read. Try again.'
        )
      )
      return
    }
    brief.commit((latest, clock) => {
      const next = recordBriefChallenge(latest, reviewer, parsed.findings, clock.now)
      return typeof next === 'string' ? null : next
    })
  }

  const start = (): void => {
    if (!selectedPlan) {
      return
    }
    const result = startApprovedBrief({
      storage: brief.storage(),
      scope,
      workspace,
      plan: selectedPlan
    })
    if ('record' in result) {
      brief.replace(result.record)
    }
    if (notifyBriefStart(result, selectedPlan.favorite.label)) {
      onStarted()
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3 scrollbar-sleek">
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'assistedBrief.revisionMeta',
            'Revision {{revision}} · {{cause}} · drafted by {{drafter}}',
            {
              revision: current.number,
              cause: briefRevisionCauseLabel(current.cause),
              drafter: describeBriefActor(record.drafter)
            }
          )}
        </p>
        {mode === 'edit' ? (
          <AssistedBriefEditForm
            content={current.content}
            disabled={busy}
            onSave={(draft) =>
              brief.commit((latest, clock) => applyBriefEdit(latest, draft, clock))
            }
            onClose={() => setMode('view')}
          />
        ) : (
          <AssistedBriefSummary
            record={record}
            content={current.content}
            disabled={busy}
            onRemove={(itemId) =>
              brief.commit((latest, clock) => removeBriefItem(latest, itemId, clock))
            }
          />
        )}
        {current.content.questions.length > 0 && mode !== 'edit' ? (
          <AssistedBriefQuestions
            key={current.number}
            content={current.content}
            disabled={busy}
            onApply={(answers) =>
              brief.commit((latest, clock) => answerBriefQuestions(latest, answers, clock))
            }
          />
        ) : null}
        {mode === 'add' ? (
          <AssistedBriefAddLine
            content={current.content}
            disabled={busy}
            onAdd={(section, text) =>
              brief.commit((latest, clock) => addPersonItem(latest, section, text, clock))
            }
            onClose={() => setMode('view')}
          />
        ) : null}
        {mode === 'view' ? (
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setMode('add')}
            >
              <Plus />
              {translate('assistedBrief.addSomething', 'Add something')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setMode('edit')}
            >
              <Pencil />
              {translate('assistedBrief.editBrief', 'Edit brief')}
            </Button>
          </div>
        ) : null}
        <AssistedBriefChallengePanel
          record={record}
          reviewer={reviewer}
          disabled={busy || mode === 'edit'}
          onRun={() => void runChallenge()}
          onDecide={(findingId, decision) =>
            brief.commit((latest, clock) =>
              decideBriefFinding(latest, findingId, decision, clock.now)
            )
          }
          onApply={() => brief.commit((latest, clock) => applyBriefChallenge(latest, clock))}
        />
        <AssistedBriefGenerationStatus generation={generation} />
        <AssistedBriefPromptView prompt={fullPrompt} />
        {brief.saveError ? (
          <p role="alert" className="text-xs text-destructive">
            {brief.saveError}
          </p>
        ) : null}
      </div>
      <div className="shrink-0 space-y-1 border-t border-border px-4 py-3">
        <AssistedBriefStartBar
          record={record}
          plans={plans}
          selectedId={selectedPlan?.favorite.id ?? ''}
          disabled={busy || mode === 'edit'}
          sessionsReady={sessionsReady || workspace.paired}
          onSelect={setSelectedId}
          onStart={start}
          onRelease={(operationId) =>
            brief.commit((latest, clock) => releaseUnconfirmedStart(latest, operationId, clock.now))
          }
        />
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto p-0 text-[11px] text-muted-foreground"
          onClick={brief.discard}
        >
          {translate('assistedBrief.startOver', 'Discard this brief and start over')}
        </Button>
      </div>
    </div>
  )
}
