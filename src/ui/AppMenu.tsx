import { EXAMPLES } from '../documents/examples'
import { driveConfigured, signOut } from '../documents/googleDrive'
import { Icon, MenuGroup } from '../panels'
import type { Project } from '../types'
import type { Theme } from './preferences'
import { useDropdown } from './useDropdown'

interface AppMenuProps {
  agentConnected: boolean
  signedIn: boolean
  theme: Theme
  onNewProject: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onOpenInNewTab: (project: Project, name: string) => void
  onImportNetlist: () => void
  onExportSvg: () => void
  onExportDxf: () => void
  onCopyShareLink: () => void
  onToggleTheme: () => void
  onShowAiHelp: () => void
  onShowHelp: () => void
  onSignIn: () => void
}

/** The header's Menu button and its list; picking an entry closes it. */
export function AppMenu(props: AppMenuProps) {
  const { agentConnected, signedIn, theme } = props
  const { open, setOpen, menuRef } = useDropdown()
  return (
    <div className="menu" ref={menuRef}>
      <button
        className="header-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        title={agentConnected ? 'Menu (AI agent connected)' : 'Menu'}
      >
        <Icon name="menu" />Menu
        {agentConnected && <span className="agent-dot connected" aria-label="Agent connected" />}
      </button>
      {open && (
        <div className="menu-list" role="menu" onClick={() => setOpen(false)}>
          <span className="menu-heading">File</span>
          <button onClick={props.onNewProject} title="An empty project in a new tab">
            <Icon name="newFile" />New project<kbd>Ctrl+N</kbd>
          </button>
          <button onClick={props.onOpen} title="Open a project from this computer or Google Drive in a new tab">
            <Icon name="open" />Open…<kbd>Ctrl+O</kbd>
          </button>
          <button onClick={props.onSave} title="Save this tab's project where it is saved; a new project asks where">
            <Icon name="save" />Save<kbd>Ctrl+S</kbd>
          </button>
          <button onClick={props.onSaveAs} title="Save under another name or somewhere else; the tab continues there">
            <Icon name="save" />Save as…<kbd>Ctrl+Shift+S</kbd>
          </button>
          <MenuGroup icon="sample" label="Examples">
            {EXAMPLES.map((example) => (
              <button key={example.name} onClick={() => props.onOpenInNewTab(example.open(), example.name)} title="A copy of this example in a new tab">
                {example.name}
              </button>
            ))}
          </MenuGroup>
          <hr />
          <MenuGroup icon="importExport" label="Import / Export">
            <button onClick={props.onImportNetlist}><Icon name="file" />Import netlist…</button>
            <button onClick={props.onExportSvg} title="Cut paths with stroke width = isolation"><Icon name="export" />Export SVG</button>
            <button onClick={props.onExportDxf} title="Area to burn as closed contours in mm (board outline + copper as holes), ready to hatch in EzCad">
              <Icon name="export" />Export DXF
            </button>
            <button onClick={props.onCopyShareLink} title="Copy a link that holds this whole project; opening it gives a copy in a new tab">
              <Icon name="link" />Copy share link
            </button>
          </MenuGroup>
          <MenuGroup icon="settings" label="Settings">
            <button onClick={props.onToggleTheme}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
              {theme === 'dark' ? 'Light mode' : 'Dark mode'}
            </button>
          </MenuGroup>
          <MenuGroup icon="help" label="Help">
            <button onClick={props.onShowAiHelp} title="Let an AI assistant edit this layout (MCP)">
              <Icon name="ai" />AI assistant…
              <span className={agentConnected ? 'agent-dot connected' : 'agent-dot'} aria-label={agentConnected ? 'Agent connected' : 'No agent'} />
            </button>
            <button onClick={props.onShowHelp}>
              <Icon name="help" />Keyboard and mouse
            </button>
          </MenuGroup>
          {driveConfigured && (
            <>
              <hr />
              <MenuGroup icon="user" label="Google account">
                {signedIn ? (
                  <button onClick={signOut} title="Google Drive projects stay open here; they save again after signing in">
                    <Icon name="cloud" />Sign out
                  </button>
                ) : (
                  <button onClick={props.onSignIn} title="Sign in to open and save projects in Google Drive">
                    <Icon name="cloud" />Sign in with Google
                  </button>
                )}
              </MenuGroup>
            </>
          )}
        </div>
      )}
    </div>
  )
}
