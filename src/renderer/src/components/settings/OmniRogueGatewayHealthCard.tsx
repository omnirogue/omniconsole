import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { OmniRogueGatewayHealthProbe } from '../../../../preload/api/omnirogue-api'
import type { OmniRogueGatewaySession } from '../../../../shared/omnirogue-account'
import {
  evaluateGatewayHealth,
  gatewayBillingLabel,
  gatewayCheckStatusLabel,
  gatewayHealthStatusLabel,
  gatewayModelName,
  gatewayStatusLine,
  GATEWAY_CHECK_TONE,
  GATEWAY_HEALTH_TONE,
  resolveGatewayHealthLabels,
  type GatewayBusyAction,
  type GatewayErrorKind,
  type GatewayHealthCheck,
  type OmniRogueGatewayHealthLabels
} from './omnirogue-gateway-health-helpers'
import {
  DEFAULT_GATEWAY_REACHABILITY_LABELS,
  withGatewayReachability,
  type GatewayReachabilityLabels
} from './omnirogue-gateway-reachability'

export type OmniRogueGatewayHealthCardProps = {
  /** Defaults to the preload gateway session reader. */
  loadSession?: () => Promise<OmniRogueGatewaySession>
  /** Defaults to the preload session-changed broadcast. */
  subscribe?: (listener: (session: OmniRogueGatewaySession) => void) => () => void
  onReconnect?: () => Promise<unknown>
  /** Defaults to the preload gateway catalog probe; a failed probe leaves the session checks. */
  checkHealth?: () => Promise<OmniRogueGatewayHealthProbe>
  labels?: Partial<OmniRogueGatewayHealthLabels & GatewayReachabilityLabels>
  now?: () => number
}

function GatewayCheckRow({
  check,
  labels
}: {
  check: GatewayHealthCheck
  labels: OmniRogueGatewayHealthLabels
}) {
  return (
    <li className="space-y-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{check.label}</span>
        <Badge variant="outline" className={GATEWAY_CHECK_TONE[check.status]}>
          {gatewayCheckStatusLabel(check.status, labels)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{check.detail}</p>
    </li>
  )
}

function GatewaySessionFacts({
  session,
  labels
}: {
  session: OmniRogueGatewaySession
  labels: OmniRogueGatewayHealthLabels
}) {
  const facts: [string, string][] = [
    [labels.billingLabel, gatewayBillingLabel(session, labels)],
    [labels.modelLabel, gatewayModelName(session, labels)]
  ]
  if (session.baseUrl) {
    facts.push([labels.endpointLabel, session.baseUrl])
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {facts.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function OmniRogueGatewayHealthCard({
  loadSession,
  subscribe,
  onReconnect,
  checkHealth,
  labels,
  now
}: OmniRogueGatewayHealthCardProps) {
  const titleId = useId()
  const text = useMemo(() => resolveGatewayHealthLabels(labels), [labels])
  const reachabilityText = useMemo(
    () => ({ ...DEFAULT_GATEWAY_REACHABILITY_LABELS, ...labels }),
    [labels]
  )
  const [session, setSession] = useState<OmniRogueGatewaySession | null>(null)
  const [probe, setProbe] = useState<OmniRogueGatewayHealthProbe | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [busy, setBusy] = useState<GatewayBusyAction | null>(null)
  const [error, setError] = useState<GatewayErrorKind | null>(null)
  const [linkOpened, setLinkOpened] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(false)
  // Why: inline props from parents must not re-trigger the mount load or resubscribe.
  const latest = useRef({ loadSession, onReconnect, checkHealth, now })
  useEffect(() => {
    latest.current = { loadSession, onReconnect, checkHealth, now }
  })
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const clock = useCallback(() => (latest.current.now ?? Date.now)(), [])

  const refresh = useCallback(async () => {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setBusy('refresh')
    setError(null)
    setLinkOpened(false)
    try {
      const load = latest.current.loadSession ?? window.api.omnirogue?.gateway.getSession
      if (!load) {
        throw new Error('Gateway session API is unavailable')
      }
      const probeHealth = latest.current.checkHealth ?? window.api?.omnirogue?.gateway.checkHealth
      const probing = probeHealth ? probeHealth().catch(() => null) : Promise.resolve(null)
      const started = clock()
      const next = await load()
      const finished = clock()
      const probed = await probing
      if (mounted.current) {
        setProbe(probed)
        setSession(next)
        setCheckedAt(finished)
        setLatencyMs(Math.max(0, Math.round(finished - started)))
      }
    } catch {
      if (mounted.current) {
        setError('load')
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setBusy(null)
      }
    }
  }, [clock])

  const reconnect = useCallback(async () => {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setBusy('reconnect')
    setError(null)
    try {
      const link = latest.current.onReconnect ?? window.api.omnirogue?.account.link
      if (!link) {
        throw new Error('Account linking is unavailable')
      }
      await link()
      if (mounted.current) {
        setLinkOpened(true)
      }
    } catch {
      if (mounted.current) {
        setError('reconnect')
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setBusy(null)
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    const listen = subscribe ?? window.api.omnirogue?.gateway.onSessionChanged
    if (!listen) {
      return
    }
    return listen((next) => {
      if (!mounted.current) {
        return
      }
      setSession(next)
      setCheckedAt(clock())
      setLatencyMs(null)
      setError(null)
    })
  }, [subscribe, clock])

  // Health is judged as of the last reading so render stays pure.
  const summary = withGatewayReachability(
    evaluateGatewayHealth(session, checkedAt ?? 0, text),
    probe,
    reachabilityText
  )
  const statusLine = gatewayStatusLine(
    { busy, linkOpened, status: summary.status, checkedAt, latencyMs },
    text
  )

  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      aria-busy={busy !== null}
      className="gap-4 shadow-none"
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle id={titleId}>{text.title}</CardTitle>
          <Badge variant="outline" className={GATEWAY_HEALTH_TONE[summary.status]}>
            {gatewayHealthStatusLabel(summary.status, text)}
          </Badge>
        </div>
        <CardDescription>{text.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy !== null} onClick={() => void refresh()}>
            {busy === 'refresh' ? <Loader2 className="motion-safe:animate-spin" /> : <RefreshCw />}
            {busy === 'refresh' ? text.refreshing : text.refresh}
          </Button>
          {summary.needsReconnect && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => void reconnect()}
            >
              {busy === 'reconnect' ? text.reconnecting : text.reconnect}
            </Button>
          )}
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {statusLine}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error === 'load' ? text.loadFailed : text.reconnectFailed}
          </p>
        )}
        {session && <GatewaySessionFacts session={session} labels={text} />}
        {summary.status === 'off' && (
          <p className="text-xs text-muted-foreground">{text.offDetail}</p>
        )}
        {summary.checks.length > 0 && (
          <ul className="divide-y divide-border">
            {summary.checks.map((check) => (
              <GatewayCheckRow key={check.id} check={check} labels={text} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
