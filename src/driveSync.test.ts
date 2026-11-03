import { describe, expect, it } from 'vitest'
import example from './examples/multivibrator.manhattan.json?raw'
import { mergeTabs, NEVER_SYNCED, syncWorkspace, type SyncState, type Workspace } from './driveSync'
import type { AppFolder, DriveFile } from './googleDrive'
import { projectFromFile, projectToFile, type ProjectTab } from './projectStore'

/** Drive's app data folder, in memory. */
function fakeFolder() {
  const files = new Map<string, DriveFile & { text: string }>()
  let nextId = 1
  const folder: AppFolder = {
    list: async () => [...files.values()].map(({ id, name, version }) => ({ id, name, version })),
    read: async (id) => files.get(id)!.text,
    write: async (name, text, id) => {
      const previous = id ? files.get(id)! : undefined
      const file = { id: id ?? `file${nextId++}`, name, text, version: String(Number(previous?.version ?? 0) + 1) }
      files.set(file.id, file)
      return { id: file.id, name, version: file.version }
    },
    remove: async (id) => void files.delete(id),
  }
  return { folder, names: () => [...files.values()].map((f) => f.name).sort(), empty: () => files.clear() }
}

const projectNamed = (name: string) => projectToFile({ ...projectFromFile(example), name })

/** A computer with open tabs; each sync keeps its state for the next one. */
function device(folder: AppFolder, tabs: { id: string; name: string }[]) {
  const contents = new Map(tabs.map((t) => [t.id, projectNamed(t.name)]))
  let openTabs: ProjectTab[] = tabs
  let state: SyncState = NEVER_SYNCED
  let nextId = 1
  const workspace: Workspace = {
    tabs: () => openTabs,
    content: (id) => contents.get(id),
    applyProject: (id, project) => void contents.set(id, projectToFile(project)),
    applyTabs: (tabs) => {
      openTabs = tabs
      for (const id of contents.keys()) if (!tabs.some((t) => t.id === id)) contents.delete(id)
    },
    newTabId: () => `copy${nextId++}`,
  }
  return {
    sync: async () => {
      const result = await syncWorkspace(folder, workspace, state)
      state = result.state
      return result.conflicts
    },
    tabs: () => openTabs.map((t) => t.id),
    name: (id: string) => projectFromFile(contents.get(id)!).name,
    edit: (id: string, name: string) => void contents.set(id, projectNamed(name)),
    close: (id: string) => {
      openTabs = openTabs.filter((t) => t.id !== id)
      contents.delete(id)
    },
  }
}

describe('syncWorkspace', () => {
  it('brings the tabs of one computer to another, next to its own', async () => {
    const drive = fakeFolder()
    const a = device(drive.folder, [{ id: 'amp', name: 'Amp' }])
    const b = device(drive.folder, [{ id: 'psu', name: 'PSU' }])
    await a.sync()
    await b.sync()
    await a.sync()
    expect(b.tabs()).toEqual(['amp', 'psu'])
    expect(a.tabs()).toEqual(['amp', 'psu'])
    expect(a.name('psu')).toBe('PSU')
    expect(drive.names()).toEqual(['tab-amp.manhattan.json', 'tab-psu.manhattan.json', 'workspace.json'])
  })

  it('copies a change to the other computer', async () => {
    const drive = fakeFolder()
    const a = device(drive.folder, [{ id: 'amp', name: 'Amp' }])
    const b = device(drive.folder, [])
    await a.sync()
    await b.sync()
    a.edit('amp', 'Amp v2')
    await a.sync()
    await b.sync()
    expect(b.name('amp')).toBe('Amp v2')
  })

  it('closes a tab on the other computer, and removes its file', async () => {
    const drive = fakeFolder()
    const a = device(drive.folder, [{ id: 'amp', name: 'Amp' }, { id: 'psu', name: 'PSU' }])
    const b = device(drive.folder, [])
    await a.sync()
    await b.sync()
    a.close('psu')
    await a.sync()
    await b.sync()
    expect(b.tabs()).toEqual(['amp'])
    expect(drive.names()).toEqual(['tab-amp.manhattan.json', 'workspace.json'])
  })

  it('keeps both versions of a project changed on both computers', async () => {
    const drive = fakeFolder()
    const a = device(drive.folder, [{ id: 'amp', name: 'Amp' }])
    const b = device(drive.folder, [])
    await a.sync()
    await b.sync()
    a.edit('amp', 'Amp from A')
    b.edit('amp', 'Amp from B')
    await a.sync()
    // The tab's name; in the editor it follows the project's.
    expect(await b.sync()).toEqual(['Amp'])
    expect(b.tabs()).toEqual(['amp', 'copy1'])
    expect(b.name('amp')).toBe('Amp from B')
    expect(b.name('copy1')).toBe('Amp from A')
    expect(await a.sync()).toEqual([])
    expect(a.name('amp')).toBe('Amp from B')
    expect(a.name('copy1')).toBe('Amp from A')
  })

  it('keeps a tab closed elsewhere that has changes here', async () => {
    const drive = fakeFolder()
    const a = device(drive.folder, [{ id: 'amp', name: 'Amp' }, { id: 'psu', name: 'PSU' }])
    const b = device(drive.folder, [])
    await a.sync()
    await b.sync()
    a.close('psu')
    b.edit('psu', 'PSU v2')
    await a.sync()
    await b.sync()
    await a.sync()
    expect(b.tabs()).toEqual(['amp', 'psu'])
    expect(a.tabs()).toEqual(['amp', 'psu'])
    expect(a.name('psu')).toBe('PSU v2')
  })

  it('closes nothing here when Drive was emptied', async () => {
    const drive = fakeFolder()
    const a = device(drive.folder, [{ id: 'amp', name: 'Amp' }])
    await a.sync()
    drive.empty()
    await a.sync()
    expect(a.tabs()).toEqual(['amp'])
    expect(drive.names()).toEqual(['tab-amp.manhattan.json', 'workspace.json'])
  })
})

describe('mergeTabs', () => {
  const tab = (id: string) => ({ id, name: id })
  it('keeps Drive order, drops tabs closed here and adds tabs opened here', () => {
    const merged = mergeTabs([tab('a'), tab('b'), tab('c')], [tab('a'), tab('c'), tab('d')], [tab('a'), tab('b'), tab('c')], () => false)
    expect(merged.map((t) => t.id)).toEqual(['a', 'c', 'd'])
  })
  it('drops a tab closed elsewhere unless it changed here', () => {
    const synced = [tab('a'), tab('b')]
    expect(mergeTabs([tab('a')], synced, synced, () => false).map((t) => t.id)).toEqual(['a'])
    expect(mergeTabs([tab('a')], synced, synced, (id) => id === 'b').map((t) => t.id)).toEqual(['a', 'b'])
  })
})
