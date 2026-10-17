import { expect, it } from 'vitest'
import { isJunkSessionTitle } from './session-junk-title'

it('flags launcher, harness and id titles, not titles naming the work', () => {
  for (const title of [
    'worker-task_5ad8df40da3a',
    'Claude Code conversation',
    'codex session',
    'ssh-20260925-a',
    '0948b124-04e9-4a31-a794-e542c6736deb',
    'deadbeefcafe'
  ]) {
    expect(isJunkSessionTitle(title)).toBe(true)
  }
  for (const title of ['Parser fix', 'Ads: Q4 headlines', 'claude', '', null, undefined]) {
    expect(isJunkSessionTitle(title)).toBe(false)
  }
})
