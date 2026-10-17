import { describe, expect, it } from 'vitest'
import { workspaceLaunchTaskId } from './workspace-launch-task'

describe('workspace launch task binding', () => {
  const folders = [{ id: 'f1', linkedTask: { hubTaskId: 'btk_folder' } }]
  it('keeps the explicit task binding ahead of folder metadata', () => {
    expect(workspaceLaunchTaskId('folder:f1', 'btk_explicit', folders)).toBe('btk_explicit')
  })
  it('finds both folder keys and legacy folder ids', () => {
    expect(workspaceLaunchTaskId('folder:f1', undefined, folders)).toBe('btk_folder')
    expect(workspaceLaunchTaskId('f1', undefined, folders)).toBe('btk_folder')
  })
  it('does not bind an unrelated workspace', () => {
    expect(workspaceLaunchTaskId('repo::/work', undefined, folders)).toBeUndefined()
  })
})
