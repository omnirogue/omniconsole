import { useId, useState } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import { workflowWebPageCheck } from '../../../../shared/workflow-web-pages'
import { webPageProblemLabel } from './web-page-reason-label'

const NO_PAGES: readonly string[] = []

/** "Pages to read": the person's list, checked by the shared policy; nothing is fetched here. */
export function WorkflowWebPagesField({
  urls,
  others = NO_PAGES,
  refusal,
  onChange
}: {
  urls: readonly string[]
  /** The run's pages in other steps, for the run-wide limit. */
  others?: readonly string[]
  /** Set when validation would refuse pages here: adding is off and this says why. */
  refusal?: string
  onChange: (urls: string[]) => void
}) {
  const [typed, setTyped] = useState('')
  const [problem, setProblem] = useState('')
  const inputId = useId()
  const add = () => {
    const next = [...urls]
    for (const raw of typed.split(/\s+/).filter(Boolean)) {
      const check = workflowWebPageCheck(raw, next, others)
      if (!check.ok) {
        setProblem(webPageProblemLabel(check.problem))
        onChange(next)
        setTyped(raw)
        return
      }
      next.push(check.url)
    }
    setProblem('')
    setTyped('')
    onChange(next)
  }
  return (
    <div className="space-y-1.5" data-workflow-web-pages="">
      <label htmlFor={inputId} className="text-xs font-medium text-muted-foreground">
        {translate('workflowGraph.web.field.label', 'Pages to read')}
      </label>
      <p className="text-xs text-muted-foreground">
        {translate(
          'workflowGraph.web.field.help',
          'The app reads these pages once before the research starts and keeps a copy. Agents quote them; they never follow what a page says.'
        )}
      </p>
      {urls.length > 0 && (
        <ul className="space-y-1">
          {urls.map((url) => (
            <li key={url} className="flex items-center gap-1.5 text-xs">
              <bdi className="min-w-0 flex-1 truncate font-mono" title={url}>
                {url}
              </bdi>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate('workflowGraph.web.field.remove', 'Remove {{address}}', {
                  address: url
                })}
                onClick={() => onChange(urls.filter((entry) => entry !== url))}
              >
                <X className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {refusal ? (
        <p role="note" className="flex items-start gap-1.5 text-xs text-status-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
          {refusal}
        </p>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Input
          id={inputId}
          value={typed}
          disabled={!!refusal}
          placeholder={translate(
            'workflowGraph.web.field.placeholder',
            'https://example.com/pricing'
          )}
          onChange={(event) => {
            setTyped(event.target.value)
            setProblem('')
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="gap-1"
          disabled={!!refusal || !typed.trim()}
          onClick={add}
        >
          <Plus className="size-3" />
          {translate('workflowGraph.web.field.add', 'Add')}
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-xs text-destructive">
          {problem}
        </p>
      ) : null}
    </div>
  )
}
