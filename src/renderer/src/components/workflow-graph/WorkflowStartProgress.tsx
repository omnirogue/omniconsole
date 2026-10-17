import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'

export function WorkflowStartProgress({ active }: { active: boolean }) {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    setSeconds(0)
    if (!active) {
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [active])

  return (
    <div className="min-h-5 text-xs text-muted-foreground">
      {active && seconds > 0 ? (
        <>
          <span role="status">
            {translate(
              'workflowGraph.setup.preparingRun',
              'Preparing sources and checking run requirements…'
            )}
          </span>{' '}
          <span aria-hidden="true">{seconds}s</span>
        </>
      ) : null}
    </div>
  )
}
