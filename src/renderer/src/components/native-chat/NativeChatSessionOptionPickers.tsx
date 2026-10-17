import { memo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { sortNativeChatSessionOptions } from '../../../../shared/native-chat-session-option-snapshot'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  nativeChatModelPillLabel,
  nativeChatOptionsPillLabel,
  nativeChatOptionsPillTitle,
  nativeChatSessionChoiceLabel,
  nativeChatSessionOptionDisabledReason,
  nativeChatSessionOptionLabel
} from './native-chat-session-option-labels'
import { NativeChatSessionOptionParityNotice } from './NativeChatSessionOptionParityNotice'
import {
  sessionOptionParityLines,
  sessionOptionParityPillLabel
} from './native-chat-session-option-parity-copy'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import {
  isCodexResumeRelaunchStatusInFlight,
  type CodexResumeRelaunchStatus
} from './codex-resume-relaunch-state'
import { codexResumeRelaunchLabel } from './codex-resume-relaunch-copy'
import { CODEX_SESSION_OPTION_CATALOG } from '../../../../shared/agent-session-option-catalog-claude-codex'

export type NativeChatSessionOptionPickersProps = {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  isWorking: boolean
  pickerRequest?: NativeChatOptionPickerRequest | null
  /** Progress of a restart-on-thread apply (Codex model/effort); null when idle. */
  applyStatus?: CodexResumeRelaunchStatus | null
}

/** Tooltip line describing where a restart-on-thread apply stands. */
function relaunchTooltipLine(status: CodexResumeRelaunchStatus | null | undefined): string | null {
  const models = CODEX_SESSION_OPTION_CATALOG.models
  if (status?.phase === 'restarting') {
    return translate(
      'components.native-chat.composer.relaunchRestarting',
      'Restarting Codex with {{value0}}…',
      { value0: codexResumeRelaunchLabel(status.requested, models) }
    )
  }
  if (status?.phase === 'verifying') {
    return translate(
      'components.native-chat.composer.relaunchVerifying',
      'Waiting for Codex to report its model…'
    )
  }
  if (status?.phase === 'mismatch') {
    return translate(
      'components.native-chat.composer.relaunchMismatch',
      'Codex came back with {{value0}}, not {{value1}}. Showing what Codex reported.',
      {
        value0: status.observed ? codexResumeRelaunchLabel(status.observed, models) : '',
        value1: codexResumeRelaunchLabel(status.requested, models)
      }
    )
  }
  // confirmed / unverified / failed already spoke through a toast; the pill stays quiet.
  return null
}

function PickerTooltipContent(props: {
  label: string
  disabledReason?: string | null
  dispatched: boolean
  relaunchLine?: string | null
  parityLines?: readonly string[]
}): React.JSX.Element {
  return (
    <div className="space-y-0.5">
      <div>{props.disabledReason ?? props.label}</div>
      {props.parityLines?.map((line) => (
        <div key={line}>{line}</div>
      ))}
      {props.dispatched ? (
        <div>
          {translate(
            'components.native-chat.composer.sentNotConfirmed',
            'Sent to the agent — not confirmed'
          )}
        </div>
      ) : null}
      {props.relaunchLine ? <div>{props.relaunchLine}</div> : null}
    </div>
  )
}

function PickerTrigger(props: {
  label: string
  tooltipLabel: string
  disabled: boolean
  disabledReason?: string | null
  dispatched: boolean
  relaunchLine?: string | null
  /** Non-empty while this pill's requested value is not the one the provider reported. */
  parityLines?: readonly string[]
}): React.JSX.Element {
  // Why: value-only visible text must still include the category in the
  // accessible name (WCAG 2.5.3 Label in Name / voice control).
  const mismatched = (props.parityLines?.length ?? 0) > 0
  const accessibleName =
    props.label === props.tooltipLabel
      ? props.tooltipLabel
      : translate('components.native-chat.composer.pillAccessibleName', '{{value0}} {{value1}}', {
          value0: props.tooltipLabel,
          value1: props.label
        })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuTrigger asChild disabled={props.disabled}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={accessibleName}
            data-session-option-parity={mismatched ? 'mismatch' : undefined}
            className={
              mismatched ? 'max-w-48 text-status-warning' : 'max-w-48 text-muted-foreground'
            }
          >
            <span className="truncate">{props.label}</span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <PickerTooltipContent
          label={props.tooltipLabel}
          disabledReason={props.disabledReason}
          dispatched={props.dispatched}
          relaunchLine={props.relaunchLine}
          parityLines={props.parityLines}
        />
      </TooltipContent>
    </Tooltip>
  )
}

function ChoiceBody(props: { label: string; description?: string }): React.JSX.Element {
  return (
    <div className="min-w-0 py-0.5">
      <div>{props.label}</div>
      {props.description ? (
        <div className="text-xs font-normal text-muted-foreground">{props.description}</div>
      ) : null}
    </div>
  )
}

function DescriptorMenuRows(props: {
  descriptor: SessionOptionDescriptor
  pending: boolean
  setValue: (value: SessionOptionValue) => void
  invokeAction: () => void
}): React.JSX.Element {
  const { descriptor, pending, setValue, invokeAction } = props
  // Why: flip-only without a baseline is an action — never claim On/Off.
  if (descriptor.action?.type === 'toggle-command') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={() => invokeAction()}>
        {translate('components.native-chat.composer.toggleOption', 'Toggle {{value0}}', {
          value0: nativeChatSessionOptionLabel(descriptor).toLowerCase()
        })}
      </DropdownMenuItem>
    )
  }
  // Why: agent-picker opens the TUI; it is not a set of radio choices. Agents with
  // no live setter at all (Codex model/effort) instead carry applyKind
  // 'resume-relaunch': ordinary radios whose apply restarts the CLI on the same
  // thread, so the menu says so in a footnote.
  if (descriptor.action?.type === 'agent-picker') {
    return (
      <DropdownMenuItem disabled={!descriptor.settable || pending} onSelect={() => invokeAction()}>
        {translate(
          'components.native-chat.composer.chooseInAgentPicker',
          'Choose in agent picker…'
        )}
        <span className="ml-2 text-[10px] text-muted-foreground">
          {translate(
            'components.native-chat.composer.chooseInAgentPickerHint',
            'opens the agent’s own picker in Terminal'
          )}
        </span>
      </DropdownMenuItem>
    )
  }
  // Why: absolute On/Off only when we have tracked truth. Unknown composed
  // booleans leave the group unselected so empty radios are not a selection.
  if (descriptor.kind.type === 'boolean') {
    const selected =
      descriptor.kind.currentValue === true
        ? 'on'
        : descriptor.kind.currentValue === false
          ? 'off'
          : undefined
    return (
      <>
        {selected === undefined ? (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {translate(
              'components.native-chat.composer.valueUnknown',
              'Current value unknown — pick On or Off'
            )}
          </DropdownMenuLabel>
        ) : null}
        <DropdownMenuRadioGroup value={selected} onValueChange={(next) => setValue(next === 'on')}>
          <DropdownMenuRadioItem value="on" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.on', 'On')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="off" disabled={!descriptor.settable || pending}>
            {translate('components.native-chat.composer.optionValue.off', 'Off')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </>
    )
  }
  return (
    <>
      <DropdownMenuRadioGroup
        value={descriptor.kind.currentValue}
        onValueChange={(value) => setValue(value)}
      >
        {descriptor.kind.choices.map((choice) => (
          <DropdownMenuRadioItem
            key={choice.value}
            value={choice.value}
            disabled={!descriptor.settable || pending}
          >
            <ChoiceBody
              label={nativeChatSessionChoiceLabel(choice)}
              description={choice.description}
            />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      {descriptor.applyKind === 'resume-relaunch' ? (
        <DropdownMenuLabel className="font-normal text-xs text-muted-foreground">
          {translate(
            'components.native-chat.composer.relaunchHint',
            'Changing this restarts Codex and resumes the conversation.'
          )}
        </DropdownMenuLabel>
      ) : null}
    </>
  )
}

/** The first row whose requested value is not the one the provider reported, if any. */
function divergingDescriptor(
  descriptors: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.parity)
}

function runSurfaceCall(
  pendingKey: string,
  setPendingId: (id: string | null) => void,
  call: () => Promise<unknown>
): void {
  setPendingId(pendingKey)
  void call()
    .catch((error) => {
      toast.error(
        translate('components.native-chat.composer.optionUpdateFailed', 'Could not update option'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    })
    .finally(() => setPendingId(null))
}

function NativeChatSessionOptionPickersInner({
  surface,
  snapshot,
  isWorking,
  pickerRequest,
  applyStatus
}: NativeChatSessionOptionPickersProps): React.JSX.Element | null {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const relaunchInFlight = isCodexResumeRelaunchStatusInFlight(applyStatus)
  const relaunchLine = relaunchTooltipLine(applyStatus)
  const model = snapshot.find((descriptor) => descriptor.category === 'model')
  const options = sortNativeChatSessionOptions(snapshot)
  if (!surface || !model) {
    return null
  }
  const requestedModelSequence = pickerRequest?.id === model.id ? pickerRequest.sequence : null
  const requestedOptionsSequence = options.some((descriptor) => descriptor.id === pickerRequest?.id)
    ? (pickerRequest?.sequence ?? null)
    : null

  const setOption = (descriptor: SessionOptionDescriptor, value: SessionOptionValue): void => {
    runSurfaceCall(descriptor.id, setPendingId, () => surface.setOption(descriptor.id, value))
  }
  const invokeAction = (descriptor: SessionOptionDescriptor): void => {
    runSurfaceCall(descriptor.id, setPendingId, () => surface.invokeAction(descriptor.id))
  }
  const acceptApplied = surface.acceptApplied
  const keepApplied = (descriptor: SessionOptionDescriptor): void => {
    runSurfaceCall(
      descriptor.id,
      setPendingId,
      () => surface.acceptApplied?.(descriptor.id) ?? Promise.resolve()
    )
  }
  const optionsParity = divergingDescriptor(options)
  const modelParityLines = model.parity ? sessionOptionParityLines(model) : undefined

  const modelReason = nativeChatSessionOptionDisabledReason(model.disabledReason)
  const modelTooltip = translate('components.native-chat.composer.model', 'Model')
  const optionsTooltip = nativeChatOptionsPillTitle(options)
  const optionsReason =
    options.length > 0 && options.every((descriptor) => !descriptor.settable)
      ? nativeChatSessionOptionDisabledReason(options[0]?.disabledReason)
      : null

  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-0.5">
      {options.length > 0 ? (
        <DropdownMenu
          key={`options:${requestedOptionsSequence ?? 'idle'}`}
          defaultOpen={requestedOptionsSequence !== null}
        >
          <PickerTrigger
            label={
              (optionsParity ? sessionOptionParityPillLabel(optionsParity) : null) ??
              nativeChatOptionsPillLabel(options)
            }
            tooltipLabel={optionsTooltip}
            disabled={isWorking || pendingId !== null || relaunchInFlight}
            disabledReason={optionsReason}
            dispatched={options.some((descriptor) => descriptor.valueSource === 'dispatched')}
            relaunchLine={relaunchLine}
            parityLines={optionsParity ? sessionOptionParityLines(optionsParity) : undefined}
          />
          <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-60">
            {options.map((descriptor, index) => {
              const reason = nativeChatSessionOptionDisabledReason(descriptor.disabledReason)
              return (
                <div key={descriptor.id}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuLabel>{nativeChatSessionOptionLabel(descriptor)}</DropdownMenuLabel>
                  {reason && !descriptor.settable ? (
                    <DropdownMenuLabel className="font-normal">{reason}</DropdownMenuLabel>
                  ) : null}
                  <NativeChatSessionOptionParityNotice
                    descriptor={descriptor}
                    disabled={pendingId !== null}
                    {...(acceptApplied ? { onAcceptApplied: () => keepApplied(descriptor) } : {})}
                  />
                  <DescriptorMenuRows
                    descriptor={descriptor}
                    pending={pendingId !== null}
                    setValue={(value) => setOption(descriptor, value)}
                    invokeAction={() => invokeAction(descriptor)}
                  />
                </div>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <DropdownMenu
        key={`model:${requestedModelSequence ?? 'idle'}`}
        defaultOpen={requestedModelSequence !== null}
      >
        <PickerTrigger
          label={sessionOptionParityPillLabel(model) ?? nativeChatModelPillLabel(model)}
          tooltipLabel={modelTooltip}
          disabled={isWorking || pendingId !== null || relaunchInFlight}
          disabledReason={modelReason}
          dispatched={model.valueSource === 'dispatched'}
          relaunchLine={relaunchLine}
          parityLines={modelParityLines}
        />
        <DropdownMenuContent align="start" side="top" collisionPadding={8} className="w-64">
          {modelReason && !model.settable ? (
            <DropdownMenuLabel className="font-normal">{modelReason}</DropdownMenuLabel>
          ) : null}
          <NativeChatSessionOptionParityNotice
            descriptor={model}
            disabled={pendingId !== null}
            {...(acceptApplied ? { onAcceptApplied: () => keepApplied(model) } : {})}
          />
          <DescriptorMenuRows
            descriptor={model}
            pending={pendingId !== null}
            setValue={(value) => setOption(model, value)}
            invokeAction={() => invokeAction(model)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export const NativeChatSessionOptionPickers = memo(NativeChatSessionOptionPickersInner)
