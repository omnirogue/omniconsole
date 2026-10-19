#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DAY = 86_400_000
const STEPS = [14, 30, 60]
const CHECKS = {
  accountExists: [false, 'account_deleted'],
  paidPlan: [true, 'paid_plan'],
  lifetime: [true, 'lifetime'],
  liveSubscription: [true, 'live_subscription'],
  refundOrDispute: [true, 'refund_or_dispute'],
  pendingRefund: [true, 'pending_refund'],
  unsubscribed: [true, 'unsubscribed'],
  bounced: [true, 'bounced'],
  complained: [true, 'complained'],
  isAdmin: [true, 'admin']
}
const REASON_TRACKS = {
  too_expensive: 'too_expensive',
  not_using_enough: 'unused_credits',
  credits_confusing: 'unused_credits',
  found_alternative: 'switching',
  technical_problems: 'technical',
  quality_issues: 'technical',
  one_project: 'project_done',
  just_testing: 'just_testing'
}
const FEEDBACK_TRACKS = {
  too_expensive: 'too_expensive',
  unused: 'unused_credits',
  switched_service: 'switching',
  low_quality: 'technical',
  too_complex: 'technical'
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) {
    return Number.NaN
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 19) === value.slice(0, 19)
    ? parsed
    : Number.NaN
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function holdoutArm(userId) {
  return createHash('sha256').update(`cancel-winback-v1:${userId}`).digest().readUInt32BE(0) % 5 ===
    0
    ? 'holdout'
    : 'send'
}

function trackFor(candidate, endedAt) {
  const reasonAt = timestamp(candidate.reasonCreatedAt)
  if (
    Number.isFinite(reasonAt) &&
    reasonAt >= endedAt - 45 * DAY &&
    reasonAt <= endedAt &&
    typeof candidate.reasonCategory === 'string'
  ) {
    return Object.hasOwn(REASON_TRACKS, candidate.reasonCategory)
      ? REASON_TRACKS[candidate.reasonCategory]
      : 'generic'
  }
  return Object.hasOwn(FEEDBACK_TRACKS, candidate.stripeFeedback)
    ? FEEDBACK_TRACKS[candidate.stripeFeedback]
    : 'generic'
}

function evaluate(candidate, now) {
  if (
    !candidate ||
    !['userId', 'customerId', 'subscriptionId'].every((key) => identifier(candidate[key]))
  ) {
    return { status: 'suppressed', reasons: ['invalid_identity'] }
  }
  const row = { userId: candidate.userId, subscriptionId: candidate.subscriptionId }
  const endedAt = timestamp(candidate.endedAt)
  if (
    candidate.eventType !== 'customer.subscription.deleted' ||
    candidate.cancellationReason !== 'cancellation_requested'
  ) {
    return { ...row, status: 'suppressed', reasons: ['not_voluntary_end'] }
  }
  if (!Number.isFinite(endedAt) || endedAt > now) {
    return { ...row, status: 'suppressed', reasons: ['invalid_end'] }
  }
  const reasons = []
  for (const [key, [blockingValue, reason]] of Object.entries(CHECKS)) {
    const value = candidate.checks?.[key]
    if (typeof value !== 'boolean') {
      reasons.push(`unverified_${key}`)
    } else if (value === blockingValue) {
      reasons.push(reason)
    }
  }
  // Twelve calendar months, clamped for leap day.
  const cutoff = new Date(now)
  const month = cutoff.getUTCMonth()
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1)
  if (cutoff.getUTCMonth() !== month) {
    cutoff.setUTCDate(0)
  }
  if (candidate.previousSequenceAt !== null) {
    const previous = timestamp(candidate.previousSequenceAt)
    if (!Number.isFinite(previous) || previous > now) {
      reasons.push('unverified_previous_sequence')
    } else if (previous >= cutoff.getTime()) {
      reasons.push('recent_sequence')
    }
  }
  if (
    !Array.isArray(candidate.completedSteps) ||
    !candidate.completedSteps.every((step) => STEPS.includes(step))
  ) {
    reasons.push('unverified_steps')
  }
  if (reasons.length) {
    return { ...row, status: 'suppressed', reasons }
  }
  const days = Math.floor(now / DAY) - Math.floor(endedAt / DAY)
  const step = STEPS.includes(days) ? days : null
  const details = {
    ...row,
    track: trackFor(candidate, endedAt),
    arm: holdoutArm(candidate.userId),
    step
  }
  if (step === null) {
    return { ...details, status: 'not_due' }
  }
  if (candidate.completedSteps.includes(step)) {
    return { ...details, status: 'already_processed' }
  }
  return { ...details, status: details.arm === 'holdout' ? 'holdout' : 'shadow' }
}

export function planCohort(snapshot, { mode = 'off', now = new Date().toISOString() } = {}) {
  if (!['off', 'shadow'].includes(mode)) {
    throw new Error('Mode must be off or shadow; sending is unsupported')
  }
  if (mode === 'off') {
    return { schemaVersion: 1, mode, rows: [], counts: {} }
  }
  const current = timestamp(now)
  const checkedAt = timestamp(snapshot?.checkedAt)
  if (!Number.isFinite(current)) {
    throw new Error('now must be a UTC ISO timestamp')
  }
  if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.candidates)) {
    throw new Error('Expected schemaVersion 1 and a candidates array')
  }
  if (!Number.isFinite(checkedAt) || checkedAt > current || current - checkedAt > DAY) {
    throw new Error('Snapshot checks must be verified within the preceding 24 hours')
  }
  // Conflicting rows must never turn an unsafe customer into a shadow candidate.
  const owners = new Map()
  const evaluated = snapshot.candidates.map((candidate, index) => {
    for (const key of ['userId', 'customerId', 'subscriptionId']) {
      if (!identifier(candidate?.[key])) {
        continue
      }
      const value = `${key}:${candidate[key]}`
      const indices = owners.get(value) ?? []
      indices.push(index)
      owners.set(value, indices)
    }
    return evaluate(candidate, current)
  })
  const duplicates = new Set([...owners.values()].filter((indices) => indices.length > 1).flat())
  const rows = evaluated.map((row, index) =>
    duplicates.has(index)
      ? { ...row, status: 'suppressed', reasons: [...(row.reasons ?? []), 'duplicate_identity'] }
      : row
  )
  const counts = {}
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1
  }
  return { schemaVersion: 1, mode, checkedAt: snapshot.checkedAt, evaluatedAt: now, rows, counts }
}

const HELP = `Usage: omnirogue-winback-cohort [--mode off|shadow] [--input snapshot.json] [--now UTC_ISO]
Read-only W2-28 cohort check. Mode defaults to off (OMNIROGUE_CANCEL_WINBACK_MODE).
Shadow prints JSON only; this utility cannot send email, change billing, or create coupons.
Snapshot schema and example: scripts/ops/omnirogue-winback-cohort.example.json
Checks must cover current account/Stripe/Mailgun state, refunds/disputes (at least 150 days),
pending refunds, sequence starts (12 months), and processed subscription steps.
previousSequenceAt is the last OTHER subscription's sequence start, or explicit null.
completedSteps lists processed steps for this ended subscription, including shadow rows.
Refresh those checks before each run. Output is advisory, never send authorization.
`

export function main(
  args,
  env = process.env,
  io = {
    read: (path) => readFileSync(path, 'utf8'),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text)
  }
) {
  try {
    if (args.length === 1 && args[0] === '--help') {
      io.out(HELP)
      return 0
    }
    const options = { mode: env.OMNIROGUE_CANCEL_WINBACK_MODE ?? 'off' }
    for (let i = 0; i < args.length; i += 2) {
      const key = { '--mode': 'mode', '--input': 'input', '--now': 'now' }[args[i]]
      if (!key || !args[i + 1] || args[i + 1].startsWith('--')) {
        throw new Error('Invalid arguments; use --help')
      }
      options[key] = args[i + 1]
    }
    if (!['off', 'shadow'].includes(options.mode)) {
      throw new Error('Mode must be off or shadow; sending is unsupported')
    }
    if (options.mode === 'shadow' && !options.input) {
      throw new Error('--input is required for shadow mode')
    }
    const snapshot = options.mode === 'off' ? null : JSON.parse(io.read(options.input))
    io.out(`${JSON.stringify(planCohort(snapshot, options), null, 2)}\n`)
    return 0
  } catch {
    // Input files may contain customer data; never echo parser errors or file contents.
    io.err(
      'Win-back cohort check refused: invalid arguments, unreadable input, or unverified snapshot. Use --help.\n'
    )
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2))
}
