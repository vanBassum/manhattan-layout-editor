# Architecture

The editor is a single-page React app. The browser holds all state; the MCP server in `mcp/`
only forwards an agent's tool calls to the page. This file fixes which part of the code may
depend on which, and where each file is headed. Files move into their folder while their domain
is being refactored, not all at once.

## Domains

| Domain | Folder | What it is | May import |
| --- | --- | --- | --- |
| model | `src/model/` | The project's data and every pure rule about it: types, geometry, netlist parsing, footprints, definitions, build styles, layout, schematic, selection, undo history, and migrations of old stored data. No React, DOM, storage or network. | model |
| export | `src/export/` | Pure conversions of a layout to files to cut with (SVG, DXF). Returns text; saving it is up to the caller. | model |
| documents | `src/documents/` | Where projects live: the project file format, the recovery copies and open tabs in IndexedDB, files on this computer, Google Drive, share links. | model |
| agent | `src/agent/` | The page side of the MCP bridge: the WebSocket connection and the commands an agent can run on a project. Gets the project and its effects (change, undo, screenshot) passed in. | model |
| ui | `src/ui/` | React components, from `App` down; the only place that renders, reads the DOM or wires the other domains together. Sub-folders per view: `ui/pcb/`, `ui/schematic/`, `ui/dialogs/`. | everything |

Rules that follow from the table:

- Dependencies point down the table and never back: nothing outside `ui` imports from `ui`, and
  `model` imports nothing outside `model`.
- A shared type lives with the concept it belongs to, not in the component that happened to use it
  first: `Geometry` in `model/types.ts`, layer settings in `ui/layers.ts` rather than in `Canvas`.
- No import cycles: `npx madge --circular --extensions ts,tsx src` stays empty.
- `src/` itself keeps only `main.tsx`, `index.css` and `errorText.ts`, which every domain may use.
- Tests sit next to the module they test.

## Where today's files go

| File | Domain |
| --- | --- |
| `types`, `geometry`, `netlist`, `netlistImport`, `footprints`, `footprintTemplates`, `buildStyles`, `layout`, `definitions`, `schematicSymbols`, `schematic`, `boundary`, `islandEdges`, `layoutDrag`, `selection`, `undoHistory` | model (in place) |
| `migrateIslands`, `migrateCutLayout` | model (in place in `model/migrations/`) |
| `exportSvg`, `exportDxf` | export (in place; `downloadText` lives in `ui/download`: it touches the DOM) |
| `projectStore`, `projectFiles`, `driveDocuments`, `googleDrive`, `googlePicker`, `shareLink` | documents (in place, with the file format split off into `projectFormat` and the examples into `examples`) |
| `agentBridge`, `agentCommands`, `agentDispatch` | agent (in place) |
| `App`, `AppMenu`, `ProjectTabs`, `CanvasBanners`, `PcbToolRail`, `SchematicToolRail`, `PcbSettings`, `panels`, `icons`, `dialogs`, `FileDialog`, `FootprintDialog`, `layers`, `viewport`, `preferences`, `shortcuts`, `useDocuments`, `useTabs`, `useDropdown`, `download` | ui (in place) |
| `Canvas`, `partDrawing`, `screenshot`, `hiddenScreenshot` | ui (in place in `ui/pcb/`): they render or read the drawn board |
| `SchematicView`, `SchematicDrawing` | ui (in place in `ui/schematic/`): the schematic's state and pointer input, and how its symbols, labels and parts are drawn |

## Data flow

- `ui/useTabs` holds the open tabs and the shown project in React state; every change goes through
  it, so it can be undone: an action as one `commitEdit`, a drag as one `beginEdit` and its updates.
  `documents` writes a recovery copy of each change to IndexedDB and tells other browser tabs.
- A part's drawn geometry and symbol come from `model/definitions.ts` (`buildNetlist`); the
  stored netlist never holds them.
- The schematic has its own nets; the PCB only takes them over on "Update PCB". A project's
  schematic is always complete (a placement per part, its wires and labels): it is completed where
  parts come in (loading, netlist import, an agent's `add_component`), never while drawing.
- An agent command runs on any open tab: `agent` gets that tab's project and functions to change
  it, undo, and take a screenshot, and never reaches into React state itself.
