import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { WorkflowMarkdown } from './WorkflowMarkdown'
import { translate } from '@/i18n/i18n'
import type { LocalWorkflowSource, LocalWorkflowView } from '../../../../shared/local-workflow-view'

function Sources({ sources }: { sources: LocalWorkflowSource[] }) {
  if (!sources.length) {
    return null
  }
  return (
    <ul
      className="space-y-2 text-xs text-muted-foreground"
      aria-label={translate('localWorkflow.sources', 'Sources')}
    >
      {sources.map((source) => (
        <li key={`${source.ref}-${source.description}`} className="break-words">
          <code>{source.ref}</code> · {source.description}
        </li>
      ))}
    </ul>
  )
}

/** Findings from legacy Discover revisions, which publish no live Discover view. */
export function LocalWorkflowEvidence({ view }: { view: LocalWorkflowView }) {
  const [filter, setFilter] = useState<'survivors' | 'refuted' | 'filtered' | 'all'>('survivors')
  const findings = view.findings ?? []
  const survivors = findings.filter((finding) =>
    ['survives', 'contested'].includes(finding.disposition)
  )
  const refuted = findings.filter((finding) => finding.disposition === 'refuted')
  const filtered = findings.filter((finding) =>
    ['duplicate', 'below threshold', 'over candidate limit'].includes(finding.disposition)
  )
  const visible =
    filter === 'all'
      ? findings
      : filter === 'refuted'
        ? refuted
        : filter === 'filtered'
          ? filtered
          : survivors
  return (
    <div className="space-y-4">
      {view.discoverCounts && (
        <div
          className="flex flex-wrap gap-2 text-xs text-muted-foreground"
          aria-label={translate('localWorkflow.discoverCoverage', 'Discover coverage')}
        >
          <span>
            {translate('localWorkflow.foundCount', '{{count}} found', {
              count: view.discoverCounts.found
            })}
          </span>
          <span>
            {translate('localWorkflow.duplicatesCount', '· {{count}} duplicates', {
              count: view.discoverCounts.duplicates
            })}
          </span>
          <span>
            {translate('localWorkflow.belowThresholdCount', '· {{count}} below threshold', {
              count: view.discoverCounts.belowThreshold
            })}
          </span>
          <span>
            {translate('localWorkflow.overLimitCount', '· {{count}} over candidate limit', {
              count: view.discoverCounts.overLimit
            })}
          </span>
          <span>
            {translate('localWorkflow.assessedCount', '· {{count}} assessed', {
              count: view.discoverCounts.assessed
            })}
          </span>
          <span>
            {translate('localWorkflow.verdictsCount', '· {{done}}/{{total}} verdicts', {
              done: view.discoverCounts.verdictsCompleted,
              total: view.discoverCounts.verdictsTotal
            })}
          </span>
          <span>
            {translate('localWorkflow.survivorsCount', '· {{count}} survivors', {
              count: view.discoverCounts.survivors
            })}
          </span>
          <span>
            {translate('localWorkflow.refutedCount', '· {{count}} refuted', {
              count: view.discoverCounts.refuted
            })}
          </span>
          <span>
            {translate('localWorkflow.notVerifiedCount', '· {{count}} not verified', {
              count: view.discoverCounts.notVerified
            })}
          </span>
          <span>
            {translate('localWorkflow.unresolvedCount', '· {{count}} unresolved', {
              count: view.discoverCounts.unresolved
            })}
          </span>
          {view.discoverCounts.omittedByFinder > 0 && (
            <span>
              {translate('localWorkflow.omittedByFinderCount', '· {{count}} omitted by finder', {
                count: view.discoverCounts.omittedByFinder
              })}
            </span>
          )}
        </div>
      )}
      {findings.length > 0 && (
        <section
          className="space-y-3"
          aria-label={translate('localWorkflow.allFindings', 'All findings')}
        >
          <div
            className="flex flex-wrap gap-1 border-b pb-2"
            role="group"
            aria-label={translate('localWorkflow.findingFilters', 'Finding filters')}
          >
            {(
              [
                ['survivors', translate('localWorkflow.survivors', 'Survivors'), survivors.length],
                ['refuted', translate('localWorkflow.refuted', 'Refuted'), refuted.length],
                ['filtered', translate('localWorkflow.filtered', 'Filtered'), filtered.length],
                ['all', translate('localWorkflow.allCandidates', 'All candidates'), findings.length]
              ] as const
            ).map(([id, label, count]) => (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={filter === id ? 'secondary' : 'ghost'}
                aria-pressed={filter === id}
                onClick={() => setFilter(id)}
              >
                {label} {count}
              </Button>
            ))}
          </div>
          {filter === 'survivors' && survivors.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {translate(
                'localWorkflow.noSurvivorsShown',
                'No surviving findings in the current results. Open All candidates to inspect the remaining evidence.'
              )}
            </p>
          )}
          {visible.map((finding, index) => (
            <Collapsible
              key={finding.id}
              id={`finding-${finding.id}`}
              className="border-b last:border-0"
            >
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  type="button"
                  aria-label={`${finding.label} · ${finding.disposition}`}
                  className="h-auto w-full justify-start gap-3 whitespace-normal py-3 text-left"
                >
                  <span className="text-muted-foreground">{index + 1}</span>
                  <span className="flex-1">
                    {finding.label} · {finding.disposition}
                  </span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-3 pb-4 pl-8">
                <WorkflowMarkdown className="text-sm" content={finding.markdown} />
                <Sources sources={finding.sources} />
                <div className="grid gap-2 sm:grid-cols-2">
                  {finding.verdicts.map((verdict) => (
                    <section key={verdict.label} className="space-y-2 rounded-lg bg-muted p-3">
                      <h4 className="text-xs font-semibold">
                        {verdict.label} · {verdict.verdict}
                      </h4>
                      <WorkflowMarkdown className="text-sm" content={verdict.markdown} />
                    </section>
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </section>
      )}
    </div>
  )
}
