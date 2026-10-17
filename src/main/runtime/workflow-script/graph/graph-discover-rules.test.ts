import { expect, it } from 'vitest'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { graphSnapshotRules } from './graph-snapshot-rules'
import {
  graphDiscoverVerifyAdmission,
  graphDiscoverVerifyRules,
  graphUsesLegacyVerification
} from './graph-discover-rules'

const spec = workflowTemplate('discover', ['claude', 'codex'])
it('freezes the verification version for new quoted Discover runs and reads it for replay', () => {
  const fields = graphDiscoverVerifyAdmission(spec)
  expect(fields).toEqual({ discoverVerifyRules: 1 })
  expect(graphSnapshotRules({ host: fields })).toMatchObject(fields)
  expect(graphUsesLegacyVerification({ config: { spec, ...fields } })).toBe(false)
})
it('keeps missing/old versions, older specs and other templates on their recorded contract', () => {
  expect(graphDiscoverVerifyRules({})).toEqual({})
  expect(graphUsesLegacyVerification({})).toBe(true)
  expect(graphUsesLegacyVerification({ config: { spec } })).toBe(true)
  const older = {
    ...spec,
    steps: spec.steps.map((step) =>
      step.list ? { ...step, list: { maxItems: step.list.maxItems } } : step
    )
  }
  expect(graphDiscoverVerifyAdmission(older)).toEqual({})
  expect(graphUsesLegacyVerification({ config: { spec: older, discoverVerifyRules: 1 } })).toBe(
    true
  )
  expect(
    graphDiscoverVerifyAdmission(workflowTemplate('investigate', ['claude', 'codex']))
  ).toEqual({})
})
it('refuses an unknown future verification version', () => {
  expect(() => graphDiscoverVerifyRules({ host: { discoverVerifyRules: 2 } })).toThrow(
    'Unsupported Discover verification rules: 2'
  )
})
