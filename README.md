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

## Google Drive sync (optional)

Menu → **Sync tabs with Google Drive** keeps the open tabs, unsaved changes included, in a hidden
folder of your Google Drive, so another computer gets them back after signing in. Without it the
editor works as before and loads nothing from Google.

The option only shows in builds with a Google OAuth client id:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Set up the OAuth consent screen (External) with the scope `.../auth/drive.appdata`, and publish it.
3. Create an OAuth client id of type **Web application**. Add the site's origin (`https://vanbassum.github.io`)
   and `http://localhost:5173` as authorized JavaScript origins.
4. Put the client id in the repository variable `GOOGLE_CLIENT_ID` (Settings → Secrets and variables → Actions → Variables),
   and locally in `.env.local` as `VITE_GOOGLE_CLIENT_ID=...`.
