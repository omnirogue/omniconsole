import { useState } from 'react'
import { toast } from 'sonner'
import { ReviewRubricSelect } from '@/components/build-review/ReviewRubricPicker'
import { RubricLibraryActions } from '@/components/build-review/RubricLibraryActions'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { saveJevLibraryRubric } from '../../../../shared/jev-rubrics'
import {
  normalizeSavedReviewRubrics,
  REVIEW_RUBRIC_MAX_CHARS,
  REVIEW_RUBRIC_NAME_MAX_CHARS,
  type ReviewRubric
} from '../../../../shared/review-rubrics'
import { rubricLibrary, type RubricLibraryEntry } from '../../../../shared/rubric-library'
import { SettingsSubsectionHeader } from './SettingsFormControls'

export function RubricsPane(): React.JSX.Element {
  const saved = normalizeSavedReviewRubrics(useAppStore((state) => state.settings?.reviewRubrics))
  const updateSettings = useAppStore((state) => state.updateSettingsOrThrow)
  const entries = rubricLibrary(saved)
  const initial = entries.find((entry) => !entry.builtIn) ?? entries[0]!
  const [draft, setDraft] = useState<ReviewRubric>(initial.rubric)
  const [name, setName] = useState(initial.builtIn ? '' : initial.rubric.name)
  const [replace, setReplace] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const selected = entries.find((entry) => entry.rubric.name === draft.name)
  const existing = saved.find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase())
  const select = (entry: RubricLibraryEntry) => {
    setDraft(entry.rubric)
    setName(entry.builtIn ? '' : entry.rubric.name)
    setReplace(false)
    setError(null)
  }
  const save = async () => {
    setError(null)
    setSaving(true)
    try {
      const entry = {
        name: name.trim(),
        instructions: draft.instructions.trim(),
        ...(selected ? { kind: selected.kind } : {})
      }
      const reviewRubrics = saveJevLibraryRubric(saved, entry, replace)
      await updateSettings({ reviewRubrics })
      setDraft({ id: 'custom', name: entry.name, instructions: entry.instructions })
      setReplace(false)
      toast.success(translate('rubrics.settings.saved', 'Rubric saved.'))
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
    <div className="space-y-6">
      <SettingsSubsectionHeader
        title={translate('rubrics.settings.library', 'Rubric library')}
        description={translate(
          'rubrics.settings.libraryHint',
          'Rubrics saved by you or agents share this library with JEV and workflows. Select one to read or edit its instructions.'
        )}
        action={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setDraft({ id: 'custom', name: '', instructions: '' })
              setName('')
              setReplace(false)
              setError(null)
            }}
          >
            {translate('rubrics.settings.new', 'New rubric')}
          </Button>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {[
          { builtIn: false, title: translate('rubrics.settings.savedTitle', 'Saved rubrics') },
          { builtIn: true, title: translate('rubrics.settings.builtInTitle', 'Built-in rubrics') }
        ].map((group) => (
          <div key={String(group.builtIn)} className="space-y-2">
            <h3 className="text-sm font-semibold">{group.title}</h3>
            <div className="max-h-48 overflow-y-auto scrollbar-sleek rounded-md border border-border p-1">
              {entries
                .filter((entry) => entry.builtIn === group.builtIn)
                .map((entry) => (
                  <Button
                    key={entry.value}
                    type="button"
                    variant={selected?.value === entry.value ? 'secondary' : 'ghost'}
                    size="sm"
                    className="w-full justify-start truncate"
                    aria-pressed={selected?.value === entry.value}
                    onClick={() => select(entry)}
                  >
                    {entry.rubric.name}
                  </Button>
                ))}
              {!group.builtIn && !saved.length ? (
                <p className="p-2 text-xs text-muted-foreground">
                  {translate(
                    'rubrics.settings.empty',
                    'No saved rubrics yet. Create one here or ask an agent to save one.'
                  )}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-3">
        <ReviewRubricSelect
          id="settings-rubric"
          rubric={draft}
          label={translate('buildReview.rubric.label', 'Rubric')}
          onChange={(rubric) => {
            const entry = entries.find((item) => item.rubric.name === rubric?.name)
            if (entry) {
              select(entry)
            }
          }}
        />
        {selected?.builtIn ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'rubrics.settings.builtInHint',
              'Built-in rubrics stay in the library. Save your changes under a new name.'
            )}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="settings-rubric-name">
            {translate('rubrics.settings.name', 'Rubric name')}
          </Label>
          <Input
            id="settings-rubric-name"
            value={name}
            maxLength={REVIEW_RUBRIC_NAME_MAX_CHARS}
            onChange={(event) => {
              setName(event.target.value)
              setReplace(false)
              setError(null)
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="settings-rubric-instructions">
            {translate('rubrics.settings.instructions', 'What to judge and how to judge it')}
          </Label>
          <Textarea
            id="settings-rubric-instructions"
            value={draft.instructions}
            maxLength={REVIEW_RUBRIC_MAX_CHARS}
            rows={8}
            onChange={(event) => {
              setDraft({ ...draft, id: 'custom', instructions: event.target.value })
              setError(null)
            }}
          />
        </div>
        {existing ? (
          <div className="flex items-center gap-2">
            <Checkbox
              id="settings-rubric-replace"
              checked={replace}
              onCheckedChange={(value) => setReplace(value === true)}
            />
            <Label htmlFor="settings-rubric-replace">
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
        <Button
          type="button"
          size="sm"
          disabled={
            saving || !name.trim() || !draft.instructions.trim() || (!!existing && !replace)
          }
          onClick={() => void save()}
        >
          {saving
            ? translate('rubrics.settings.saving', 'Saving…')
            : translate('buildReview.rubric.save', 'Save rubric')}
        </Button>
        <RubricLibraryActions
          saved={saved}
          {...(selected && !selected.builtIn ? { selectedName: selected.rubric.name } : {})}
        />
      </div>
    </div>
  )
}
