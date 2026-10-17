import React, { useRef, useState } from 'react'
import { Mic } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNativeChatDictationActions } from '@/components/native-chat/use-native-chat-dictation-actions'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import {
  describeBriefActor,
  type BriefActorChoice
} from '../../../../../shared/assisted-brief-actors'
import { parseBriefDraft } from '../../../../../shared/assisted-brief-draft-parse'
import { buildBriefDraftingPrompt } from '../../../../../shared/assisted-brief-drafting-prompt'
import { extractNamedModels } from '../../../../../shared/assisted-brief-named-models'
import {
  createBriefRecord,
  isBriefRequestTooLong
} from '../../../../../shared/assisted-brief-revisions'
import {
  ASSISTED_BRIEF_LIMITS,
  type AssistedBriefRecord
} from '../../../../../shared/assisted-brief-types'
import { AssistedBriefGenerationStatus } from './AssistedBriefGenerationStatus'
import { briefRunnerUnavailableReason } from './assisted-brief-runner-client'
import type { BriefWorkspace } from './assisted-brief-workspace'
import type { BriefGeneration } from './use-brief-generation'

const IGNORE_PRESSED = (): void => {}

function DictateButton({
  textareaRef,
  disabled
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  disabled: boolean
}): React.JSX.Element | null {
  const enabled = useAppStore((state) => state.settings?.voice?.enabled === true)
  const dictating = useAppStore((state) => state.dictationState !== 'idle')
  // Why: the existing dictation inserts into the focused field; this only focuses it and toggles.
  const { toggleDictation } = useNativeChatDictationActions({
    textareaRef,
    setDictationPressed: IGNORE_PRESSED
  })
  if (!enabled) {
    return null
  }
  const label = translate('assistedBrief.dictate', 'Dictate')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={dictating}
          disabled={disabled}
          onClick={toggleDictation}
        >
          <Mic />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/** Step one: the rough request in the person's words, and who drafts the brief. */
export function AssistedBriefCompose({
  workspace,
  initialRequest,
  choices,
  generation,
  saveError,
  onDrafted
}: {
  workspace: BriefWorkspace
  initialRequest: string
  choices: readonly BriefActorChoice[]
  generation: BriefGeneration
  saveError: string
  onDrafted: (record: AssistedBriefRecord) => boolean
}): React.JSX.Element {
  const [text, setText] = useState(initialRequest)
  const [choiceId, setChoiceId] = useState(choices[0]?.favoriteId ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const choice = choices.find((entry) => entry.favoriteId === choiceId) ?? choices[0]
  const unavailable = briefRunnerUnavailableReason(workspace)
  const busy = generation.running !== null
  const tooLong = isBriefRequestTooLong(text)
  const maxChars = ASSISTED_BRIEF_LIMITS.requestChars

  const draft = async (): Promise<void> => {
    if (!choice || !text.trim() || tooLong) {
      return
    }
    const namedModels = extractNamedModels(text)
    const prompt = buildBriefDraftingPrompt({
      request: text,
      attachments: [],
      namedModels,
      workspaceLabel: workspace.label,
      workspaceKind: workspace.kind
    })
    const output = await generation.run({ purpose: 'draft', actor: choice.actor }, prompt)
    if (output === null) {
      return
    }
    const parsed = parseBriefDraft(output, { request: text, namedModels, newId: createBrowserUuid })
    if (!parsed.ok) {
      generation.setError(
        translate(
          'assistedBrief.draftUnreadable',
          'The draft could not be read. Try again, or send the request directly.'
        )
      )
      return
    }
    onDrafted(
      createBriefRecord({
        briefId: createBrowserUuid(),
        workspaceKey: workspace.workspaceKey,
        original: { text, attachments: [] },
        drafter: choice.actor,
        content: parsed.content,
        now: Date.now()
      })
    )
  }

  return (
    <form
      className="space-y-3 px-4 pb-4"
      onSubmit={(event) => {
        event.preventDefault()
        void draft()
      }}
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="assisted-brief-request">
            {translate('assistedBrief.requestLabel', 'What outcome do you want?')}
          </Label>
          <DictateButton textareaRef={textareaRef} disabled={busy} />
        </div>
        <Textarea
          id="assisted-brief-request"
          ref={textareaRef}
          autoFocus
          rows={5}
          value={text}
          disabled={busy}
          aria-invalid={tooLong || undefined}
          onChange={(event) => setText(event.target.value)}
          placeholder={translate(
            'assistedBrief.requestPlaceholder',
            'Describe it roughly, in your own words.'
          )}
          className="text-sm"
        />
        <div className="flex items-start justify-between gap-2 text-[11px] text-muted-foreground">
          <span>
            {translate(
              'assistedBrief.noAttachments',
              'Attachments are not added to the brief yet. Name any files or paths in your request.'
            )}
          </span>
          {text.length >= maxChars * 0.8 ? (
            <span className="shrink-0 tabular-nums">
              {translate('assistedBrief.requestLength', '{{length}} of {{max}} characters', {
                length: text.length.toLocaleString(),
                max: maxChars.toLocaleString()
              })}
            </span>
          ) : null}
        </div>
        {tooLong ? (
          <p role="alert" className="text-xs text-destructive">
            {translate(
              'assistedBrief.requestTooLong',
              'Drafting takes requests up to {{max}} characters. Shorten it, or send it directly.',
              { max: maxChars.toLocaleString() }
            )}
          </p>
        ) : null}
      </div>
      {choices.length > 0 ? (
        <div className="space-y-1">
          <Label>{translate('assistedBrief.draftWith', 'Draft with')}</Label>
          <Select value={choice?.favoriteId ?? ''} onValueChange={setChoiceId} disabled={busy}>
            <SelectTrigger
              className="w-full text-xs"
              aria-label={translate('assistedBrief.draftWith', 'Draft with')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {choices.map((entry) => (
                <SelectItem key={entry.favoriteId} value={entry.favoriteId}>
                  {describeBriefActor(entry.actor)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {translate(
            'assistedBrief.noDrafter',
            'Drafting needs a Claude or Codex favourite. Sending directly still works.'
          )}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        {translate(
          'assistedBrief.composeHelp',
          'One model drafts a short brief. It may read this workspace, but it does not change files or start the work.'
        )}
      </p>
      {unavailable ? <p className="text-xs text-muted-foreground">{unavailable}</p> : null}
      <AssistedBriefGenerationStatus generation={generation} />
      {saveError ? (
        <p role="alert" className="text-xs text-destructive">
          {saveError}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={busy || tooLong || !text.trim() || !choice || Boolean(unavailable)}
      >
        {translate('assistedBrief.draftBrief', 'Draft brief')}
      </Button>
    </form>
  )
}
