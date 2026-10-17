import { translate } from '@/i18n/i18n'
import { useEffect, useId, useRef, useState } from 'react'
import { Copy, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// Structural projection keeps main-process modules outside the renderer dependency graph.
type DiagnosticCheck = {
  id: string
  label: string
  status: 'pass' | 'warn' | 'fail' | 'skipped'
  latencyMs: number
  message: string
  remediation?: 'reconnect' | 'top-up' | 'retry'
  checks?: DiagnosticCheck[]
}
export type OmniRogueDiagnosticsReport = {
  checkedAt: string
  status: DiagnosticCheck['status']
  billingMode: 'own-login' | 'omnirogue-credits'
  stages: DiagnosticCheck[]
}
export type OmniRogueDiagnosticsCardProps = {
  runDoctor: () => Promise<OmniRogueDiagnosticsReport>
  onReconnect?: () => Promise<unknown>
  onTopUp?: () => Promise<unknown>
}
const STAGES = [
  ['account', 'Account Link & Token Lease'],
  ['wallet', 'Unified Credit Wallet'],
  ['mcp', 'Unified MCP'],
  ['gateway', 'Multi-Model LLM Gateway']
] as const
const STATUS = { pass: 'Healthy', warn: 'Attention', fail: 'Failed', skipped: 'Skipped' }
const TONE = {
  pass: 'border-status-success/30 text-status-success',
  warn: 'border-status-warning-border bg-status-warning-background text-status-warning',
  fail: 'border-destructive/30 text-destructive',
  skipped: 'text-muted-foreground'
}

function CheckResult({ check }: { check: DiagnosticCheck }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all text-sm font-medium">{check.label}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {translate('omnirogueDiagnostics.latency', '{{milliseconds}} ms', {
              milliseconds: check.latencyMs
            })}
          </span>
          <Badge variant="outline" className={TONE[check.status]}>
            {STATUS[check.status]}
          </Badge>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{check.message}</p>
    </div>
  )
}

export function OmniRogueDiagnosticsCard({
  runDoctor,
  onReconnect,
  onTopUp
}: OmniRogueDiagnosticsCardProps) {
  const titleId = useId()
  const [report, setReport] = useState<OmniRogueDiagnosticsReport | null>(null)
  const [busyAction, setBusyAction] = useState<'check' | 'reconnect' | 'top-up' | null>(null)
  const busy = busyAction !== null
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true),
    inFlight = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    if (!busy) {
      setWorking(false)
      return
    }
    const timer = setTimeout(() => setWorking(true), 200)
    return () => clearTimeout(timer)
  }, [busy])

  async function run(action: 'check' | 'reconnect' | 'top-up') {
    if (inFlight.current) {
      return
    }
    inFlight.current = true
    setBusyAction(action)
    setError(null)
    setReport(null)
    try {
      if (action === 'reconnect') {
        const reconnect = onReconnect ?? window.api.omnirogue?.account.link
        if (!reconnect) {
          throw new Error('unavailable')
        }
        await reconnect()
        if (mounted.current) {
          toast.info(
            translate(
              'omnirogueDiagnostics.linkingHint',
              'Complete account linking, then retry the check.'
            )
          )
        }
      } else if (action === 'top-up') {
        const topUp = onTopUp ?? window.api.omnirogue?.credits.openTopUp
        if (!topUp) {
          throw new Error('unavailable')
        }
        await topUp()
        if (mounted.current) {
          toast.info(
            translate('omnirogueDiagnostics.creditsHint', 'After adding credits, retry the check.')
          )
        }
      } else {
        const result = await runDoctor()
        if (mounted.current) {
          setReport(result)
        }
      }
    } catch {
      if (mounted.current) {
        setError(
          action === 'check'
            ? 'Diagnostics could not finish. Retry the check.'
            : action === 'reconnect'
              ? 'Account linking could not open. Retry from account settings.'
              : 'Billing could not open. Retry from account settings.'
        )
      }
    } finally {
      inFlight.current = false
      if (mounted.current) {
        setBusyAction(null)
        setWorking(false)
      }
    }
  }
  async function copyReport() {
    if (!report) {
      return
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      if (mounted.current) {
        toast.success(translate('omnirogueDiagnostics.copied', 'Diagnostic JSON copied.'))
      }
    } catch {
      if (mounted.current) {
        setError('Copy failed. Select and copy the diagnostic JSON below.')
      }
    }
  }
  const results = report?.stages.flatMap((stage) => [stage, ...(stage.checks ?? [])]) ?? []
  const reconnect = results.some((stage) => stage.remediation === 'reconnect')
  const topUp = results.some((stage) => stage.remediation === 'top-up')

  return (
    <Card role="region" aria-labelledby={titleId} aria-busy={busy} className="gap-4 shadow-none">
      <CardHeader>
        <CardTitle id={titleId}>
          {translate('omnirogueDiagnostics.title', 'OmniRogue diagnostics')}
        </CardTitle>
        <CardDescription>
          {translate(
            'omnirogueDiagnostics.description',
            'Check your account, credit wallet, unified tools and model gateway.'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" className="w-32" disabled={busy} onClick={() => void run('check')}>
            {working ? <Loader2 className="motion-safe:animate-spin" /> : <RefreshCw />}
            {working
              ? busyAction === 'check'
                ? translate('omnirogueDiagnostics.checking', 'Checking…')
                : translate('omnirogueDiagnostics.opening', 'Opening…')
              : report || error
                ? translate('omnirogueDiagnostics.retry', 'Retry Check')
                : translate('omnirogueDiagnostics.run', 'Run Check')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !report}
            onClick={() => void copyReport()}
          >
            <Copy /> {translate('omnirogueDiagnostics.copy', 'Copy diagnostic JSON')}
          </Button>
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {working
            ? busyAction === 'check'
              ? translate(
                  'omnirogueDiagnostics.checkingDetail',
                  'Checking account, wallet, MCP endpoints and model catalog…'
                )
              : busyAction === 'reconnect'
                ? translate('omnirogueDiagnostics.openingAccount', 'Opening account linking…')
                : translate('omnirogueDiagnostics.openingBilling', 'Opening billing…')
            : report
              ? translate('omnirogueDiagnostics.checked', '{{status}} · Checked {{time}}', {
                  status: STATUS[report.status],
                  time: new Date(report.checkedAt).toLocaleTimeString()
                })
              : translate(
                  'omnirogueDiagnostics.notRun',
                  'Run a check to see the current service status.'
                )}
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <ol className="divide-y divide-border">
          {STAGES.map(([id, label]) => {
            const stage = report?.stages.find((result) => result.id === id)
            return (
              <li key={id} className="space-y-3 py-3 first:pt-0 last:pb-0">
                {stage ? (
                  <CheckResult check={stage} />
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{label}</span>
                    <Badge variant="outline">
                      {working && busyAction === 'check'
                        ? translate('omnirogueDiagnostics.pending', 'Pending')
                        : translate('omnirogueDiagnostics.notChecked', 'Not checked')}
                    </Badge>
                  </div>
                )}
                {stage?.checks?.map((endpoint) => (
                  <CheckResult key={endpoint.id} check={endpoint} />
                ))}
              </li>
            )
          })}
        </ol>
        {(reconnect || topUp) && (
          <div className="flex flex-wrap gap-2">
            {reconnect && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run('reconnect')}
              >
                {translate('omnirogueDiagnostics.reconnect', 'Reconnect Account')}
              </Button>
            )}
            {topUp && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run('top-up')}
              >
                {translate('omnirogueCredits.topUp', 'Top Up Credits')}
              </Button>
            )}
          </div>
        )}
        {report && (
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {translate('omnirogueDiagnostics.json', 'Diagnostic JSON')}
            </summary>
            <pre className="scrollbar-sleek mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(report, null, 2)}
            </pre>
          </details>
        )}
      </CardContent>
    </Card>
  )
}
