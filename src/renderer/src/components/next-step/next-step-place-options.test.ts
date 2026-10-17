import { expect, it } from 'vitest'
import type { WorkFolderCompany } from '../../../../shared/console-work-folders-contract'
import { nextStepPlaceOptions, placeChoiceFromCompanyPlace } from './next-step-place-options'

const companies = [
  {
    id: 'cmp_click',
    slug: 'apexlabs',
    name: 'ApexLabs',
    domains: [
      { id: 'dom_ads', name: 'Advertising' },
      { id: null, name: 'Unfiled' },
      { id: 'dom_eng', name: '  ' }
    ]
  },
  { id: null, slug: 'ghost', name: 'Ghost', domains: [{ id: 'dom_x', name: 'X' }] }
] as unknown as WorkFolderCompany[]

it('lists every company → department pair the hub can file under, in tree order', () => {
  expect(nextStepPlaceOptions(companies)).toEqual([
    {
      value: 'cmp_click/dom_ads',
      label: 'ApexLabs → Advertising',
      choice: {
        companyId: 'cmp_click',
        unitId: 'dom_ads',
        companyName: 'ApexLabs',
        unitName: 'Advertising'
      }
    },
    {
      value: 'cmp_click/dom_eng',
      label: 'ApexLabs → dom_eng',
      choice: {
        companyId: 'cmp_click',
        unitId: 'dom_eng',
        companyName: 'ApexLabs',
        unitName: 'dom_eng'
      }
    }
  ])
})

it('turns the folder’s place into a choice only when it names a department', () => {
  expect(
    placeChoiceFromCompanyPlace({
      company: { id: 'cmp_click', slug: 'apexlabs', name: 'ApexLabs' },
      domain: { id: 'dom_ads', name: 'Advertising' },
      project: null
    })
  ).toEqual({
    companyId: 'cmp_click',
    unitId: 'dom_ads',
    companyName: 'ApexLabs',
    unitName: 'Advertising'
  })
  expect(
    placeChoiceFromCompanyPlace({
      company: { id: 'cmp_click', slug: 'apexlabs', name: 'ApexLabs' },
      domain: null,
      project: null
    })
  ).toBeNull()
  expect(placeChoiceFromCompanyPlace(null)).toBeNull()
})
