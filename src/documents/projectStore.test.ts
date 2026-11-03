import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import example from '../examples/Astable multivibrator.json?raw'
import { emptyProject, projectFromFile } from './projectFormat'

// projectStore keeps its state in the module, so each test loads a fresh copy on a fresh database.
beforeEach(() => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', new IDBFactory())
  // Other copies in this test run must not hear each other.
  vi.stubGlobal('BroadcastChannel', undefined)
})

/** Puts the tabs and project records a last session left behind into the database. */
async function seedSession(tabs: { id: string; name: string }[], projects: Record<string, unknown>) {
  const opening = indexedDB.open('manhattan-layout-editor', 1)
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore('projects')
    opening.result.createObjectStore('meta')
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  const transaction = db.transaction(['projects', 'meta'], 'readwrite')
  transaction.objectStore('meta').put(tabs, 'tabs')
  for (const [id, stored] of Object.entries(projects)) transaction.objectStore('projects').put(stored, id)
  await new Promise((resolve) => (transaction.oncomplete = resolve))
  db.close()
}

describe('openProjectStore', () => {
  it('reopens the tabs it can, and tells why each other tab could not be opened', async () => {
    await seedSession(
      [
        { id: 'good', name: 'Good' },
        { id: 'gone', name: 'Gone' },
        { id: 'damaged', name: 'Damaged' },
      ],
      {
        good: { project: projectFromFile(example), savedContent: example },
        damaged: { project: { netlist: { components: [] } }, savedContent: '' },
      },
    )
    vi.resetModules()
    const store = await import('./projectStore')
    await store.openProjectStore()
    expect(store.loadTabs().tabs.map((t) => t.id)).toEqual(['good'])
    expect(store.restoreErrors).toEqual([
      'Could not open "Gone" again: its recovery copy is missing.',
      'Could not open "Damaged" again: the project is damaged: netlist or layout is missing.',
    ])
  })
})

describe('open projects', () => {
  it('refuse an id that is not open, rather than inventing an empty project', async () => {
    const store = await import('./projectStore')
    await store.openProjectStore()
    expect(() => store.readProject('nope')).toThrow('no open project has id "nope"')
    expect(() => store.projectFile('nope')).toThrow('no open project has id "nope"')
    expect(() => store.writeProject('nope', emptyProject())).toThrow('no open project has id "nope"')
  })
})

describe('file status', () => {
  it('gets a new version, and tells its listeners, only when a tab gets or loses unsaved changes', async () => {
    const store = await import('./projectStore')
    await store.openProjectStore()
    const { activeId } = store.loadTabs()
    let heard = 0
    store.onFileChange(() => heard++)
    const before = store.fileStatusVersion()
    const shown = store.readProject(activeId)
    const changed = { ...shown, settings: { ...shown.settings, snap: 1 } }

    store.writeProject(activeId, changed)
    expect(store.projectFile(activeId).dirty).toBe(true)
    expect(store.fileStatusVersion()).toBe(before + 1)

    store.writeProject(activeId, { ...changed, settings: { ...changed.settings, snap: 2 } })
    expect(store.fileStatusVersion()).toBe(before + 1)

    store.setSavedProject(activeId, changed)
    expect(store.fileStatusVersion()).toBe(before + 2)
    expect(heard).toBe(2)
  })
})

describe('reopening a tab', () => {
  it('compares its saved content as this version writes it, and names a local file tab after its file', async () => {
    const handle = { name: 'amp.manhattan.json' }
    // Before locations, a record kept its linked file as `handle`; `example` was written by an older version.
    await seedSession([{ id: 'amp', name: 'Old name' }], { amp: { project: projectFromFile(example), savedContent: example, handle } })
    vi.resetModules()
    const store = await import('./projectStore')
    await store.openProjectStore()
    expect(store.loadTabs().tabs).toEqual([{ id: 'amp', name: 'amp' }])
    expect(store.projectFile('amp')).toMatchObject({ location: { kind: 'local', handle }, dirty: false, checked: false })
  })
})

describe('a Drive tab from before November 2026', () => {
  it('has its location reduced to the document, and the version moved to the saved revision', async () => {
    await seedSession([{ id: 'doc', name: 'Amp' }], {
      doc: { project: projectFromFile(example), savedContent: example, location: { kind: 'drive', fileId: 'f1', version: '7' } },
    })
    vi.resetModules()
    const store = await import('./projectStore')
    await store.openProjectStore()
    const file = store.projectFile('doc')
    expect(file.location).toEqual({ kind: 'drive', fileId: 'f1' })
    expect(file.driveRevision).toEqual({ version: '7' })
    expect(file).toMatchObject({ dirty: false, checked: false })
  })
})

/** Stands in for the BroadcastChannel, so a test can deliver a message from another browser tab. */
class FakeChannel {
  static last: FakeChannel
  listeners: ((e: MessageEvent) => void)[] = []
  constructor() {
    FakeChannel.last = this
  }
  addEventListener(_type: string, listener: (e: MessageEvent) => void) {
    this.listeners.push(listener)
  }
  postMessage() {}
  receive(data: unknown) {
    this.listeners.forEach((listener) => listener({ data } as MessageEvent))
  }
}

describe('another browser tab', () => {
  it('changing a project updates it here, and keeps whether it was checked', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    const store = await import('./projectStore')
    await store.openProjectStore()
    const { activeId } = store.loadTabs()
    const changes: unknown[] = []
    store.onRemoteChange((change) => changes.push(change))
    const shown = store.readProject(activeId)
    const changed = { ...shown, settings: { ...shown.settings, snap: 1 } }
    const savedContent = store.projectFile(activeId).savedContent

    FakeChannel.last.receive({ kind: 'project', id: activeId, stored: { project: changed, savedContent } })

    expect(store.readProject(activeId)).toBe(changed)
    expect(store.projectFile(activeId)).toMatchObject({ savedContent, dirty: true, checked: true })
    expect(changes).toEqual([{ kind: 'project', id: activeId, project: changed }])
  })

  it('changing the tabs updates them here', async () => {
    vi.stubGlobal('BroadcastChannel', FakeChannel)
    const store = await import('./projectStore')
    await store.openProjectStore()
    const tabs = [{ id: 'other', name: 'Other' }]
    const changes: unknown[] = []
    store.onRemoteChange((change) => changes.push(change))

    FakeChannel.last.receive({ kind: 'tabs', tabs })

    expect(store.loadTabs().tabs).toEqual(tabs)
    expect(changes).toEqual([{ kind: 'tabs', tabs }])
  })
})
