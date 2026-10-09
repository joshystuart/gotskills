import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  nextSelection,
  pruneSelection,
  type CatalogueSelection,
} from './catalogueSelection'

const VISIBLE = ['a', 'b', 'c', 'd', 'e']
const NONE = { meta: false, shift: false }
const META = { meta: true, shift: false }
const SHIFT = { meta: false, shift: true }
const BOTH = { meta: true, shift: true }

function sel(ids: string[], anchor: string | null): CatalogueSelection {
  return { ids: new Set(ids), anchor }
}

function ids(selection: CatalogueSelection): string[] {
  return [...selection.ids].sort()
}

describe('nextSelection', () => {
  it('plain click returns an empty selection anchored at the clicked row', () => {
    const next = nextSelection(sel(['a', 'b'], 'a'), VISIBLE, 'c', NONE, null)
    expect(ids(next)).toEqual([])
    expect(next.anchor).toBe('c')
  })

  it('⌘ toggles a row on and off', () => {
    const on = nextSelection(sel(['a'], 'a'), VISIBLE, 'c', META, null)
    expect(ids(on)).toEqual(['a', 'c'])
    expect(on.anchor).toBe('c')
    const off = nextSelection(on, VISIBLE, 'c', META, null)
    expect(ids(off)).toEqual(['a'])
  })

  it('⌘ on an empty selection takes the open skill in first', () => {
    const next = nextSelection(EMPTY_SELECTION, VISIBLE, 'd', META, 'b')
    expect(ids(next)).toEqual(['b', 'd'])
  })

  it('⌘ on the open skill with an empty selection selects only it', () => {
    const next = nextSelection(EMPTY_SELECTION, VISIBLE, 'b', META, 'b')
    expect(ids(next)).toEqual(['b'])
  })

  it('⇧ selects the range from the anchor downwards', () => {
    expect(ids(nextSelection(sel([], 'b'), VISIBLE, 'd', SHIFT, 'b'))).toEqual(['b', 'c', 'd'])
  })

  it('⇧ selects the range from the anchor upwards', () => {
    expect(ids(nextSelection(sel([], 'd'), VISIBLE, 'a', SHIFT, 'd'))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('⇧ replaces the selection and keeps the anchor', () => {
    const next = nextSelection(sel(['e'], 'b'), VISIBLE, 'c', SHIFT, null)
    expect(ids(next)).toEqual(['b', 'c'])
    expect(next.anchor).toBe('b')
  })

  it('⌘⇧ adds the range to the current selection', () => {
    const next = nextSelection(sel(['a'], 'c'), VISIBLE, 'e', BOTH, null)
    expect(ids(next)).toEqual(['a', 'c', 'd', 'e'])
  })

  it('⇧ re-clicking the anchor selects just the anchor', () => {
    expect(ids(nextSelection(sel(['a', 'b', 'c'], 'b'), VISIBLE, 'b', SHIFT, null))).toEqual(['b'])
  })

  it('⇧ with no anchor selects the clicked row', () => {
    expect(ids(nextSelection(EMPTY_SELECTION, VISIBLE, 'c', SHIFT, null))).toEqual(['c'])
  })

  it('a range over a filtered list uses visible order only', () => {
    const filtered = ['a', 'c', 'e']
    expect(ids(nextSelection(sel([], 'a'), filtered, 'e', SHIFT, null))).toEqual(['a', 'c', 'e'])
  })
})

describe('pruneSelection', () => {
  it('drops ids no longer in the list and keeps the rest', () => {
    const pruned = pruneSelection(sel(['a', 'c', 'x'], 'x'), ['a', 'b', 'c'])
    expect(ids(pruned)).toEqual(['a', 'c'])
    expect(pruned.anchor).toBeNull()
  })

  it('keeps the anchor when it is still listed', () => {
    expect(pruneSelection(sel(['a'], 'a'), ['a']).anchor).toBe('a')
  })
})
