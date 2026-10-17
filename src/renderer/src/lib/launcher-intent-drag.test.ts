/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest'
import { isSessionSidebarDrag } from '../../../shared/session-sidebar-drag-types'
import {
  beginLaunchIntentDrag,
  clearLaunchIntentDrag,
  getLaunchIntentDrag,
  LAUNCH_INTENT_DRAG_TYPE,
  readLaunchIntentDrag
} from './launcher-intent-drag'

function transfer() {
  const entries = new Map<string, string>()
  return {
    types: [] as string[],
    setData(type: string, value: string) {
      entries.set(type, value)
      this.types = [...entries.keys()]
    },
    getData(type: string) {
      return entries.get(type) ?? ''
    }
  }
}
afterEach(() => clearLaunchIntentDrag())
describe('launch intent drag', () => {
  it('serializes the provider, passes the preload guard, and retains dragover state', () => {
    const data = transfer()
    beginLaunchIntentDrag(data, { agent: 'codex' })
    expect(data.getData(LAUNCH_INTENT_DRAG_TYPE)).toBe('{"agent":"codex"}')
    expect(isSessionSidebarDrag(data.types)).toBe(true)
    expect(readLaunchIntentDrag(data)).toEqual({ agent: 'codex' })
    expect(getLaunchIntentDrag()).toEqual({ agent: 'codex' })
    clearLaunchIntentDrag()
    expect(getLaunchIntentDrag()).toBeNull()
    expect(isSessionSidebarDrag(['text/plain'])).toBe(false)
  })
  it('rejects malformed and unknown providers and strips untrusted fields', () => {
    const data = transfer()
    for (const value of ['{', 'null', '{}', '{"agent":"shell"}']) {
      data.setData(LAUNCH_INTENT_DRAG_TYPE, value)
      expect(readLaunchIntentDrag(data)).toBeNull()
    }
    data.setData(
      LAUNCH_INTENT_DRAG_TYPE,
      '{"agent":"claude","account":{"launchEnv":{"TOKEN":"untrusted"}}}'
    )
    expect(readLaunchIntentDrag(data)).toEqual({ agent: 'claude' })
  })

  it('LP-03: an owner clears only its own drag', () => {
    const first = beginLaunchIntentDrag(transfer(), { agent: 'codex' })
    beginLaunchIntentDrag(transfer(), { agent: 'claude' })
    clearLaunchIntentDrag(first)
    expect(getLaunchIntentDrag()).toEqual({ agent: 'claude' })
  })
  it.each([
    ['a drop anywhere', () => window.dispatchEvent(new Event('drop'))],
    ['a dragend anywhere', () => window.dispatchEvent(new Event('dragend'))],
    ['Escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))]
  ])('LP-03: %s ends the in-flight drag', (_name, end) => {
    beginLaunchIntentDrag(transfer(), { agent: 'codex' })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(getLaunchIntentDrag()).toEqual({ agent: 'codex' })
    end()
    expect(getLaunchIntentDrag()).toBeNull()
  })
})
