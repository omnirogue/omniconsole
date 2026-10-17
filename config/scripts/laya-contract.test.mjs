import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'
import { LAYA_MODEL, LAYA_MODEL_REVISION } from '../../src/shared/laya-shadow'
import { summarizeEvaluation } from './typesafe-evaluation-metrics.mjs'
import { EVALUATION_CASES } from './typesafe-evaluation-corpus.mjs'
import { runEvaluation, validateEvaluationEnvironment } from './run-typesafe-evaluation.mjs'

describe('Laya comparison contract', () => {
  it('provisions pinned CPU-only PyTorch without caching CUDA wheels on the CPU runner', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/typesafe-evaluation.yml', import.meta.url),
        'utf8'
      )
    )
    const provision = workflow.jobs.evaluate.steps.find(
      (item) => item.name === 'Provision pinned Laya outside inference'
    )
    const cpu =
      'python -m pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu'
    const dependencies = 'python -m pip install --no-cache-dir -r config/laya/requirements.txt'
    expect(provision.run).toContain(cpu)
    expect(provision.run).toContain(dependencies)
    expect(provision.run.indexOf(cpu)).toBeLessThan(provision.run.indexOf(dependencies))
    expect(provision.run).toContain(
      'torch.__version__ == "2.8.0+cpu" and torch.version.cuda is None'
    )
    expect(provision.run.indexOf('assert torch.')).toBeLessThan(
      provision.run.indexOf('checkpoint.py download')
    )
    expect(provision.run).toContain(
      'python -m pip freeze > typesafe-evaluation-results/laya-python-packages.txt'
    )
  })

  it('isolates the local worker from Jev credentials and preserves metadata only', () => {
    const workflow = parse(
      readFileSync(
        new URL('../../.github/workflows/typesafe-evaluation.yml', import.meta.url),
        'utf8'
      )
    )
    const step = workflow.jobs.evaluate.steps.find(
      (item) => item.name === 'Preload Laya and compare identical synthetic inputs'
    )
    expect(step.if).toBe("inputs.comparator == 'laya-local'")
    expect(step.env).toEqual({
      TYPESAFE_EVALUATION_LIVE: '1',
      EVALUATION_EXPECTED_SHA: '${{ inputs.expected_sha }}',
      EVALUATION_SPLIT: '${{ inputs.split }}',
      EVALUATION_COMPARATOR: 'laya-local',
      EVALUATION_SUITE: '${{ inputs.suite }}',
      TYPESAFE_EVALUATION_KEY: '${{ secrets.TYPESAFE_EVALUATION_KEY }}'
    })
    expect(step.run).toContain('env -u TYPESAFE_EVALUATION_KEY python -B config/laya/serve.py')
    expect(step.run).toContain('openssl rand -hex 32')
    expect(step.run).toContain('p.chmod(0o600)')
    expect(workflow.jobs.evaluate.steps.at(-1).with.path).toBe('typesafe-evaluation-results/')
  })

  it('pins the worker and app to the same checkpoint and source hashes', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../laya/manifest.json', import.meta.url), 'utf8')
    )
    expect(manifest.model).toBe(LAYA_MODEL)
    expect(manifest.modelRevision).toBe(LAYA_MODEL_REVISION)
    expect(manifest.sourceRevision).toMatch(/^[a-f0-9]{40}$/)
    for (const digest of Object.values({ ...manifest.modelFiles, ...manifest.sourceFiles })) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('keeps the frozen corpus and reports unsupported Laya cases in the denominator', async () => {
    const cases = EVALUATION_CASES.filter((item) => item.split === 'holdout').slice(0, 2)
    const jev = async () => ({ status: 'error', elapsedMs: 1, errorCode: 'network', answers: {} })
    const laya = async () => ({
      status: 'error',
      elapsedMs: 1,
      errorCode: 'input_too_large',
      answers: {}
    })
    const result = await runEvaluation({
      cases,
      comparator: 'laya-local',
      providers: { typesafe: jev, 'laya-local': laya },
      classifyAgentTurnFailure: () => 'unknown'
    })
    expect(result.requests).toBe(4)
    const summary = summarizeEvaluation(cases, result.observations, { rightArm: 'laya-local' })
    expect(summary.paired[0].rightArm).toBe('laya-local')
    expect(summary.groups.find((row) => row.arm === 'laya-local')).toMatchObject({
      cases: 2,
      errors: 2,
      quality: { cases: { correct: 0, total: 2 } }
    })
  })

  it('requires an explicit Laya credential and manual GitHub admission', () => {
    const env = {
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      TYPESAFE_EVALUATION_LIVE: '1',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main-next',
      GITHUB_SHA: 'a'.repeat(40),
      EVALUATION_EXPECTED_SHA: 'a'.repeat(40),
      EVALUATION_SPLIT: 'development',
      EVALUATION_COMPARATOR: 'laya-local',
      TYPESAFE_EVALUATION_KEY: 'test'
    }
    expect(() => validateEvaluationEnvironment(env)).toThrow()
    expect(
      validateEvaluationEnvironment({ ...env, LAYA_SHADOW_TOKEN: 'b'.repeat(64) })
    ).toMatchObject({ comparator: 'laya-local' })
    expect(() =>
      validateEvaluationEnvironment({
        ...env,
        LAYA_SHADOW_TOKEN: 'b'.repeat(64),
        EVALUATION_SUITE: 'advertising'
      })
    ).toThrow('evaluation_laya_requires_core_suite')
  })

  it.skipIf(process.platform === 'win32')(
    'checks worker input admission without importing torch or downloading models',
    async () => {
      const result = await runProcess({
        program: 'python3',
        args: ['-B', '-m', 'unittest', 'test_request_limits.py'],
        cwd: fileURLToPath(new URL('../laya/', import.meta.url)),
        timeoutMs: 10_000
      })
      expect(result.code, result.stderr).toBe(0)
    }
  )
})
