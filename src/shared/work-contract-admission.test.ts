import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  admitAgentLaunch,
  classifyAgentLaunch,
  parseWorkContract,
  workContractAdmissionMode,
  workContractDigest,
  workContractProblems,
  type WorkContract
} from './work-contract-admission'

function softwareContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 2,
    work_ref: 'wave12:item-7',
    contract_revision: 1,
    deliverable_kind: 'software_change',
    root: { kind: 'software_change', source: 'decision' },
    requested_outcome: 'Add the  billing   export endpoint',
    target: { repo: 'omnirogue/omni-console', base: 'main' },
    scope: { owned_paths: ['bff/omni_bff/billing.py'] },
    acceptance: [{ id: 'ci', kind: 'required_checks', subject: 'candidate_commit' }],
    authority: { basis: 'decision', decision: { slug: 'wave-12', revision: 3, decision_id: 9 } },
    ...overrides
  }
}

function reportContract(): Record<string, unknown> {
  return {
    schema_version: 2,
    work_ref: 'research-1',
    contract_revision: 1,
    deliverable_kind: 'report',
    root: { kind: 'report', source: 'operator_request' },
    requested_outcome: 'Compare the three relay providers',
    acceptance: [
      { id: 'grounded', kind: 'source_grounding', expected: 'Cites each provider price page' }
    ],
    authority: { basis: 'operator_request', request: 'Compare relay providers for me' }
  }
}

function parsed(value: Record<string, unknown>): WorkContract {
  const result = parseWorkContract(value)
  if (!result.ok) {
    throw new Error(result.message)
  }
  return result.contract
}

function codes(value: Record<string, unknown>): string[] {
  return workContractProblems(parsed(value)).map((problem) => problem.code)
}

describe('parseWorkContract', () => {
  it('normalizes a valid contract like the BFF parser', () => {
    const contract = parsed(
      softwareContract({ limits: { deadline: '2026-10-18T09:00:00.250+02:00' } })
    )
    expect(contract.role).toBe('deliver')
    expect(contract.parent_work_ref).toBeNull()
    expect(contract.requested_outcome).toBe('Add the billing export endpoint')
    expect(contract.scope).toEqual({
      owned_paths: ['bff/omni_bff/billing.py'],
      excluded_actions: []
    })
    expect(contract.limits).toEqual({ deadline: '2026-10-18T07:00:00Z' })
  })

  it.each([
    [{ schema_version: 1 }, 'contract.schema_version must be 2'],
    [{ deliverable_kind: 'document' }, 'contract.deliverable_kind must be one of'],
    [{ extra: true }, 'contract has unsupported fields: extra'],
    [{ acceptance: [] }, 'contract.acceptance must list 1 to 32 checks'],
    [{ root: { kind: 'software_change' } }, 'contract.root needs kind'],
    [{ target: { repo: 'omni-console' } }, 'contract.target.repo must be owner/name'],
    [{ target: { repo: 'a/b', base: '../main' } }, 'contract.target.base must name the branch'],
    [{ role: 'subtask' }, 'a subtask or verify contract names its parent_work_ref'],
    [{ limits: { deadline: '2026-10-18T09:00:00' } }, 'contract.limits.deadline'],
    [{ authority: { basis: 'decision' } }, 'contract.authority.decision names slug'],
    [
      {
        acceptance: [
          { id: 'a', kind: 'required_checks' },
          { id: 'a', kind: 'behavior_check' }
        ]
      },
      'acceptance id a is listed twice'
    ]
  ])('refuses %j', (overrides, message) => {
    const result = parseWorkContract(softwareContract(overrides))
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.message).toContain(message)
  })
})

describe('workContractProblems', () => {
  it('accepts a consistent software change and report', () => {
    expect(codes(softwareContract())).toEqual([])
    expect(codes(reportContract())).toEqual([])
  })

  it('refuses a build whose only proof is a long markdown file', () => {
    expect(
      codes(
        softwareContract({
          scope: { owned_paths: ['docs/plan.md'] },
          acceptance: [
            {
              id: 'doc',
              kind: 'artifact_published',
              expected: 'Markdown file of minimum 150 lines'
            }
          ]
        })
      )
    ).toEqual([
      'deliverable_mismatch',
      'acceptance_kind_mismatch',
      'no_implementation_workspace',
      'line_count_acceptance'
    ])
  })

  it('names downgrades, missing targets, wrong subjects and inferred roots', () => {
    expect(
      codes(
        softwareContract({
          root: { kind: 'software_change', source: 'inferred' },
          target: null,
          acceptance: [{ id: 'ci', kind: 'required_checks', subject: 'preview' }]
        })
      )
    ).toEqual(['target_required', 'check_subject_mismatch', 'needs_classification'])
    expect(
      codes({ ...reportContract(), root: { kind: 'software_change', source: 'decision' } })
    ).toEqual(['deliverable_downgrade'])
  })

  it('lets a verify role carry checks for another kind', () => {
    const verify = {
      ...reportContract(),
      role: 'verify',
      parent_work_ref: 'wave12:item-7',
      acceptance: [
        { id: 'pr', kind: 'pr_open' },
        { id: 'review', kind: 'human_review' }
      ]
    }
    expect(codes(verify)).toEqual([])
  })
})

describe('workContractDigest', () => {
  it('hashes sorted-key compact JSON', () => {
    const contract = parsed(reportContract())
    const digest = workContractDigest(contract)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    const { authority, ...rest } = reportContract()
    const reordered = parsed({ authority, ...rest })
    expect(workContractDigest(reordered)).toBe(digest)
    expect(createHash('sha256').update('{"a":[1,{"b":null,"c":"x"}],"z":2}').digest('hex')).toBe(
      workContractDigest({ z: 2, a: [1, { c: 'x', b: null }] } as unknown as WorkContract)
    )
  })
})

describe('classifyAgentLaunch', () => {
  const wave12 = { prompt: 'Build it', promptDelivery: 'auto-submit' as const }

  it('treats an auto-submitted or background launch from a script as unattended', () => {
    expect(
      classifyAgentLaunch({ params: wave12, actorKind: 'local-cli', hubAdmitted: false })
    ).toBe('unattended')
    expect(
      classifyAgentLaunch({
        params: { prompt: 'x' },
        actorKind: 'paired-device',
        hubAdmitted: false
      })
    ).toBe('unattended')
    expect(
      classifyAgentLaunch({
        params: { presentation: 'background' },
        actorKind: 'local-cli',
        hubAdmitted: false
      })
    ).toBe('unattended')
  })

  it('keeps drafts, empty prompts and the person lane interactive', () => {
    expect(
      classifyAgentLaunch({
        params: { prompt: 'x', promptDelivery: 'draft' },
        actorKind: 'local-cli',
        hubAdmitted: false
      })
    ).toBe('interactive')
    expect(
      classifyAgentLaunch({ params: { prompt: '  ' }, actorKind: 'local-cli', hubAdmitted: false })
    ).toBe('interactive')
    expect(classifyAgentLaunch({ params: wave12, actorKind: 'mobile', hubAdmitted: false })).toBe(
      'interactive'
    )
    expect(classifyAgentLaunch({ params: wave12, actorKind: 'local-cli', hubAdmitted: true })).toBe(
      'hub_admitted'
    )
  })
})

describe('admitAgentLaunch', () => {
  it('counts an uncontracted unattended launch in shadow and refuses it in enforce', () => {
    expect(
      admitAgentLaunch({ classification: 'unattended', contract: undefined, mode: 'shadow' })
    ).toEqual({
      admitted: true,
      workAdmission: { status: 'uncontracted', mode: 'shadow' }
    })
    const enforced = admitAgentLaunch({
      classification: 'unattended',
      contract: undefined,
      mode: 'enforce'
    })
    expect(enforced).toMatchObject({ admitted: false, code: 'work_contract_required' })
    expect(enforced.message).toContain('launch_ai_sessions_batch')
  })

  it('refuses a defective contract in shadow but ignores it when off', () => {
    const bad = softwareContract({ acceptance: [{ id: 'doc', kind: 'artifact_published' }] })
    expect(
      admitAgentLaunch({ classification: 'unattended', contract: bad, mode: 'shadow' })
    ).toMatchObject({
      admitted: false,
      code: 'deliverable_mismatch'
    })
    expect(
      admitAgentLaunch({
        classification: 'interactive',
        contract: { schema_version: 1 },
        mode: 'shadow'
      })
    ).toMatchObject({ admitted: false, code: 'invalid_work_contract' })
    expect(admitAgentLaunch({ classification: 'unattended', contract: bad, mode: 'off' })).toEqual({
      admitted: true,
      workAdmission: { status: 'uncontracted', mode: 'off' }
    })
  })

  it('records a direct contract as unverified authority and still refuses it in enforce', () => {
    const shadow = admitAgentLaunch({
      classification: 'unattended',
      contract: reportContract(),
      mode: 'shadow'
    })
    expect(shadow).toMatchObject({
      admitted: true,
      workAdmission: {
        status: 'contracted',
        authorityVerified: false,
        workRef: 'research-1',
        deliverableKind: 'report'
      }
    })
    expect(shadow.workAdmission.contractDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(
      admitAgentLaunch({
        classification: 'unattended',
        contract: reportContract(),
        mode: 'enforce'
      })
    ).toMatchObject({ admitted: false, code: 'work_contract_required' })
    expect(
      admitAgentLaunch({ classification: 'hub_admitted', contract: undefined, mode: 'enforce' })
    ).toEqual({ admitted: true, workAdmission: { status: 'hub_admitted', mode: 'enforce' } })
  })
})

describe('workContractAdmissionMode', () => {
  it('defaults to shadow', () => {
    expect(workContractAdmissionMode({})).toBe('shadow')
    expect(workContractAdmissionMode({ OMNI_WORK_CONTRACT_ADMISSION: 'Enforce' })).toBe('enforce')
    expect(workContractAdmissionMode({ OMNI_WORK_CONTRACT_ADMISSION: 'off' })).toBe('off')
    expect(workContractAdmissionMode({ OMNI_WORK_CONTRACT_ADMISSION: 'strict' })).toBe('shadow')
  })
})
