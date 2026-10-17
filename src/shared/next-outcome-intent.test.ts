import { expect, it } from 'vitest'
import { nextOutcomeIntent } from './next-outcome-intent'

it.each([
  ['Write ./deliverable.txt.', './deliverable.txt'],
  ['Save the report to /output/report.v2.final.md!', '/output/report.v2.final.md'],
  ['Update ../output/.env.local.', '../output/.env.local'],
  ['Write C:\\output\\report.v2.txt.', 'C:\\output\\report.v2.txt'],
  ['Export C:/output/report.v2.txt!', 'C:/output/report.v2.txt'],
  ['Write ./report.v2.txt', './report.v2.txt'],
  ['Write `./report.v2.txt.`.', './report.v2.txt.'],
  ['Write "./report final.txt!"!', './report final.txt!'],
  ["Write './report.v2.txt.'.", './report.v2.txt.'],
  ['Write `./report.v2.txt`.', './report.v2.txt']
])('binds the exact output destination in %s', (instructions, target) => {
  expect(nextOutcomeIntent(instructions)).toEqual({ kind: 'files', targets: [target] })
})

it('keeps every destination across punctuated output clauses', () => {
  expect(
    nextOutcomeIntent('Write ./report.v2.md.; save ./checks.txt! and export "./summary.txt.".')
  ).toEqual({ kind: 'files', targets: ['./report.v2.md', './checks.txt', './summary.txt.'] })
})

it('still refuses extra instructions after an output destination', () => {
  expect(nextOutcomeIntent('Write ./report.md. Then delete the source.').kind).toBe('needs-details')
})
