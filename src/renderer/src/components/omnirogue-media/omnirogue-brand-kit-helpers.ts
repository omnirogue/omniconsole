export type OmniRogueBrandKit = {
  id: string
  name: string
  logoUrl: string
  colors: readonly string[]
  fonts: readonly string[]
  voice: string
  guidelines: string
}
export type OmniRogueBrandKitDraft = Omit<OmniRogueBrandKit, 'id'>
// The adapter owns authentication, persistence, and account/workspace scoping.
export type OmniRogueBrandKitService = {
  list: (options: { signal: AbortSignal }) => Promise<readonly OmniRogueBrandKit[]>
  save: (
    draft: OmniRogueBrandKitDraft,
    options: { id?: string; signal: AbortSignal }
  ) => Promise<OmniRogueBrandKit>
}
export type BrandKitForm = {
  name: string
  logoUrl: string
  colors: string
  fonts: string
  voice: string
  guidelines: string
}
export type BrandKitField = keyof BrandKitForm
export const BRAND_KIT_FIELDS: readonly BrandKitField[] = [
  'name', 'logoUrl', 'colors', 'fonts', 'voice', 'guidelines'
]
export const BRAND_KIT_FIELD_LIMITS: Record<BrandKitField, number> = {
  name: 80, logoUrl: 2048, colors: 128, fonts: 400, voice: 1000, guidelines: 2000
}
export const DEFAULT_BRAND_KIT_LABELS = {
  title: 'Brand kit',
  description: 'Keep your media consistent with saved colors, fonts, and brand guidance.',
  search: 'Search brand kits',
  kits: 'Saved brand kits',
  newKit: 'New kit',
  empty: 'No brand kits yet. Create a kit to get started.',
  noMatches: 'No brand kits match your search.',
  chooseKit: 'Choose a kit or create a new one.',
  loading: 'Loading brand kits…',
  loadFailed: 'Could not load brand kits. Try again.',
  saveFailed: 'Could not save this brand kit. Your edits are still here.',
  applyFailed: 'Could not apply this brand kit. Try again.',
  retry: 'Try again',
  close: 'Close',
  save: 'Save kit',
  saving: 'Saving…',
  apply: 'Use kit',
  applying: 'Applying…',
  unsaved: 'Save or discard your changes before choosing another kit.',
  discard: 'Discard changes',
  name: 'Kit name',
  logoUrl: 'Logo URL',
  colors: 'Colors',
  fonts: 'Fonts',
  voice: 'Brand voice',
  guidelines: 'Visual guidelines',
  logoAlt: 'Brand logo preview',
  colorsHint: 'Up to 8 hex colors, separated by commas or new lines.',
  fontsHint: 'Up to 4 font names, separated by commas or new lines.',
  logoHint: 'Optional HTTPS image URL.',
  nameRequired: 'Enter a kit name of 80 characters or fewer.',
  invalidColors: 'Use up to 8 colors in #RGB or #RRGGBB format.',
  invalidFonts: 'Use up to 4 font names of 80 characters or fewer.',
  invalidLogoUrl: 'Use an HTTPS URL without embedded credentials.',
  textTooLong: 'This field exceeds its character limit.'
}
export type OmniRogueBrandKitLabels = typeof DEFAULT_BRAND_KIT_LABELS
export type BrandKitErrorKey = 'nameRequired' | 'invalidColors' | 'invalidFonts' | 'invalidLogoUrl' | 'textTooLong'
export type BrandKitErrors = Partial<Record<BrandKitField, BrandKitErrorKey>>

export function brandKitToForm(kit?: OmniRogueBrandKitDraft): BrandKitForm {
  return {
    name: kit?.name ?? '', logoUrl: kit?.logoUrl ?? '', colors: kit?.colors.join(', ') ?? '',
    fonts: kit?.fonts.join(', ') ?? '', voice: kit?.voice ?? '', guidelines: kit?.guidelines ?? ''
  }
}

export function safeBrandKitLogoUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

export function normalizeBrandKitColor(value: string): string | null {
  const hex = value.trim()
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(hex)) {
    return null
  }
  return (hex.length === 4 ? `#${Array.from(hex.slice(1), (digit) => digit.repeat(2)).join('')}` : hex).toUpperCase()
}

const splitValues = (value: string): string[] => value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)

export function validateBrandKitForm(form: BrandKitForm): {
  draft: OmniRogueBrandKitDraft | null
  errors: BrandKitErrors
} {
  const errors: BrandKitErrors = {}
  for (const field of BRAND_KIT_FIELDS) {
    if (form[field].length > BRAND_KIT_FIELD_LIMITS[field]) {
      errors[field] = 'textTooLong'
    }
  }
  if (!form.name.trim() || form.name.trim().length > 80) {
    errors.name = 'nameRequired'
  }
  const colors = splitValues(form.colors).map(normalizeBrandKitColor)
  const fonts = splitValues(form.fonts)
  if (colors.length > 8 || colors.some((color) => color === null)) {
    errors.colors = 'invalidColors'
  }
  if (fonts.length > 4 || fonts.some((font) => font.length > 80)) {
    errors.fonts = 'invalidFonts'
  }
  const logoUrl = form.logoUrl.trim() ? safeBrandKitLogoUrl(form.logoUrl) : ''
  if (logoUrl === null) {
    errors.logoUrl = 'invalidLogoUrl'
  }
  if (Object.keys(errors).length) {
    return { draft: null, errors }
  }
  return {
    draft: {
      name: form.name.trim(), logoUrl: logoUrl ?? '',
      colors: [...new Set(colors.filter((color): color is string => color !== null))],
      fonts: [...new Set(fonts)], voice: form.voice.trim(), guidelines: form.guidelines.trim()
    }, errors
  }
}

export function hasBrandKitChanges(form: BrandKitForm, kit?: OmniRogueBrandKitDraft): boolean {
  const original = brandKitToForm(kit)
  return BRAND_KIT_FIELDS.some((field) => original[field] !== form[field])
}

export function filterBrandKits(kits: readonly OmniRogueBrandKit[], query: string): OmniRogueBrandKit[] {
  const needle = query.trim().toLocaleLowerCase()
  return kits.filter((kit) => kit.name.toLocaleLowerCase().includes(needle))
}
