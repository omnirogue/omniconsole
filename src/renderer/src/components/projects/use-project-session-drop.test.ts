import { expect, it } from 'vitest'
import { droppedSessionKeys } from './use-project-session-drop'

it('files the dragged row alone without a batch', () => {
  expect(droppedSessionKeys('a', undefined)).toEqual(['a'])
})

it('files every picked session when the batch holds only sessions', () => {
  expect(droppedSessionKeys('a', { sessionKeys: ['a', 'b'], folderIds: [] })).toEqual(['a', 'b'])
})

it('files only the row when the batch also holds folders', () => {
  expect(droppedSessionKeys('a', { sessionKeys: ['a', 'b'], folderIds: ['f'] })).toEqual(['a'])
})
