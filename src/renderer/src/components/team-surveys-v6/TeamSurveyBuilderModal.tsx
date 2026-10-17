import React, { useCallback, useId, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Eye, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'

export type TeamSurveyQuestionKind = 'single_select' | 'multi_select' | 'rating' | 'rank' | 'free_text'
export type TeamSurveyOption = { id: string; label: string }
export type TeamSurveyQuestion = {
  id: string; kind: TeamSurveyQuestionKind; prompt: string; required: boolean; options: TeamSurveyOption[]; scaleMax: number
}
export type TeamSurveyAudience = 'one_to_one' | 'one_to_many'
export type TeamSurveyMember = { id: string; name: string }
export type TeamSurveyDraft = {
  title: string; description: string; audience: TeamSurveyAudience; recipientIds: string[]; questions: TeamSurveyQuestion[]
}
// single_select: option id; multi_select/rank: option ids (rank in chosen order); rating: 1..scaleMax; free_text: text.
export type TeamSurveyAnswer = string | string[] | number
export type TeamSurveyResponse = { answers: Record<string, TeamSurveyAnswer> }
export type TeamSurveyBuilderModalProps = {
  open: boolean; onOpenChange: (open: boolean) => void; mode: 'build' | 'respond'; members?: TeamSurveyMember[]
  // Seeds the builder, or is the survey being answered; read once per open.
  survey?: TeamSurveyDraft; onPublish?: (draft: TeamSurveyDraft) => void | Promise<void>
  onSubmitResponse?: (response: TeamSurveyResponse) => void | Promise<void>
}
type RunAction = (action: () => void | Promise<void>) => Promise<string | null>
type Answers = Record<string, TeamSurveyAnswer>
const t = (key: string, fallback: string): string => translate(`teamSurveys.${key}`, fallback)
const KINDS: TeamSurveyQuestionKind[] = ['single_select', 'multi_select', 'rating', 'rank', 'free_text']
const CHOICE_KINDS = new Set<TeamSurveyQuestionKind>(['single_select', 'multi_select', 'rank'])
const SCALES = [5, 7, 10]
const KIND_LABELS: Record<TeamSurveyQuestionKind, [string, string]> = {
  single_select: ['kind.single', 'Single choice'], multi_select: ['kind.multi', 'Multiple choice'],
  rating: ['kind.rating', 'Rating'], rank: ['kind.rank', 'Rank'], free_text: ['kind.text', 'Free text']
}
const newOption = (): TeamSurveyOption => ({ id: crypto.randomUUID(), label: '' })
const newQuestion = (): TeamSurveyQuestion => ({
  id: crypto.randomUUID(), kind: 'single_select', prompt: '', required: true, options: [newOption(), newOption()], scaleMax: 5
})
const emptyDraft = (): TeamSurveyDraft => ({ title: '', description: '', audience: 'one_to_many', recipientIds: [], questions: [newQuestion()] })
// Drops options left over from a kind switch and trims text before the draft leaves the builder.
const finalizeDraft = (draft: TeamSurveyDraft): TeamSurveyDraft => ({
  ...draft, title: draft.title.trim(), description: draft.description.trim(),
  questions: draft.questions.map((q) => ({
    ...q, prompt: q.prompt.trim(), options: CHOICE_KINDS.has(q.kind) ? q.options.map((o) => ({ ...o, label: o.label.trim() })) : []
  }))
})
function move<T>(items: T[], index: number, delta: number): T[] {
  const target = index + delta
  if (index < 0 || target < 0 || target >= items.length) { return items }
  const next = [...items]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}
function draftProblem(draft: TeamSurveyDraft): string | null {
  if (!draft.title.trim()) { return t('problem.title', 'Add a survey title.') }
  if (draft.recipientIds.length === 0) { return t('problem.recipients', 'Choose at least one recipient.') }
  if (draft.audience === 'one_to_one' && draft.recipientIds.length > 1) { return t('problem.oneToOne', 'A 1-to-1 survey has one recipient.') }
  if (draft.questions.length === 0) { return t('problem.questions', 'Add at least one question.') }
  for (const question of draft.questions) {
    if (!question.prompt.trim()) { return t('problem.prompt', 'Every question needs a prompt.') }
    if (!CHOICE_KINDS.has(question.kind)) { continue }
    const labels = question.options.map((option) => option.label.trim().toLowerCase())
    if (labels.length < 2 || labels.some((label) => !label)) { return t('problem.options', 'Choice and rank questions need two or more options.') }
    if (new Set(labels).size !== labels.length) { return t('problem.duplicate', 'Options in a question must be unique.') }
  }
  return null
}
const isAnswered = (answer: TeamSurveyAnswer | undefined): boolean =>
  Array.isArray(answer) ? answer.length > 0 : typeof answer === 'number' || (typeof answer === 'string' && answer.trim().length > 0)
// Rank starts in authored order so an untouched rank question is still a complete answer.
const seedAnswers = (questions: TeamSurveyQuestion[]): Answers =>
  Object.fromEntries(questions.filter((q) => q.kind === 'rank').map((q) => [q.id, q.options.map((o) => o.id)]))

export function TeamSurveyBuilderModal(props: TeamSurveyBuilderModalProps): React.ReactElement {
  const { open, onOpenChange, mode, survey } = props
  const [busy, setBusy] = useState(false)
  const changeOpen = useCallback((next: boolean) => { if (!busy) { onOpenChange(next) } }, [busy, onOpenChange])
  const run = useCallback<RunAction>(async (action) => {
    setBusy(true)
    try { await action(); onOpenChange(false); return null }
    catch (error) { return error instanceof Error ? error.message : String(error) }
    finally { setBusy(false) }
  }, [onOpenChange])
  const cancel = useCallback(() => changeOpen(false), [changeOpen])
  // Content unmounts on close, so each open starts from a fresh draft or answer sheet.
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="scrollbar-sleek max-h-[85vh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
        {mode === 'build' ? (
          <SurveyBuilder seed={survey} members={props.members ?? []} busy={busy} run={run} onPublish={props.onPublish} onCancel={cancel} />
        ) : survey ? (
          <SurveyRespondent survey={survey} busy={busy} run={run} onSubmit={props.onSubmitResponse} onCancel={cancel} />
        ) : (
          <DialogHeader><DialogTitle>{t('missing.title', 'This survey could not be loaded.')}</DialogTitle></DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  )
}
type FooterProps = { status: string; error: string | null; busy: boolean; onCancel: () => void; children: React.ReactNode }
function SurveyFooter({ status, error, busy, onCancel, children }: FooterProps): React.ReactElement {
  return (
    <DialogFooter className="items-center sm:justify-between">
      <p className={error ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{error ?? status}</p>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t('action.cancel', 'Cancel')}</Button>
        {children}
      </div>
    </DialogFooter>
  )
}

type BuilderProps = {
  seed?: TeamSurveyDraft; members: TeamSurveyMember[]; busy: boolean; run: RunAction; onCancel: () => void
  onPublish?: (draft: TeamSurveyDraft) => void | Promise<void>
}
function SurveyBuilder({ seed, members, busy, run, onPublish, onCancel }: BuilderProps): React.ReactElement {
  const titleId = useId()
  const [draft, setDraft] = useState<TeamSurveyDraft>(() => seed ?? emptyDraft())
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = useMemo(() => draftProblem(draft), [draft])
  const patch = (next: Partial<TeamSurveyDraft>): void => setDraft((current) => ({ ...current, ...next }))
  const setQuestions = (update: (questions: TeamSurveyQuestion[]) => TeamSurveyQuestion[]): void =>
    setDraft((current) => ({ ...current, questions: update(current.questions) }))
  const setAudience = (audience: TeamSurveyAudience): void => setDraft((current) => ({
    ...current, audience, recipientIds: audience === 'one_to_one' ? current.recipientIds.slice(0, 1) : current.recipientIds
  }))
  const toggleRecipient = (id: string, checked: boolean): void => setDraft((current) => {
    if (!checked) { return { ...current, recipientIds: current.recipientIds.filter((r) => r !== id) } }
    return { ...current, recipientIds: current.audience === 'one_to_one' ? [id] : [...current.recipientIds, id] }
  })
  const publish = async (): Promise<void> => { if (!problem && onPublish) { setError(await run(() => onPublish(finalizeDraft(draft)))) } }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{preview ? t('preview.title', 'Respondent preview') : t('builder.title', 'Build team survey')}</DialogTitle>
        <DialogDescription>{preview ? t('preview.body', 'What recipients will see. Answers here are not saved.')
          : t('builder.body', 'Ask one teammate or the whole team a set of questions.')}</DialogDescription>
      </DialogHeader>
      {preview ? <SurveyQuestions questions={draft.questions} disabled={false} /> : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={titleId}>{t('field.title', 'Title')}</Label>
            <Input id={titleId} value={draft.title} disabled={busy} onChange={(e) => patch({ title: e.target.value })} />
            <Textarea value={draft.description} disabled={busy} rows={2} aria-label={t('field.description', 'Description')}
              placeholder={t('field.descriptionHint', 'Optional context for respondents')} onChange={(e) => patch({ description: e.target.value })} />
          </div>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>{t('field.audience', 'Audience')}</Label>
              <p className="text-xs text-muted-foreground">{draft.audience === 'one_to_one'
                ? t('audience.oneHint', 'Pick exactly one teammate.') : t('audience.manyHint', 'Pick everyone who should answer.')}</p>
            </div>
            <ToggleGroup type="single" variant="outline" size="sm" value={draft.audience} disabled={busy}
              onValueChange={(value) => { if (value) { setAudience(value as TeamSurveyAudience) } }}>
              <ToggleGroupItem value="one_to_one">{t('audience.one', '1-to-1')}</ToggleGroupItem>
              <ToggleGroupItem value="one_to_many">{t('audience.many', '1-to-many')}</ToggleGroupItem>
            </ToggleGroup>
            {members.length === 0 ? <p className="text-[11px] text-muted-foreground">{t('audience.none', 'No teammates available.')}</p> : (
              <div className="grid grid-cols-2 gap-1.5">
                {members.map((member) => (
                  <label key={member.id} className="flex items-center gap-2 text-[13px]">
                    <Checkbox checked={draft.recipientIds.includes(member.id)} disabled={busy}
                      onCheckedChange={(checked) => toggleRecipient(member.id, checked === true)} />
                    <span className="truncate">{member.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="space-y-3">
            {draft.questions.map((question, index) => (
              <QuestionEditor key={question.id} question={question} position={index} total={draft.questions.length} disabled={busy}
                onChange={(next) => setQuestions((qs) => qs.map((q) => (q.id === question.id ? { ...q, ...next } : q)))}
                onMove={(delta) => setQuestions((qs) => move(qs, qs.findIndex((q) => q.id === question.id), delta))}
                onRemove={() => setQuestions((qs) => qs.filter((q) => q.id !== question.id))} />
            ))}
            <Button variant="outline" size="sm" disabled={busy}
              onClick={() => setQuestions((qs) => [...qs, newQuestion()])}><Plus />{t('question.add', 'Add question')}</Button>
          </div>
        </div>
      )}
      <SurveyFooter status={problem ?? ''} error={error} busy={busy} onCancel={onCancel}>
        <Button variant="ghost" disabled={busy} onClick={() => setPreview(!preview)}>{preview ? <Pencil /> : <Eye />}
          {preview ? t('action.edit', 'Edit') : t('action.preview', 'Preview')}</Button>
        <Button disabled={busy || problem !== null || !onPublish} onClick={() => void publish()}>
          {busy && <Loader2 className="animate-spin" />}{t('action.publish', 'Send survey')}</Button>
      </SurveyFooter>
    </>
  )
}

type QuestionEditorProps = {
  question: TeamSurveyQuestion; position: number; total: number; disabled: boolean
  onChange: (next: Partial<TeamSurveyQuestion>) => void; onMove: (delta: number) => void; onRemove: () => void
}
function QuestionEditor({ question, position, total, disabled, onChange, onMove, onRemove }: QuestionEditorProps): React.ReactElement {
  const setOption = (id: string, label: string): void => onChange({ options: question.options.map((o) => (o.id === id ? { ...o, label } : o)) })
  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">Q{position + 1}</span>
        <Select value={question.kind} disabled={disabled} onValueChange={(kind) => onChange({ kind: kind as TeamSurveyQuestionKind })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>{KINDS.map((kind) => <SelectItem key={kind} value={kind}>{t(...KIND_LABELS[kind])}</SelectItem>)}</SelectContent>
        </Select>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox checked={question.required} disabled={disabled}
            onCheckedChange={(checked) => onChange({ required: checked === true })} />{t('question.required', 'Required')}
        </label>
        <Button variant="ghost" size="icon-xs" disabled={disabled || position === 0} aria-label={t('question.up', 'Move up')}
          onClick={() => onMove(-1)}><ArrowUp /></Button>
        <Button variant="ghost" size="icon-xs" disabled={disabled || position === total - 1} aria-label={t('question.down', 'Move down')}
          onClick={() => onMove(1)}><ArrowDown /></Button>
        <Button variant="ghost" size="icon-xs" disabled={disabled} aria-label={t('question.remove', 'Remove question')} onClick={onRemove}><Trash2 /></Button>
      </div>
      <Input value={question.prompt} disabled={disabled} aria-label={t('question.prompt', 'Question prompt')}
        placeholder={t('question.promptHint', 'What do you want to ask?')} onChange={(e) => onChange({ prompt: e.target.value })} />
      {CHOICE_KINDS.has(question.kind) && (
        <div className="space-y-1.5 pl-3">
          {question.options.map((option, index) => (
            <div key={option.id} className="flex items-center gap-1.5">
              <Input value={option.label} disabled={disabled} className="h-8" aria-label={t('option.label', 'Option')}
                placeholder={`${t('option.label', 'Option')} ${index + 1}`} onChange={(e) => setOption(option.id, e.target.value)} />
              <Button variant="ghost" size="icon-xs" disabled={disabled || question.options.length <= 2} aria-label={t('option.remove', 'Remove option')}
                onClick={() => onChange({ options: question.options.filter((o) => o.id !== option.id) })}><X /></Button>
            </div>
          ))}
          <Button variant="ghost" size="xs" disabled={disabled}
            onClick={() => onChange({ options: [...question.options, newOption()] })}><Plus />{t('option.add', 'Add option')}</Button>
        </div>
      )}
      {question.kind === 'rating' && (
        <ToggleGroup type="single" variant="outline" size="sm" className="ml-3" value={String(question.scaleMax)} disabled={disabled}
          aria-label={t('rating.scale', 'Rating scale')} onValueChange={(value) => { if (value) { onChange({ scaleMax: Number(value) }) } }}>
          {SCALES.map((scale) => <ToggleGroupItem key={scale} value={String(scale)}>1–{scale}</ToggleGroupItem>)}
        </ToggleGroup>
      )}
    </div>
  )
}

type RespondentProps = {
  survey: TeamSurveyDraft; busy: boolean; run: RunAction; onCancel: () => void; onSubmit?: (response: TeamSurveyResponse) => void | Promise<void>
}
function SurveyRespondent({ survey, busy, run, onSubmit, onCancel }: RespondentProps): React.ReactElement {
  const [answers, setAnswers] = useState<Answers>(() => seedAnswers(survey.questions))
  const [error, setError] = useState<string | null>(null)
  const missing = survey.questions.filter((q) => q.required && !isAnswered(answers[q.id])).length
  const submit = async (): Promise<void> => { if (missing === 0 && onSubmit) { setError(await run(() => onSubmit({ answers }))) } }
  const status = missing > 0 ? translate('teamSurveys.respond.missing', '{{count}} required question(s) left', { count: missing }) : ''
  return (
    <>
      <DialogHeader><DialogTitle>{survey.title}</DialogTitle>
        {survey.description && <DialogDescription>{survey.description}</DialogDescription>}</DialogHeader>
      <SurveyQuestions questions={survey.questions} disabled={busy} answers={answers} onAnswersChange={setAnswers} />
      <SurveyFooter status={status} error={error} busy={busy} onCancel={onCancel}>
        <Button disabled={busy || missing > 0 || !onSubmit} onClick={() => void submit()}>
          {busy && <Loader2 className="animate-spin" />}{t('action.submit', 'Submit answers')}</Button>
      </SurveyFooter>
    </>
  )
}

type SurveyQuestionsProps = {
  questions: TeamSurveyQuestion[]; disabled: boolean
  // Omitted in builder preview: answers stay local and are discarded on exit.
  answers?: Answers; onAnswersChange?: React.Dispatch<React.SetStateAction<Answers>>
}
function SurveyQuestions({ questions, disabled, answers, onAnswersChange }: SurveyQuestionsProps): React.ReactElement {
  const [localAnswers, setLocalAnswers] = useState<Answers>(() => seedAnswers(questions))
  const current = answers ?? localAnswers
  const setAnswers = onAnswersChange ?? setLocalAnswers
  return (
    <ol className="space-y-4">
      {questions.map((question, index) => (
        <li key={question.id} className="space-y-2">
          <p className="text-sm font-medium">{index + 1}. {question.prompt || t('respond.untitled', 'Untitled question')}
            {question.required && <span className="text-muted-foreground"> *</span>}</p>
          <AnswerControl question={question} value={current[question.id]} disabled={disabled}
            onChange={(value) => setAnswers((prev) => ({ ...prev, [question.id]: value }))} />
        </li>
      ))}
    </ol>
  )
}

type AnswerControlProps = {
  question: TeamSurveyQuestion; value: TeamSurveyAnswer | undefined; disabled: boolean; onChange: (value: TeamSurveyAnswer) => void
}
function AnswerControl({ question, value, disabled, onChange }: AnswerControlProps): React.ReactElement {
  const optionLabel = (o: TeamSurveyOption | undefined): string => o?.label || t('option.blank', '(blank option)')
  if (question.kind === 'free_text') {
    return <Textarea rows={3} disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
  }
  if (question.kind === 'rating') {
    const scores = Array.from({ length: question.scaleMax }, (_, offset) => offset + 1)
    return (
      <ToggleGroup type="single" variant="outline" size="sm" disabled={disabled} value={typeof value === 'number' ? String(value) : ''}
        onValueChange={(next) => { if (next) { onChange(Number(next)) } }}>
        {scores.map((score) => <ToggleGroupItem key={`score-${score}`} value={String(score)}>{score}</ToggleGroupItem>)}
      </ToggleGroup>
    )
  }
  if (question.kind === 'single_select') {
    return (
      <ToggleGroup type="single" variant="outline" spacing={1} className="w-full flex-col items-stretch" disabled={disabled}
        value={typeof value === 'string' ? value : ''} onValueChange={(next) => { if (next) { onChange(next) } }}>
        {question.options.map((o) => <ToggleGroupItem key={o.id} value={o.id} className="justify-start">{optionLabel(o)}</ToggleGroupItem>)}
      </ToggleGroup>
    )
  }
  if (question.kind === 'multi_select') {
    const picked = Array.isArray(value) ? value : []
    return (
      <div className="space-y-1.5">
        {question.options.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm">
            <Checkbox checked={picked.includes(o.id)} disabled={disabled}
              onCheckedChange={(checked) => onChange(checked === true ? [...picked, o.id] : picked.filter((id) => id !== o.id))} />{optionLabel(o)}
          </label>
        ))}
      </div>
    )
  }
  const order = Array.isArray(value) ? value : question.options.map((o) => o.id)
  const byId = new Map(question.options.map((o) => [o.id, o]))
  return (
    <ol className="space-y-1">
      {order.map((id, index) => (
        <li key={id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm">
          <span className="w-5 text-xs text-muted-foreground">{index + 1}</span>
          <span className="flex-1 truncate">{optionLabel(byId.get(id))}</span>
          <Button variant="ghost" size="icon-xs" disabled={disabled || index === 0} aria-label={t('rank.up', 'Rank higher')}
            onClick={() => onChange(move(order, index, -1))}><ArrowUp /></Button>
          <Button variant="ghost" size="icon-xs" disabled={disabled || index === order.length - 1} aria-label={t('rank.down', 'Rank lower')}
            onClick={() => onChange(move(order, index, 1))}><ArrowDown /></Button>
        </li>
      ))}
    </ol>
  )
}
