# Architecture

The editor is a single-page React app. The browser holds all state; the MCP server in `mcp/`
only forwards an agent's tool calls to the page. This file fixes which part of the code may
depend on which, and where each file is headed. Files move into their folder while their domain
is being refactored, not all at once.

## Domains

| Domain | Folder | What it is | May import |
| --- | --- | --- | --- |
| model | `src/model/` | The project's data and every pure rule about it: types, geometry, netlist parsing, footprints, definitions, layout, schematic, selection, undo history, and migrations of old stored data. No React, DOM, storage or network. | model |
| optimize | `src/optimize/` | Layout strategies that build a complete layout from a netlist. | model |
| export | `src/export/` | Pure conversions of a layout to files to cut with (SVG, DXF). Returns text; saving it is up to the caller. | model |
| documents | `src/documents/` | Where projects live: the project file format, the recovery copies and open tabs in IndexedDB, files on this computer, Google Drive, share links. | model, optimize (only to validate and default the chosen strategy) |
| agent | `src/agent/` | The page side of the MCP bridge: the WebSocket connection and the commands an agent can run on a project. Gets the project and its effects (change, undo, screenshot) passed in. | model, optimize |
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
| `types`, `geometry`, `netlist`, `footprints`, `layout`, `definitions`, `schematicSymbols`, `schematic`, `raster`, `cuts`, `selection`, `undoHistory` | model |
| `migrateIslands`, `migrateCutLayout` | model (`model/migrations/`) |
| `optimize/*` | optimize (already in place) |
| `exportSvg`, `exportDxf` | export (`downloadText` moves to `ui`: it touches the DOM) |
| `projectStore`, `projectFiles`, `driveDocuments`, `googleDrive`, `googlePicker`, `shareLink` | documents (in place, with the file format split off into `projectFormat` and the examples into `examples`) |
| `agentBridge`, `agentCommands`, `agentDispatch` | agent |
| `App`, `AppMenu`, `ProjectTabs`, `CanvasBanners`, `PcbToolRail`, `SchematicToolRail`, `PcbSettings`, `panels`, `icons`, `dialogs`, `FileDialog`, `FootprintDialog`, `layers`, `viewport`, `preferences`, `shortcuts`, `useDocuments`, `useTabs`, `useDropdown` | ui (in place) |
| `Canvas`, `screenshot`, `hiddenScreenshot` | ui (`ui/pcb/`): they render or read the drawn board |
| `SchematicView` | ui (`ui/schematic/`) |

## Data flow

- `ui/useTabs` holds the open tabs and the shown project in React state; every change goes through
  it, so it can be undone: an action as one `commitEdit`, a drag as one `beginEdit` and its updates.
  `documents` writes a recovery copy of each change to IndexedDB and tells other browser tabs.
- A part's drawn geometry and symbol come from `model/definitions.ts` (`buildNetlist`); the
  stored netlist never holds them.
- The schematic has its own nets; the PCB only takes them over on "Update PCB".
- An agent command runs on any open tab: `agent` gets that tab's project and functions to change
  it, undo, and take a screenshot, and never reaches into React state itself.
