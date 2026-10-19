import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Coins, Loader2, Swords, Trophy } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { OmniRogueCreditsApi } from '../../../../preload/api/omnirogue-api'
import { OMNIROGUE_GATEWAY_MODELS } from '../../../../shared/omnirogue-account'
import {
  isUsableQuickGenerateQuote, quickGenerateCreditGuard, useQuickGenerateBalance
} from '../omnirogue-media/omnirogue-quick-generate-helpers'
import {
  MODEL_ARENA_MAX_CONTENDERS, MODEL_ARENA_MIN_CONTENDERS, ModelArenaError, buildModelArenaRequest,
  fillModelArenaLabel, formatModelArenaCredits, formatModelArenaLatency,
  isCompleteModelArenaRound, modelArenaContenderName, modelArenaDisplayOrder, modelArenaErrorKey,
  modelArenaModelLabel, modelArenaRoundCredits, resolveModelArenaLabels, toggleModelArenaSelection
} from './omnirogue-model-arena-helpers'
import type {
  ModelArenaModel, ModelArenaQuote, ModelArenaRequest, ModelArenaRound, ModelArenaVerdict,
  OmniRogueModelArenaLabelKey, OmniRogueModelArenaLabels, OmniRogueModelArenaService
} from './omnirogue-model-arena-helpers'

export type OmniRogueModelArenaModalProps = {
  service: OmniRogueModelArenaService
  models?: readonly ModelArenaModel[]
  creditsApi?: OmniRogueCreditsApi
  labels?: Partial<OmniRogueModelArenaLabels>
  // Fires only after the adapter has persisted the vote.
  onVerdict?: (verdict: ModelArenaVerdict) => void
  open?: boolean
  onOpenChange?: (open: boolean) => void
  showTrigger?: boolean
}

export function OmniRogueModelArenaModal({
  open: controlledOpen, onOpenChange, showTrigger = true, labels, ...props
}: OmniRogueModelArenaModalProps): React.ReactElement {
  const [localOpen, setLocalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const text = useMemo(() => resolveModelArenaLabels(labels), [labels])
  const open = controlledOpen ?? localOpen
  // Busy is reported by the mounted content, so a closed dialog is never busy.
  const blocking = open && busy
  const changeOpen = useCallback((next: boolean) => {
    if (blocking) {
      return
    }
    setLocalOpen(next)
    onOpenChange?.(next)
  }, [blocking, onOpenChange])
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      {showTrigger ? (
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm"><Swords className="size-3.5" />{text.title}</Button>
        </DialogTrigger>
      ) : null}
      {open ? <ModelArenaContent {...props} text={text} onBusyChange={setBusy} onClose={() => changeOpen(false)} /> : null}
    </Dialog>
  )
}

type ContentProps = Pick<OmniRogueModelArenaModalProps, 'service' | 'models' | 'creditsApi' | 'onVerdict'> & {
  text: OmniRogueModelArenaLabels
  onBusyChange: (busy: boolean) => void
  onClose: () => void
}
type QuoteState = { request: ModelArenaRequest; service: OmniRogueModelArenaService; value: ModelArenaQuote }
type RoundState = { value: ModelArenaRound; blind: boolean }

function ModelArenaContent({
  service, models = OMNIROGUE_GATEWAY_MODELS, creditsApi, onVerdict, text, onBusyChange, onClose
}: ContentProps) {
  const id = useId()
  const [prompt, setPrompt] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [blind, setBlind] = useState(true)
  const [quote, setQuote] = useState<QuoteState | null>(null)
  const [revision, setRevision] = useState(0)
  const [quoteFailed, setQuoteFailed] = useState(false)
  const [error, setError] = useState<OmniRogueModelArenaLabelKey | null>(null)
  const [phase, setPhase] = useState<'idle' | 'checking' | 'running' | 'voting'>('idle')
  const [round, setRound] = useState<RoundState | null>(null)
  const [verdict, setVerdict] = useState<ModelArenaVerdict | null>(null)
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const liveService = useRef(service)
  useEffect(() => {
    liveService.current = service
  }, [service])
  const { balance, refresh } = useQuickGenerateBalance(creditsApi ?? window.api?.omnirogue?.credits)
  const request = useMemo(() => buildModelArenaRequest(prompt, selected, models), [prompt, selected, models])
  const busy = phase !== 'idle'
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current?.abort()
    }
  }, [])
  useEffect(() => {
    onBusyChange(busy)
  }, [busy, onBusyChange])
  useEffect(() => {
    const controller = new AbortController()
    setQuote(null)
    setQuoteFailed(false)
    if (request) {
      void Promise.resolve().then(() => service.quote(request, { signal: controller.signal })).then((value) => {
        if (controller.signal.aborted) {
          return
        }
        if (!isUsableQuickGenerateQuote(value)) {
          throw new ModelArenaError('invalidQuote')
        }
        setQuote({ request, service, value })
      }).catch(() => {
        if (!controller.signal.aborted) {
          setQuoteFailed(true)
        }
      })
    }
    return () => {
      controller.abort()
    }
  }, [request, service, revision])
  // Quotes are single-use and expire; re-quote when the current one lapses.
  useEffect(() => {
    if (!quote) {
      return undefined
    }
    const expiry = setTimeout(() => setRevision((count) => count + 1), Math.min(quote.value.expiresAt - Date.now(), 2_147_483_647))
    return () => clearTimeout(expiry)
  }, [quote])
  const currentQuote = quote?.request === request && quote.service === service ? quote.value : null
  const guard = quickGenerateCreditGuard(balance, currentQuote?.credits ?? null)
  const canRun = Boolean(request && currentQuote && guard.allowed && !busy && !round)

  function finish(controller: AbortController): void {
    if (mounted.current && !controller.signal.aborted) {
      operation.current = null
      setPhase('idle')
    }
  }
  async function run(): Promise<void> {
    if (!canRun || !request || !currentQuote || operation.current) {
      return
    }
    const controller = new AbortController()
    operation.current = controller
    setError(null)
    setPhase('checking')
    try {
      const freshBalance = await refresh()
      if (controller.signal.aborted) {
        return
      }
      if (service !== liveService.current) {
        throw new ModelArenaError('serviceChanged')
      }
      if (!isUsableQuickGenerateQuote(currentQuote)) {
        setRevision((count) => count + 1)
        throw new ModelArenaError('expired')
      }
      if (!quickGenerateCreditGuard(freshBalance, currentQuote.credits).allowed) {
        throw new ModelArenaError('balanceChanged')
      }
      setPhase('running')
      const next = await service.run(request, { quoteId: currentQuote.id, signal: controller.signal })
      if (controller.signal.aborted) {
        return
      }
      if (!isCompleteModelArenaRound(next, request)) {
        throw new ModelArenaError('incompleteRound')
      }
      setRound({ value: next, blind })
      setVerdict(null)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setError(modelArenaErrorKey(cause, 'runFailed'))
      }
    } finally {
      finish(controller)
      if (mounted.current && !controller.signal.aborted) {
        // Quotes are single-use; always fetch a fresh one for the next round.
        setRevision((count) => count + 1)
        void refresh().catch(() => {})
      }
    }
  }
  async function vote(winnerModelId: string | null): Promise<void> {
    if (!round || verdict || operation.current) {
      return
    }
    const controller = new AbortController()
    operation.current = controller
    const next: ModelArenaVerdict = { roundId: round.value.id, winnerModelId, blind: round.blind }
    setError(null)
    setPhase('voting')
    try {
      await service.vote(next, { signal: controller.signal })
      if (controller.signal.aborted) {
        return
      }
      setVerdict(next)
      onVerdict?.(next)
    } catch {
      if (mounted.current && !controller.signal.aborted) {
        setError('voteFailed')
      }
    } finally {
      finish(controller)
    }
  }
  function newRound(): void {
    setRound(null)
    setVerdict(null)
    setError(null)
  }

  const answers = round ? modelArenaDisplayOrder(round.value, round.blind) : []
  const revealed = Boolean(round && (!round.blind || verdict))
  const completed = answers.filter((answer) => answer.status === 'completed').length
  const credits = (value: number | undefined): string =>
    value === undefined ? text.unknownValue : formatModelArenaCredits(value, text)
  const alert = error ?? (quoteFailed ? 'quoteFailed' : null)
  return (
    <DialogContent className="scrollbar-sleek max-h-[90vh] overflow-y-auto sm:max-w-3xl" showCloseButton={!busy}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-sm"><Swords className="size-4" />{text.title}</DialogTitle>
        <DialogDescription className="text-xs">{text.description}</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <fieldset disabled={busy || Boolean(round)} className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor={`${id}-prompt`}>{text.prompt}</Label>
            <Textarea id={`${id}-prompt`} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </div>
          <div className="space-y-2" role="group" aria-labelledby={`${id}-models`}>
            <div className="flex items-baseline justify-between gap-2">
              <span id={`${id}-models`} className="text-sm font-medium">{text.models}</span>
              <span className="text-xs text-muted-foreground">
                {fillModelArenaLabel(text.selection, {
                  selected: selected.length, max: MODEL_ARENA_MAX_CONTENDERS, min: MODEL_ARENA_MIN_CONTENDERS
                })}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {models.map((model) => {
                const checked = selected.includes(model.id)
                return (
                  <div key={model.id} className="flex items-center gap-2">
                    <Checkbox
                      id={`${id}-model-${model.id}`}
                      checked={checked}
                      disabled={busy || Boolean(round) || (!checked && selected.length >= MODEL_ARENA_MAX_CONTENDERS)}
                      onCheckedChange={() => setSelected((current) => toggleModelArenaSelection(current, model.id))}
                    />
                    <Label htmlFor={`${id}-model-${model.id}`} className="text-xs font-normal">{model.label}</Label>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor={`${id}-blind`}>{text.blind}</Label>
              <p className="text-xs text-muted-foreground">{text.blindHint}</p>
            </div>
            <Switch id={`${id}-blind`} checked={blind} onCheckedChange={setBlind} disabled={busy || Boolean(round)} />
          </div>
        </fieldset>
        <div className="space-y-1 rounded-md border bg-muted/40 p-2.5 text-xs" role="status" aria-live="polite">
          <div className="flex items-center gap-1.5">
            <Coins className="size-3.5" />
            {fillModelArenaLabel(text.cost, { amount: credits(currentQuote?.credits) })}
          </div>
          <div>{fillModelArenaLabel(text.available, { amount: credits(balance?.availableCredits) })}</div>
          {request && !currentQuote && !quoteFailed && !round ? <p>{text.quoting}</p> : null}
          {guard.status === 'low' ? <p className="text-status-warning">{text.lowBalance}</p> : null}
          {guard.status === 'insufficient' ? <p className="text-destructive">{text.insufficient}</p> : null}
          {balance ? null : <p>{text.unknownBalance}</p>}
        </div>
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => {
          setRevision((count) => count + 1)
          void refresh().catch(() => setError('refreshFailed'))
        }}>{text.refresh}</Button>
        {round ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {fillModelArenaLabel(text.roundCharged, { amount: credits(modelArenaRoundCredits(round.value)) })}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {answers.map((answer, index) => {
                const contender = modelArenaContenderName(index, text)
                const name = revealed
                  ? fillModelArenaLabel(text.revealed, { contender, model: modelArenaModelLabel(answer.modelId, models) })
                  : contender
                return (
                  <div key={answer.modelId} role="group" aria-label={name} className="space-y-2 rounded-md border p-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{name}</span>
                      {verdict?.winnerModelId === answer.modelId ? <Badge><Trophy className="size-3" />{text.winner}</Badge> : null}
                    </div>
                    {answer.status === 'completed' ? (
                      <pre className="scrollbar-sleek max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-mono">{answer.output}</pre>
                    ) : (
                      <p className="text-destructive">{text.answerFailed}</p>
                    )}
                    <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-muted-foreground">
                      <dt>{text.latency}</dt><dd>{formatModelArenaLatency(answer.latencyMs, text)}</dd>
                      <dt>{text.charged}</dt><dd>{credits(answer.credits)}</dd>
                    </dl>
                    {!verdict && answer.status === 'completed' ? (
                      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void vote(answer.modelId)}>
                        {text.pick}
                      </Button>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {verdict?.winnerModelId === null ? <p className="text-xs" role="status">{text.tieResult}</p> : null}
          </div>
        ) : null}
        {alert ? <p role="alert" className="text-xs text-destructive">{text[alert]}</p> : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{text.close}</Button>
        {round && !verdict && completed >= MODEL_ARENA_MIN_CONTENDERS ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void vote(null)}>{text.tie}</Button>
        ) : null}
        {round ? (
          <Button type="button" disabled={busy} onClick={newRound}>{text.newRound}</Button>
        ) : (
          <Button type="button" className="w-40" disabled={!canRun} onClick={() => void run()}>
            {busy ? <Loader2 className="size-4 motion-safe:animate-spin" /> : null}
            {phase === 'checking' ? text.checking : phase === 'running' ? text.running : text.run}
          </Button>
        )}
        {phase === 'voting' ? <span className="text-xs text-muted-foreground" role="status">{text.voting}</span> : null}
      </DialogFooter>
    </DialogContent>
  )
}
