import { useId, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Plus, Star, Trash2, User, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import {
  rosterPersonDetail,
  uniqueRosterPeople,
  type TeamRosterPerson
} from '../../../../shared/team-roster-search'

// [label, needs more than one recipient]
const MODES = {
  single_approver: ['Single approver', false],
  first_responder: ['First responder', true],
  majority_quorum: ['Majority quorum', true],
  unanimous: ['Unanimous', true],
  survey: ['Survey', false]
} as const satisfies Record<string, readonly [string, boolean]>
const TARGET_KINDS = { person: 'Person', team: 'Team', role: 'Role', section: 'Section' } as const

export type DecisionResolutionMode = keyof typeof MODES
export type DecisionGroupKind = Exclude<TargetKind, 'person'>
export type DecisionTargetGroup = {
  kind: DecisionGroupKind
  id: string
  name: string
  memberIds: readonly string[]
}
export type DecisionTarget =
  | { kind: 'person'; personId: string }
  | { kind: DecisionGroupKind; groupId: string; memberIds: string[] }
export type DecisionComposerOption = { id: string; label: string }
export type DecisionComposerDraft = {
  target: DecisionTarget
  mode: DecisionResolutionMode
  title: string
  context: string
  options: DecisionComposerOption[]
  /** Null only for surveys, which decide nothing. */
  recommendedOptionId: string | null
  approverId: string | null
  quorum: number | null
}

type TargetKind = keyof typeof TARGET_KINDS

const SUMMARIES: Record<DecisionResolutionMode | 'person' | 'personSurvey', string> = {
  person: '{{name}} decides.',
  personSurvey: '{{name}} answers; nothing is decided automatically.',
  single_approver: '{{name}} decides for {{group}}.',
  first_responder: 'The first of {{count}} people to answer decides.',
  majority_quorum: 'Decided when {{quorum}} of {{count}} pick the same option.',
  unanimous: 'Decided only if all {{count}} pick the same option.',
  survey: 'All {{count}} people answer; nothing is decided automatically.'
}
const newOption = (): DecisionComposerOption => ({ id: crypto.randomUUID(), label: '' })
const t = (key: string, fallback: string, values?: Parameters<typeof translate>[2]): string =>
  translate(`teamDecisions.composer.${key}`, fallback, values)

function SearchPicker(props: {
  items: readonly { id: string; name: string; detail: string | null }[]
  value: string | null
  onChange: (id: string) => void
  placeholder: string
  icon: typeof User
}) {
  const [open, setOpen] = useState(false)
  const selected = props.items.find((item) => item.id === props.value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full">
          <props.icon className="size-3.5" />
          <span className="flex-1 truncate text-left">{selected?.name ?? props.placeholder}</span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={props.placeholder} />
          <CommandList>
            <CommandEmpty>{t('noMatches', 'No matches.')}</CommandEmpty>
            {props.items.map((item) => (
              <CommandItem
                key={item.id}
                value={`${item.name} ${item.id} ${item.detail ?? ''}`}
                onSelect={() => {
                  props.onChange(item.id)
                  setOpen(false)
                }}
              >
                <Check className={item.id === props.value ? 'size-3.5' : 'size-3.5 opacity-0'} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="truncate text-[11px] text-muted-foreground">{item.detail}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function DecisionTargetComposer(props: {
  people: readonly TeamRosterPerson[]
  groups: readonly DecisionTargetGroup[]
  onSubmit: (draft: DecisionComposerDraft) => void
  onCancel?: () => void
  submitting?: boolean
}) {
  const { people, groups, onSubmit, onCancel, submitting } = props
  const [targetKind, setTargetKind] = useState<TargetKind>('person')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [mode, setMode] = useState<DecisionResolutionMode>('single_approver')
  const [approverId, setApproverId] = useState<string | null>(null)
  const [quorumText, setQuorumText] = useState('')
  const [title, setTitle] = useState('')
  const [context, setContext] = useState('')
  const [options, setOptions] = useState<DecisionComposerOption[]>(() => [newOption(), newOption()])
  const [recommendedId, setRecommendedId] = useState<string | null>(null)
  const titleId = useId()
  // Only roster ids reach a person; a guessed address reaches nobody.
  const personItems = useMemo(
    () =>
      uniqueRosterPeople(people)
        .filter((person) => person.id.startsWith('emp_'))
        .map((p) => ({ id: p.id, name: p.name, detail: rosterPersonDetail(p) ?? p.id })),
    [people]
  )
  const names = useMemo(() => new Map(personItems.map((p) => [p.id, p.name])), [personItems])
  const isGroup = targetKind !== 'person'
  const group = groups.find((g) => g.kind === targetKind && g.id === targetId) ?? null
  const onRoster = (ids: readonly string[]): string[] => ids.filter((id) => names.has(id))
  const members = group ? onRoster(group.memberIds) : []
  const count = members.length
  const pickerItems = isGroup
    ? groups
        .filter((g) => g.kind === targetKind)
        .map((g) => ({
          id: g.id,
          name: g.name,
          detail: t('memberCount', '{{count}} people', { count: onRoster(g.memberIds).length })
        }))
    : personItems
  const approver = approverId && members.includes(approverId) ? approverId : null
  const needsApprover = isGroup && mode === 'single_approver'
  const needsQuorum = isGroup && mode === 'majority_quorum'
  const majority = Math.floor(count / 2) + 1
  const quorum = quorumText.trim() === '' ? majority : Number(quorumText)
  const quorumInvalid = !Number.isInteger(quorum) || quorum < 1 || quorum > count
  const filled = options.filter((option) => option.label.trim() !== '')
  const labels = new Set(filled.map((option) => option.label.trim().toLowerCase()))
  const recommended = filled.some((option) => option.id === recommendedId) ? recommendedId : null
  const name = names.get((isGroup ? approver : targetId) ?? '') ?? '…'
  const values = { name, group: group?.name ?? '…', count, quorum }
  const chooseTargetKind = (next: TargetKind): void => {
    setTargetKind(next)
    setTargetId(null)
    setMode((current) => (next === 'person' && MODES[current][1] ? 'single_approver' : current))
  }
  const editOption = (id: string, label: string): void =>
    setOptions((current) => current.map((o) => (o.id === id ? { ...o, label } : o)))
  const addOption = (): void => setOptions((current) => [...current, newOption()])

  const checks: [boolean, string, string][] = [
    [!targetId || (isGroup && !group), 'needTarget', 'Choose who answers.'],
    [isGroup && count === 0, 'emptyGroup', 'This group has no people on the roster.'],
    [needsApprover && !approver, 'needApprover', 'Choose the approver.'],
    [needsQuorum && quorumInvalid, 'badQuorum', 'Quorum must be between 1 and {{count}}.'],
    [title.trim() === '', 'needTitle', 'Add the question.'],
    [filled.length < 2, 'needOptions', 'Add at least two options.'],
    [labels.size !== filled.length, 'duplicateOptions', 'Each option must be different.'],
    [mode !== 'survey' && !recommended, 'needRecommended', 'Mark the recommended option.']
  ]
  const failed = checks.find(([fails]) => fails)
  const problem = failed ? t(failed[1], failed[2], values) : null
  const summaryKey = isGroup ? mode : mode === 'survey' ? 'personSurvey' : 'person'
  const summary = t(`summary.${summaryKey}`, SUMMARIES[summaryKey], values)

  const submit = (): void => {
    if (problem || !targetId) {
      return
    }
    onSubmit({
      target: group
        ? { kind: group.kind, groupId: group.id, memberIds: members }
        : { kind: 'person', personId: targetId },
      mode,
      title: title.trim(),
      context: context.trim(),
      options: filled.map((option) => ({ id: option.id, label: option.label.trim() })),
      recommendedOptionId: mode === 'survey' ? null : recommended,
      approverId: !isGroup ? targetId : needsApprover ? approver : null,
      quorum: needsQuorum ? quorum : null
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>{t('audienceLabel', 'Who answers')}</Label>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={targetKind}
          onValueChange={(next) => next && chooseTargetKind(next as TargetKind)}
        >
          {(Object.keys(TARGET_KINDS) as TargetKind[]).map((kind) => (
            <ToggleGroupItem key={kind} value={kind}>
              {t(`kind.${kind}`, TARGET_KINDS[kind])}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <SearchPicker
          items={pickerItems}
          value={targetId}
          onChange={setTargetId}
          icon={isGroup ? Users : User}
          placeholder={t(`find.${targetKind}`, `Find a ${targetKind}…`)}
        />
      </div>

      <div className="space-y-2">
        <Label>{t('mode', 'How it resolves')}</Label>
        <Select value={mode} onValueChange={(next) => setMode(next as DecisionResolutionMode)}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MODES) as DecisionResolutionMode[]).map((key) => (
              <SelectItem key={key} value={key} disabled={!isGroup && MODES[key][1]}>
                {t(`mode.${key}`, MODES[key][0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {needsApprover ? (
          <SearchPicker
            items={personItems.filter((item) => members.includes(item.id))}
            value={approver}
            onChange={setApproverId}
            icon={User}
            placeholder={t('findApprover', 'Choose the approver…')}
          />
        ) : null}
        {needsQuorum ? (
          <Input
            type="number"
            min={1}
            value={quorumText}
            placeholder={t('quorumDefault', 'Majority ({{count}})', { count: majority })}
            aria-label={t('quorum', 'Quorum')}
            aria-invalid={quorumText !== '' && quorumInvalid}
            onChange={(event) => setQuorumText(event.target.value)}
          />
        ) : null}
        <p className="text-[11px] text-muted-foreground">{summary}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={titleId}>{t('title', 'Question')}</Label>
        <Input id={titleId} value={title} onChange={(event) => setTitle(event.target.value)} />
        <Textarea
          value={context}
          placeholder={t('context', 'Context the reader needs to answer (optional)')}
          aria-label={t('contextLabel', 'Context')}
          onChange={(event) => setContext(event.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label>{t('options', 'Options')}</Label>
        {options.map((option) => (
          <div key={option.id} className="flex items-center gap-1.5">
            {mode === 'survey' ? null : (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-pressed={recommended === option.id}
                aria-label={t('markRecommended', 'Mark as recommended')}
                onClick={() => setRecommendedId(option.id)}
              >
                <Star className={recommended === option.id ? 'fill-current' : 'opacity-40'} />
              </Button>
            )}
            <Input
              value={option.label}
              aria-label={t('optionLabel', 'Option')}
              onChange={(event) => editOption(option.id, event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={options.length <= 2}
              aria-label={t('removeOption', 'Remove option')}
              onClick={() => setOptions((current) => current.filter((o) => o.id !== option.id))}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
        <Button type="button" variant="ghost" size="xs" onClick={addOption}>
          <Plus />
          {t('addOption', 'Add option')}
        </Button>
      </div>
      <div className="flex items-center justify-end gap-2">
        {problem ? <p className="mr-auto text-xs text-muted-foreground">{problem}</p> : null}
        {onCancel ? (
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            {t('cancel', 'Cancel')}
          </Button>
        ) : null}
        <Button type="button" size="sm" disabled={problem !== null || submitting} onClick={submit}>
          {mode === 'survey' ? t('sendSurvey', 'Send survey') : t('sendDecision', 'Send decision')}
        </Button>
      </div>
    </div>
  )
}
