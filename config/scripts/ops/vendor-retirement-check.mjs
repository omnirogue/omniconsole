#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ENABLE_FLAG = 'OMNI_VENDOR_RETIREMENT_CHECK_ENABLED'
const HOUR = 60 * 60 * 1000
const MAX_EVIDENCE_AGE = 24 * HOUR
const OBSERVATION_PERIOD = 48 * HOUR
const REVIEW_EVIDENCE = [
  'migrationResult',
  'naturalWorkerRuns',
  'routesAndDependencies',
  'backupRestore',
  'protectedSessions',
  'telemetryHandoff',
  'currentInvoice',
  'contractAndNotice',
  'destinationCosts'
]
const CLOSURE_EVIDENCE = ['exactChangeApproval', 'providerCancellation', 'nextInvoice']
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasText = (value) => typeof value === 'string' && value.trim().length > 0

function timestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  ) {
    return Number.NaN
  }
  const parsed = Date.parse(value)
  const canonical = value.includes('.') ? value : value.replace('Z', '.000Z')
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === canonical
    ? parsed
    : Number.NaN
}

// This checks supplied attestations; only the owning systems can establish their truth.
export function assessRetirement(packet, { phase = 'review', now = Date.now() } = {}) {
  const blockers = []
  const block = (field, reason) => blockers.push({ field, reason })
  if (!['review', 'closure'].includes(phase) || !Number.isFinite(now)) {
    throw new Error('Invalid assessment options')
  }
  if (!isObject(packet)) {
    throw new Error('Packet must be a JSON object')
  }
  if (packet.schemaVersion !== 1) {
    block('schemaVersion', 'Expected version 1')
  }
  if (packet.candidateId !== 'C01') {
    block('candidateId', 'Expected email-server retirement C01')
  }
  for (const field of ['provider', 'accountId', 'instanceId', 'contractId']) {
    if (!hasText(packet.resource?.[field])) {
      block(`resource.${field}`, 'Exact resource identity required')
    }
  }

  const cutover = timestamp(packet.workerCutoverAt)
  if (!Number.isFinite(cutover) || cutover > now) {
    block('workerCutoverAt', 'Verified worker cutover timestamp required, with timezone')
  } else if (now - cutover < OBSERVATION_PERIOD) {
    block('workerCutoverAt', '48 hours of observation after worker cutover required')
  }

  function checkEvidence(field, { afterCutover = false } = {}) {
    const item = packet.evidence?.[field]
    if (!isObject(item) || item.status !== 'verified' || !hasText(item.reference)) {
      block(`evidence.${field}`, 'Verified evidence and a durable reference required')
      return
    }
    for (const key of ['provider', 'accountId', 'instanceId', 'contractId']) {
      if (!hasText(item.resource?.[key]) || item.resource[key] !== packet.resource?.[key]) {
        block(
          `evidence.${field}.resource.${key}`,
          'Evidence must identify the exact provider resource and contract'
        )
      }
    }
    const observed = timestamp(item.observedAt)
    const effective = timestamp(item.effectiveAt)
    if (Number.isFinite(effective) && observed < effective) {
      block(`evidence.${field}.observedAt`, 'Readback cannot precede the event it verifies')
    }
    if (!Number.isFinite(observed) || observed > now || now - observed > MAX_EVIDENCE_AGE) {
      block(
        `evidence.${field}.observedAt`,
        'Readback must be within the past 24 hours, with timezone'
      )
    }
    if (afterCutover && (!Number.isFinite(cutover) || observed < cutover)) {
      block(`evidence.${field}.observedAt`, 'Evidence must be read back after worker cutover')
    }
  }
  for (const field of REVIEW_EVIDENCE) {
    checkEvidence(field, { afterCutover: true })
  }
  const naturalRun = timestamp(packet.evidence?.naturalWorkerRuns?.effectiveAt)
  if (
    !Number.isFinite(naturalRun) ||
    !Number.isFinite(cutover) ||
    naturalRun < cutover ||
    naturalRun > now
  ) {
    block(
      'evidence.naturalWorkerRuns.effectiveAt',
      'Natural worker execution after cutover required; a smoke test is insufficient'
    )
  }

  // An empty list is permitted only alongside the verified routes/dependency inventory.
  if (!Array.isArray(packet.clients)) {
    block('clients', 'Explicit dependency-client inventory required')
  } else {
    const seen = new Set()
    packet.clients.forEach((client, index) => {
      const field = `clients[${index}]`
      if (!isObject(client) || !hasText(client.id) || seen.has(client.id)) {
        block(field, 'Unique client identity required')
        return
      }
      seen.add(client.id)
      if (!['live', 'exited'].includes(client.verdict)) {
        block(`${field}.verdict`, 'Client remains unverifiable; obtain owning-host evidence')
      }
      if (client.dependencyResolved !== true || !hasText(client.reference)) {
        block(field, 'Compatibility dependency resolution and owning-host reference required')
      }
      const observed = timestamp(client.observedAt)
      if (
        !Number.isFinite(observed) ||
        observed > now ||
        now - observed > MAX_EVIDENCE_AGE ||
        observed < cutover
      ) {
        block(`${field}.observedAt`, 'Fresh owning-host readback after cutover required')
      }
    })
  }

  if (phase === 'closure') {
    for (const field of CLOSURE_EVIDENCE) {
      checkEvidence(field)
    }
    const approved = timestamp(packet.evidence?.exactChangeApproval?.effectiveAt)
    const cancelled = timestamp(packet.evidence?.providerCancellation?.effectiveAt)
    const invoiced = timestamp(packet.evidence?.nextInvoice?.effectiveAt)
    if (!Number.isFinite(approved) || approved > now) {
      block(
        'evidence.exactChangeApproval.effectiveAt',
        'Dated approval for this exact resource required'
      )
    }
    if (
      !Number.isFinite(cancelled) ||
      !Number.isFinite(cutover) ||
      cancelled < cutover + OBSERVATION_PERIOD ||
      cancelled > now ||
      cancelled < approved
    ) {
      block(
        'evidence.providerCancellation.effectiveAt',
        'Cancellation must follow approval and 48-hour observation'
      )
    }
    if (
      !Number.isFinite(invoiced) ||
      !Number.isFinite(cancelled) ||
      invoiced <= cancelled ||
      invoiced > now
    ) {
      block(
        'evidence.nextInvoice.effectiveAt',
        'Authoritative next invoice after cancellation required'
      )
    }
  }

  return {
    candidateId: 'C01',
    phase,
    status: blockers.length
      ? 'blocked'
      : phase === 'closure'
        ? 'closure_evidence_complete'
        : 'ready_for_review',
    authorizesCancellation: false,
    blockers
  }
}

export function runCli(args, { env = process.env, read = readFileSync, write = console.log } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    write(`Usage: vendor-retirement-check.mjs <packet.json> [--phase review|closure]
       vendor-retirement-check.mjs --template
Enable with ${ENABLE_FLAG}=1. Read-only; exit 0 complete, 1 blocked, 2 invalid, 3 disabled.
Review requires the C01 migration/finance packet and 48 hours after worker cutover.
Closure also requires exact approval, provider cancellation and the next invoice.
References are supplied attestations, not independently authenticated by this tool.
All evidence must bind to the resource and have a readback in the past 24 hours.
Use ISO UTC timestamps (YYYY-MM-DDTHH:mm:ss[.SSS]Z). Keep secrets out of packets.
Source: W3-23 SaaS Vendor Consolidation Audit, C01; Slite fwh34pEQJxSvHF.`)
    return 0
  }
  if (args.length === 1 && args[0] === '--template') {
    const resource = { provider: '', accountId: '', instanceId: '', contractId: '' }
    const evidence = Object.fromEntries(
      [...REVIEW_EVIDENCE, ...CLOSURE_EVIDENCE].map((field) => [
        field,
        {
          status: 'pending',
          reference: '',
          observedAt: null,
          resource: { ...resource },
          ...(['naturalWorkerRuns', ...CLOSURE_EVIDENCE].includes(field)
            ? { effectiveAt: null }
            : {})
        }
      ])
    )
    write(
      JSON.stringify(
        {
          schemaVersion: 1,
          candidateId: 'C01',
          resource,
          workerCutoverAt: null,
          evidence,
          clients: [
            {
              id: '',
              verdict: 'unverifiable',
              dependencyResolved: false,
              reference: '',
              observedAt: null
            }
          ]
        },
        null,
        2
      )
    )
    return 0
  }
  if (env[ENABLE_FLAG] !== '1') {
    write(JSON.stringify({ status: 'disabled', flag: ENABLE_FLAG }))
    return 3
  }
  if (
    ![1, 3].includes(args.length) ||
    args[0].startsWith('-') ||
    (args.length === 3 && (args[1] !== '--phase' || !['review', 'closure'].includes(args[2])))
  ) {
    write(
      JSON.stringify({ status: 'invalid', error: 'Expected packet.json [--phase review|closure]' })
    )
    return 2
  }
  try {
    const packet = JSON.parse(read(args[0], 'utf8'))
    const result = assessRetirement(packet, { phase: args[2] ?? 'review' })
    write(JSON.stringify(result, null, 2))
    return result.status === 'blocked' ? 1 : 0
  } catch {
    // Do not echo arbitrary packet contents or filesystem errors into shared logs.
    write(JSON.stringify({ status: 'invalid', error: 'Cannot read a valid retirement packet' }))
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2))
}
