import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import example from './examples/Astable multivibrator.manhattan.json?raw'

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
    const { projectFromFile } = await import('./projectStore')
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
    expect(() => store.writeProject('nope', store.emptyProject())).toThrow('no open project has id "nope"')
  })
})
