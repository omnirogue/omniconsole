import { expect, it } from 'vitest'
import { folderGlance, summarizeAssistantMessage } from './next-step-outcome-facts'

it('names a folder by its last two segments on any platform', () => {
  expect(folderGlance('/Users/maintainer/Work/OmniAgentOS')).toBe('Work/OmniAgentOS')
  expect(folderGlance('C:\\Users\\sal\\Desktop\\')).toBe('sal/Desktop')
  expect(folderGlance('/work')).toBe('work')
  expect(folderGlance('/')).toBe('/')
})

it('folds whitespace and leaves short answers whole', () => {
  expect(summarizeAssistantMessage('  Done.\n\nThe  tests pass. ')).toBe('Done. The tests pass.')
  expect(summarizeAssistantMessage('')).toBeNull()
  expect(summarizeAssistantMessage(undefined)).toBeNull()
})

it('cuts a long answer on a word boundary and marks the cut', () => {
  const words = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ')
  const summary = summarizeAssistantMessage(words, 60)!
  expect(summary.length).toBeLessThanOrEqual(61)
  expect(summary.endsWith('…')).toBe(true)
  expect(summary.slice(0, -1).endsWith('word')).toBe(false)
  expect(summary.slice(0, -1)).toBe(words.slice(0, summary.length - 1))
})

it('cuts inside a word only when the text has no usable space', () => {
  expect(summarizeAssistantMessage('x'.repeat(30), 10)).toBe(`${'x'.repeat(10)}…`)
})
