import { useState } from 'react'
import { Check, Plug, ShieldCheck, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

export type ToolStatus = 'connected' | 'disconnected' | 'error'
export type AccessEffect = 'allow' | 'deny'
export type AccessDecision = 'approve' | 'deny'

/** A tool connected once at the WorkOS org level and brokered to agents whose role permits it. */
export type OrgTool = {
  id: string
  name: string
  provider: string
  status: ToolStatus
  scopes: string[]
}
export type ToolGrant = { toolId: string; toolName: string; actions: string[]; allowed: boolean }
export type AgentCapability = { id: string; label: string; roles: string[]; grants: ToolGrant[] }
type AccessSubject = { agentLabel: string; toolName: string; action: string }
/** One rule explain_access evaluated, in evaluation order. */
export type TraceStep = {
  id: string
  rule: string
  source: string
  effect: AccessEffect | 'skip'
  detail?: string
}
export type AccessTrace = AccessSubject & {
  id: string
  agentId: string
  toolId: string
  decision: AccessEffect
  evaluatedAt: string
  steps: TraceStep[]
}
export type AccessRequest = AccessSubject & {
  id: string
  reason: string
  requestedBy: string
  requestedAt: string
  status: 'pending' | 'approved' | 'denied'
}

export type RbacAccessDrawerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  orgName: string
  tools: OrgTool[]
  agents: AgentCapability[]
  traces: AccessTrace[]
  requests: AccessRequest[]
  onConnectTool: (toolId: string) => Promise<void>
  onDecideRequest: (requestId: string, decision: AccessDecision) => Promise<void>
}

type Run = { pending: ReadonlySet<string>; run: (key: string, action: () => Promise<void>) => void }
type TagKind = TraceStep['effect'] | ToolStatus

const row = 'rounded-md border p-2.5 text-xs'

function Tag({ kind, className }: { kind: TagKind; className?: string }) {
  const tags: Record<TagKind, [string, string]> = {
    allow: ['text-status-success', translate('rbacAccess.effect.allow', 'Allow')],
    deny: ['text-destructive', translate('rbacAccess.effect.deny', 'Deny')],
    skip: ['text-muted-foreground', translate('rbacAccess.effect.skip', 'No match')],
    connected: ['text-status-success', translate('rbacAccess.tool.connected', 'Connected')],
    disconnected: ['text-muted-foreground', translate('rbacAccess.tool.off', 'Not connected')],
    error: ['text-status-warning', translate('rbacAccess.tool.error', 'Needs reconnect')]
  }
  const [tone, label] = tags[kind]
  return <span className={cn(tone, className)}>{label}</span>
}

function Empty({ text }: { text: string }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{text}</p>
}

function TraceSteps({ trace }: { trace: AccessTrace | undefined }) {
  if (!trace) {
    return <Empty text={translate('rbacAccess.traces.none', 'No explain_access trace recorded.')} />
  }
  return (
    <ol className="space-y-1 border-t px-2.5 py-2">
      {trace.steps.map((step) => (
        <li key={step.id} className="grid grid-cols-[64px_72px_1fr] gap-2">
          <Tag kind={step.effect} />
          <span className="text-muted-foreground">{step.source}</span>
          <span className="min-w-0 break-words">
            <span className="font-mono">{step.rule}</span>
            {step.detail && <span className="block text-muted-foreground">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

type ToolsProps = Run & Pick<RbacAccessDrawerProps, 'tools' | 'onConnectTool'>

function ToolsTab({ tools, onConnectTool, pending, run }: ToolsProps) {
  if (tools.length === 0) {
    return <Empty text={translate('rbacAccess.tools.empty', 'No org tools available.')} />
  }
  return tools.map((tool) => {
    const key = `tool:${tool.id}`
    return (
      <div key={tool.id} className={cn('mb-2 flex items-start justify-between gap-3', row)}>
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {tool.name} <span className="text-xs text-muted-foreground">{tool.provider}</span>
          </p>
          <Tag kind={tool.status} className="block" />
          <div className="flex flex-wrap gap-1">
            {tool.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="font-mono text-[11px]">
                {scope}
              </Badge>
            ))}
          </div>
        </div>
        {tool.status !== 'connected' && (
          <Button
            size="xs"
            variant="outline"
            disabled={pending.has(key)}
            onClick={() => run(key, () => onConnectTool(tool.id))}
          >
            <Plug aria-hidden="true" />
            {tool.status === 'error'
              ? translate('rbacAccess.tools.reconnect', 'Reconnect')
              : translate('rbacAccess.tools.connect', 'Connect')}
          </Button>
        )}
      </div>
    )
  })
}

function AgentsTab({ agents, traces }: Pick<RbacAccessDrawerProps, 'agents' | 'traces'>) {
  if (agents.length === 0) {
    return <Empty text={translate('rbacAccess.agents.empty', 'No agents in this org.')} />
  }
  return agents.map((agent) => (
    <section key={agent.id} className={cn('mb-2 space-y-1.5', row)}>
      <h3 className="flex flex-wrap items-center gap-1 text-sm font-medium">
        <span className="mr-1">{agent.label}</span>
        {agent.roles.map((role) => (
          <Badge key={role} variant="secondary">
            {role}
          </Badge>
        ))}
      </h3>
      {agent.grants.length === 0 && (
        <p className="text-muted-foreground">
          {translate('rbacAccess.agents.noGrants', 'No tool grants.')}
        </p>
      )}
      {agent.grants.map((grant) => (
        <details key={grant.toolId} className="rounded-md border">
          <summary className="cursor-pointer px-2 py-1.5">
            <Tag kind={grant.allowed ? 'allow' : 'deny'} className="mr-1.5 font-medium" />
            {grant.toolName}
            <span className="ml-1.5 font-mono text-muted-foreground">
              {grant.actions.join(', ')}
            </span>
          </summary>
          <TraceSteps
            trace={traces.find((t) => t.agentId === agent.id && t.toolId === grant.toolId)}
          />
        </details>
      ))}
    </section>
  ))
}

function TracesTab({ traces }: { traces: AccessTrace[] }) {
  if (traces.length === 0) {
    return <Empty text={translate('rbacAccess.traces.empty', 'No explain_access traces yet.')} />
  }
  return traces.map((trace) => (
    <details key={trace.id} className="mb-1.5 rounded-md border text-xs">
      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-2">
        <Tag kind={trace.decision} className="font-medium" />
        <span className="min-w-0 truncate">
          {trace.agentLabel} → {trace.toolName}{' '}
          <span className="font-mono text-muted-foreground">{trace.action}</span>
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {trace.evaluatedAt}
        </span>
      </summary>
      <TraceSteps trace={trace} />
    </details>
  ))
}

type RequestsProps = Run & Pick<RbacAccessDrawerProps, 'requests' | 'onDecideRequest'>

function RequestsTab({ requests, onDecideRequest, pending, run }: RequestsProps) {
  if (requests.length === 0) {
    return <Empty text={translate('rbacAccess.requests.empty', 'No pending access requests.')} />
  }
  return requests.map((request) => {
    const key = `request:${request.id}`
    const busy = pending.has(key)
    const decide = (decision: AccessDecision) =>
      run(key, () => onDecideRequest(request.id, decision))
    return (
      <div key={request.id} className={cn('mb-2 space-y-1.5', row)}>
        <p className="text-sm">
          <span className="font-medium">{request.agentLabel}</span> → {request.toolName}{' '}
          <span className="font-mono text-xs text-muted-foreground">{request.action}</span>
        </p>
        {request.reason && <p className="text-muted-foreground">{request.reason}</p>}
        <div className="flex items-center justify-between gap-2 text-muted-foreground">
          {request.requestedBy} · {request.requestedAt}
          <span className="flex gap-1.5">
            <Button size="xs" variant="outline" disabled={busy} onClick={() => decide('deny')}>
              <X aria-hidden="true" />
              {translate('rbacAccess.requests.deny', 'Deny')}
            </Button>
            <Button size="xs" disabled={busy} onClick={() => decide('approve')}>
              <Check aria-hidden="true" />
              {translate('rbacAccess.requests.approve', 'Approve')}
            </Button>
          </span>
        </div>
      </div>
    )
  })
}

/** WorkOS org-shared tool broker: connect tools, inspect agent grants, read traces, approve requests. */
export function RbacAccessDrawer(props: RbacAccessDrawerProps) {
  const { orgName, tools, agents, traces, onConnectTool, onDecideRequest } = props
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const requests = props.requests.filter((request) => request.status === 'pending')

  const run: Run['run'] = (key, action) => {
    setError(null)
    setPending((current) => new Set(current).add(key))
    // Why: a synchronous throw from the callback must still clear the busy state.
    void Promise.resolve()
      .then(action)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason))
      )
      .finally(() => setPending((current) => new Set([...current].filter((k) => k !== key))))
  }

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="size-4 text-muted-foreground" />
            {translate('rbacAccess.title', 'Tool access')}
          </SheetTitle>
          <SheetDescription>
            {translate(
              'rbacAccess.description',
              'Connect each tool once for {{org}}. Agents use it only where their role allows.',
              { org: orgName }
            )}
          </SheetDescription>
        </SheetHeader>
        {error && (
          <p
            role="alert"
            className="mx-4 rounded-md border border-destructive/30 p-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        <Tabs defaultValue="tools" className="min-h-0 flex-1 px-4 pb-4">
          <TabsList>
            <TabsTrigger value="tools">{translate('rbacAccess.tab.tools', 'Tools')}</TabsTrigger>
            <TabsTrigger value="agents">{translate('rbacAccess.tab.agents', 'Agents')}</TabsTrigger>
            <TabsTrigger value="traces">{translate('rbacAccess.tab.traces', 'Traces')}</TabsTrigger>
            <TabsTrigger value="requests">
              {translate('rbacAccess.tab.requests', 'Requests')}
              {requests.length > 0 && (
                <Badge className="ml-1 h-4 px-1 text-[10px] tabular-nums">{requests.length}</Badge>
              )}
            </TabsTrigger>
          </TabsList>
          <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
            <TabsContent value="tools">
              <ToolsTab {...{ tools, onConnectTool, pending, run }} />
            </TabsContent>
            <TabsContent value="agents">
              <AgentsTab agents={agents} traces={traces} />
            </TabsContent>
            <TabsContent value="traces">
              <TracesTab traces={traces} />
            </TabsContent>
            <TabsContent value="requests">
              <RequestsTab {...{ requests, onDecideRequest, pending, run }} />
            </TabsContent>
          </div>
        </Tabs>
      </SheetContent>
    </Sheet>
  )
}
