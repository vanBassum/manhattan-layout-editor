import { describe, expect, it, vi } from 'vitest'

describe('projectsFolder', () => {
  it('looks the folder up again after signing in anew, which may be another Google account', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    })
    const signInAs = (accessToken: string) =>
      stored.set(
        'manhattan-layout-editor/drive-token',
        JSON.stringify({ accessToken, expiresAt: Date.now() + 60_000, scope: 'https://www.googleapis.com/auth/drive.file' }),
      )
    // Each account has its own folder: the id names the token that found it.
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).Authorization.replace('Bearer ', '')
      return new Response(JSON.stringify({ files: [{ id: `folder of ${token}` }] }))
    })
    const { projectsFolder } = await import('./googleDrive')

    signInAs('alice')
    expect(await projectsFolder()).toBe('folder of alice')
    signInAs('bob')
    expect(await projectsFolder()).toBe('folder of bob')
  })
})
