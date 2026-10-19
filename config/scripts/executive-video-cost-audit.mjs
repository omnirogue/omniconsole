#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const HELP = `Read-only Executive Video provider-attempt reconciliation (W13-11).
Usage: node executive-video-cost-audit.mjs --enable-executive-video-cost-audit --input export.json --budget-usd 65
Disabled by default. No network, billing writes, or permission to retry/enroll.
Exit: 0 reconciled within supplied budget, 1 review required, 2 disabled/invalid input.
Input: {schemaVersion:1, attempts:[{accountId,billingPeriodId,jobId,provider,
requestId,status,billingStatus,actualCostUsd,reservedCostUsd}]}
Use opaque IDs. Export EVERY provider attempt, including failures, for each period.
status: pending|succeeded|failed|cancelled. billingStatus: pending|reconciled.
USD fields: nonnegative decimal strings, up to six decimal places. Unknown actual
cost is null and requires a worst-case reservedCostUsd. Reconciled costs require
invoice/provider confirmation, including an explicit "0" for unbilled attempts.
Repeating an identical provider/requestId is deduplicated across exports; any
conflict is invalid. Do not combine this output with generation/winning-take costs.
Budget is an operator-supplied review target, never a purchased-output limit.
This offline check cannot prove export completeness or invoice authenticity.`

function usd(value, field) {
  if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`${field} must be a nonnegative USD decimal string`)
  }
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
}

function formatUsd(value) {
  return `${value / 1_000_000n}.${String(value % 1_000_000n).padStart(6, '0')}`
}

function identifier(value, field) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value)) {
    throw new Error(`${field} must be an opaque identifier (1-160 characters)`)
  }
  return value
}

function normalizeAttempt(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('attempt must be an object')
  }
  const ids = Object.fromEntries(
    ['accountId', 'billingPeriodId', 'jobId', 'provider', 'requestId'].map((field) => [
      field,
      identifier(row[field], field)
    ])
  )
  if (!['pending', 'succeeded', 'failed', 'cancelled'].includes(row.status)) {
    throw new Error('invalid provider status')
  }
  if (!['pending', 'reconciled'].includes(row.billingStatus)) {
    throw new Error('invalid billingStatus')
  }
  const reconciled = row.billingStatus === 'reconciled'
  if (reconciled && row.status === 'pending') {
    throw new Error('pending provider attempt cannot be reconciled')
  }
  if (!reconciled && row.actualCostUsd !== null) {
    throw new Error('unconfirmed cost must be null; reserve worst-case spend instead')
  }
  const actual = reconciled ? usd(row.actualCostUsd, 'actualCostUsd') : null
  const reserved = usd(row.reservedCostUsd, 'reservedCostUsd')
  if (!reconciled && reserved === 0n) {
    throw new Error('unknown provider cost requires a positive worst-case reservation')
  }
  return {
    ...ids,
    status: row.status,
    billingStatus: row.billingStatus,
    actualCostUsd: actual === null ? null : formatUsd(actual),
    reservedCostUsd: formatUsd(reserved)
  }
}

export function auditExecutiveVideoCosts(document, budgetUsd) {
  const budget = usd(budgetUsd, 'budget-usd')
  if (budget === 0n) {
    throw new Error('budget-usd must be positive')
  }
  if (document?.schemaVersion !== 1 || !Array.isArray(document.attempts)) {
    throw new Error('expected schemaVersion 1 and attempts array')
  }
  if (document.attempts.length === 0 || document.attempts.length > 100_000) {
    throw new Error('expected 1-100000 attempt rows; empty input is not cost evidence')
  }
  const unique = new Map()
  let duplicateRows = 0
  for (const row of document.attempts) {
    const attempt = normalizeAttempt(row)
    const key = JSON.stringify([attempt.provider, attempt.requestId])
    const previous = unique.get(key)
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(attempt)) {
        throw new Error('conflicting rows for the same provider/requestId; reconcile exports first')
      }
      duplicateRows += 1
    } else {
      unique.set(key, attempt)
    }
  }
  const periods = new Map()
  for (const attempt of unique.values()) {
    const key = JSON.stringify([attempt.accountId, attempt.billingPeriodId])
    if (!periods.has(key)) {
      periods.set(key, {
        accountId: attempt.accountId,
        billingPeriodId: attempt.billingPeriodId,
        confirmed: 0n,
        reserved: 0n,
        jobs: new Map(),
        issues: []
      })
    }
    const period = periods.get(key)
    if (!period.jobs.has(attempt.jobId)) {
      period.jobs.set(attempt.jobId, [])
    }
    period.jobs.get(attempt.jobId).push(attempt)
    if (attempt.actualCostUsd === null) {
      period.reserved += usd(attempt.reservedCostUsd, 'reservedCostUsd')
      period.issues.push({ code: 'unresolved_provider_cost', jobId: attempt.jobId })
    } else {
      // Failed attempts still cost money; settled reservations are replaced, never added.
      period.confirmed += usd(attempt.actualCostUsd, 'actualCostUsd')
    }
  }
  const results = [...periods.values()].map((period) => {
    for (const [jobId, attempts] of period.jobs) {
      if (attempts.length > 2) {
        period.issues.push({ code: 'attempt_limit_exceeded', jobId })
      }
      const billedProviders = new Set(
        attempts
          .filter(
            (attempt) =>
              attempt.actualCostUsd !== null && usd(attempt.actualCostUsd, 'actualCostUsd') > 0n
          )
          .map((attempt) => attempt.provider)
      )
      if (billedProviders.size > 1) {
        period.issues.push({ code: 'multiple_billed_providers', jobId })
      }
    }
    const committed = period.confirmed + period.reserved
    if (committed > budget) {
      period.issues.push({ code: 'budget_exceeded' })
    }
    return {
      accountId: period.accountId,
      billingPeriodId: period.billingPeriodId,
      confirmedCostUsd: formatUsd(period.confirmed),
      outstandingReservationUsd: formatUsd(period.reserved),
      committedCostUsd: formatUsd(committed),
      issues: period.issues
    }
  })
  return {
    schemaVersion: 1,
    assessment: results.some((period) => period.issues.length) ? 'review_required' : 'reconciled',
    scope: 'supplied_attempts_only',
    budgetUsd: formatUsd(budget),
    uniqueAttempts: unique.size,
    duplicateRows,
    periods: results
  }
}

export function main(args = process.argv.slice(2), io = console) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        help: { type: 'boolean' },
        'enable-executive-video-cost-audit': { type: 'boolean', default: false },
        input: { type: 'string' },
        'budget-usd': { type: 'string' }
      },
      allowPositionals: false
    })
    if (values.help) {
      io.log(HELP)
      return 0
    }
    if (!values['enable-executive-video-cost-audit']) {
      io.log(JSON.stringify({ assessment: 'disabled', flag: 'enable-executive-video-cost-audit' }))
      return 2
    }
    if (!values.input || !values['budget-usd']) {
      throw new Error('input and budget-usd are required')
    }
    const input = readFileSync(values.input, 'utf8')
    let document
    try {
      document = JSON.parse(input)
    } catch {
      throw new Error('invalid JSON input')
    }
    const result = auditExecutiveVideoCosts(document, values['budget-usd'])
    io.log(JSON.stringify(result, null, 2))
    return result.assessment === 'reconciled' ? 0 : 1
  } catch (error) {
    io.error(JSON.stringify({ assessment: 'invalid_input', error: error.message }))
    return 2
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === import.meta.filename) {
  process.exitCode = main()
}
