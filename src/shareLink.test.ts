import { describe, expect, it, vi } from 'vitest'
import example from './examples/Astable multivibrator.manhattan.json?raw'
import { projectFromFile } from './projectStore'
import { shareLinkOf, takeSharedProject } from './shareLink'

describe('share links', () => {
  it('carry the project there and back, and are taken off the address bar once opened', async () => {
    const page = { origin: 'https://example.org', pathname: '/editor/', search: '?a=1', hash: '' }
    const replaceState = vi.fn()
    vi.stubGlobal('location', page)
    vi.stubGlobal('history', { replaceState })
    const project = projectFromFile(example)

    const link = await shareLinkOf(project)
    expect(link).toMatch(/^https:\/\/example\.org\/editor\/#share=[\w-]+$/)
    page.hash = link.slice(link.indexOf('#'))

    expect(await takeSharedProject()).toEqual(project)
    expect(replaceState).toHaveBeenCalledWith(null, '', '/editor/?a=1')
  })

  it('opens nothing for a page without one', async () => {
    vi.stubGlobal('location', { hash: '#other' })
    expect(await takeSharedProject()).toBeNull()
  })
})
