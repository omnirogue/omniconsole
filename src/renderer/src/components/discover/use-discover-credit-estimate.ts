import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { LocalWorkflowDraft } from '../../../../shared/local-workflow-draft'
import type {
  DiscoverCreditPricing,
  DiscoverCreditQuoteRequest,
  DiscoverCreditQuoteResult
} from '../../../../shared/discover-credit-quote-ipc'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { workflowMaxAgentsForStart } from '../workflow-graph/WorkflowMaxAgentsField'

type EstimateState = DiscoverCreditQuoteResult & {
  key: string
  revision: number
  loading: boolean
}

export function useDiscoverCreditEstimate(
  worktreeId: string,
  draft: LocalWorkflowDraft,
  spec: WorkflowSpec,
  pricing?: DiscoverCreditPricing
) {
  const creditBilling = useAppStore(
    (state) => state.settings?.primaryAi?.billing === 'omnirogue-credits'
  )
  const enabled =
    creditBilling && (spec.template === 'discover' || spec.template === 'quick-discover')
  const planned = planWorkflowCalls(spec)
  const cap = workflowMaxAgentsForStart(spec, planned.total, draft.graph?.maxAgents)
  const request: DiscoverCreditQuoteRequest = {
    mode:
      spec.template === 'quick-discover'
        ? 'quick'
        : draft.discover?.depth === 'exhaustive'
          ? 'deep'
          : 'standard',
    pricing,
    agentCalls: Math.min(planned.agentTotal, cap ?? planned.agentTotal)
  }
  // A quote for old models, scope, host, or limits must never enable the current draft.
  const key = JSON.stringify({ worktreeId, draft, spec, request })
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<EstimateState | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const refresh = () => setRevision((value) => value + 1)
    const account = window.api?.omnirogue?.account?.onStatusChanged?.(refresh)
    const balance = window.api?.omnirogue?.credits?.onBalanceChanged?.(refresh)
    const timer = window.setInterval(refresh, 30_000)
    window.addEventListener('focus', refresh)
    return () => {
      account?.()
      balance?.()
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setState(null)
      return
    }
    let current = true
    setState({ key, revision, loading: true, quote: null, guard: null })
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { request } = JSON.parse(key) as { request: DiscoverCreditQuoteRequest }
          const result = await window.api.localWorkflow.quoteDiscoverCredits(request)
          if (current) {
            setState({ ...result, key, revision, loading: false })
          }
        } catch {
          if (current) {
            setState({
              key,
              revision,
              loading: false,
              quote: null,
              guard: null,
              unavailableReason: 'Unable to verify Discover credits. Refresh before launching.'
            })
          }
        }
      })()
    }, 250)
    return () => {
      current = false
      window.clearTimeout(timer)
    }
  }, [enabled, key, revision])

  const current = state?.key === key && state.revision === revision ? state : null
  // With no pricing provider there is no quote; the wallet guard alone decides.
  const quoted = !!current?.quote || !pricing
  return {
    enabled,
    requiresQuote: creditBilling,
    allowed: !enabled || (quoted && current?.guard?.allowed === true && !current.loading),
    quote: current?.quote ?? null,
    guard: current?.guard ?? null,
    loading: enabled && (!current || current.loading),
    unavailableReason: current?.unavailableReason,
    refresh: () => setRevision((value) => value + 1)
  }
}
