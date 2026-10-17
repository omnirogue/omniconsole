import { translate } from '@/i18n/i18n'
import { companiesApi, useCompaniesRead } from './companies-client'

export type CompanyAccess = {
  /** `all` = the whole estate, `some` = a named list, `unknown` = the scope could not be read. */
  scope: 'all' | 'some' | 'unknown'
  count: number | null
  /** True when this company is inside the reader's scope. Unknown scope allows nothing. */
  allows: (...identifiers: (string | null | undefined)[]) => boolean
  loading: boolean
}

/**
 * The console's own company scope (`/api/me`), mirrored in the UI so the desktop
 * never offers work on a company the reader cannot act on.
 *
 * Why this fails CLOSED: an unreadable scope is not evidence of wide access. The
 * earlier version answered `allows: () => true` whenever `/api/me` failed, so one
 * 500 from the console showed every company the folder tree returned. A reader
 * whose scope cannot be established now sees nothing until it can be, and
 * `companyAccessSummary` says why.
 *
 * `company_scope` is the console's own word for how wide the scope is and wins
 * when present; `'all'` is the super-admin answer. Otherwise a null `companies`
 * keeps its documented meaning of the whole estate, and a list means that list.
 */
export function useCompanyAccess(): CompanyAccess {
  const me = useCompaniesRead(() => companiesApi().me(), 'me')
  if (me.error || !me.data) {
    return { scope: 'unknown', count: null, allows: () => false, loading: me.loading }
  }
  if (me.data.company_scope === 'all') {
    return { scope: 'all', count: null, allows: () => true, loading: me.loading }
  }
  const companies = me.data.companies ?? null
  if (!companies) {
    return { scope: 'all', count: null, allows: () => true, loading: me.loading }
  }
  const allowed = new Set(companies)
  return {
    scope: 'some',
    count: allowed.size,
    allows: (...identifiers) =>
      identifiers.some((identifier) => Boolean(identifier) && allowed.has(identifier as string)),
    loading: me.loading
  }
}

export function companyAccessSummary(access: CompanyAccess): string | null {
  if (access.scope === 'all') {
    return translate('companies.accessAll', 'Your access covers every company.')
  }
  if (access.scope === 'some') {
    const count = access.count ?? 0
    return count === 1
      ? translate('companies.accessOne', 'Your access covers 1 company.')
      : translate('companies.accessSome', 'Your access covers {{count}} companies.', { count })
  }
  return translate(
    'companies.accessUnknown',
    'Your company access could not be read, so nothing is listed. Sign in again or retry.'
  )
}

export type CompanyFolderSet = {
  /** True once the folder tree answered with at least one company. */
  known: boolean
  loading: boolean
  count: number
  /** True when any of the identifiers names a company the folder tree shows. */
  has: (...identifiers: (string | null | undefined)[]) => boolean
}

/**
 * The companies the console's own folder tree shows (`/api/work/folders`): only
 * the ones work is filed under, not every record the org tree carries.
 *
 * Why this fails CLOSED too: the previous `!known ||` answered true for every
 * company whenever the tree read failed or came back empty, which turned a
 * transient error into "show the whole estate". An unread tree now matches
 * nothing, so a reader sees companies only once the console has actually named
 * them. `known` stays on the result so a caller can tell "none filed" apart
 * from "could not read" when it explains an empty list.
 */
export function useCompanyFolderSet(): CompanyFolderSet {
  const folders = useCompaniesRead(() => companiesApi().folders(), 'folders')
  const companies = folders.data?.companies ?? []
  const keys = new Set<string>()
  for (const company of companies) {
    for (const key of [company.id, company.slug]) {
      if (key) {
        keys.add(key)
      }
    }
  }
  const known = !folders.error && companies.length > 0
  return {
    known,
    loading: folders.loading && !folders.data,
    count: companies.length,
    has: (...identifiers) =>
      identifiers.some((identifier) => Boolean(identifier) && keys.has(identifier as string))
  }
}
