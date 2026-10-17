import assert from 'node:assert/strict'
import { test } from 'node:test'
import { slugify } from '../src/slug.mjs'

test('folds diacritics', () => {
  assert.equal(slugify('Crème Brûlée'), 'creme-brulee')
  assert.equal(slugify('Ångström über'), 'angstrom-uber')
})

test('collapses every non-alphanumeric run to one hyphen', () => {
  assert.equal(slugify('a__b  c--d/e'), 'a-b-c-d-e')
  assert.equal(slugify('v2.0 (beta) #3'), 'v2-0-beta-3')
})

test('drops a hyphen left at the cut', () => {
  assert.equal(slugify('hello world', { maxLength: 6 }), 'hello')
  assert.equal(slugify('hello world', { maxLength: 7 }), 'hello-w')
})

test('defaults the cap to 60', () => {
  assert.equal(slugify('a'.repeat(80)).length, 60)
})

test('returns untitled for empty and symbol-only titles', () => {
  assert.equal(slugify(''), 'untitled')
  assert.equal(slugify(' -- '), 'untitled')
})

test('throws TypeError for a non-string title', () => {
  assert.throws(() => slugify(42), TypeError)
  assert.throws(() => slugify(null), TypeError)
})
