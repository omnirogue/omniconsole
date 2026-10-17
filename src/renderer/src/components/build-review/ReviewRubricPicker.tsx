import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { saveJevLibraryRubric } from '../../../../shared/jev-rubrics'
import {
  normalizeSavedReviewRubrics,
  REVIEW_RUBRIC_MAX_CHARS,
  REVIEW_RUBRIC_NAME_MAX_CHARS,
  REVIEW_RUBRIC_PRESETS,
  type ReviewRubric,
  type SavedReviewRubric
} from '../../../../shared/review-rubrics'
import { RUBRIC_KINDS, type RubricKind } from '../../../../shared/rubric-kinds'
import { rubricLibrary } from '../../../../shared/rubric-library'
import { RubricLibraryActions } from './RubricLibraryActions'

/** The whole library: review presets, the starters, then what the person saved. */
export function reviewRubricOptions(saved: readonly SavedReviewRubric[]) {
  return rubricLibrary(saved)
}

function kindLabel(kind: RubricKind): string {
  switch (kind) {
    case 'review':
      return translate('rubrics.kind.review', 'Reviews')
    case 'ads':
      return translate('rubrics.kind.ads', 'Ads')
    case 'page':
      return translate('rubrics.kind.page', 'Pages')
    case 'reply':
      return translate('rubrics.kind.reply', 'Customer replies')
    case 'repo':
      return translate('rubrics.kind.repo', 'Repositories')
    case 'code':
      return translate('rubrics.kind.code', 'Code')
    case 'idea':
      return translate('rubrics.kind.idea', 'Ideas')
    case 'name':
      return translate('rubrics.kind.name', 'Names')
    case 'research':
      return translate('rubrics.kind.research', 'Research')
    case 'plan':
      return translate('rubrics.kind.plan', 'Plans')
    case 'post':
      return translate('rubrics.kind.post', 'Social posts')
    case 'prompt':
      return translate('rubrics.kind.prompt', 'Prompts')
    case 'other':
      return translate('rubrics.kind.other', 'Other')
  }
}

/** Picker groups: the person's own rubrics first, then the built-ins by what they judge. */
function optionGroups(saved: readonly SavedReviewRubric[]) {
  const options = reviewRubricOptions(saved)
  const own = options.filter((option) => !option.builtIn)
  return [
    ...(own.length
      ? [{ key: 'yours', label: translate('rubrics.yours', 'Yours'), options: own }]
      : []),
    ...RUBRIC_KINDS.map((kind) => ({
      key: kind,
      label: kindLabel(kind),
      options: options.filter((option) => option.builtIn && option.kind === kind)
    })).filter((group) => group.options.length)
  ]
}

function optionValue(rubric: ReviewRubric | undefined, saved: readonly SavedReviewRubric[]) {
  if (!rubric) {
    return ''
  }
  const match = reviewRubricOptions(saved).find(
    (option) =>
      option.rubric.name === rubric.name && option.rubric.instructions === rubric.instructions
  )
  return match?.value ?? 'edited'
}

export function useSavedReviewRubrics(): SavedReviewRubric[] {
  return normalizeSavedReviewRubrics(useAppStore((s) => s.settings?.reviewRubrics))
}

/** A rubric select over presets and saved rubrics; `edited` shows a rubric changed in place. */
export function ReviewRubricSelect({
  id,
  rubric,
  onChange,
  label,
  emptyLabel
}: {
  id: string
  rubric: ReviewRubric | undefined
  onChange: (rubric: ReviewRubric | undefined) => void
  label: string
  /** Offers "no rubric" under this label; without it a rubric is always chosen. */
  emptyLabel?: string
}) {
  const saved = useSavedReviewRubrics()
  const options = reviewRubricOptions(saved)
  const value = rubric ? optionValue(rubric, saved) : emptyLabel ? 'none' : ''
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next === 'none' && emptyLabel) {
          onChange(undefined)
          return
        }
        const option = options.find((entry) => entry.value === next)
        if (option) {
          onChange(option.rubric)
        }
      }}
    >
      <SelectTrigger id={id} aria-label={label} className="w-full">
        <SelectValue placeholder={translate('buildReview.rubric.choose', 'Choose a rubric')} />
      </SelectTrigger>
      <SelectContent>
        {emptyLabel && <SelectItem value="none">{emptyLabel}</SelectItem>}
        {optionGroups(saved).map((group) => (
          <SelectGroup key={group.key}>
            <SelectLabel className="text-[11px] text-muted-foreground">{group.label}</SelectLabel>
            {group.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.rubric.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
        {value === 'edited' && rubric && (
          <SelectItem value="edited">
            {translate('buildReview.rubric.edited', '{{name}} (edited)', { name: rubric.name })}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  )
}

/** One reviewer's rubric: pick one, or edit its instructions and save them to settings. */
export function ReviewRubricPicker({
  id,
  rubric,
  onChange,
  emptyLabel
}: {
  id: string
  rubric: ReviewRubric | undefined
  onChange: (rubric: ReviewRubric | undefined) => void
  /** Offers "no rubric"; editing then starts from the General preset. */
  emptyLabel?: string
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [replace, setReplace] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saved = useSavedReviewRubrics()
  const updateSettings = useAppStore((s) => s.updateSettingsOrThrow)
  const current = rubric ?? REVIEW_RUBRIC_PRESETS[0]!
  const trimmedName = name.trim()
  const existing = saved.find((entry) => entry.name.toLowerCase() === trimmedName.toLowerCase())
  const canSave =
    !saving &&
    trimmedName.length > 0 &&
    trimmedName.length <= REVIEW_RUBRIC_NAME_MAX_CHARS &&
    current.instructions.trim().length > 0 &&
    (!existing || replace)
  const save = async () => {
    // A rubric saved from a starter keeps what it judges, so it groups with it.
    const from = reviewRubricOptions(saved).find((option) => option.rubric.name === current.name)
    const entry = {
      name: trimmedName,
      instructions: current.instructions.trim(),
      ...(from && from.kind !== 'other' ? { kind: from.kind } : {})
    }
    setError(null)
    setSaving(true)
    try {
      // Same policy as Settings and agents: no built-in names, explicit replacement, the limits.
      await updateSettings({ reviewRubrics: saveJevLibraryRubric(saved, entry, replace) })
      onChange({ id: 'custom', name: entry.name, instructions: entry.instructions })
      setName('')
      setReplace(false)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate('rubrics.settings.saveFailed', 'Could not save the rubric.')
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <ReviewRubricSelect
            id={id}
            rubric={emptyLabel ? rubric : current}
            onChange={onChange}
            label={translate('buildReview.rubric.label', 'Rubric')}
            {...(emptyLabel ? { emptyLabel } : {})}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={editing}
          aria-controls={`${id}-instructions`}
          onClick={() => setEditing((open) => !open)}
        >
          {editing
            ? translate('buildReview.rubric.done', 'Done')
            : translate('buildReview.rubric.edit', 'Edit')}
        </Button>
      </div>
      {editing && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-instructions`} className="text-xs text-muted-foreground">
            {translate(
              'buildReview.rubric.instructions',
              'What this reviewer judges, and what counts as a blocker'
            )}
          </Label>
          <Textarea
            id={`${id}-instructions`}
            value={current.instructions}
            maxLength={REVIEW_RUBRIC_MAX_CHARS}
            rows={6}
            onChange={(event) => {
              setError(null)
              onChange({ ...current, id: 'custom', instructions: event.target.value })
            }}
          />
          <div className="flex items-center gap-2">
            <Input
              aria-label={translate('buildReview.rubric.saveName', 'Name to save it under')}
              placeholder={translate('buildReview.rubric.saveName', 'Name to save it under')}
              value={name}
              maxLength={REVIEW_RUBRIC_NAME_MAX_CHARS}
              onChange={(event) => {
                setName(event.target.value)
                setReplace(false)
                setError(null)
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canSave}
              onClick={() => void save()}
            >
              {translate('buildReview.rubric.save', 'Save rubric')}
            </Button>
          </div>
          {existing ? (
            <div className="flex items-center gap-2">
              <Checkbox
                id={`${id}-replace`}
                checked={replace}
                onCheckedChange={(value) => setReplace(value === true)}
              />
              <Label htmlFor={`${id}-replace`} className="text-xs">
                {translate('rubrics.settings.replace', 'Replace the saved rubric “{{name}}”', {
                  name: existing.name
                })}
              </Label>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <RubricLibraryActions
            saved={saved}
            {...(saved.some((entry) => entry.name === current.name)
              ? { selectedName: current.name }
              : {})}
          />
        </div>
      )}
    </div>
  )
}
