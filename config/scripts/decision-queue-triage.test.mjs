import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import {
  reconcileQueuePresentation,
  confirmQueuePresentation
} from './decision-queue-presentation.mjs'
import {
  checkLanderParity,
  compareLanderGroup,
  confirmLanderGroup
} from './decision-lander-comparison.mjs'
import { readDecisionLedger } from './decision-record-ledger.mjs'
import { validateRecipeLedger, summarizeRecipeLedger } from './decision-recipe-outcomes.mjs'
import { buildRecipeRequest } from './decision-recipes.mjs'
import {
  decisionRecipeRegistry,
  getDecisionRecipe,
  recipeQuestionHash
} from './decision-recipe-registry.mjs'
import { evaluateRecipe } from './run-decision-recipe.mjs'

const environment = { JEV_QUEUE_TRIAGE_ENABLED: '1' }
const page = {
  id: 'page-one',
  title: 'Draft heading',
  question: 'Which heading?',
  revision: 'r2',
  scope: 'presentation_only',
  evidenceRefs: ['https://example.org/decision/one']
}
const decisions = [
  {
    id: 'decision-one',
    revision: 'r1',
    resolution: 'Use the short heading.',
    timestamp: '2026-01-01T00:00:00Z',
    sourceLink: page.evidenceRefs[0]
  }
]
const group = {
  id: 'draft-group',
  scope: 'draft_only',
  items: ['a', 'b', 'c'].map((id) => ({
    id,
    title: `Draft ${id}`,
    price: 'USD 10 one-time',
    ctaText: 'Read more',
    primaryLink: 'https://example.org/details'
  }))
}
const choice = (humanChoice, extra = {}) => ({
  humanChoice,
  actor: 'reviewer-one',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:00:01.250Z',
  ...extra
})
const provider = (scope = 'exact_same_scope', confidence = 1) => ({
  evaluate: async (request) => ({
    provider: 'typesafe',
    model: request.model,
    answers: request.questions.scope
      ? { scope: { type: 'choice', choice: scope, confidence } }
      : {
          quality: {
            type: 'score',
            score: JSON.parse(request.state.candidate).id === 'b' ? 3 : 1,
            confidence
          }
        }
  })
})
async function fixture(work) {
  const directory = await mkdtemp(join(tmpdir(), 'queue-triage-'))
  try {
    await work({
      environment: { ...environment },
      ledgerPath: join(directory, 'observations.jsonl'),
      provider: provider()
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('flag off is inert at every entry point and preserves legacy request/registry bytes', async () => {
  const state = { message: 'How do I open a file?' }
  const before = JSON.stringify(buildRecipeRequest('support_triage', state))
  const registry = JSON.stringify(decisionRecipeRegistry({}))
  const archived = recipeQuestionHash(getDecisionRecipe('support_triage'))
  await fixture(async (options) => {
    await readDecisionLedger(options.ledgerPath, true)
    for (const flag of [undefined, '0', 'false', 'true', '']) {
      const off = {
        ...options,
        environment: { JEV_QUEUE_TRIAGE_ENABLED: flag },
        provider: {
          evaluate() {
            assert.fail('provider must remain inert')
          }
        }
      }
      assert.equal((await reconcileQueuePresentation(null, null, off)).status, 'disabled')
      assert.equal((await compareLanderGroup(null, off)).status, 'disabled')
      assert.equal(checkLanderParity(null, off).status, 'disabled')
      assert.equal((await confirmQueuePresentation(null, off)).status, 'disabled')
      assert.equal((await confirmLanderGroup(null, off)).status, 'disabled')
      await assert.rejects(
        evaluateRecipe({ recipeId: 'queue_presentation_triage', state: {}, ...off }),
        /queue_triage_disabled/
      )
    }
    assert.deepEqual(await readDecisionLedger(options.ledgerPath, true), [])
  })
  assert.equal(JSON.stringify(buildRecipeRequest('support_triage', state)), before)
  assert.equal(JSON.stringify(decisionRecipeRegistry({})), registry)
  assert.equal(decisionRecipeRegistry({}).length, 7)
  assert.equal(recipeQuestionHash(getDecisionRecipe('support_triage')), archived)
  assert.equal(decisionRecipeRegistry(environment).length, 9)
})

test('linked reconciliation suggests only; explicit clicks append actor/timing, never change queue', async () => {
  for (const disposition of ['exact_same_scope', 'superseded_subset']) {
    await fixture(async (options) => {
      options.provider = provider(disposition)
      const original = JSON.stringify(page)
      const result = await reconcileQueuePresentation(page, decisions, options)
      assert.deepEqual(result.suggestion, {
        queueItemId: page.id,
        suggestion: 'clear_from_queue',
        evidenceRef: decisions[0].sourceLink,
        disposition,
        recipeId: 'queue_presentation_triage',
        recipeVersion: 1
      })
      assert.equal(result.visibility, 'keep_visible')
      const before = await readFile(options.ledgerPath, 'utf8')
      assert.equal(before.includes('confirmed'), false)
      assert.equal(before.includes(page.question), false)
      await confirmQueuePresentation(
        choice('confirmed', { observationId: result.observationId }),
        options
      )
      const rows = await readDecisionLedger(options.ledgerPath)
      assert.equal(rows.length, 2)
      assert.equal(rows[1].actor, 'reviewer-one')
      assert.equal(rows[1].elapsedMs, 1250)
      assert.equal(rows[1].queueItemId, page.id)
      assert.equal(rows[1].humanChoice, 'confirmed')
      assert.equal(rows[1].evidenceRef, decisions[0].sourceLink)
      assert.equal(validateRecipeLedger(rows).humanChoices.length, 1)
      assert.equal(JSON.stringify(page), original)
      await assert.rejects(
        confirmQueuePresentation(
          choice('confirmed', { observationId: result.observationId }),
          options
        ),
        /duplicate/
      )
      assert.equal(
        summarizeRecipeLedger(rows).find((row) => row.recipeId === 'queue_presentation_triage')
          .labelled,
        0
      )
    })
  }
})

test('missing evidence, new scope, low confidence and prohibited scope never suggest clearing', async () => {
  await fixture(async (options) => {
    for (const scope of ['new_scope', 'insufficient_evidence']) {
      assert.equal(
        (
          await reconcileQueuePresentation(page, decisions, {
            ...options,
            provider: provider(scope)
          })
        ).suggestion,
        null
      )
    }
    assert.equal(
      (
        await reconcileQueuePresentation(page, decisions, {
          ...options,
          provider: provider('exact_same_scope', 0.89)
        })
      ).suggestion,
      null
    )
    const never = {
      ...options,
      provider: {
        evaluate() {
          assert.fail('inadmissible model call')
        }
      }
    }
    for (const scope of ['money', 'ads', 'deploy', 'case_close', undefined]) {
      assert.equal(
        (await reconcileQueuePresentation({ ...page, scope }, decisions, never)).suggestion,
        null
      )
    }
    assert.equal(
      (await reconcileQueuePresentation({ ...page, evidenceRefs: [] }, decisions, never))
        .suggestion,
      null
    )
    assert.equal(
      (await reconcileQueuePresentation(page, [{ ...decisions[0], revision: '' }], never))
        .suggestion,
      null
    )
  })
})

test('lander parity blocks inference on missing or mismatched values and reports per-item reasons', async () => {
  await fixture(async (options) => {
    for (const field of ['price', 'ctaText', 'primaryLink']) {
      for (const replacement of ['', 'different']) {
        const input = structuredClone(group)
        input.items[0][field] = replacement
        const result = await compareLanderGroup(input, {
          ...options,
          provider: {
            evaluate() {
              assert.fail('parity failed')
            }
          }
        })
        assert.equal(result.proposedDefault, null)
        assert.equal(result.parity.passed, false)
        assert.equal(result.parity.items.length, 3)
        assert.ok(
          result.parity.items.every((item) =>
            item.reasons.some((reason) => reason.startsWith(field))
          )
        )
        assert.deepEqual(result.reviewItemIds, ['a', 'b', 'c'])
      }
    }
  })
})

test('arbitrary-size groups rank drafts; confirmation is separate and persisted with timing', async () => {
  await fixture(async (options) => {
    const result = await compareLanderGroup(group, options)
    assert.equal(result.proposedDefault, 'b')
    assert.equal(result.rankings.length, 3)
    assert.equal((await readDecisionLedger(options.ledgerPath)).length, 1)
    await assert.rejects(
      confirmLanderGroup(
        choice('confirmed', { observationId: result.observationId, chosenId: 'a' }),
        options
      )
    )
    await confirmLanderGroup(
      choice('confirmed', { observationId: result.observationId, chosenId: 'b' }),
      options
    )
    const rows = await readDecisionLedger(options.ledgerPath)
    assert.equal(rows[1].groupId, group.id)
    assert.equal(rows[1].chosenId, 'b')
    assert.equal(rows[1].actor, 'reviewer-one')
    assert.equal(rows[1].elapsedMs, 1250)
    assert.equal(rows[1].recipeVersion, 1)
    validateRecipeLedger(rows)
    for (const patch of [{ actor: '' }, { elapsedMs: -1 }, { chosenId: 'a' }]) {
      assert.throws(() => validateRecipeLedger([rows[0], { ...rows[1], ...patch }]))
    }
  })
})

test('unavailable, wrong model and timeouts preserve every item without partial rankings or forced picks', async () => {
  for (const evaluate of [
    async () => {
      throw new Error('private provider failure')
    },
    () => new Promise(() => {}),
    async () => ({ model: 'wrong' })
  ]) {
    await fixture(async (options) => {
      const failing = { ...options, provider: { evaluate }, timeoutMs: 20 }
      const reconciliation = await reconcileQueuePresentation(page, decisions, failing)
      assert.equal(reconciliation.suggestion, null)
      assert.equal(reconciliation.visibility, 'keep_visible')
      const landers = await compareLanderGroup(group, failing)
      assert.equal(landers.proposedDefault, null)
      assert.deepEqual(landers.rankings, [])
      assert.deepEqual(landers.reviewItemIds, ['a', 'b', 'c'])
      await confirmLanderGroup(
        choice('deferred_to_manual', { observationId: landers.observationId, chosenId: null }),
        options
      )
      const rows = await readDecisionLedger(options.ledgerPath)
      assert.equal(rows.at(-1).elapsedMs, 1250)
      assert.equal(rows.at(-1).actor, 'reviewer-one')
      assert.equal(rows.at(-1).humanChoice, 'deferred_to_manual')
      assert.equal(
        rows.some((row) => row.humanChoice === 'confirmed'),
        false
      )
      validateRecipeLedger(rows)
    })
  }
})

test('rejects, ties, low confidence, kill switches and revoked flag retain manual review', async () => {
  await fixture(async (options) => {
    const result = await reconcileQueuePresentation(page, decisions, options)
    await assert.rejects(
      confirmQueuePresentation(
        choice('confirmed', { observationId: result.observationId, actor: '' }),
        options
      )
    )
    await confirmQueuePresentation(
      choice('rejected', { observationId: result.observationId }),
      options
    )
    assert.equal((await readDecisionLedger(options.ledgerPath)).at(-1).humanChoice, 'rejected')
    for (const confidence of [0.5, 1]) {
      const tied = { ...group, items: group.items.filter((item) => item.id !== 'b') }
      assert.equal(
        (
          await compareLanderGroup(tied, {
            ...options,
            provider: provider('exact_same_scope', confidence)
          })
        ).proposedDefault,
        null
      )
    }
    for (const key of ['JEV_DECISIONS_DISABLED', 'OMNI_STRUCTURED_DECISIONS_KILL']) {
      assert.equal(
        (
          await compareLanderGroup(group, {
            ...options,
            environment: { ...environment, [key]: 'TRUE' }
          })
        ).status,
        'disabled'
      )
    }
    const revoking = { ...options, environment: { ...environment } }
    revoking.provider = {
      evaluate: async (request) => {
        revoking.environment.JEV_QUEUE_TRIAGE_ENABLED = '0'
        return provider().evaluate(request)
      }
    }
    const before = await readFile(options.ledgerPath, 'utf8')
    assert.equal((await reconcileQueuePresentation(page, decisions, revoking)).status, 'disabled')
    assert.equal(await readFile(options.ledgerPath, 'utf8'), before)
  })
})
