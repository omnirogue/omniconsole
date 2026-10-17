const { createHash } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const directory = join(process.cwd(), 'docs/workflows/evidence/quality-diagnostics-2026-09-21')
mkdirSync(directory, { recursive: true })
const cases = [
  { id: 'council-01', name: 'council01', head: '930c06812', mode: 'plan', exitCode: 0 },
  { id: 'discover-01', name: 'discover01', head: '930c06812', mode: 'plan', exitCode: 0 },
  { id: 'council-02', name: 'council02', head: 'c800ecdda', mode: 'plan', exitCode: 0 },
  { id: 'discover-02', name: 'discover02', head: 'fb7f2fde0', mode: 'plan', exitCode: 1 },
  { id: 'council-03', name: 'council03', head: 'a77f171b3', mode: 'dontAsk', exitCode: 0 }
]
const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/workflows/quality-gate-small-2026-09-21.json'), 'utf8')
)
const rows = []
for (const item of cases) {
  const source = `/tmp/omni-workflow-quality-${item.name}-0921`
  const report = JSON.parse(readFileSync(join(source, 'quality-report.json'), 'utf8'))
  const score = JSON.parse(readFileSync(join(source, 'blind-score.json'), 'utf8'))
  const blindMap = JSON.parse(readFileSync(join(source, 'blind-map.json'), 'utf8'))
  const caseInput = manifest.cases.find((entry) => entry.id === item.id)
  const attempts = report.attempts.map((attempt) => {
    const receipt = attempt.receipt_json ? JSON.parse(attempt.receipt_json) : null
    const terminalPath = join(source, attempt.id, 'terminal.json')
    const terminal = existsSync(terminalPath)
      ? JSON.parse(readFileSync(terminalPath, 'utf8'))
      : null
    return {
      id: attempt.id,
      callId: attempt.call_id,
      ordinal: attempt.ordinal,
      state: attempt.state,
      liveness: receipt?.liveness ?? null,
      resolvedModels: receipt?.resolvedModels ?? null,
      usage: receipt?.usage ?? null,
      terminal: terminal
        ? {
            code: terminal.result.code,
            signal: terminal.result.signal,
            timedOut: terminal.result.timedOut,
            stdoutTruncated: terminal.result.stdoutTruncated ?? false,
            stderrTruncated: terminal.result.stderrTruncated ?? false,
            groupCleanupRequired: terminal.groupCleanupRequired
          }
        : null
    }
  })
  const output = {
    testId: item.id,
    status: report.outcome.state === 'completed' ? 'pass-execution-only' : 'fail',
    sourceHeadAtStart: item.head,
    sourceHeadBasis:
      'Git commit timestamps bracket recorded run start; in-process module imports are not a signed build.',
    cliVersions: { claude: '2.1.278', codex: '0.155.1', grok: '1.0.30 (04b7ffed98c6)' },
    accountReference: 'configured-local diagnostic; no credential copied',
    claudePermissionMode: item.mode,
    policyBasis:
      'Persisted Claude launch command digest independently matched this exact mode and not the opposite mode.',
    manifestSha256: report.manifestSha256,
    caseInputSha256: createHash('sha256')
      .update(JSON.stringify({ prompt: caseInput.prompt, evidence: caseInput.evidence }))
      .digest('hex'),
    command: `npx --yes tsx config/scripts/workflows/probe-held-out-quality.ts ${item.id} /tmp/omni-workflow-quality-${item.name}-0921`,
    exitCode: item.exitCode,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    executionId: report.executionId,
    outcome: report.outcome,
    baseline: {
      model: report.baseline.resolvedModels,
      value: report.baseline.value,
      usage: report.baseline.usage,
      startedAt: report.baseline.startedAt,
      endedAt: report.baseline.endedAt
    },
    attempts,
    externalLedger: report.ledger.map(({ event, attemptId, callId, code, at }) => ({
      event,
      attemptId,
      callId,
      code: code ?? null,
      at
    })),
    replayMatches: report.replayMatches,
    blindScore: { ...score, revealedLabels: blindMap },
    cost: 'Provider receipts report usage but not a reliable currency charge.',
    gateStatus:
      'Diagnostic only. These five mixed-policy cases are excluded from the later stable-head 12-case release evaluation.'
  }
  writeFileSync(join(directory, `${item.id}.json`), `${JSON.stringify(output, null, 2)}\n`)
  rows.push({
    id: item.id,
    state: report.outcome.state,
    mode: item.mode,
    head: item.head,
    externalLaunches: report.ledger.filter((row) => row.event === 'spawn').length,
    baselineScore: score[blindMap.A === 'baseline' ? 'A' : 'B'].total,
    workflowScore: score[blindMap.A === 'workflow' ? 'A' : 'B'].total
  })
}
const summary = {
  kind: 'mixed-policy diagnostics, not Gate E release results',
  frozenManifestSha256: createHash('sha256')
    .update(readFileSync(join(process.cwd(), 'docs/workflows/quality-gate-small-2026-09-21.json')))
    .digest('hex'),
  casesRun: rows.length,
  completed: rows.filter((row) => row.state === 'completed').length,
  failed: rows.filter((row) => row.state !== 'completed').length,
  independentHumanScores: 0,
  stableHeadReleaseCases: 0,
  rows
}
writeFileSync(join(directory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
process.stdout.write(
  `${JSON.stringify({ directory, cases: rows.length, failed: summary.failed })}\n`
)
