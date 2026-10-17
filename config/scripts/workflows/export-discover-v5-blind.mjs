#!/usr/bin/env node
// Pre-registered, model-masked first-outcome export. No provider calls.
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import assert from 'node:assert/strict'

const ARMS = ['workflow', 'baseline-low', 'baseline-high']
const FIELDS = ['title', 'location', 'trigger', 'impact', 'severity']
const FORBIDDEN =
  /\b(?:claude|sonnet|grok|codex|gemini|anthropic|openai|baseline|workflow|ranking|model usage|cli)\b/i

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${name}`)
  }
  return value.trim()
}

function textOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeFinding(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Malformed finding')
  }
  const finding = Object.fromEntries(FIELDS.map((field) => [field, textOrEmpty(raw[field])]))
  if (!finding.title) {
    throw new Error('Finding without title')
  }
  if (!['low', 'medium', 'high', 'critical'].includes(finding.severity)) {
    throw new Error(`Invalid finding severity: ${finding.severity}`)
  }
  if (!Array.isArray(raw.evidence)) {
    throw new Error('Finding without evidence list')
  }
  const seen = new Set()
  finding.evidence = raw.evidence
    .map((item) => {
      const evidence = {
        ref: requiredText(item?.ref, 'evidence ref'),
        description: requiredText(item?.description, 'evidence description')
      }
      const key = JSON.stringify(evidence)
      if (seen.has(key)) {
        return null
      }
      seen.add(key)
      return evidence
    })
    .filter(Boolean)
  return finding
}

function workflowAnswer(report) {
  const outcome = report.firstOutcome
  if (!outcome || typeof outcome.state !== 'string') {
    throw new Error('Missing first outcome')
  }
  if (outcome.state !== 'completed') {
    return { status: 'failed', confirmedFindings: [], unconfirmedNotes: [] }
  }
  const assessed = outcome.result?.assessed
  if (!Array.isArray(assessed)) {
    throw new Error('Completed workflow lacks assessed claims')
  }
  const confirmedFindings = []
  const unconfirmedNotes = []
  for (const claim of assessed) {
    if (claim.disposition === 'survives') {
      confirmedFindings.push(normalizeFinding(claim))
    } else if (['contested', 'refuted', 'insufficient-evidence'].includes(claim.disposition)) {
      const reasons = Array.isArray(claim.votes)
        ? [...new Set(claim.votes.map((vote) => textOrEmpty(vote?.reason)).filter(Boolean))]
        : []
      unconfirmedNotes.push({
        claim: requiredText(claim.title, 'unconfirmed claim title'),
        disposition: claim.disposition.replaceAll('-', ' '),
        reason: reasons.join(' ') || 'The available evidence did not confirm this claim.'
      })
    } else {
      throw new Error(`Unexpected workflow disposition: ${String(claim.disposition)}`)
    }
  }
  return { status: 'completed', confirmedFindings, unconfirmedNotes }
}

function baselineAnswer(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Missing baseline record')
  }
  if (record.error || !record.value || record.process?.code !== 0 || record.process?.timedOut) {
    return { status: 'failed', confirmedFindings: [], unconfirmedNotes: [] }
  }
  if (!Array.isArray(record.value.findings)) {
    throw new Error('Completed baseline lacks findings')
  }
  const confirmedFindings = record.value.findings.map(normalizeFinding)
  const note = textOrEmpty(record.value.omissionReason)
  const unconfirmedNotes =
    note && !/^(?:none\.?|n\/a|no omissions?\.?|)$/i.test(note)
      ? [{ claim: '', disposition: 'not claimed', reason: note }]
      : []
  return { status: 'completed', confirmedFindings, unconfirmedNotes }
}

function packet(caseData, answer, packetId) {
  return {
    packetId,
    task: {
      prompt: requiredText(caseData.prompt, 'case prompt'),
      evidence: caseData.evidence.map((item) => ({
        ref: requiredText(item.ref, 'case evidence ref'),
        text: requiredText(item.text, 'case evidence text')
      }))
    },
    answer
  }
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[array[i], array[j]] = [array[j], array[i]]
  }
  return array
}

function csvValue(value) {
  const text = String(value ?? '')
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function ratingsCsv(packets) {
  const header = [
    'packet_id',
    'row_type',
    'claim_index',
    'claim_supported_yes_no_unclear',
    'supported_root_in_your_words',
    'duplicate_of_claim_index',
    'severity_low_medium_high_critical',
    'missed_supported_roots',
    'unconfirmed_note_assessment',
    'comments'
  ]
  const rows = [header]
  for (const item of packets) {
    item.answer.confirmedFindings.forEach((_, index) => {
      rows.push([item.packetId, 'claim', index + 1, '', '', '', '', '', '', ''])
    })
    rows.push([item.packetId, 'summary', '', '', '', '', '', '', '', ''])
  }
  return `${rows.map((row) => row.map(csvValue).join(',')).join('\n')}\n`
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) {
      throw new Error('Use --manifest, --reports, --packets, --key')
    }
    args.set(argv[i], argv[i + 1])
  }
  for (const key of ['--manifest', '--reports', '--packets', '--key']) {
    if (!args.has(key)) {
      throw new Error(`Missing ${key}`)
    }
  }
  return Object.fromEntries([...args].map(([key, value]) => [key.slice(2), resolve(value)]))
}

function isWithin(parent, child) {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'))
}

function exportPackets({
  manifest: manifestPath,
  reports: reportsDir,
  packets: packetDir,
  key: keyPath
}) {
  if (existsSync(packetDir) || existsSync(keyPath)) {
    throw new Error('Output packets or key already exist')
  }
  if (isWithin(packetDir, keyPath) || isWithin(keyPath, packetDir)) {
    throw new Error('Private key must be outside the packet directory')
  }
  const manifestBytes = readFileSync(manifestPath)
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex')
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (
    manifest.version !== 5 ||
    !manifest.frozenAt ||
    !Array.isArray(manifest.cases) ||
    manifest.cases.length !== 6
  ) {
    throw new Error('Expected a frozen six-case Discover v5 manifest')
  }
  const cases = new Set()
  const entries = []
  const heads = new Set()
  for (const caseData of manifest.cases) {
    const caseId = requiredText(caseData.id, 'case ID')
    if (cases.has(caseId)) {
      throw new Error(`Duplicate case ID: ${caseId}`)
    }
    cases.add(caseId)
    const reportPath = join(reportsDir, caseId, 'quality-report.json')
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    if (report.caseId !== caseId || report.manifestSha256 !== manifestSha256) {
      throw new Error(`Case/manifest mismatch in ${reportPath}`)
    }
    if (report.limits?.discoverProgramRevision !== 4) {
      throw new Error(`Unexpected Discover revision in ${reportPath}`)
    }
    heads.add(requiredText(report.sourceHead, 'source HEAD'))
    if (
      !report.baselines ||
      !Object.hasOwn(report.baselines, 'low') ||
      !Object.hasOwn(report.baselines, 'high')
    ) {
      throw new Error(`Both baseline records required in ${reportPath}`)
    }
    const answers = [
      workflowAnswer(report),
      baselineAnswer(report.baselines.low),
      baselineAnswer(report.baselines.high)
    ]
    ARMS.forEach((arm, index) => {
      const packetId = `P-${randomUUID()}`
      const data = packet(caseData, answers[index], packetId)
      if (FORBIDDEN.test(JSON.stringify(data))) {
        throw new Error(
          `Producer identity text found in ${caseId} ${arm}; review and normalize before export`
        )
      }
      entries.push({ caseId, arm, reportPath, data })
    })
  }
  if (heads.size !== 1) {
    throw new Error('Reports do not share one source HEAD')
  }
  shuffle(entries)
  const publicPackets = entries.map((entry) => entry.data)
  const privateKey = {
    manifestSha256,
    sourceHead: [...heads][0],
    packetOrder: entries.map((entry, index) => ({
      order: index + 1,
      packetId: entry.data.packetId,
      caseId: entry.caseId,
      arm: entry.arm,
      reportPath: entry.reportPath
    }))
  }
  mkdirSync(packetDir)
  writeFileSync(keyPath, `${JSON.stringify(privateKey, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  for (let i = 0; i < publicPackets.length; i++) {
    writeFileSync(
      join(packetDir, `${String(i + 1).padStart(2, '0')}-${publicPackets[i].packetId}.json`),
      `${JSON.stringify(publicPackets[i], null, 2)}\n`,
      { flag: 'wx' }
    )
  }
  for (const rater of [1, 2]) {
    writeFileSync(join(packetDir, `rater-${rater}-scores.csv`), ratingsCsv(publicPackets), {
      flag: 'wx'
    })
  }
  writeFileSync(
    join(packetDir, 'RATER-INSTRUCTIONS.md'),
    '# Discover blind review\n\nReview each packet using only its task and answer. The answer is a first attempt. Treat only `confirmedFindings` as claims. `unconfirmedNotes` are not confirmed findings. For each claim, mark support, describe the distinct root cause in your own words, identify a duplicate claim index if any, and rate severity. In the summary row, record any supported root the answer missed and assess the unconfirmed notes. Keep your ratings private from the other rater. Do not seek the manifest, seeded truth, reports, or private arm key. Lock both rating files before adjudication and unblinding.\n',
    { flag: 'wx' }
  )
  console.log(
    JSON.stringify({
      packetCount: publicPackets.length,
      packetDir,
      keyPath,
      manifestSha256,
      sourceHead: [...heads][0]
    })
  )
}

function selfTest() {
  const finding = {
    issueKey: 'hidden',
    title: 'A defect',
    location: 'x:1',
    trigger: 'when called',
    impact: 'bad',
    severity: 'high',
    evidence: [{ ref: 'x:1', description: 'proof' }]
  }
  const result = workflowAnswer({
    firstOutcome: {
      state: 'completed',
      result: {
        assessed: [
          { ...finding, disposition: 'survives' },
          {
            ...finding,
            title: 'Maybe',
            disposition: 'contested',
            votes: [{ reason: 'not established' }]
          }
        ]
      }
    }
  })
  assert.equal(result.confirmedFindings.length, 1)
  assert.equal(result.unconfirmedNotes.length, 1)
  assert.equal(result.confirmedFindings[0].issueKey, undefined)
  assert.equal(
    baselineAnswer({ process: { code: 0 }, value: { findings: [finding], omissionReason: '' } })
      .confirmedFindings.length,
    1
  )
  assert.equal(baselineAnswer({ error: 'failed' }).status, 'failed')
  assert.equal(workflowAnswer({ firstOutcome: { state: 'failed' } }).status, 'failed')
  const masked = packet(
    { prompt: 'Inspect', evidence: [{ ref: 'x:1', text: 'source' }] },
    result,
    'P-test'
  )
  assert.deepEqual(Object.keys(masked), ['packetId', 'task', 'answer'])
  assert.equal(ratingsCsv([masked]).split('\n').length, 4)
  console.log('blind export self-test passed')
}

if (process.argv.length === 3 && process.argv[2] === '--self-test') {
  selfTest()
} else {
  exportPackets(parseArgs(process.argv.slice(2)))
}
