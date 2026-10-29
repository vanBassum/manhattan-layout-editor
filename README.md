# Manhattan Layout Editor

Browser tool for planning Manhattan-style (laser-cut island / dead-bug) circuit boards from a netlist.

**Live:** https://vanbassum.github.io/manhattan-layout-editor/

- Import an EasyEDA (`.tel`, `.enet`), KiCad (`.net`) or Protel netlist.
- Drag islands and parts; open/shorted pins and isolation problems show live.
- Convert plain resistors to 1206 SMD (or back) from the component list.
- Layers can be shown, faded or hidden.
- Export the island cuts as SVG for laser engraving.

## AI assistant (MCP)

Click **AI** in the editor for setup, or run once:

```
claude mcp add manhattan -- npx -y github:vanBassum/manhattan-layout-editor
```

Then open the site; the status bar shows **Agent connected**. Agents given only the site link find this in [`llms.txt`](https://vanbassum.github.io/manhattan-layout-editor/llms.txt).

## Run locally

```
pnpm install
pnpm dev
```
