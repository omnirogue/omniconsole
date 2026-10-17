import { describe, expect, it } from 'vitest'
import {
  emptySessionPlaces,
  parseSessionPlaces,
  rememberRecentFolder,
  sessionPlaceKey,
  setSessionPlace,
  type SessionPlaces
} from '@/lib/session-place-choice'
import { createSessionPlaceStore, type SessionPlaceStorage } from './session-place-store'

const ads = {
  companyId: 'cmp_click',
  unitId: 'dom_ads',
  companyName: 'ApexLabs',
  unitName: 'Advertising'
}
const eng = { ...ads, unitId: 'dom_eng', unitName: 'Engineering' }

function memoryStorage(initial?: SessionPlaces): SessionPlaceStorage & { saved: SessionPlaces[] } {
  let current = initial ?? emptySessionPlaces()
  const saved: SessionPlaces[] = []
  return {
    saved,
    load: () => current,
    save: (next) => {
      current = next
      saved.push(next)
    }
  }
}

describe('the place model', () => {
  it('remembers a choice per conversation and forgets it on null', () => {
    const one = setSessionPlace(emptySessionPlaces(), 'tab:pane', ads)
    expect(one.places).toEqual({ 'tab:pane': ads })
    const two = setSessionPlace(one, 'other', eng)
    expect(Object.keys(two.places)).toEqual(['tab:pane', 'other'])
    expect(setSessionPlace(two, 'tab:pane', null).places).toEqual({ other: eng })
    expect(setSessionPlace(two, '  ', ads)).toBe(two)
  })

  it('keeps the newest three folders, once each, newest first', () => {
    let places = emptySessionPlaces()
    for (const folder of ['/a', '/b', '/a', '/c', '/d']) {
      places = rememberRecentFolder(places, folder)
    }
    expect(places.recentFolders).toEqual(['/d', '/c', '/a'])
    expect(rememberRecentFolder(places, '   ')).toBe(places)
  })

  it('reads a drifted store row by row and never throws', () => {
    expect(
      parseSessionPlaces({
        places: { good: ads, bad: { companyId: '' } },
        recentFolders: ['/x', 3, '', '/y', '/z', '/w']
      })
    ).toEqual({ places: { good: ads }, recentFolders: ['/x', '/y', '/z'] })
    expect(parseSessionPlaces('nope')).toEqual(emptySessionPlaces())
    expect(parseSessionPlaces(null)).toEqual(emptySessionPlaces())
  })

  it('keys a place by the two ids the hub files by', () => {
    expect(sessionPlaceKey(ads)).toBe('cmp_click/dom_ads')
  })
})

describe('the per-device store', () => {
  it('loads once, writes every change through and serves the recents', () => {
    const storage = memoryStorage({ places: { 'tab:pane': ads }, recentFolders: ['/old'] })
    const store = createSessionPlaceStore(storage)
    expect(store.getState().loaded).toBe(false)
    store.getState().load()
    expect(store.getState().places['tab:pane']).toEqual(ads)
    store.getState().setPlace('tab:pane', eng)
    store.getState().rememberFolder('/new')
    expect(storage.saved.at(-1)).toEqual({
      places: { 'tab:pane': eng },
      recentFolders: ['/new', '/old']
    })
    expect(store.getState().recentFolders).toEqual(['/new', '/old'])
    store.getState().load()
    expect(store.getState().places['tab:pane']).toEqual(eng)
  })
})
