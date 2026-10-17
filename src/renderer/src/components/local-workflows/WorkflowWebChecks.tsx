import { translate } from '@/i18n/i18n'
import type { WorkflowWebCheck } from '../../../../shared/workflow-graph-web'

function markText(mark: WorkflowWebCheck['mark']): string {
  switch (mark) {
    case 'found':
      return translate('localWorkflow.webChecks.found', 'found in the page')
    case 'not-in-page':
      return translate('localWorkflow.webChecks.notInPage', 'NOT in the page')
    case 'leaves-out':
      return translate(
        'localWorkflow.webChecks.leavesOut',
        'leaves words out, so it was not checked'
      )
    case 'unreadable':
      return translate('localWorkflow.webChecks.unreadable', 'page could not be read')
    case 'unknown':
      return translate('localWorkflow.webChecks.unknown', 'no such source')
    case 'unquoted':
      return translate('localWorkflow.webChecks.unquoted', 'no quote given')
    case 'pending':
      return translate('localWorkflow.webChecks.pending', 'page not read yet')
  }
}

// Invisible and direction characters show as codes, so a quote cannot hide or reorder its words.
function shownQuote(quote: string): string {
  const flat = quote
    .replace(/\s+/g, ' ')
    .trim()
    .replace(
      /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu,
      (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
    )
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
}

/** The app's checks as plain text from data: no model Markdown is parsed, so none can forge a row. */
export function WorkflowWebChecks({
  checks,
  compact
}: {
  checks?: readonly WorkflowWebCheck[]
  /** One line beside a model-written reason, in a list of results. */
  compact?: boolean
}) {
  if (!checks) {
    return null
  }
  const rows = [
    ...new Map(checks.map((check) => [JSON.stringify([check.id, check.mark, check.quote]), check]))
  ]
  if (compact) {
    return (
      <p className="break-words text-[11px]" data-workflow-web-checks="compact">
        {`${translate('localWorkflow.webChecks.title', 'App quote checks')}: `}
        {rows.length
          ? rows.map(([key, check], index) => (
              <span key={key} data-web-mark={check.mark}>
                {`${index ? '; ' : ''}${check.id} ${markText(check.mark)}`}
                {check.quote !== undefined ? (
                  <bdi className="font-mono"> “{shownQuote(check.quote)}”</bdi>
                ) : null}
              </span>
            ))
          : translate(
              'localWorkflow.webChecks.none',
              'No citation of a web source was recognised.'
            )}
      </p>
    )
  }
  return (
    <section
      aria-label={translate('localWorkflow.webChecks.title', 'App quote checks')}
      className="space-y-1 rounded-md border border-dashed px-3 py-2 text-xs"
      data-workflow-web-checks=""
    >
      <p className="font-medium">
        {translate('localWorkflow.webChecks.title', 'App quote checks')}
      </p>
      <p className="text-muted-foreground">
        {translate(
          'localWorkflow.webChecks.note',
          'Any citation mark inside the answer is the model’s own, not the app’s. These are the app’s checks of its quotes, from the pages it kept.'
        )}
      </p>
      {rows.length ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {rows.map(([key, check]) => (
            <li key={key} data-web-mark={check.mark}>
              {`${check.id} ${markText(check.mark)}`}
              {check.quote !== undefined ? (
                <>
                  {': '}
                  <bdi className="break-words font-mono">“{shownQuote(check.quote)}”</bdi>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          {translate('localWorkflow.webChecks.none', 'No citation of a web source was recognised.')}
        </p>
      )}
    </section>
  )
}
