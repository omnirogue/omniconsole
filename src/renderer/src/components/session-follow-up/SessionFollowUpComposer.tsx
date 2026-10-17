import { useId, useState } from 'react'
import { Send } from 'lucide-react'
import {
  WorkflowError,
  WorkflowSelect,
  WorkflowTextField
} from '@/components/console-workflows/WorkflowFields'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { workflowErrorMessage } from '@/lib/console-workflow-client'
import { saveSessionFollowUp } from '@/lib/session-follow-up-commands'
import { followUpActionLabel } from '@/lib/session-follow-up-messages'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sessionFollowUpStep, type SessionChain } from '../../../../shared/session-chain-types'
import { parseFollowUpRequest } from '../../../../shared/session-follow-up-parser'
import {
  SESSION_FOLLOW_UP_ACTIONS,
  type SessionFollowUpAction
} from '../../../../shared/session-follow-up-rule'
import type { TeamRosterPerson } from '../../../../shared/team-roster-search'
import {
  applyFollowUpIntent,
  followUpDraftFromForm,
  formFromRule,
  initialFollowUpForm,
  type FollowUpFormContext,
  type FollowUpFormState,
  type FollowUpProblem
} from './session-follow-up-draft'
import { SessionFollowUpDeliverablesField } from './SessionFollowUpDeliverablesField'
import { SessionFollowUpProblems } from './SessionFollowUpProblems'
import { SessionFollowUpRecipientPicker } from './SessionFollowUpRecipientPicker'
import { SessionFollowUpTaskPicker } from './SessionFollowUpTaskPicker'
import { useSessionFollowUpContext } from './use-session-follow-up-context'

const NO_ACTION = '__none__'

type ComposerProps = {
  session: SidebarSession
  /** A saved rule that has not started delivering, to edit in place; null for a new one. */
  editing: SessionChain | null
  onSaved: () => void
}

/**
 * Next step → When finished → Send for review → person. The sentence box and the
 * controls fill one form and save through one path, so both create the same rule.
 */
export function SessionFollowUpComposer(props: ComposerProps): React.JSX.Element {
  const loaded = useSessionFollowUpContext(props.session)
  if (!loaded.context) {
    return (
      <WorkflowError
        message={translate(
          'sessionFollowUp.workspaceMissing',
          'The source workspace is no longer available.'
        )}
      />
    )
  }
  return <SessionFollowUpForm {...props} {...loaded} context={loaded.context} />
}

function SessionFollowUpForm({
  session,
  editing,
  onSaved,
  context,
  roster,
  reloadRoster,
  tasks,
  reloadTasks,
  sessionStopped
}: ComposerProps &
  Omit<ReturnType<typeof useSessionFollowUpContext>, 'context'> & {
    context: FollowUpFormContext
  }): React.JSX.Element {
  const sentenceId = useId()
  const peopleId = useId()
  const rule = editing ? (sessionFollowUpStep(editing)?.handoff ?? null) : null
  const [form, setForm] = useState<FollowUpFormState>(() =>
    rule ? formFromRule(rule, context) : initialFollowUpForm(context)
  )
  const [sentence, setSentence] = useState('')
  const [problems, setProblems] = useState<FollowUpProblem[]>([])
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const people = roster.phase === 'ready' ? roster.value : []

  const save = async (next: FollowUpFormState): Promise<void> => {
    const { draft, problems: blocking } = followUpDraftFromForm(next, context)
    setProblems(blocking)
    if (!draft || pending) {
      return
    }
    setPending(true)
    setError('')
    try {
      await saveSessionFollowUp(session, draft)
      onSaved()
    } catch (reason) {
      setError(workflowErrorMessage(reason))
    } finally {
      setPending(false)
    }
  }

  const submitSentence = (): void => {
    if (!sentence.trim() || roster.phase !== 'ready') {
      return
    }
    const applied = applyFollowUpIntent(
      form,
      parseFollowUpRequest(sentence, new Date()),
      people,
      context
    )
    setForm(applied.form)
    if (applied.problems.length > 0) {
      setProblems(applied.problems)
      return
    }
    // Why: a sentence that resolves clearly is the approval; it saves without a second confirm.
    void save(applied.form)
  }

  const choosePerson = (person: TeamRosterPerson): void => {
    setForm((current) =>
      current.people.some((entry) => entry.id === person.id)
        ? current
        : { ...current, people: [...current.people, person] }
    )
    setProblems((current) =>
      current.filter(
        (problem) =>
          !(
            problem.kind === 'person-choice' &&
            problem.match.candidates.some((candidate) => candidate.id === person.id)
          )
      )
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {translate('sessionFollowUp.whenFinished', 'When {{session}} finishes', {
          session: session.label
        })}
      </p>
      {sessionStopped ? (
        <p className="text-[11px] text-muted-foreground">
          {form.deliverableMode === 'manifest' && form.manifestPath
            ? translate(
                'sessionFollowUp.alreadyStoppedManifest',
                'This session has stopped, so saving checks its manifest and sends right away if it lists its files.'
              )
            : translate(
                'sessionFollowUp.alreadyStoppedFiles',
                'This session has stopped. Saving checks the files, then waits for you to confirm it is finished.'
              )}
        </p>
      ) : null}
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          submitSentence()
        }}
      >
        <Label htmlFor={sentenceId}>
          {translate('sessionFollowUp.sentenceLabel', 'Say what happens next')}
        </Label>
        <div className="flex gap-2">
          <Input
            id={sentenceId}
            autoFocus
            value={sentence}
            disabled={pending}
            placeholder={translate(
              'sessionFollowUp.sentencePlaceholder',
              'Once done, send the final deliverables to Iris for review'
            )}
            onChange={(event) => setSentence(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            className="h-9"
            disabled={pending || !sentence.trim() || roster.phase !== 'ready'}
          >
            {translate('sessionFollowUp.sentenceSave', 'Save')}
          </Button>
        </div>
      </form>
      <SessionFollowUpProblems problems={problems} onChoose={choosePerson} />
      <div className="grid gap-3 sm:grid-cols-2">
        <WorkflowSelect
          label={translate('sessionFollowUp.sendFor', 'Ask for')}
          value={form.action ?? NO_ACTION}
          disabled={pending}
          onChange={(value) =>
            setForm((current) => ({
              ...current,
              action: value === NO_ACTION ? null : (value as SessionFollowUpAction)
            }))
          }
          options={[
            {
              value: NO_ACTION,
              label: translate('sessionFollowUp.actionNone', 'Nothing specific — the work says it')
            },
            ...SESSION_FOLLOW_UP_ACTIONS.map((action) => ({
              value: action,
              label: followUpActionLabel(action) ?? action
            }))
          ]}
        />
        <div className="min-w-0 space-y-2">
          <Label htmlFor={peopleId}>{translate('sessionFollowUp.to', 'To')}</Label>
          {roster.phase === 'error' ? (
            <div className="space-y-2">
              <WorkflowError message={roster.message} />
              <Button type="button" size="sm" variant="outline" onClick={reloadRoster}>
                {translate('sessionFollowUp.retryLoad', 'Try again')}
              </Button>
            </div>
          ) : (
            <SessionFollowUpRecipientPicker
              id={peopleId}
              roster={people}
              selected={form.people}
              loading={roster.phase !== 'ready'}
              disabled={pending}
              onChange={(next) => setForm((current) => ({ ...current, people: next }))}
            />
          )}
        </div>
      </div>
      <SessionFollowUpDeliverablesField form={form} disabled={pending} onChange={setForm} />
      <SessionFollowUpTaskPicker
        linked={context.linkedTask}
        tasks={tasks}
        value={form.task}
        disabled={pending}
        onChange={(task) => setForm((current) => ({ ...current, task }))}
        onReload={reloadTasks}
      />
      <details className="space-y-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          {translate('sessionFollowUp.noteAndDue', 'Note and due date')}
        </summary>
        <div className="space-y-3 pt-2">
          <WorkflowTextField
            label={translate('sessionFollowUp.note', 'Note')}
            value={form.note}
            disabled={pending}
            multiline
            prose
            maxLength={8192}
            onChange={(note) => setForm((current) => ({ ...current, note }))}
          />
          <WorkflowTextField
            label={translate('sessionFollowUp.due', 'Due date')}
            value={form.due}
            inputType="datetime-local"
            disabled={pending}
            onChange={(due) => setForm((current) => ({ ...current, due }))}
          />
        </div>
      </details>
      <WorkflowError message={error} />
      <div className="flex justify-end">
        <Button disabled={pending || roster.phase !== 'ready'} onClick={() => void save(form)}>
          <Send className="size-3.5" />
          {pending
            ? translate('sessionFollowUp.saving', 'Saving…')
            : editing
              ? translate('sessionFollowUp.saveChanges', 'Save changes')
              : translate('sessionFollowUp.saveNextStep', 'Save next step')}
        </Button>
      </div>
    </div>
  )
}
