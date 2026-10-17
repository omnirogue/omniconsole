const { createHash, randomInt } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { dirname, isAbsolute, join, relative, resolve } = require('node:path')

const reportPath = process.argv[2]
if (!reportPath || process.argv.length > 5) {
  throw new Error(
    'Use: node blind-quality-report.cjs <quality-report.json> [packet-dir] [map-file]'
  )
}

const reportFile = resolve(reportPath)
const directory = dirname(reportFile)
const packetDir = resolve(process.argv[3] ?? join(directory, 'rater-packet'))
const mapFile = resolve(process.argv[4] ?? join(directory, 'blind-map.json'))
const within = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}
if (within(packetDir, mapFile) || within(packetDir, reportFile)) {
  throw new Error('The arm map and raw report must be outside the rater packet')
}
if (existsSync(packetDir) || existsSync(mapFile)) {
  throw new Error('Blinded packet or arm map already exists; keep the original randomization')
}

const reportBytes = readFileSync(reportFile)
const report = JSON.parse(reportBytes.toString('utf8'))
if (!['council', 'discover'].includes(report.preset) || !report.caseId) {
  throw new Error('Expected a Council or Discover quality report with a case ID')
}
const stable = Object.hasOwn(report, 'finalOutcome') || Object.hasOwn(report, 'baselines')
const outcome = stable ? report.finalOutcome : report.outcome
const baselines = stable ? report.baselines : { baseline: report.baseline }
const arms = stable ? ['workflow', 'baseline-low', 'baseline-high'] : ['workflow', 'baseline']
if (!outcome || !baselines || (stable ? !baselines.low || !baselines.high : !baselines.baseline)) {
  throw new Error('Quality report lacks the workflow outcome or a required baseline')
}

const fields = ['title', 'location', 'trigger', 'impact', 'severity', 'evidence']
const normalize = (findings) =>
  findings.map((finding) => Object.fromEntries(fields.map((field) => [field, finding[field]])))
const noOutput = 'NO OUTPUT (execution or parsing failed)\n'
const render = (arm) => {
  const result =
    arm === 'workflow' ? outcome.result : baselines[stable ? arm.slice(9) : 'baseline']?.value
  if (arm === 'workflow' && outcome.state !== 'completed') {
    return noOutput
  }
  if (!result) {
    return noOutput
  }
  if (report.preset === 'council') {
    const markdown = arm === 'workflow' ? result.synthesis?.markdown : result.markdown
    return typeof markdown === 'string' && markdown.trim() ? `${markdown}\n` : noOutput
  }
  const findings = arm === 'workflow' ? result.survivors : result.findings
  if (!Array.isArray(findings)) {
    return noOutput
  }
  const ranking = arm === 'workflow' ? result.ranking?.ranking : null
  const ordered = Array.isArray(ranking)
    ? [...findings].sort(
        (a, b) =>
          ranking.findIndex((item) => item.findingId === a.id) -
          ranking.findIndex((item) => item.findingId === b.id)
      )
    : findings
  return `${JSON.stringify(normalize(ordered), null, 2)}\n`
}

let caseText = `# ${report.caseId}\n\nPreset: ${report.preset}\n`
if (stable) {
  const manifestPath = resolve(
    __dirname,
    '../../../docs/workflows/quality-gate-small-2026-09-21.json'
  )
  const manifestBytes = readFileSync(manifestPath)
  const digest = createHash('sha256').update(manifestBytes).digest('hex')
  if (digest !== report.manifestSha256) {
    throw new Error('Report and frozen quality manifest hashes differ')
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const testCase = manifest.cases.find((item) => item.id === report.caseId)
  if (!testCase) {
    throw new Error('Case ID is absent from the frozen quality manifest')
  }
  const rubric = manifest.rubric[report.preset]
  caseText += `\n## Task\n\n${testCase.prompt}\n\n## Evidence\n\n${testCase.evidence.map((item) => `- ${item.ref}: ${item.text}`).join('\n')}\n\n## Rating axes\n\n${rubric.map((axis, index) => `${index + 1}. ${axis}`).join('\n')}\n\nScore each axis 0 (miss/harm), 1 (partial), or 2 (sound). Record an overall preference and reasons. Rate a missing output as zero.\n`
} else {
  caseText +=
    '\nThe legacy report does not contain its frozen task. Provide that task separately before rating.\n'
}

const shuffled = [...arms]
for (let i = shuffled.length - 1; i > 0; i--) {
  const j = randomInt(i + 1)
  ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
}
const armByLabel = Object.fromEntries(
  shuffled.map((arm, index) => [String.fromCharCode(65 + index), arm])
)
mkdirSync(packetDir, { recursive: true })
writeFileSync(join(packetDir, 'case.md'), caseText)
for (const [label, arm] of Object.entries(armByLabel)) {
  writeFileSync(join(packetDir, `${label}.txt`), render(arm))
}
writeFileSync(
  mapFile,
  `${JSON.stringify({ caseId: report.caseId, reportSha256: createHash('sha256').update(reportBytes).digest('hex'), armByLabel }, null, 2)}\n`,
  { flag: 'wx', mode: 0o600 }
)
process.stdout.write(
  `Blinded ${report.caseId}: ${packetDir} (${arms.length} arms); map: ${mapFile}\n`
)
