// A saved project file: what a file on this computer, a Google Drive document, a share link and a
// recovery copy hold, and the file name a project is saved under.

import { buildProjectNetlist, checkedDefinitions, withDefinitions, withoutUnfitDefinitions } from '../model/definitions'
import { withoutCutLines } from '../model/migrations/migrateCutLayout'
import { completePlacements, labelSymbolForName, netlistSchematic } from '../model/schematic'
import type { BuiltNetlist, LabelSymbol, NetLabel, Project, Schematic, SchematicPlacement, Settings, Wire } from '../model/types'
import { BUILD_STYLES, findBuildStyle } from '../model/buildStyles'

export const DEFAULT_SETTINGS: Settings = { snap: 0.5, isolation: 0.4, buildStyle: BUILD_STYLES[0].id }

/**
 * Settings as stored before v8, with fields the editor no longer has: one `strategy` named both the
 * build style and the layout optimizer, `clearance` and `maxLead` only steered that optimizer, and
 * `placement` was written only by recovery copies made while testing an optimizer that never shipped.
 */
type StoredSettings = Partial<Settings> & { strategy?: string; clearance?: unknown; maxLead?: unknown; placement?: unknown }

/**
 * Stored settings with the missing ones defaulted and the optimizer's dropped. Settings from before
 * v8 get their build style from their strategy. Throws for an unknown build style.
 */
function checkedSettings(stored: StoredSettings | undefined): Settings {
  const { strategy, clearance: _clearance, maxLead: _maxLead, placement: _placement, ...current } = stored ?? {}
  const settings = { ...DEFAULT_SETTINGS, ...(strategy === undefined ? {} : { buildStyle: strategy }), ...current }
  return { ...settings, buildStyle: findBuildStyle(settings.buildStyle).id }
}

/** A label as stored before its symbol was: it was drawn as the symbol its name suggests. */
type StoredLabel = Omit<NetLabel, 'symbol'> & { symbol?: LabelSymbol }

const checkedLabel = (label: StoredLabel): NetLabel => ({ ...label, symbol: label.symbol ?? labelSymbolForName(label.name) })

/**
 * A schematic as older versions stored it: none before the schematic view, placements only for
 * parts that were moved, and wires and labels only once the schematic was edited.
 */
interface StoredSchematic {
  placements: SchematicPlacement[]
  wires?: Wire[]
  labels?: StoredLabel[]
}

/**
 * The stored schematic as older versions drew it: every part placed, and until it was edited, every
 * pin labelled with its net.
 */
function checkedSchematic(stored: StoredSchematic | undefined, built: BuiltNetlist): Schematic {
  const placements = stored === undefined ? [] : stored.placements
  if (stored?.labels === undefined) return netlistSchematic(built, placements)
  return { placements: completePlacements(built, placements), wires: stored.wires ?? [], labels: stored.labels.map(checkedLabel) }
}

export const emptyProject = (settings: Settings = DEFAULT_SETTINGS): Project => ({
  guid: crypto.randomUUID(),
  netlist: { components: [], nets: [] },
  layout: { islands: [], placements: [] },
  schematic: { placements: [], wires: [], labels: [] },
  settings,
})

/**
 * A project read from storage or a file; projects from before guids get one here, parts without a
 * component definition get one from the built-in templates, and a cut-line layout becomes islands.
 * The name older versions stored is dropped, an old strategy becomes a build style, and the
 * optimizer's settings are dropped. The schematic is completed as older versions drew it. Throws
 * without a netlist or layout, for an invalid component definition, naming it, and for an unknown
 * build style.
 */
export function checkedProject(data: unknown): Project {
  const { name: _name, schematic: storedSchematic, ...project } = (data ?? {}) as Partial<Omit<Project, 'schematic'>> & {
    name?: unknown
    schematic?: StoredSchematic
  }
  if (!project.netlist?.components || !project.layout?.islands) throw new Error('the project is damaged: netlist or layout is missing')
  const definitions = checkedDefinitions(project.definitions)
  const checked = withoutCutLines(
    withDefinitions({
      ...(project as Omit<Project, 'schematic'>),
      guid: project.guid || crypto.randomUUID(),
      // Recovery copies from before definitions were checked may still refer to one a re-import made unfit.
      netlist: withoutUnfitDefinitions(project.netlist, definitions),
      // Completed below, once the parts are built.
      schematic: { placements: [], wires: [], labels: [] },
      definitions,
    }),
  )
  const schematic = checkedSchematic(storedSchematic, buildProjectNetlist(checked))
  return { ...checked, schematic, settings: checkedSettings(checked.settings) }
}

// Bump the version when the stored layout changes meaning, and convert older files in projectFromFile.
// v6: component definitions (symbol and footprints) are stored in the project.
// v7: no name inside: a project is called by its file's name.
// v8: settings hold a build style instead of a strategy, and no optimizer settings (clearance, maxLead).
const FILE_FORMAT = 'manhattan-layout-editor'
const FILE_VERSION = 8

export function projectToFile(project: Project): string {
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, project: withDefinitions(project) }, null, 2)
}

export function projectFromFile(text: string): Project {
  const data = JSON.parse(text) as { format?: unknown; version?: unknown; project?: unknown }
  if (data?.format !== FILE_FORMAT || typeof data.version !== 'number') throw new Error('Not a Manhattan project file.')
  if (data.version > FILE_VERSION) throw new Error('This project was saved by a newer version of the editor.')
  return checkedProject(data.project)
}

/**
 * A saved document's project and its content as this version of the editor writes it, so saved
 * contents compare equal whatever version wrote them. Text that is no project stays as it is, and
 * `project` is then null.
 */
export function readSavedProject(text: string): { project: Project | null; content: string } {
  try {
    const project = projectFromFile(text)
    return { project, content: projectToFile(project) }
  } catch {
    return { project: null, content: text }
  }
}

/** "amp" → "amp.json". A project file is plain JSON; its "format" field says it is a project. */
export const projectFileName = (name: string) => `${name}.json`

/** "amp.json" → "amp"; also takes "amp.manhattan.json", as files were named until November 2026. */
export const projectNameOf = (fileName: string) => fileName.replace(/(\.manhattan)?\.json$/i, '')

/** Files that may hold a project, as offered for opening. */
export const isProjectFileName = (fileName: string) => /\.json$/i.test(fileName)
