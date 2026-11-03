import type { BuildStyleId } from './types'

/** How the board's copper is made, which decides how its islands are edited. */
interface BuildStyle {
  id: BuildStyleId
  label: string
  description: string
  /** Whether a clicked rectangle of an island gets resize handles, or the island is only edited by its outline. */
  rectHandles: boolean
}

export const BUILD_STYLES: BuildStyle[] = [
  {
    id: 'knife',
    label: 'Knife',
    description: 'A copper board cut into islands, one per net',
    // An island is a polygon of many strips; handles on its strips would only get in the way.
    rectHandles: false,
  },
  {
    id: 'manhattan',
    label: 'Manhattan',
    description: 'Pads glued on a copper board that is the ground plane, one pad per net',
    rectHandles: true,
  },
]

export function findBuildStyle(id: string): BuildStyle {
  const style = BUILD_STYLES.find((s) => s.id === id)
  if (!style) throw new Error(`Unknown build style "${id}"; choose ${BUILD_STYLES.map((s) => `"${s.id}"`).join(' or ')}`)
  return style
}
