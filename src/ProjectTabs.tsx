import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from './panels'

export interface TabInfo {
  id: string
  label: string
  /** Shown as a dot; closing the tab asks to save first. */
  unsaved: boolean
  /** Where the project is saved, shown as the tab's icon. */
  location: 'drive' | 'local' | 'none'
}

const LOCATIONS = {
  drive: { icon: 'cloud', label: 'Google Drive' },
  local: { icon: 'file', label: 'This computer' },
  none: { icon: 'newFile', label: 'Not saved yet' },
} as const

/** Matches .project-tabs gap and the .icon-button width of the overflow menu button in index.css. */
const GAP = 4
const ICON_BUTTON = 30

/**
 * The tabs that fit in `room` px, in order, always including the active one.
 * Returns null when every tab fits, so no overflow menu is needed.
 */
function tabsThatFit(tabs: TabInfo[], widths: Map<string, number>, activeId: string, room: number): Set<string> | null {
  const widthOf = (tab: TabInfo) => (widths.get(tab.id) ?? 0) + GAP
  if (tabs.reduce((sum, tab) => sum + widthOf(tab), 0) <= room) return null

  const roomWithMenu = room - ICON_BUTTON
  const shown = new Set([activeId])
  let used = widths.get(activeId) ?? 0
  for (const tab of tabs) {
    if (tab.id === activeId) continue
    if (used + widthOf(tab) > roomWithMenu) break
    shown.add(tab.id)
    used += widthOf(tab)
  }
  return shown
}

function TabContent({ tab }: { tab: TabInfo }) {
  return (
    <>
      <Icon name={LOCATIONS[tab.location].icon} />
      <span className="tab-label">{tab.label}</span>
      {tab.unsaved && <span className="unsaved-dot" aria-label="unsaved changes">●</span>}
    </>
  )
}

interface ProjectTabsProps {
  tabs: TabInfo[]
  activeId: string
  onSwitch: (id: string) => void
  onClose: (id: string) => void
}

/** Project tabs in the header; the tabs that do not fit go into a menu instead of a scroll bar. */
export function ProjectTabs({ tabs, activeId, onSwitch, onClose }: ProjectTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const tabElements = useRef(new Map<string, HTMLDivElement>())
  const [room, setRoom] = useState(0)
  const [shown, setShown] = useState<Set<string> | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const strip = stripRef.current!
    const observer = new ResizeObserver(() => setRoom(strip.clientWidth))
    observer.observe(strip)
    return () => observer.disconnect()
  }, [])

  // The tabs array is new on every render of the editor; measure only when what is drawn changes.
  const drawn = tabs.map((tab) => `${tab.id} ${tab.unsaved} ${tab.location} ${tab.label}`).join('\n')
  // Hidden tabs stay rendered (invisible, out of the flow), so every tab's width can be measured here.
  useLayoutEffect(() => {
    const widths = new Map([...tabElements.current].map(([id, element]) => [id, element.offsetWidth]))
    setShown(tabsThatFit(tabs, widths, activeId, room))
  }, [drawn, activeId, room])

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])

  const isShown = (tab: TabInfo) => shown === null || shown.has(tab.id)
  const overflowing = tabs.filter((tab) => !isShown(tab))
  const titleOf = (tab: TabInfo) =>
    [LOCATIONS[tab.location].label, tab.label, tab.unsaved ? 'Unsaved changes' : tab.location !== 'none' && 'Saved'].filter(Boolean).join(' · ')

  return (
    <div className="project-tabs" role="tablist" ref={stripRef}>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          ref={(element) => {
            if (element) tabElements.current.set(tab.id, element)
            else tabElements.current.delete(tab.id)
          }}
          className={['project-tab', tab.id === activeId && 'active', !isShown(tab) && 'overflowed'].filter(Boolean).join(' ')}
          aria-hidden={!isShown(tab)}
        >
          <button role="tab" aria-selected={tab.id === activeId} className="tab-name" onClick={() => onSwitch(tab.id)} title={titleOf(tab)}>
            <TabContent tab={tab} />
          </button>
          <button className="tab-close" onClick={() => onClose(tab.id)} title="Close project" aria-label={`Close ${tab.label}`}>
            ✕
          </button>
        </div>
      ))}
      {overflowing.length > 0 && (
        <div className="menu" ref={menuRef}>
          <button
            className="icon-button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(!menuOpen)}
            title={`${overflowing.length} more project${overflowing.length === 1 ? '' : 's'}`}
            aria-label="More project tabs"
          >
            <Icon name="menu" />
          </button>
          {menuOpen && (
            <div className="menu-list" role="menu">
              {overflowing.map((tab) => (
                <div key={tab.id} className="menu-tab">
                  <button
                    onClick={() => {
                      setMenuOpen(false)
                      onSwitch(tab.id)
                    }}
                    title={titleOf(tab)}
                  >
                    <TabContent tab={tab} />
                  </button>
                  <button className="tab-close" onClick={() => onClose(tab.id)} title="Close project" aria-label={`Close ${tab.label}`}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
