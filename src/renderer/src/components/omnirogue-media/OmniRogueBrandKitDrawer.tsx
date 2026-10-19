import React, { useEffect, useId, useRef, useState } from 'react'
import { Loader2, Palette } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  BRAND_KIT_FIELDS, BRAND_KIT_FIELD_LIMITS, DEFAULT_BRAND_KIT_LABELS,
  brandKitToForm, filterBrandKits, hasBrandKitChanges, normalizeBrandKitColor,
  safeBrandKitLogoUrl, validateBrandKitForm
} from './omnirogue-brand-kit-helpers'
import type {
  BrandKitErrors, BrandKitField, BrandKitForm, OmniRogueBrandKit,
  OmniRogueBrandKitLabels, OmniRogueBrandKitService
} from './omnirogue-brand-kit-helpers'

export type OmniRogueBrandKitDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Change this key when the adapter's account or workspace changes.
  contextKey: string
  service: OmniRogueBrandKitService
  onApply: (kit: OmniRogueBrandKit, options: { signal: AbortSignal }) => void | Promise<void>
  // Initial selection on opening; unsaved edits remain local to this drawer.
  selectedKitId?: string
  labels?: Partial<OmniRogueBrandKitLabels>
}

export function OmniRogueBrandKitDrawer(props: OmniRogueBrandKitDrawerProps): React.ReactElement {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <BrandKitContent key={props.contextKey} {...props} /> : null}
    </Sheet>
  )
}

function BrandKitContent({ service, onApply, onOpenChange, selectedKitId, labels: overrides }: OmniRogueBrandKitDrawerProps) {
  const labels = { ...DEFAULT_BRAND_KIT_LABELS, ...overrides }
  const id = useId()
  const [data, setData] = useState<{ service: OmniRogueBrandKitService; kits: readonly OmniRogueBrandKit[] } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<OmniRogueBrandKit | null>(null)
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<BrandKitForm>(() => brandKitToForm())
  const [errors, setErrors] = useState<BrandKitErrors>({})
  const [error, setError] = useState<'saveFailed' | 'applyFailed' | null>(null)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'applying'>('idle')
  const operation = useRef<AbortController | null>(null)
  const initialSelection = useRef(selectedKitId)
  const liveService = useRef(service)
  useEffect(() => {
    liveService.current = service
  }, [service])
  const ready = data?.service === service
  const kits = ready ? data.kits : []
  const busy = phase !== 'idle'
  const dirty = editing && hasBrandKitChanges(form, selected ?? undefined)
  const visibleKits = filterBrandKits(kits, query)

  useEffect(() => {
    const controller = new AbortController()
    setData(null)
    setLoadError(false)
    setEditing(false)
    setSelected(null)
    setQuery('')
    setErrors({})
    setError(null)
    setPhase('idle')
    void Promise.resolve().then(() => service.list({ signal: controller.signal })).then((next) => {
      if (controller.signal.aborted) { return }
      setData({ service, kits: next })
      const choice = next.find((kit) => kit.id === initialSelection.current) ?? null
      setSelected(choice)
      setForm(brandKitToForm(choice ?? undefined))
      setEditing(Boolean(choice))
    }).catch(() => {
      if (!controller.signal.aborted) { setLoadError(true) }
    })
    return () => {
      controller.abort()
      operation.current?.abort()
      operation.current = null
    }
  }, [service, reload])

  function choose(kit: OmniRogueBrandKit | null): void {
    if (busy || dirty || !ready) { return }
    setSelected(kit)
    setForm(brandKitToForm(kit ?? undefined))
    setEditing(true)
    setErrors({})
    setError(null)
  }

  function update(field: BrandKitField, value: string): void {
    setForm((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined }))
    setError(null)
  }

  async function save(): Promise<void> {
    if (operation.current || !ready || !editing || (!dirty && selected)) { return }
    const result = validateBrandKitForm(form)
    setErrors(result.errors)
    if (!result.draft) { return }
    const controller = new AbortController()
    operation.current = controller
    setPhase('saving')
    setError(null)
    try {
      const kit = await service.save(result.draft, { id: selected?.id, signal: controller.signal })
      if (controller.signal.aborted || liveService.current !== service) { return }
      if (!kit.id.trim() || (selected && kit.id !== selected.id) || !validateBrandKitForm(brandKitToForm(kit)).draft) {
        throw new Error(labels.saveFailed)
      }
      setData((current) => current?.service === service ? {
        service, kits: [...current.kits.filter((item) => item.id !== kit.id), kit]
      } : current)
      setSelected(kit)
      setForm(brandKitToForm(kit))
    } catch {
      if (!controller.signal.aborted && liveService.current === service) { setError('saveFailed') }
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setPhase('idle')
      }
    }
  }

  async function apply(): Promise<void> {
    if (operation.current || !ready || !selected || dirty) { return }
    const result = validateBrandKitForm(form)
    setErrors(result.errors)
    if (!result.draft) { return }
    const controller = new AbortController()
    operation.current = controller
    setPhase('applying')
    setError(null)
    try {
      await onApply({ ...result.draft, id: selected.id }, { signal: controller.signal })
      if (!controller.signal.aborted && liveService.current === service) { onOpenChange(false) }
    } catch {
      if (!controller.signal.aborted && liveService.current === service) { setError('applyFailed') }
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setPhase('idle')
      }
    }
  }

  return (
    <SheetContent
      side="right" showCloseButton={false} className="w-full sm:max-w-lg"
      onEscapeKeyDown={(event) => { if (busy || dirty) { event.preventDefault() } }}
      onInteractOutside={(event) => { if (busy || dirty) { event.preventDefault() } }}
    >
      <SheetHeader className="border-b">
        <SheetTitle className="flex items-center gap-2 text-sm">
          <Palette className="size-4" aria-hidden="true" />{labels.title}
        </SheetTitle>
        <SheetDescription className="text-xs">{labels.description}</SheetDescription>
      </SheetHeader>
      <div className="scrollbar-sleek min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-busy={busy || (!ready && !loadError)}>
        {!ready && !loadError ? <p role="status" className="text-xs text-muted-foreground">{labels.loading}</p> : null}
        {loadError ? <div className="space-y-2">
          <p role="alert" className="text-xs text-destructive">{labels.loadFailed}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>{labels.retry}</Button>
        </div> : null}
        {ready ? <>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <Label htmlFor={`${id}-search`}>{labels.search}</Label>
              <Input id={`${id}-search`} value={query} onChange={(event) => setQuery(event.target.value)} />
            </div>
            <Button type="button" variant="outline" size="sm" disabled={busy || dirty} onClick={() => choose(null)}>{labels.newKit}</Button>
          </div>
          <ul aria-label={labels.kits} className="space-y-1">
            {visibleKits.map((kit) => <li key={kit.id}>
              <Button type="button" variant="ghost" className="h-auto w-full justify-start whitespace-normal break-words text-left data-[current=true]:bg-accent"
                aria-pressed={selected?.id === kit.id} data-current={selected?.id === kit.id}
                disabled={busy || dirty} onClick={() => choose(kit)}>
                {kit.name}
              </Button>
            </li>)}
          </ul>
          {!visibleKits.length ? <p className="text-xs text-muted-foreground">{kits.length ? labels.noMatches : labels.empty}</p> : null}
          {editing ? <form id={`${id}-form`} onSubmit={(event) => { event.preventDefault(); void save() }}>
            <fieldset disabled={busy} className="space-y-3">
              {BRAND_KIT_FIELDS.map((field) => <BrandKitFormField key={field} field={field} id={`${id}-${field}`}
                value={form[field]} labels={labels} error={errors[field] ? labels[errors[field]] : undefined}
                onChange={(value) => update(field, value)} />)}
            </fieldset>
          </form> : <p className="text-xs text-muted-foreground">{labels.chooseKit}</p>}
          {dirty ? <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{labels.unsaved}</p>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => {
              setForm(brandKitToForm(selected ?? undefined)); setErrors({}); setError(null)
            }}>{labels.discard}</Button>
          </div> : null}
        </> : null}
        {error ? <p role="alert" className="text-xs text-destructive">{labels[error]}</p> : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t p-4">
        <Button type="button" variant="ghost" disabled={busy || dirty} onClick={() => onOpenChange(false)}>{labels.close}</Button>
        {editing && ready ? <Button type="submit" form={`${id}-form`} variant="outline" disabled={busy || (!dirty && Boolean(selected))}>
          {phase === 'saving' ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
          {phase === 'saving' ? labels.saving : labels.save}
        </Button> : null}
        <Button type="button" className="w-28" disabled={busy || dirty || !selected || !ready} onClick={() => void apply()}>
          {phase === 'applying' ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : null}
          {phase === 'applying' ? labels.applying : labels.apply}
        </Button>
      </div>
    </SheetContent>
  )
}

type FieldProps = {
  field: BrandKitField
  id: string
  value: string
  labels: OmniRogueBrandKitLabels
  error?: string
  onChange: (value: string) => void
}
function BrandKitFormField({ field, id, value, labels, error, onChange }: FieldProps) {
  const multiline = field === 'voice' || field === 'guidelines'
  const hint = field === 'colors' ? labels.colorsHint : field === 'fonts' ? labels.fontsHint : field === 'logoUrl' ? labels.logoHint : undefined
  const logoUrl = field === 'logoUrl' ? safeBrandKitLogoUrl(value) : null
  const colors = field === 'colors' ? value.split(/[,\n]/).map(normalizeBrandKitColor).filter((color): color is string => Boolean(color)) : []
  const controlProps = {
    id, value, maxLength: BRAND_KIT_FIELD_LIMITS[field], 'aria-invalid': Boolean(error),
    'aria-describedby': [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value)
  }
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{labels[field]}</Label>
      {multiline ? <Textarea {...controlProps} /> : <Input {...controlProps} />}
      {hint ? <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p> : null}
      {logoUrl ? <img src={logoUrl} alt={labels.logoAlt} referrerPolicy="no-referrer" className="size-12 rounded-md border object-contain" /> : null}
      {colors.length ? <div className="flex flex-wrap gap-2" aria-hidden="true">
        {colors.map((color, index) => <span key={`${index}-${color}`} className="size-5 rounded-sm border" style={{ backgroundColor: color }} />)}
      </div> : null}
      {error ? <p id={`${id}-error`} role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}
