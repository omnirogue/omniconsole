import type { OmniRogueGatewaySession } from '../../../../shared/omnirogue-account'

export type GatewayCheckStatus = 'pass' | 'warn' | 'fail'
export type GatewayHealthStatus = 'healthy' | 'degraded' | 'down' | 'off' | 'unknown'
export type GatewayCheckId = 'token' | 'expiry' | 'catalog' | 'model' | 'restart' | 'reachability'
export type GatewayHealthCheck = {
  id: GatewayCheckId
  status: GatewayCheckStatus
  label: string
  detail: string
}
export type GatewayHealthSummary = {
  status: GatewayHealthStatus
  checks: GatewayHealthCheck[]
  needsReconnect: boolean
}
export type GatewayBusyAction = 'refresh' | 'reconnect'
export type GatewayErrorKind = 'load' | 'reconnect'

// Matches the doctor's minTokenHeadroomMs so both surfaces agree on "expires soon".
export const GATEWAY_EXPIRY_WARNING_MS = 300_000

export const DEFAULT_GATEWAY_HEALTH_LABELS = Object.freeze({
  title: 'Model gateway health',
  description: 'Token, expiry and model catalog for the OmniRogue multi-model gateway.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  reconnect: 'Reconnect Account',
  reconnecting: 'Opening…',
  loading: 'Checking the gateway session…',
  notChecked: 'Not checked yet.',
  checkedAt: '{{status}} · Checked {{time}} · {{milliseconds}} ms',
  updatedAt: '{{status}} · Updated {{time}}',
  reconnectHint: 'Complete account linking, then refresh.',
  loadFailed: 'The gateway session could not be read. Refresh to retry.',
  reconnectFailed: 'Account linking could not open. Retry from account settings.',
  statusHealthy: 'Healthy',
  statusDegraded: 'Attention',
  statusDown: 'Unavailable',
  statusOff: 'Off',
  statusUnknown: 'Not checked',
  checkPass: 'OK',
  checkWarn: 'Attention',
  checkFail: 'Failed',
  offDetail:
    'Agents use your own provider login. Switch billing to OmniRogue credits to route through the gateway.',
  endpointLabel: 'Endpoint',
  billingLabel: 'Billing',
  billingCredits: 'OmniRogue credits',
  billingOwnLogin: 'Own login',
  tokenLabel: 'Gateway token',
  tokenReady: 'Token leased for this session.',
  tokenMissing: 'No gateway token. Reconnect your OmniRogue account.',
  expiryLabel: 'Token expiry',
  expiryOk: 'Valid until {{time}}.',
  expirySoon: 'Expires soon ({{time}}). Reconnect to renew.',
  expired: 'Token expired. Reconnect your OmniRogue account.',
  expiryUnknown: 'Token expiry could not be verified.',
  catalogLabel: 'Model catalog',
  catalogReady: '{{count}} models available.',
  catalogEmpty: 'The gateway returned no models.',
  modelLabel: 'Selected model',
  modelDefault: 'Gateway default',
  modelReady: '{{model}} is available.',
  modelMissing: '{{model}} is not in the gateway catalog.',
  modelUnverified: '{{model}} could not be verified without a catalog.',
  restartLabel: 'Billing change',
  restartRequired: 'Restart running agents to apply the billing change.'
})

export type OmniRogueGatewayHealthLabels = Record<
  keyof typeof DEFAULT_GATEWAY_HEALTH_LABELS,
  string
>

const SUCCESS_TONE = 'border-status-success/30 text-status-success'
const WARNING_TONE = 'border-status-warning-border bg-status-warning-background text-status-warning'
const DANGER_TONE = 'border-destructive/30 text-destructive'
const MUTED_TONE = 'text-muted-foreground'

export const GATEWAY_HEALTH_TONE: Readonly<Record<GatewayHealthStatus, string>> = {
  healthy: SUCCESS_TONE,
  degraded: WARNING_TONE,
  down: DANGER_TONE,
  off: MUTED_TONE,
  unknown: MUTED_TONE
}

export const GATEWAY_CHECK_TONE: Readonly<Record<GatewayCheckStatus, string>> = {
  pass: SUCCESS_TONE,
  warn: WARNING_TONE,
  fail: DANGER_TONE
}

export function resolveGatewayHealthLabels(
  overrides?: Partial<OmniRogueGatewayHealthLabels>
): OmniRogueGatewayHealthLabels {
  return { ...DEFAULT_GATEWAY_HEALTH_LABELS, ...overrides }
}

export function fillGatewayLabel(
  template: string,
  values: Record<string, string | number> = {}
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match
  )
}

export function formatGatewayClock(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit'
  })
}

export function gatewayHealthStatusLabel(
  status: GatewayHealthStatus,
  labels: OmniRogueGatewayHealthLabels
): string {
  switch (status) {
    case 'healthy':
      return labels.statusHealthy
    case 'degraded':
      return labels.statusDegraded
    case 'down':
      return labels.statusDown
    case 'off':
      return labels.statusOff
    case 'unknown':
      return labels.statusUnknown
  }
}

export function gatewayCheckStatusLabel(
  status: GatewayCheckStatus,
  labels: OmniRogueGatewayHealthLabels
): string {
  switch (status) {
    case 'pass':
      return labels.checkPass
    case 'warn':
      return labels.checkWarn
    case 'fail':
      return labels.checkFail
  }
}

export function gatewayBillingLabel(
  session: OmniRogueGatewaySession,
  labels: OmniRogueGatewayHealthLabels
): string {
  return session.billing === 'omnirogue-credits' ? labels.billingCredits : labels.billingOwnLogin
}

/** Catalog label for the selected model, falling back to its id or the gateway default. */
export function gatewayModelName(
  session: OmniRogueGatewaySession,
  labels: OmniRogueGatewayHealthLabels
): string {
  const id = session.model?.trim()
  if (!id) {
    return labels.modelDefault
  }
  return session.availableModels?.find((model) => model.id === id)?.label ?? id
}

function expiryCheck(
  expiresAt: number | undefined,
  nowMs: number,
  labels: OmniRogueGatewayHealthLabels
): GatewayHealthCheck {
  const base = { id: 'expiry', label: labels.expiryLabel } as const
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return { ...base, status: 'warn', detail: labels.expiryUnknown }
  }
  const time = formatGatewayClock(expiresAt)
  if (expiresAt <= nowMs) {
    return { ...base, status: 'fail', detail: labels.expired }
  }
  if (expiresAt - nowMs < GATEWAY_EXPIRY_WARNING_MS) {
    return { ...base, status: 'warn', detail: fillGatewayLabel(labels.expirySoon, { time }) }
  }
  return { ...base, status: 'pass', detail: fillGatewayLabel(labels.expiryOk, { time }) }
}

function modelCheck(
  session: OmniRogueGatewaySession,
  labels: OmniRogueGatewayHealthLabels
): GatewayHealthCheck {
  const base = { id: 'model', label: labels.modelLabel } as const
  const id = session.model?.trim()
  if (!id) {
    return { ...base, status: 'pass', detail: labels.modelDefault }
  }
  const catalog = session.availableModels ?? []
  if (catalog.length === 0) {
    return {
      ...base,
      status: 'warn',
      detail: fillGatewayLabel(labels.modelUnverified, { model: id })
    }
  }
  const match = catalog.find((model) => model.id === id)
  if (!match) {
    return { ...base, status: 'warn', detail: fillGatewayLabel(labels.modelMissing, { model: id }) }
  }
  return {
    ...base,
    status: 'pass',
    detail: fillGatewayLabel(labels.modelReady, { model: match.label })
  }
}

export function evaluateGatewayHealth(
  session: OmniRogueGatewaySession | null,
  nowMs: number,
  labels: OmniRogueGatewayHealthLabels
): GatewayHealthSummary {
  if (!session) {
    return { status: 'unknown', checks: [], needsReconnect: false }
  }
  if (session.billing !== 'omnirogue-credits') {
    return { status: 'off', checks: [], needsReconnect: false }
  }
  const catalogSize = session.availableModels?.length ?? 0
  const checks: GatewayHealthCheck[] = [
    session.tokenAvailable
      ? { id: 'token', status: 'pass', label: labels.tokenLabel, detail: labels.tokenReady }
      : { id: 'token', status: 'fail', label: labels.tokenLabel, detail: labels.tokenMissing },
    expiryCheck(session.expiresAt, nowMs, labels),
    catalogSize > 0
      ? {
          id: 'catalog',
          status: 'pass',
          label: labels.catalogLabel,
          detail: fillGatewayLabel(labels.catalogReady, { count: catalogSize })
        }
      : { id: 'catalog', status: 'warn', label: labels.catalogLabel, detail: labels.catalogEmpty },
    modelCheck(session, labels)
  ]
  if (session.requiresRestartForBillingChange) {
    checks.push({
      id: 'restart',
      status: 'warn',
      label: labels.restartLabel,
      detail: labels.restartRequired
    })
  }
  const needsReconnect = checks.some(
    (check) => (check.id === 'token' || check.id === 'expiry') && check.status !== 'pass'
  )
  let status: GatewayHealthStatus = 'healthy'
  if (!session.active || checks.some((check) => check.status === 'fail')) {
    status = 'down'
  } else if (checks.some((check) => check.status === 'warn')) {
    status = 'degraded'
  }
  return { status, checks, needsReconnect }
}

export function gatewayStatusLine(
  state: {
    busy: GatewayBusyAction | null
    linkOpened: boolean
    status: GatewayHealthStatus
    checkedAt: number | null
    latencyMs: number | null
  },
  labels: OmniRogueGatewayHealthLabels
): string {
  if (state.busy === 'refresh') {
    return labels.loading
  }
  if (state.busy === 'reconnect') {
    return labels.reconnecting
  }
  if (state.linkOpened) {
    return labels.reconnectHint
  }
  if (state.checkedAt === null) {
    return labels.notChecked
  }
  const values = {
    status: gatewayHealthStatusLabel(state.status, labels),
    time: formatGatewayClock(state.checkedAt)
  }
  if (state.latencyMs === null) {
    return fillGatewayLabel(labels.updatedAt, values)
  }
  return fillGatewayLabel(labels.checkedAt, { ...values, milliseconds: state.latencyMs })
}
