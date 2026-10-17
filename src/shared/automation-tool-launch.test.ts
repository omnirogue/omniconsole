import { expect, it } from 'vitest'
import { routineLaunchArgs, routineLaunchPreferences } from './automation-tool-launch'
it('reuses the existing read-only lineage flags and removes bypass overrides', () => {
  const preferences = routineLaunchPreferences({
    tools: { skills: [], mcpServers: [], allowWrite: false },
    launchPreferences: { model: 'test' }
  })
  expect(preferences).toEqual({ model: 'test', permissionMode: 'read-only' })
  const args = routineLaunchArgs(
    'codex',
    '--dangerously-bypass-approvals-and-sandbox --model test -c sandbox_mode="danger-full-access"',
    preferences
  )
  expect(args).toBe('--model test -s read-only -a never')
  expect(routineLaunchArgs('claude', '--dangerously-skip-permissions', preferences)).toBe(
    '--permission-mode plan'
  )
})
it('does not silently permit writes on unsupported lineages', () => {
  expect(() => routineLaunchArgs('hermes', '', { permissionMode: 'read-only' })).toThrow(
    'does not support'
  )
})
it('preserves defaults on legacy routines', () => {
  expect(routineLaunchPreferences({})).toBeUndefined()
})
