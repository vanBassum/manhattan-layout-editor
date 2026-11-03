// A saved project file: what a file on this computer, a Google Drive document, a share link and a
// recovery copy hold, and the file name a project is saved under.

import { checkedDefinitions, withDefinitions, withoutUnfitDefinitions } from '../model/definitions'
import { withoutCutLines } from '../model/migrations/migrateCutLayout'
import type { Project, Settings } from '../model/types'
import { findStrategy, STRATEGIES } from '../optimize'

export const DEFAULT_SETTINGS: Settings = { snap: 0.5, isolation: 0.4, strategy: STRATEGIES[0].id, clearance: 3, maxLead: 10 }

export const emptyProject = (settings: Settings = DEFAULT_SETTINGS): Project => ({
  guid: crypto.randomUUID(),
  netlist: { components: [], nets: [] },
  layout: { islands: [], placements: [] },
  settings,
})

/**
 * A project read from storage or a file; projects from before guids get one here, parts without a
 * component definition get one from the built-in templates, and a cut-line layout becomes islands.
 * The name older versions stored is dropped. Throws without a netlist or layout, and for an invalid
 * component definition, naming it.
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
      settings: { ...DEFAULT_SETTINGS, ...project.settings },
    }),
  )
  return { ...checked, settings: { ...checked.settings, strategy: findStrategy(checked.settings.strategy).id } }
}

// Bump the version when the stored layout changes meaning, and convert older files in projectFromFile.
// v6: component definitions (symbol and footprints) are stored in the project.
// v7: no name inside: a project is called by its file's name.
const FILE_FORMAT = 'manhattan-layout-editor'
const FILE_VERSION = 7

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
