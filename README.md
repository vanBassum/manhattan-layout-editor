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

`mcp/server.mjs` lets Claude Code inspect and edit the layout open at http://localhost:5173 (registered in `.mcp.json`). Only works with a local dev server, not the Pages site.
