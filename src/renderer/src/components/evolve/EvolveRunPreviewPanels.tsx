import { useEffect, useMemo, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { EVOLVE_RPC, type EvolveRunRecord } from '../../../../shared/evolve-workflow'
import type { EvolveJudgment } from './evolve-judge-audit-helpers'
import { evolveJudgmentsFromAuditBundle, evolveParetoCandidates } from './evolve-run-preview-data'
import { EvolveJudgeAuditInspector } from './EvolveJudgeAuditInspector'
import { EvolveParetoChartCard } from './EvolveParetoChartCard'

type AuditState = { judgments: EvolveJudgment[] } | { error: string } | null

/** Remounted per run (keyed by id), so its state never carries over to another run. */
function EvolveJudgeAuditSection({ runId }: { runId: string }) {
  const [audit, setAudit] = useState<AuditState>(null)
  useEffect(() => {
    let active = true
    void callRuntimeRpc<{ bundle: unknown }>({ kind: 'local' }, EVOLVE_RPC.auditBundle, {
      id: runId
    })
      .then(({ bundle }) => {
        if (active) {
          setAudit({ judgments: evolveJudgmentsFromAuditBundle(bundle) })
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setAudit({ error: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      active = false
    }
  }, [runId])

  if (!audit) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {translate('evolve.judgeAudit.loading', 'Loading the judge audit…')}
      </p>
    )
  }
  if ('error' in audit) {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {translate('evolve.judgeAudit.unavailable', 'Judge audit unavailable: {{reason}}', {
          reason: audit.error
        })}
      </p>
    )
  }
  return <EvolveJudgeAuditInspector judgments={audit.judgments} />
}

/** OmniSI previews (Settings > Experimental): quality-cost frontier and hosted judge audit. */
export function EvolveRunPreviewPanels({ run }: { run: EvolveRunRecord }) {
  const enabled = useAppStore((state) => state.settings?.experimentalOmniSiPreviews === true)
  const candidates = useMemo(() => evolveParetoCandidates(run), [run])
  if (!enabled) {
    return null
  }
  return (
    <>
      <EvolveParetoChartCard candidates={candidates} />
      {run.cloudRunId ? <EvolveJudgeAuditSection key={run.id} runId={run.id} /> : null}
    </>
  )
}
