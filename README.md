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

## Google Drive (optional)

A project is saved either on this computer or in Google Drive; the tab's icon shows which. **Open…**
and **Save as…** show a file explorer: Google Drive, and the work folders you add from this computer,
with subfolders, renaming and deleting. Projects in Google Drive live in the folder
"Manhattan Layout Editor" in your Drive, save themselves a moment after each change, and open from
any computer. Nothing is copied between the two: **Save as…** makes a copy elsewhere and continues
there. Without Google the editor works as before and loads nothing from Google.

Google Drive is only offered in builds with a Google OAuth client id:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Set up the OAuth consent screen (External) with the scopes `.../auth/drive.file` and `.../auth/drive.appdata`
   (the latter only to move projects that earlier versions kept in a hidden folder), and publish it.
3. Create an OAuth client id of type **Web application**. Add the site's origin (`https://vanbassum.github.io`)
   and `http://localhost:5173` as authorized JavaScript origins.
4. Put the client id in the repository variable `GOOGLE_CLIENT_ID` (Settings → Secrets and variables → Actions → Variables),
   and locally in `.env.local` as `VITE_GOOGLE_CLIENT_ID=...`.
