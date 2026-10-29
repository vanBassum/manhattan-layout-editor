// Projects live in localStorage, one key per project, plus an index of the open tabs. Each
// browser tab remembers its own active project in sessionStorage, so two browser tabs can work
// on different projects without overwriting each other.

import { migrateGappedIslands } from './migrateIslands'
import { STRATEGIES } from './optimize'
import type { Project, Settings } from './types'

export interface ProjectTab {
  id: string
  name: string
}

export const DEFAULT_SETTINGS: Settings = { snap: 0.5, isolation: 0.4, strategy: STRATEGIES[0].id, clearance: 3, maxLead: 10 }

// v5: islands touch; the isolation cut runs along their shared edges (see migrateIslands.ts).
// v4 keys were only written by a development build during that switch and are ignored.
const PROJECT_PREFIX = 'manhattan-layout-editor/project-v5'
// v3: islands with isolation gaps between them. Only ever read, so it stays as a way back.
const V3_PROJECT_PREFIX = 'manhattan-layout-editor/project-v3'
/** From before tabs: a single v3 project under the bare prefix. */
const LEGACY_PROJECT_KEY = V3_PROJECT_PREFIX
export const TABS_KEY = 'manhattan-layout-editor/tabs-v1'
const ACTIVE_TAB_KEY = 'manhattan-layout-editor/active-tab'
export const projectKey = (id: string) => `${PROJECT_PREFIX}/${id}`
const v3ProjectKey = (id: string) => `${V3_PROJECT_PREFIX}/${id}`

export const emptyProject = (settings: Settings = DEFAULT_SETTINGS): Project => ({
  guid: crypto.randomUUID(),
  name: 'Untitled',
  netlist: { components: [], nets: [] },
  layout: { islands: [], placements: [] },
  settings,
})

export const newTabId = () => Math.random().toString(36).slice(2, 10)

export function parseStoredProject(stored: string): Project | null {
  return checkedProject(JSON.parse(stored))
}

/** A project read from storage or a file; projects from before guids get one here. */
function checkedProject(data: unknown): Project | null {
  const project = data as Partial<Project> | null
  if (!project?.netlist?.components || !project.layout?.islands) return null
  return {
    ...(project as Project),
    guid: project.guid || crypto.randomUUID(),
    settings: { ...DEFAULT_SETTINGS, ...project.settings },
  }
}

// A saved project file. Bump the version when the stored layout changes meaning, and convert
// older files in projectFromFile.
const FILE_FORMAT = 'manhattan-layout-editor'
const FILE_VERSION = 5

export function projectToFile(project: Project): string {
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, project }, null, 2)
}

export function projectFromFile(text: string): Project {
  const data = JSON.parse(text) as { format?: unknown; version?: unknown; project?: unknown }
  if (data?.format !== FILE_FORMAT || typeof data.version !== 'number') throw new Error('Not a Manhattan project file.')
  if (data.version > FILE_VERSION) throw new Error('This project was saved by a newer version of the editor.')
  const project = checkedProject(data.project)
  if (!project) throw new Error('The project file is damaged: netlist or layout is missing.')
  return project
}

export function parseStoredTabs(stored: string | null): ProjectTab[] {
  try {
    const tabs = stored ? (JSON.parse(stored) as ProjectTab[]) : []
    return Array.isArray(tabs) ? tabs.filter((t) => typeof t.id === 'string') : []
  } catch {
    return []
  }
}

/** A project saved before v4, migrated; null when there is none. Never changes the stored v3 copy. */
function readV3Project(id: string): Project | null {
  const stored = localStorage.getItem(v3ProjectKey(id))
  const project = stored ? parseStoredProject(stored) : null
  return project ? migrateGappedIslands(project) : null
}

export function readProject(id: string): Project {
  try {
    const stored = localStorage.getItem(projectKey(id))
    if (stored === null) {
      const migrated = readV3Project(id)
      if (migrated) {
        writeProject(id, migrated)
        return migrated
      }
    }
    const raw = stored ? (JSON.parse(stored) as Partial<Project>) : null
    const project = checkedProject(raw)
    if (project) {
      // A project from before guids gets its guid stored right away, so it reads the same next time.
      if (!raw?.guid) writeProject(id, project)
      return project
    }
  } catch {
    // Corrupt or inaccessible storage: start empty.
  }
  return emptyProject()
}

// Storage full or disabled: the editor keeps working for this session, so writes fail silently.
export function writeProject(id: string, project: Project) {
  try {
    // Every project with a v3 copy gets its v4 copy when it is read. Without one, `project` was
    // read before this version loaded (a browser tab kept open over an update) and still has gaps.
    const unread = localStorage.getItem(projectKey(id)) === null && localStorage.getItem(v3ProjectKey(id)) !== null
    const current = unread ? migrateGappedIslands(project) : project
    localStorage.setItem(projectKey(id), JSON.stringify(current))
  } catch {}
}

export function writeTabs(tabs: ProjectTab[]) {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
  } catch {}
}

export function removeProject(id: string) {
  try {
    localStorage.removeItem(projectKey(id))
  } catch {}
}

export function rememberActiveTab(id: string) {
  try {
    sessionStorage.setItem(ACTIVE_TAB_KEY, id)
  } catch {}
}

/** The open tabs and the one this browser tab shows; the first run adopts the single-project storage. */
export function loadTabs(): { tabs: ProjectTab[]; activeId: string } {
  let tabs: ProjectTab[] = []
  try {
    tabs = parseStoredTabs(localStorage.getItem(TABS_KEY))
  } catch {}
  if (tabs.length === 0) {
    const id = newTabId()
    let project = emptyProject()
    try {
      const legacy = localStorage.getItem(LEGACY_PROJECT_KEY)
      const parsed = legacy ? parseStoredProject(legacy) : null
      if (parsed) project = migrateGappedIslands(parsed)
    } catch {}
    writeProject(id, project)
    tabs = [{ id, name: project.name }]
    writeTabs(tabs)
  }
  let remembered: string | null = null
  try {
    remembered = sessionStorage.getItem(ACTIVE_TAB_KEY)
  } catch {}
  const activeId = tabs.some((t) => t.id === remembered) ? remembered! : tabs[0].id
  return { tabs, activeId }
}
