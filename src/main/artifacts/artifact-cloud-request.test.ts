import { describe, expect, it } from 'vitest'
import type { ArtifactWriteRequest } from '../../shared/artifacts'
import { artifactWriteBody } from './artifact-cloud-request'

const plain: ArtifactWriteRequest = {
  sourceKey: '/repo/report.html',
  content: '<h1>Hi</h1>',
  contentType: 'text/html',
  fileName: 'report.html',
  apiUrl: 'http://localhost:3000',
  authToken: 'token-a'
}

describe('artifactWriteBody', () => {
  it('keeps the plain share body byte-for-byte unchanged without review flags', () => {
    expect(JSON.stringify(artifactWriteBody(plain))).toBe(
      '{"content":"<h1>Hi</h1>","contentType":"text/html","fileName":"report.html"}'
    )
  })

  it('sends review and audience only when requested', () => {
    expect(
      artifactWriteBody({
        ...plain,
        review: { question: 'Ship it?', reviewers: ['a@example.com', 'emp_1'] },
        audience: 'reviewers'
      })
    ).toEqual({
      content: '<h1>Hi</h1>',
      contentType: 'text/html',
      fileName: 'report.html',
      review: { question: 'Ship it?', reviewers: ['a@example.com', 'emp_1'] },
      audience: 'reviewers'
    })
    expect(
      artifactWriteBody({ ...plain, review: { about: { category: 'finance' } } }).review
    ).toEqual({ about: { category: 'finance' } })
    expect(artifactWriteBody({ ...plain, review: {} })).toEqual({
      content: '<h1>Hi</h1>',
      contentType: 'text/html',
      fileName: 'report.html',
      review: {}
    })
  })

  it('never forwards local-only transport fields', () => {
    const body = artifactWriteBody({ ...plain, review: {} }) as Record<string, unknown>
    expect(body).not.toHaveProperty('sourceKey')
    expect(body).not.toHaveProperty('authToken')
    expect(body).not.toHaveProperty('apiUrl')
  })
})
