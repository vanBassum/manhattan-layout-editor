// A saved project file: what a file on this computer, a Google Drive document, a share link and a
// recovery copy hold, and the file name a project is saved under.

import { checkedDefinitions, withDefinitions, withoutUnfitDefinitions } from '../model/definitions'
import { withoutCutLines } from '../model/migrations/migrateCutLayout'
import type { Project, Settings } from '../model/types'
import { BUILD_STYLES, findBuildStyle, findPlacement, PLACEMENTS } from '../optimize'

export const DEFAULT_SETTINGS: Settings = {
  snap: 0.5,
  isolation: 0.4,
  buildStyle: BUILD_STYLES[0].id,
  placement: PLACEMENTS[0].id,
  clearance: 3,
  maxLead: 10,
}

/** Settings as stored before v8: one `strategy` named both how the copper is made and where the parts go. */
type StoredSettings = Partial<Settings> & { strategy?: string }

/**
 * Stored settings with the missing ones defaulted. Settings from before v8 get their build style
 * from their strategy; placement had no choice then. Throws for an unknown build style or placement.
 */
function checkedSettings(stored: StoredSettings | undefined): Settings {
  const { strategy, ...current } = stored ?? {}
  const settings = { ...DEFAULT_SETTINGS, ...(strategy === undefined ? {} : { buildStyle: strategy }), ...current }
  return { ...settings, buildStyle: findBuildStyle(settings.buildStyle).id, placement: findPlacement(settings.placement).id }
}

export const emptyProject = (settings: Settings = DEFAULT_SETTINGS): Project => ({
  guid: crypto.randomUUID(),
  netlist: { components: [], nets: [] },
  layout: { islands: [], placements: [] },
  settings,
})

/**
 * A project read from storage or a file; projects from before guids get one here, parts without a
 * component definition get one from the built-in templates, and a cut-line layout becomes islands.
 * The name older versions stored is dropped, and an old strategy becomes a build style. Throws
 * without a netlist or layout, for an invalid component definition, naming it, and for an unknown
 * build style or placement.
 */
export function checkedProject(data: unknown): Project {
  const project = { ...(data as Partial<Project> & { name?: unknown }) }
  if (!project?.netlist?.components || !project.layout?.islands) throw new Error('the project is damaged: netlist or layout is missing')
  delete project.name
  const definitions = checkedDefinitions(project.definitions)
  const checked = withoutCutLines(
    withDefinitions({
      ...(project as Project),
      guid: project.guid || crypto.randomUUID(),
      // Recovery copies from before definitions were checked may still refer to one a re-import made unfit.
      netlist: withoutUnfitDefinitions(project.netlist, definitions),
      definitions,
    }),
  )
  return { ...checked, settings: checkedSettings(checked.settings) }
}

// Bump the version when the stored layout changes meaning, and convert older files in projectFromFile.
// v6: component definitions (symbol and footprints) are stored in the project.
// v7: no name inside: a project is called by its file's name.
// v8: settings hold a build style and a placement instead of one strategy.
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
