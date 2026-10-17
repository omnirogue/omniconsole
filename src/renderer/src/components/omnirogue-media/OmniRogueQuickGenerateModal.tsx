import React, { useCallback, useEffect, useState } from 'react'
import { Coins, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import type { OmniRogueCreditsApi } from '../../../../preload/api/omnirogue-api'
import {
  QUICK_GENERATE_ASPECT_RATIOS,
  isQuickGenerateShortcut,
  sameQuickGenerateTerminal
} from './omnirogue-quick-generate-helpers'
import type {
  OmniRogueQuickGenerateService,
  QuickGenerateAspectSelection,
  QuickGenerateInsertion,
  QuickGenerateInsertFormat,
  QuickGenerateKind,
  QuickGenerateTerminal
} from './omnirogue-quick-generate-helpers'
import { useQuickGenerateController } from './omnirogue-quick-generate-controller'

export type OmniRogueQuickGenerateModalProps = {
  service: OmniRogueQuickGenerateService
  activeTerminal: QuickGenerateTerminal | null
  // Paste into this exact host/session without submitting; Markdown must use the terminal's paste path.
  onInsert: (insertion: QuickGenerateInsertion) => void | Promise<void>
  creditsApi?: OmniRogueCreditsApi
  open?: boolean
  onOpenChange?: (open: boolean) => void
  showTrigger?: boolean
  shortcutEnabled?: boolean
}
const t = (key: string, fallback: string): string =>
  translate(`omnirogueQuickGenerate.${key}`, fallback)
const count = (value: number): string =>
  new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)

export function OmniRogueQuickGenerateModal({
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
  shortcutEnabled = true,
  ...props
}: OmniRogueQuickGenerateModalProps): React.ReactElement {
  const [localOpen, setLocalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const open = controlledOpen ?? localOpen
  const effectiveBusy = open && busy
  const isMac = navigator.userAgent.includes('Mac')
  const changeOpen = useCallback(
    (next: boolean) => {
      if (effectiveBusy) {
        return
      }
      setLocalOpen(next)
      onOpenChange?.(next)
    },
    [effectiveBusy, onOpenChange]
  )
  useEffect(() => {
    if (!shortcutEnabled) {
      return
    }
    const listener = (event: KeyboardEvent): void => {
      if (!open && isQuickGenerateShortcut(event, isMac)) {
        event.preventDefault()
        changeOpen(true)
      }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [shortcutEnabled, isMac, open, changeOpen])
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {showTrigger ? (
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <Sparkles className="size-3.5" />
            {t('title', 'Quick Generate')}
            {shortcutEnabled ? (
              <ShortcutKeyCombo keys={isMac ? ['⌘', '⇧', 'G'] : ['Ctrl', 'Shift', 'G']} />
            ) : null}
          </Button>
        </DialogTrigger>
      ) : null}
      {open ? (
        <QuickGenerateContent {...props} onBusyChange={setBusy} onClose={() => changeOpen(false)} />
      ) : null}
    </Dialog>
  )
}

type ContentProps = Pick<
  OmniRogueQuickGenerateModalProps,
  'service' | 'activeTerminal' | 'onInsert' | 'creditsApi'
> & {
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}
function QuickGenerateContent({
  service,
  activeTerminal,
  onInsert,
  creditsApi,
  onBusyChange,
  onClose
}: ContentProps) {
  const {
    id,
    prompt,
    setPrompt,
    kind,
    setKind,
    ratio,
    setRatio,
    format,
    setFormat,
    setRevision,
    quoteError,
    error,
    setError,
    phase,
    result,
    balance,
    refresh,
    request,
    busy,
    currentQuote,
    guard,
    canGenerate,
    generate,
    insert
  } = useQuickGenerateController({
    service,
    activeTerminal,
    onInsert,
    creditsApi,
    onBusyChange
  })
  const costText = currentQuote
    ? translate('omnirogueQuickGenerate.creditsAmount', `${count(currentQuote.credits)} cr`, {
        credits: count(currentQuote.credits)
      })
    : '—'
  const generateLabel =
    phase === 'checking'
      ? t('checking', 'Checking credits…')
      : phase === 'generating'
        ? t('generating', 'Generating…')
        : t('generate', 'Generate')
  return (
    <DialogContent
      className="scrollbar-sleek max-h-[90vh] overflow-y-auto sm:max-w-lg"
      showCloseButton={!busy}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="size-4" />
          {t('title', 'Quick Generate')}
        </DialogTitle>
        <DialogDescription className="text-xs">
          {t('description', 'Create media with OmniRogue, then insert it into your terminal.')}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <fieldset disabled={busy || Boolean(result)} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={`${id}-prompt`}>{t('prompt', 'Prompt')}</Label>
            <Textarea
              id={`${id}-prompt`}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor={`${id}-kind`}>{t('media', 'Media type')}</Label>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as QuickGenerateKind)}
                disabled={busy || Boolean(result)}
              >
                <SelectTrigger id={`${id}-kind`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="image">{t('image', 'Image')}</SelectItem>
                  <SelectItem value="video">{t('video', 'Video')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-ratio`}>{t('ratio', 'Aspect ratio')}</Label>
              <Select
                value={ratio}
                onValueChange={(value) => setRatio(value as QuickGenerateAspectSelection)}
                disabled={busy || Boolean(result)}
              >
                <SelectTrigger id={`${id}-ratio`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {QUICK_GENERATE_ASPECT_RATIOS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                  <SelectItem value="multi-pack">
                    {t('multiPack', 'Multi-pack (all 4 ratios)')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </fieldset>
        <div
          className="space-y-1 rounded-md border bg-muted/40 p-2.5 text-xs"
          role="status"
          aria-live="polite"
        >
          <div className="flex items-center gap-1.5">
            <Coins className="size-3.5" />
            {t('cost', 'Batch cost')}: {costText}
          </div>
          <div>
            {t('available', 'Available credits')}: {balance ? count(balance.availableCredits) : '—'}
          </div>
          {request && !currentQuote && !quoteError ? (
            <p>{t('quoting', 'Loading credit cost…')}</p>
          ) : null}
          {guard.status === 'low' ? (
            <p className="text-status-warning">
              {t('lowBalance', 'Low credit balance after generation.')}
            </p>
          ) : null}
          {guard.status === 'insufficient' ? (
            <p className="text-destructive">
              {t('insufficient', 'Insufficient credits for this batch.')}
            </p>
          ) : null}
          {!balance ? (
            <p>{t('unknownBalance', 'Connect OmniRogue or refresh your credits to continue.')}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            setRevision((value) => value + 1)
            void refresh().catch(() =>
              setError(t('refreshFailed', 'Could not refresh credits. Try again.'))
            )
          }}
        >
          {t('refresh', 'Refresh credits')}
        </Button>
        {!activeTerminal ? (
          <p className="text-xs text-muted-foreground">
            {t('noTerminal', 'Select an active terminal to generate media.')}
          </p>
        ) : null}
        {result ? (
          <div className="space-y-2">
            <p className="text-xs">{t('ready', 'Assets ready to insert')}</p>
            <ul className="space-y-1 text-xs">
              {result.assets.map((asset) => (
                <li key={asset.aspectRatio} className="break-all font-mono">
                  {asset.aspectRatio}: {asset.path}
                </li>
              ))}
            </ul>
            <Label htmlFor={`${id}-format`}>{t('insertAs', 'Insert as')}</Label>
            <Select
              value={format}
              onValueChange={(value) => setFormat(value as QuickGenerateInsertFormat)}
              disabled={busy}
            >
              <SelectTrigger id={`${id}-format`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="path">{t('path', 'Shell-escaped path')}</SelectItem>
                <SelectItem value="markdown">{t('markdown', 'Markdown embed')}</SelectItem>
              </SelectContent>
            </Select>
            {!sameQuickGenerateTerminal(result.terminal, activeTerminal) ? (
              <p role="alert" className="text-xs text-destructive">
                {t('returnToTerminal', 'Return to the original terminal to insert these assets.')}
              </p>
            ) : null}
          </div>
        ) : null}
        {quoteError || error ? (
          <p role="alert" className="text-xs text-destructive">
            {error || quoteError}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          {t('close', 'Close')}
        </Button>
        {result ? (
          <Button
            type="button"
            disabled={busy || !sameQuickGenerateTerminal(result.terminal, activeTerminal)}
            onClick={() => void insert()}
          >
            {phase === 'inserting'
              ? t('inserting', 'Inserting…')
              : t('insert', 'Insert into terminal')}
          </Button>
        ) : (
          <Button
            type="button"
            className="w-40"
            disabled={!canGenerate}
            onClick={() => void generate()}
          >
            {busy ? <Loader2 className="size-4 motion-safe:animate-spin" /> : null}
            {generateLabel}
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  )
}
