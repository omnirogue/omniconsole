import { resolveCompanyFolder, resolveDomainFolder } from '../../../shared/company-folders'
import { companySlug } from '../../../shared/company-identity'
import type { WorkFolderCompany } from '../../../shared/console-work-folders-contract'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'

/** Where a folder sits in the estate: company, then department, then project. */
export type CompanyPlace = {
  company: { id: string | null; slug: string; name: string }
  domain: { id: string | null; name: string } | null
  /** The project whose folder the path is inside, when the tree names one. */
  project: { id: string | null; name: string } | null
}

/**
 * The company and department a path belongs to, by the folders Settings gave each
 * company (the same rule the Companies tree files by). The deepest department wins;
 * a path in the company root is the company alone; a path outside every company is null.
 */
export function companyPlaceForPath(
  companies: readonly WorkFolderCompany[],
  path: string | null | undefined,
  context: {
    home: string
    workRoot: string | null | undefined
    overrides: Record<string, string> | null | undefined
  }
): CompanyPlace | null {
  if (!path || !context.home) {
    return null
  }
  for (const company of companies) {
    const slug = companySlug(company.slug ?? company.name ?? company.id ?? '')
    if (!slug) {
      continue
    }
    const name = company.name ?? slug
    const folder = resolveCompanyFolder({
      workRoot: context.workRoot,
      overrides: context.overrides,
      company: { slug, name },
      home: context.home
    })
    if (!isPathInsideOrEqual(folder, path)) {
      continue
    }
    const domain = company.domains
      .map((candidate) => ({ candidate, name: (candidate.name ?? '').trim() }))
      .filter((entry) => entry.name.length > 0)
      .map((entry) => ({ ...entry, folder: resolveDomainFolder(folder, entry.name) }))
      .filter((entry) => isPathInsideOrEqual(entry.folder, path))
      .sort((a, b) => b.folder.length - a.folder.length)[0]
    const project = domain
      ? (domain.candidate.projects ?? [])
          .map((row) => ({ row, name: (row.name ?? '').trim() }))
          .filter((entry) => entry.name.length > 0)
          .map((entry) => ({ ...entry, folder: resolveDomainFolder(domain.folder, entry.name) }))
          .filter((entry) => isPathInsideOrEqual(entry.folder, path))
          .sort((a, b) => b.folder.length - a.folder.length)[0]
      : undefined
    return {
      company: { id: company.id ?? null, slug, name },
      domain: domain ? { id: domain.candidate.id ?? null, name: domain.name } : null,
      project: project ? { id: project.row.id ?? null, name: project.name } : null
    }
  }
  return null
}
