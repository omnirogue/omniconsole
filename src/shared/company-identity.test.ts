import { describe, expect, it } from 'vitest'
import { companyIdentity, companyInitials, companySlug, divisionKind } from './company-identity'

describe('company identity (console parity)', () => {
  it('normalises a name to the console slug', () => {
    expect(companySlug('Omni Rogue')).toBe('omnirogue')
    expect(companySlug('ACME')).toBe('acme')
  })

  it('draws the four real marks and the monograms with their console colour', () => {
    expect(companyIdentity('omnirogue')).toMatchObject({
      kind: 'logo',
      asset: 'omnirogue.png',
      color: '#af5fff'
    })
    expect(companyIdentity('apexlabs')).toMatchObject({
      asset: 'apexlabs.png',
      color: '#ff8700'
    })
    expect(companyIdentity('omniagentos')).toMatchObject({
      kind: 'monogram',
      asset: 'omniagentos-monogram.svg',
      color: '#00d75f'
    })
  })

  it('falls back to initials for a company the console never drew', () => {
    expect(companyIdentity('Bloom Lane Ventures')).toMatchObject({
      kind: 'initials',
      asset: null,
      initials: 'BL'
    })
    expect(companyInitials('betacorp')).toBe('SW')
  })

  it('reads department names the way the console does', () => {
    expect(divisionKind('Sales')).toBe('sales')
    expect(divisionKind('Engineering')).toBe('development')
    expect(divisionKind('Customer Support')).toBe('customer-service')
    expect(divisionKind('Something new')).toBe('generic')
  })
})
