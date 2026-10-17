import { expect, it } from 'vitest'
import type { Automation } from './automations-types'
import { routineDepartmentSlug, routineMacDependence } from './routine-mac-dependence'
const clean = {
  projectId: '',
  executionTargetType: 'local',
  executionTargetId: 'local',
  workspaceMode: 'new_per_run',
  workspaceId: null,
  prompt: 'Summarize server activity',
  precheck: null
} as Automation
it('passes a routine with no machine dependencies', () =>
  expect(routineMacDependence(clean)).toEqual([]))
it.each([
  [{ projectId: 'project' }, 'project'],
  [{ runContext: { projectId: 'logical-project' } }, 'project'],
  [{ executionTargetType: 'ssh', executionTargetId: 'remote' }, 'host'],
  [{ executionTargetId: 'override' }, 'host'],
  [{ workspaceMode: 'existing' }, 'workspace'],
  [{ workspaceId: 'workspace' }, 'workspace'],
  [{ prompt: 'Read /Users/maintainer/report' }, 'path'],
  [{ prompt: 'Read ~/report' }, 'path'],
  [{ prompt: 'Read C:\\reports' }, 'path'],
  [{ precheck: { command: 'check', timeoutSeconds: 1 } }, 'precheck']
])('explains dependency %j', (patch, reason) =>
  expect(routineMacDependence({ ...clean, ...patch } as Automation)).toEqual([reason])
)
it('returns all applicable reasons', () =>
  expect(
    routineMacDependence({
      ...clean,
      projectId: 'p',
      workspaceId: 'w',
      prompt: '~/file'
    })
  ).toEqual(['project', 'workspace', 'path']))
it.each([
  ['Marketing Ops', 'marketing-ops'],
  ['  Sales & Support! ', 'sales-support'],
  ['---A---B---', 'a-b'],
  ['你好', ''],
  ['', '']
])('slugifies %s defensively', (name, slug) => expect(routineDepartmentSlug(name)).toBe(slug))
