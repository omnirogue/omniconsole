/**
 * What a company looks like — the same table the OmniOS console uses
 * (console/src/gtd/lib/company-icons.ts), so the desktop never shows a second
 * version of a company. Colours are the estate's termgrid hues; four companies
 * ship a real mark, the rest a monogram, and an unknown slug draws initials.
 */
export type CompanyIconKind = 'logo' | 'monogram' | 'initials'

export type CompanyIdentity = {
  slug: string
  name: string
  kind: CompanyIconKind
  /** Asset file name under resources/logos, null for initials. */
  asset: string | null
  initials: string
  color: string
}

const COMPANY_ASSET: Record<string, { file: string; kind: 'logo' | 'monogram' }> = {
  acme: { file: 'acme.png', kind: 'logo' },
  omnirogue: { file: 'omnirogue.png', kind: 'logo' },
  apexlabs: { file: 'apexlabs.png', kind: 'logo' },
  betacorp: { file: 'betacorp.png', kind: 'logo' },
  omniagentos: { file: 'omniagentos-monogram.svg', kind: 'monogram' },
  personal: { file: 'personal-monogram.svg', kind: 'monogram' },
  hardwaredirect: { file: 'hardwaredirect-monogram.svg', kind: 'monogram' },
  greenwell: { file: 'greenwell-monogram.svg', kind: 'monogram' }
}

export const COMPANY_NAME: Record<string, string> = {
  omnirogue: 'OmniRogue',
  apexlabs: 'ApexLabs',
  acme: 'ACME',
  betacorp: 'BetaCorp',
  omniagentos: 'OmniAgentOS',
  personal: 'Personal',
  hardwaredirect: 'HardwareDirect',
  greenwell: 'GreenWell'
}

export const COMPANY_SLUG_COLOR: Record<string, string> = {
  omniagentos: '#00d75f',
  omnirogue: '#af5fff',
  acme: '#0087ff',
  apexlabs: '#ff8700',
  betacorp: '#ff5faf',
  hardwaredirect: '#00afaf',
  greenwell: '#7bc96f',
  personal: '#8a8a8a'
}

export const UNKNOWN_COMPANY_COLOR = '#8a8a8a'

/** "Hardware Direct", "HardwareDirect" and "hardwaredirect" are one company. */
export function companySlug(company: string): string {
  return company
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

export function companyInitials(company: string): string {
  const words = company
    .trim()
    .split(/[\s/_-]+/)
    .filter(Boolean)
  if (words.length === 0) {
    return '?'
  }
  if (words.length === 1) {
    const word = words[0]!
    return (word.length === 1 ? word : word.slice(0, 2)).toUpperCase()
  }
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase()
}

export function companyColor(company: string): string {
  return COMPANY_SLUG_COLOR[companySlug(company)] ?? UNKNOWN_COMPANY_COLOR
}

export function companyIdentity(company: string, displayName?: string | null): CompanyIdentity {
  const slug = companySlug(company)
  const name = displayName?.trim() || COMPANY_NAME[slug] || company.trim()
  const asset = COMPANY_ASSET[slug]
  return {
    slug,
    name,
    kind: asset?.kind ?? 'initials',
    asset: asset?.file ?? null,
    initials: companyInitials(name),
    color: companyColor(slug)
  }
}

export type DivisionKind =
  | 'sales'
  | 'operations'
  | 'development'
  | 'creative'
  | 'prototypes'
  | 'customer-service'
  | 'finance'
  | 'marketing'
  | 'product'
  | 'generic'

/**
 * The hub appends a company id to some org-unit names ("Customer Service [co_2302…]"),
 * and that tail is not part of the label. Stripping it is what makes a real hub name
 * resolve: without this, such a department read as `generic`, so it wore a neutral
 * folder mark in the sidebar and could carry no division headline at all.
 */
function cleanDivisionName(name: string): string {
  return name.replace(/\s*\[co_[a-z0-9]+\]\s*$/i, '').trim()
}

/** The label a person reads: the department name minus any company-id tail. */
export function divisionLabel(name: string | null | undefined): string {
  return name === null || name === undefined ? '' : cleanDivisionName(name)
}

/** The console's own reading of a department name; unknown names stay generic. */
export function divisionKind(name: string | null | undefined): DivisionKind {
  // Collapsed whitespace too: "Customer  Service" is the same department.
  const key = cleanDivisionName(name ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
  switch (key) {
    case 'sales':
      return 'sales'
    case 'operations':
    case 'ops':
      return 'operations'
    case 'development':
    case 'engineering':
      return 'development'
    case 'creative':
    case 'creatives':
      return 'creative'
    case 'prototype':
    case 'prototypes':
      return 'prototypes'
    case 'customer service':
    case 'customer support':
    case 'support':
      return 'customer-service'
    case 'finance':
    case 'finance/admin':
    case 'admin':
      return 'finance'
    case 'marketing':
      return 'marketing'
    case 'product':
      return 'product'
    default:
      return 'generic'
  }
}

/**
 * Which departments own a headline figure on a division card at all.
 *
 * Operations is deliberately absent. The collector's operations block is company-wide,
 * so a figure from it on the Operations card would be the company's number wearing a
 * department's label — and every other card would then look quiet by comparison for no
 * reason. An unknown department owns none either, because inventing a Sales headline for
 * a folder that merely sounds like sales would put money on a department that has none.
 */
const HEADLINE_KINDS: readonly DivisionKind[] = [
  'sales',
  'customer-service',
  'finance',
  'development'
]

export function divisionOwnsHeadline(kind: DivisionKind): boolean {
  return HEADLINE_KINDS.includes(kind)
}
