import type { FontSize } from '../../shared/ipc'

/** The root font size for each preset. */
export const FONT_SIZE_PERCENT: Record<FontSize, string> = {
  small: '90%',
  default: '100%',
  large: '115%',
  larger: '130%',
}

export function applyFontSize(fontSize: FontSize): void {
  document.documentElement.style.fontSize = FONT_SIZE_PERCENT[fontSize] ?? FONT_SIZE_PERCENT.default
}
