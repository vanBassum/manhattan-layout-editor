# Manhattan Layout Editor

Browser tool for planning Manhattan-style (dead-bug / laser-cut island) circuit boards from a netlist.

**Live:** https://vanbassum.github.io/manhattan-layout-editor/

- Import an EasyEDA (`.tel`, `.enet`), KiCad (`.net`) or Protel netlist.
- Drag islands and parts; open/shorted pins and isolation problems show live.
- Export the island cuts as SVG for laser engraving.

## Run locally

```
pnpm install
pnpm dev
```

## AI agent (MCP)

Without cloning: `claude mcp add manhattan -- npx -y github:vanBassum/manhattan-layout-editor`, then open the live site. Agents given only the site link find this in [`llms.txt`](https://vanbassum.github.io/manhattan-layout-editor/llms.txt).

`mcp/server.mjs` lets Claude Code inspect and edit the layout open in your browser (registered in `.mcp.json`). Run Claude Code in this repo, then open the live site or `pnpm dev`; the status bar shows **Agent connected**. Other origins: set `MANHATTAN_ALLOWED_ORIGINS`.
