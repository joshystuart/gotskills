/** The Catalogue's multi-selection, built Finder-style with ⌘ and ⇧ clicks. */
export interface CatalogueSelection {
  /** Selected skill ids; the selection bar shows at size >= 2. */
  ids: ReadonlySet<string>
  /** Last clicked row; the start of a ⇧ range. */
  anchor: string | null
}

/** Modifier keys held during a row click. */
export interface ClickModifiers {
  meta: boolean
  shift: boolean
}

export const EMPTY_SELECTION: CatalogueSelection = { ids: new Set(), anchor: null }

function rangeBetween(visibleIds: readonly string[], from: string, to: string): string[] {
  const start = visibleIds.indexOf(from)
  const end = visibleIds.indexOf(to)
  if (start === -1 || end === -1) return [to]
  return visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1)
}

/**
 * The selection after a row click. A plain click empties it, ⌘ toggles the
 * row (taking the open skill in first when the selection is empty), ⇧
 * replaces it with the range from the anchor in visible order, and ⌘⇧ adds
 * that range.
 */
export function nextSelection(
  current: CatalogueSelection,
  visibleIds: readonly string[],
  clickedId: string,
  modifiers: ClickModifiers,
  openId: string | null
): CatalogueSelection {
  if (modifiers.shift) {
    const anchor = current.anchor ?? clickedId
    const range = rangeBetween(visibleIds, anchor, clickedId)
    const ids = modifiers.meta ? new Set([...current.ids, ...range]) : new Set(range)
    return { ids, anchor }
  }
  if (modifiers.meta) {
    const ids = new Set(current.ids)
    if (ids.size === 0 && openId !== null) ids.add(openId)
    if (ids.has(clickedId) && !(current.ids.size === 0 && openId === clickedId)) {
      ids.delete(clickedId)
    } else {
      ids.add(clickedId)
    }
    return { ids, anchor: clickedId }
  }
  return { ids: new Set(), anchor: clickedId }
}

/** Drops selected ids, and the anchor, that are no longer in the list. */
export function pruneSelection(
  current: CatalogueSelection,
  listedIds: readonly string[]
): CatalogueSelection {
  const listed = new Set(listedIds)
  return {
    ids: new Set([...current.ids].filter((id) => listed.has(id))),
    anchor: current.anchor !== null && listed.has(current.anchor) ? current.anchor : null,
  }
}
