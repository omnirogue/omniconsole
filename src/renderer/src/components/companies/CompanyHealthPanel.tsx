import { ArrowUpRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  domainForId,
  healthHref,
  metricValue,
  type CompanyHealth,
  type DomainHealth,
  type HealthAction,
  type HealthChange,
  type HealthEvidence,
  type HealthMetric
} from '../../../../shared/console-company-health-contract'
import { CompaniesNotice, HealthBadge, SectionTitle } from './CompaniesNotice'
import { companiesApi, useCompaniesRead } from './companies-client'
import {
  healthFolderName,
  healthHierarchy,
  keyedByContent,
  type HealthFolder
} from './company-model'

function openLink(href: string): void {
  void window.api.shell.openUrl(href)
}

function LinkOut({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => openLink(href)}
      className="inline-flex items-center gap-1 text-left text-primary underline-offset-4 hover:underline"
    >
      {children}
      <ArrowUpRight className="size-3" aria-hidden />
    </button>
  )
}

/** An evidence row has no id; its label, link and detail are what make it itself. */
const evidenceKey = (item: HealthEvidence): string =>
  `${item.label}:${item.href ?? ''}:${item.detail ?? ''}`
/** A folder is its org unit; an unassigned bucket falls back to what it is and what it says. */
const folderKey = (node: HealthFolder): string =>
  node.domain.id ?? `${node.domain.kind}:${node.domain.name}`

function Evidence({ items }: { items: HealthEvidence[] }) {
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate(
          'companies.noEvidence',
          'No supporting evidence was included in this observation.'
        )}
      </p>
    )
  }
  return (
    <ul className="space-y-2 text-xs">
      {keyedByContent(items, evidenceKey).map(({ key, item }) => {
        const href = healthHref(item.href)
        return (
          <li key={key}>
            {href ? <LinkOut href={href}>{item.label}</LinkOut> : <span>{item.label}</span>}
            {item.detail ? (
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{item.detail}</p>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function Headlines({ metrics }: { metrics: HealthMetric[] }) {
  if (metrics.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('companies.noOutcomes', 'Outcome measurements have not been reported yet.')}
      </p>
    )
  }
  return (
    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-health-headlines>
      {metrics.slice(0, 3).map((metric) => (
        <div key={metric.id} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{metric.label}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">{metricValue(metric)}</dd>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {metric.actual === null || metric.actual === undefined
              ? translate('companies.notMeasured', 'Not measured')
              : metric.coverage.state === 'partial'
                ? translate('companies.partialCoverage', 'Partial coverage')
                : metric.trend?.direction &&
                    !['unknown', 'flat', 'steady'].includes(metric.trend.direction)
                  ? metric.trend.detail
                  : null}
          </p>
        </div>
      ))}
    </dl>
  )
}

function Changes({ changes }: { changes: HealthChange[] }) {
  if (changes.length === 0) {
    return null
  }
  return (
    <div
      className="space-y-1 text-xs"
      aria-label={translate('companies.whatChanged', 'What changed')}
    >
      {keyedByContent(
        changes.slice(0, 3),
        (change) => `${change.metric_id ?? ''}:${change.label}:${change.detail ?? ''}`
      ).map(({ key, item: change }) => (
        <p key={key}>
          <span className="font-medium">{change.label}</span>
          {change.detail ? ` · ${change.detail}` : ''}
        </p>
      ))}
    </div>
  )
}

function Actions({ actions }: { actions: HealthAction[] }) {
  const usable = actions.filter((action) => healthHref(action.href))
  if (usable.length === 0) {
    return null
  }
  return (
    <ul
      className="divide-y rounded-lg border"
      aria-label={translate('companies.needsAction', 'Needs action')}
    >
      {keyedByContent(
        usable.slice(0, 3),
        (action) => action.task_id ?? `${action.label}:${action.href ?? ''}`
      ).map(({ key, item: action }) => (
        <li key={key} className="px-3 py-2 text-sm">
          <LinkOut href={healthHref(action.href) as string}>{action.label}</LinkOut>
        </li>
      ))}
    </ul>
  )
}

function MetricsDetail({ metrics }: { metrics: HealthMetric[] }) {
  return (
    <div className="divide-y">
      {metrics.map((metric) => (
        <details key={metric.id} className="py-2.5">
          <summary className="cursor-pointer text-sm">
            <span>{metric.label}</span>
            <span className="ml-3 font-medium tabular-nums">{metricValue(metric)}</span>
          </summary>
          <div className="mt-3 space-y-2 border-l-2 pl-3">
            <p className="text-xs">{metric.summary}</p>
            <p className="text-xs text-muted-foreground">{metric.coverage.detail}</p>
            {metric.target?.label ? (
              <p className="text-xs">
                {translate('companies.standard', 'Standard')}: {metric.target.label}
              </p>
            ) : null}
            {metric.owner?.name ? (
              <p className="text-xs">
                {translate('companies.responsible', 'Responsible')}: {metric.owner.name}
              </p>
            ) : null}
            {metric.trend?.detail ? (
              <p className="text-xs text-muted-foreground">{metric.trend.detail}</p>
            ) : null}
            <Evidence items={metric.evidence} />
          </div>
        </details>
      ))}
    </div>
  )
}

function FolderCard({ node }: { node: HealthFolder }) {
  const { domain, children } = node
  return (
    <article
      className="min-w-0 rounded-xl border bg-card"
      data-domain-health={domain.id ?? domain.kind}
    >
      <div className="space-y-1.5 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">{healthFolderName(domain)}</span>
          <HealthBadge status={domain.status} />
        </div>
        <p className="text-xs text-muted-foreground">{domain.summary}</p>
        {domain.changes[0] ? <p className="text-xs">{domain.changes[0].label}</p> : null}
      </div>
      {children.length > 0 ? (
        <details className="border-t" data-health-children={domain.id}>
          <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
            {translate('companies.folderCount', '{{count}} folders', { count: children.length })}
          </summary>
          <div className="space-y-2 border-t p-2">
            {keyedByContent(children, folderKey).map(({ key, item: child }) => (
              <FolderCard key={key} node={child} />
            ))}
          </div>
        </details>
      ) : null}
    </article>
  )
}

export function CompanyHealthBody({
  company,
  domain
}: {
  company: CompanyHealth
  domain?: DomainHealth | null
}) {
  const subject = domain ?? company
  const roots = healthHierarchy(company.domains)
  return (
    <div
      className="space-y-4"
      data-company-health={company.slug}
      data-company-health-level={domain ? 'domain' : 'company'}
    >
      <div className="flex flex-wrap items-start gap-2">
        <HealthBadge status={subject.status} />
        <p className="min-w-0 flex-1 text-sm">{subject.summary}</p>
      </div>
      <Headlines metrics={subject.headline_metrics} />
      <Changes changes={subject.changes} />
      <Actions actions={subject.actions} />
      {domain ? (
        <details open>
          <summary className="cursor-pointer text-sm font-medium">
            {translate('companies.measurements', 'Measurements & evidence')}
          </summary>
          <MetricsDetail metrics={domain.metrics} />
        </details>
      ) : (
        <section
          className="space-y-2"
          aria-label={translate('companies.domainHealth', 'Domain health')}
        >
          <SectionTitle
            title={translate('companies.domains', 'Domains')}
            sub={translate('companies.domainTotal', '{{count}} domains', { count: roots.length })}
          />
          <div className="grid items-start gap-2 sm:grid-cols-2">
            {keyedByContent(roots, folderKey).map(({ key, item: node }) => (
              <FolderCard key={key} node={node} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

/** The scorecard for one company, optionally narrowed to one of its departments. */
export function CompanyHealthPanel({ slug, domainId }: { slug: string; domainId?: string }) {
  const query = useCompaniesRead(
    () => companiesApi().health({ company: slug }),
    `health:${slug}`,
    Boolean(slug)
  )
  if (query.error) {
    return <CompaniesNotice error={query.error} onRetry={query.reload} />
  }
  if (!query.data) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {translate('companies.loadingHealth', 'Loading company health…')}
      </p>
    )
  }
  const company = query.data.companies.find((row) => row.slug === slug)
  if (!company) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {translate(
          'companies.noHealthAccess',
          'No company health is available within your access.'
        )}
      </p>
    )
  }
  return <CompanyHealthBody company={company} domain={domainForId(company, domainId)} />
}
