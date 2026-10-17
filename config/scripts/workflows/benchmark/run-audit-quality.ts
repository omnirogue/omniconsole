import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { runAuditQuality } from './audit-quality-run'
import { auditQualityScore } from './audit-quality-score'
import { auditQualityManifestSchema, validateAuditQualityScoring } from './audit-quality-validation'

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    model: { type: 'string' },
    out: { type: 'string' },
    repetitions: { type: 'string', default: '1' },
    observations: { type: 'string' },
    adjudications: { type: 'string' },
    manifest: { type: 'string' }
  }
})
if (!values.out) {
  throw new Error(
    'Pass --out <new-directory>; optionally --live --model <pinned-Claude-model>. Scoring: --manifest <file> --observations <file> --adjudications <file> --out <new-report-file>.'
  )
}
if (values.observations || values.adjudications || values.manifest) {
  if (!values.observations || !values.adjudications || !values.manifest || values.live) {
    throw new Error('Scoring needs manifest, observations and adjudications, without --live')
  }
  const manifest = auditQualityManifestSchema.parse(
    JSON.parse(readFileSync(values.manifest, 'utf8'))
  )
  const parsed = validateAuditQualityScoring(
    JSON.parse(readFileSync(values.observations, 'utf8')),
    JSON.parse(readFileSync(values.adjudications, 'utf8'))
  )
  if (
    parsed.trials.some(
      (trial) => trial.inputHash !== manifest.inputHash || trial.mode !== manifest.mode
    )
  ) {
    throw new Error('Observations do not match the frozen manifest')
  }
  const report = auditQualityScore(parsed.trials, parsed.labels, manifest.repetitions)
  writeFileSync(resolve(values.out), `${JSON.stringify(report, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600
  })
  console.log(JSON.stringify({ quality: report.quality, report: resolve(values.out) }))
} else {
  void runAuditQuality({
    directory: resolve(values.out),
    mode: values.live ? 'live' : 'fixture',
    model: values.model,
    repetitions: Number(values.repetitions)
  }).then(({ trials, report }) => {
    console.log(
      JSON.stringify({
        directory: resolve(values.out!),
        quality: report.quality,
        trials: trials.length,
        failures: trials.filter((trial) => trial.state === 'failed').length
      })
    )
    if (trials.some((trial) => trial.state === 'failed')) {
      process.exitCode = 1
    }
  })
}
