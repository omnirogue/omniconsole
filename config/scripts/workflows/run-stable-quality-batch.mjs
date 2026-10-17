import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const manifestPath = 'docs/workflows/quality-gate-small-2026-09-21.json'
const expectedManifest = '7242abce4716524cb9b551e942457fc5b5c1a1edfb84efc212ff41ae464f4455'
const manifestBytes = readFileSync(manifestPath)
const manifestSha = createHash('sha256').update(manifestBytes).digest('hex')
if (manifestSha !== expectedManifest) {
  throw new Error('Frozen quality manifest changed')
}
const cases = JSON.parse(manifestBytes.toString('utf8')).cases.map((item) => item.id)
if (cases.length !== 12 || new Set(cases).size !== 12) {
  throw new Error('Expected exactly twelve unique frozen quality cases')
}
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
const mode = process.argv[2]
if (mode === '--plan') {
  const outputRoot = process.argv[3] ?? '/tmp/omni-workflow-quality-stable-<new-batch-id>'
  const plan = {
    status: dirty ? 'not-ready-dirty-source' : 'ready-for-final-head-review',
    expectedHead: head,
    frozenManifestSha256: manifestSha,
    frozenCases: cases,
    defaultLimits: {
      council: { logicalCalls: 7, persistedAttemptsPerCall: 3, hostAttemptAllowance: 21 },
      discover: { logicalCalls: 28, persistedAttemptsPerCall: 3, hostAttemptAllowance: 84 },
      automaticAttemptsPerRun: 1,
      explicitRepairsAfterVerifiedExit: 2,
      baselineCalls: 24
    },
    forecast:
      'About 40–90 minutes at one Discover candidate per case; 654 is the hard 12-case workflow-plus-two-baselines launch ceiling. Extra candidates or repairs increase time and cost.',
    command: `node config/scripts/workflows/run-stable-quality-batch.mjs --run ${head} ${outputRoot} --repair-verified`
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  process.exit(0)
}
const [expectedHead, outputRoot, repairFlag] = process.argv.slice(3)
if (mode !== '--run' || !expectedHead || !outputRoot || repairFlag !== '--repair-verified') {
  throw new Error('Use --plan or --run <exact-head> <new-output-dir> --repair-verified')
}
if (head !== expectedHead || dirty || existsSync(outputRoot)) {
  throw new Error('Quality batch requires exact clean source head and a new output directory')
}
mkdirSync(outputRoot)
const rows = []
for (const caseId of cases) {
  const directory = join(outputRoot, caseId)
  const command = [
    '--yes',
    'tsx',
    'config/scripts/workflows/probe-stable-quality-case.ts',
    caseId,
    directory,
    expectedHead,
    '--repair-verified'
  ]
  const startedAt = new Date().toISOString()
  const result = spawnSync('npx', command, { stdio: 'inherit', timeout: 4 * 60 * 60 * 1000 })
  const reportPath = join(directory, 'quality-report.json')
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
  const row = {
    caseId,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    firstState: report?.firstOutcome?.state ?? null,
    finalState: report?.finalOutcome?.state ?? null,
    explicitRepairs: Math.max(0, (report?.outcomes?.length ?? 1) - 1),
    reportPath: report ? reportPath : null
  }
  rows.push(row)
  writeFileSync(
    join(outputRoot, 'batch-progress.json'),
    `${JSON.stringify(
      {
        expectedHead,
        manifestSha256: manifestSha,
        rows
      },
      null,
      2
    )}\n`
  )
  process.stdout.write(`${JSON.stringify(row)}\n`)
  if (result.status !== 0 && !report) {
    process.exitCode = 1
    break
  }
}
if (rows.some((row) => row.exitCode !== 0 || row.finalState !== 'completed')) {
  process.exitCode = 1
}
