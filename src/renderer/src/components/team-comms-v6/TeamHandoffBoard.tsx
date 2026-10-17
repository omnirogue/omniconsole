import { useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  WorkflowError,
  WorkflowSelect,
  WorkflowTextField
} from '@/components/console-workflows/WorkflowFields'
import type { HandoffQueue, HandoffRecipient } from '../../../../shared/console-handoff-contract'

type Handoff = HandoffQueue['threads'][number]
type Action = NonNullable<Handoff['action']>
type Reply = 'reply' | 'status' | 'done'
type Decision = 'approve' | 'request_changes'
type Horizon = 'short_term' | 'long_term'
type Result = { ok: true } | { ok: false; error: string }
type SendInput = { to: string; action: Action; note: string; operation_id: string }
type ReplyInput = { thread_id: string; outcome: Reply; note: string; operation_id: string }
type ReviewInput = Omit<ReplyInput, 'outcome'> & { decision: Decision; version_ids: string[] }
type OutcomeInput = {
  title: string
  horizon: Horizon
  org_company_id: string
  org_unit_id?: string
  owner_employee_id?: string
}
export type TeamOutcome = OutcomeInput & { id: string; state: string; description?: string }
// Adapters validate receipts, persist retry IDs, and refresh canonical data after successful writes.
export type TeamHandoffActions = {
  send_handoff?: (input: SendInput) => Promise<Result>
  act_on_handoff?: (input: ReplyInput) => Promise<Result>
  review_handoff?: (input: ReviewInput) => Promise<Result>
  create_outcome?: (input: OutcomeInput) => Promise<Result>
}
export type TeamHandoffBoardProps = {
  scopeKey: string
  currentEmployeeId: string
  companyId: string
  unitId?: string
  handoffs: Handoff[]
  outcomes: TeamOutcome[]
  recipients: HandoffRecipient[]
  actions: TeamHandoffActions
  loading?: boolean
  error?: string
}
type Editor =
  | { kind: 'send'; label: string }
  | { kind: 'outcome'; label: string }
  | { kind: 'reply'; label: string; handoff: Handoff; outcome: Reply }
  | { kind: 'review'; label: string; handoff: Handoff; decision: Decision }
const actionOptions = ['review', 'approve', 'decide', 'edit', 'fyi'] as const

function ActionEditor({
  editor,
  board,
  onClose
}: {
  editor: Editor
  board: TeamHandoffBoardProps
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [recipient, setRecipient] = useState('')
  const [action, setAction] = useState<Action>('review')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<(() => Promise<Result>) | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [success, setSuccess] = useState(false)
  const busy = useRef(false)
  const locked = pending || !!saved || uncertain || success
  const valid =
    !!text.trim() &&
    (editor.kind !== 'send' || board.recipients.some((person) => person.id === recipient)) &&
    (editor.kind !== 'outcome' || !!board.companyId)
  const run = async (request: () => Promise<Result>) => {
    if (busy.current) {
      return
    }
    busy.current = true
    setPending(true)
    setError('')
    try {
      const result = await request()
      if (!result.ok) {
        setError(result.error)
        setSaved(null)
        return
      }
      setSaved(null)
      setSuccess(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      if (editor.kind === 'outcome') {
        setUncertain(true)
      } else {
        setSaved(() => request)
      }
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  const submit = () => {
    if (!valid || locked) {
      return
    }
    const note = text.trim()
    const operation_id = crypto.randomUUID()
    const actions = board.actions
    if (editor.kind === 'send' && actions.send_handoff) {
      const handler = actions.send_handoff
      void run(() => handler({ to: recipient, action, note, operation_id }))
    } else if (editor.kind === 'reply' && actions.act_on_handoff) {
      const handler = actions.act_on_handoff
      void run(() =>
        handler({ thread_id: editor.handoff.id, outcome: editor.outcome, note, operation_id })
      )
    } else if (editor.kind === 'review' && actions.review_handoff) {
      const handler = actions.review_handoff
      const currentIds = editor.handoff.files.filter((file) => file.current).map((file) => file.id)
      const version_ids = currentIds.length > 0 ? currentIds : [editor.handoff.id]
      const input = {
        thread_id: editor.handoff.id,
        decision: editor.decision,
        version_ids,
        note,
        operation_id
      }
      void run(() => handler(input))
    } else if (editor.kind === 'outcome' && actions.create_outcome) {
      const handler = actions.create_outcome
      void run(() =>
        handler({
          title: note,
          horizon: 'short_term',
          org_company_id: board.companyId,
          org_unit_id: board.unitId
        })
      )
    } else {
      setError('This action is no longer available.')
    }
  }
  return (
    <Card className="gap-3 py-4 shadow-none">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{editor.label}</CardTitle>
      </CardHeader>
      <CardContent className="px-4">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          {'handoff' in editor && <p className="break-words text-sm">{editor.handoff.title}</p>}
          {editor.kind === 'send' && (
            <>
              <WorkflowSelect
                label="Recipient"
                value={recipient}
                onChange={setRecipient}
                disabled={locked}
                options={board.recipients.map((person) => ({
                  value: person.id,
                  label: person.name
                }))}
              />
              <WorkflowSelect
                label="Requested action"
                value={action}
                disabled={locked}
                options={actionOptions.map((value) => ({ value, label: value }))}
                onChange={(value) => {
                  if (actionOptions.includes(value as Action)) {
                    setAction(value as Action)
                  }
                }}
              />
            </>
          )}
          {editor.kind === 'outcome' && (
            <p className="text-xs text-muted-foreground">
              Creates a short-term company goal. No task or execution is started.
            </p>
          )}
          <WorkflowTextField
            label={editor.kind === 'outcome' ? 'Desired outcome' : 'Note'}
            value={text}
            onChange={setText}
            disabled={locked}
            multiline
            prose
            maxLength={editor.kind === 'outcome' ? 160 : 8192}
          />
          <WorkflowError message={error} />
          <div role="status" className="text-sm">
            {pending && 'Saving…'}
            {success && 'Saved.'}
            {uncertain &&
              'Delivery is uncertain. Check the server before creating another outcome.'}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={!valid || locked}>
              {editor.label}
            </Button>
            {saved && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void run(saved)}
              >
                Retry same request
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending || !!saved || uncertain}
              onClick={onClose}
            >
              {success ? 'Done' : 'Cancel'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
function handoffChoices(handoff: Handoff, actions: TeamHandoffActions): Editor[] {
  const choices: Editor[] = []
  if (actions.act_on_handoff) {
    choices.push({ kind: 'reply', label: 'Reply', handoff, outcome: 'reply' })
    choices.push({ kind: 'reply', label: 'Post progress', handoff, outcome: 'status' })
    choices.push({ kind: 'reply', label: 'Mark done', handoff, outcome: 'done' })
  }
  if (actions.review_handoff && (handoff.action === 'review' || handoff.action === 'approve')) {
    const currentFiles = handoff.files.filter((file) => file.current)
    if (currentFiles.length > 0 && currentFiles.every((file) => file.available)) {
      choices.push({ kind: 'review', label: 'Approve versions', handoff, decision: 'approve' })
    }
    choices.push({ kind: 'review', label: 'Request changes', handoff, decision: 'request_changes' })
  }
  return choices
}

function Board(props: TeamHandoffBoardProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const names = new Map(props.recipients.map((person) => [person.id, person.name]))
  const name = (id: string) => names.get(id) ?? id
  const disabled = !!editor || !!props.loading
  return (
    <section aria-label="Handoffs and outcomes" aria-busy={props.loading} className="space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Handoffs & outcomes</h2>
        <div className="flex flex-wrap gap-2">
          {props.actions.send_handoff && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setEditor({ kind: 'send', label: 'Send handoff' })}
            >
              Send handoff
            </Button>
          )}
          {props.actions.create_outcome && (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !props.companyId}
              onClick={() => setEditor({ kind: 'outcome', label: 'Create outcome' })}
            >
              New outcome
            </Button>
          )}
        </div>
      </div>
      {editor && <ActionEditor editor={editor} board={props} onClose={() => setEditor(null)} />}
      <WorkflowError message={props.error} />
      {props.loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading handoffs and outcomes…
        </p>
      )}
      {!props.loading && !props.error && !props.handoffs.length && !props.outcomes.length && (
        <p className="text-sm text-muted-foreground">No cards in this view.</p>
      )}
      <div className="grid gap-3 xl:grid-cols-2">
        {props.handoffs.map((handoff) => {
          const canAct =
            handoff.recipient_employee_id === props.currentEmployeeId &&
            handoff.state !== 'resolved' &&
            !handoff.archived
          const files = handoff.files.filter((file) => file.current)
          return (
            <Card key={handoff.id} className="gap-3 py-4 shadow-none">
              <CardHeader className="px-4">
                <CardTitle className="break-words text-sm">{handoff.title}</CardTitle>
                <p className="break-words text-xs text-muted-foreground">
                  {name(handoff.author_employee_id)} → {name(handoff.recipient_employee_id)}
                </p>
                <Badge variant="secondary">{handoff.state}</Badge>
              </CardHeader>
              <CardContent className="space-y-3 px-4">
                <p className="text-xs text-muted-foreground">
                  {handoff.action ?? 'Handoff'}
                  {handoff.due_at ? ` · Due ${handoff.due_at}` : ''}
                </p>
                {files.map((file) => (
                  <p key={file.id} className="break-words text-xs">
                    {file.name} · Version {file.version}
                    {file.available ? '' : ' · Unavailable'}
                  </p>
                ))}
                {handoff.reviews
                  .filter((review) => review.current)
                  .map((review) => (
                    <p key={review.id} className="break-words text-sm">
                      {review.decision === 'approve' ? 'Approved' : 'Changes requested'}
                      {review.note ? `: ${review.note}` : ''}
                    </p>
                  ))}
                {canAct && (
                  <div className="flex flex-wrap gap-2">
                    {handoffChoices(handoff, props.actions).map((choice) => (
                      <Button
                        key={choice.label}
                        size="sm"
                        variant="outline"
                        disabled={disabled}
                        onClick={() => setEditor(choice)}
                      >
                        {choice.label}
                      </Button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
        {props.outcomes.map((outcome) => (
          <Card key={outcome.id} className="gap-3 py-4 shadow-none">
            <CardHeader className="px-4">
              <CardTitle className="break-words text-sm">{outcome.title}</CardTitle>
              <Badge variant="secondary">{outcome.state}</Badge>
            </CardHeader>
            <CardContent className="space-y-2 px-4 text-sm">
              <p>
                {outcome.horizon === 'short_term' ? 'Short term' : 'Long term'} ·{' '}
                {outcome.owner_employee_id ? name(outcome.owner_employee_id) : 'Unassigned'}
              </p>
              <details>
                <summary className="cursor-pointer">Outcome details</summary>
                <p className="whitespace-pre-wrap break-words">
                  {outcome.description || 'No additional details.'}
                </p>
              </details>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  )
}

export function TeamHandoffBoard(props: TeamHandoffBoardProps) {
  const scope = [props.scopeKey, props.currentEmployeeId, props.companyId, props.unitId]
  return <Board key={JSON.stringify(scope)} {...props} />
}
export default TeamHandoffBoard
