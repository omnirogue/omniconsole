import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import {
  briefEditDraft,
  isBriefSectionFull,
  type BriefEditDraft
} from '../../../../../shared/assisted-brief-revisions'
import {
  BRIEF_LIST_SECTIONS,
  type BriefContent,
  type BriefListSection
} from '../../../../../shared/assisted-brief-types'
import { briefSectionFullLabel, briefSectionLabel } from './assisted-brief-labels'
import type { BriefCommitResult } from './use-assisted-brief'

/** "Add something": one new line, recorded as the person's requirement. */
export function AssistedBriefAddLine({
  content,
  disabled,
  onAdd,
  onClose
}: {
  content: BriefContent
  disabled: boolean
  onAdd: (section: BriefListSection, text: string) => BriefCommitResult
  onClose: () => void
}): React.JSX.Element {
  const [section, setSection] = useState<BriefListSection>('scope')
  const [text, setText] = useState('')
  const full = isBriefSectionFull(content, section)
  return (
    <form
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (onAdd(section, text) === 'saved') {
          onClose()
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={section} onValueChange={(value) => setSection(value as BriefListSection)}>
          <SelectTrigger
            className="h-7 w-44 text-xs"
            aria-label={translate('assistedBrief.addSection', 'Section')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BRIEF_LIST_SECTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {briefSectionLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={translate('assistedBrief.addPlaceholder', 'What should the brief also say?')}
          aria-label={translate('assistedBrief.addLabel', 'New line for the brief')}
          className="h-7 min-w-0 flex-1 text-sm"
        />
        <Button type="submit" size="sm" disabled={disabled || full || !text.trim()}>
          {translate('assistedBrief.add', 'Add')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {translate('assistedBrief.cancel', 'Cancel')}
        </Button>
      </div>
      {full ? (
        <p role="alert" className="text-xs text-destructive">
          {briefSectionFullLabel(section)}
        </p>
      ) : null}
    </form>
  )
}

/** "Edit brief": the whole brief as plain lines; changed or new lines become the person's own. */
export function AssistedBriefEditForm({
  content,
  disabled,
  onSave,
  onClose
}: {
  content: BriefContent
  disabled: boolean
  onSave: (draft: BriefEditDraft) => BriefCommitResult
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(() => briefEditDraft(content))
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        // Why: a failed save keeps the form and its edits open; the save error shows below.
        if (onSave(draft) !== 'failed') {
          onClose()
        }
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="assisted-brief-outcome">
          {translate('assistedBrief.outcome', 'Outcome')}
        </Label>
        <Input
          id="assisted-brief-outcome"
          value={draft.outcome}
          onChange={(event) => setDraft({ ...draft, outcome: event.target.value })}
          className="text-sm"
        />
      </div>
      {BRIEF_LIST_SECTIONS.map((section) => (
        <div key={section} className="space-y-1">
          <Label htmlFor={`assisted-brief-${section}`}>{briefSectionLabel(section)}</Label>
          <Textarea
            id={`assisted-brief-${section}`}
            rows={Math.max(2, draft.sections[section].split('\n').length)}
            value={draft.sections[section]}
            onChange={(event) =>
              setDraft({ ...draft, sections: { ...draft.sections, [section]: event.target.value } })
            }
            className="text-sm"
          />
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'assistedBrief.editHelp',
          'One line per item. Lines you change or add become your requirements.'
        )}
      </p>
      <div className="flex gap-1.5">
        <Button type="submit" size="sm" disabled={disabled || !draft.outcome.trim()}>
          {translate('assistedBrief.saveEdit', 'Save brief')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {translate('assistedBrief.cancel', 'Cancel')}
        </Button>
      </div>
    </form>
  )
}
