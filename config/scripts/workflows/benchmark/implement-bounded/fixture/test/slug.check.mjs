import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from '../src/slug.mjs'

test('lowercases and hyphenates', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
  assert.equal(slugify('  Queue -- status  '), 'queue-status')
})

test('caps the length', () => {
  assert.equal(slugify('abcdefghij', { maxLength: 4 }), 'abcd')
})

test('falls back to untitled', () => {
  assert.equal(slugify('!!!'), 'untitled')
})
