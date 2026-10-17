import { describe, expect, it } from 'vitest'
import { classifySessionFile, SESSION_VIDEO_EXTENSIONS } from './session-file-kind'

describe('classifySessionFile', () => {
  it.each([
    ['/w/shot.PNG', 'image'],
    ['/w/a.jpeg', 'image'],
    ['/w/logo.svg', 'image'],
    ['/w/hero.avif', 'image'],
    ['/w/clip.mp4', 'video'],
    ['/w/clip.MOV', 'video'],
    ['/w/clip.webm', 'video'],
    ['/w/index.html', 'html'],
    ['/w/index.htm', 'html'],
    ['/w/report.pdf', 'pdf'],
    ['/w/README.md', 'markdown'],
    ['/w/data.csv', 'csv'],
    ['/w/app.ts', 'other'],
    ['/w/.env', 'other'],
    ['C:\\w\\photo.jpg', 'image']
  ])('%s is %s', (path, kind) => {
    expect(classifySessionFile(path)).toBe(kind)
  })

  it('names exactly the video extensions for main-process thumbnails', () => {
    expect([...SESSION_VIDEO_EXTENSIONS].sort()).toEqual(['m4v', 'mov', 'mp4', 'webm'])
  })
})
