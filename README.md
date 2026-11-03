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

A project is saved either on this computer or in Google Drive; the tab's icon shows which. Files on
this computer open and save through the computer's own file dialogs. For Google Drive, Open and Save
show the folder "Manhattan Layout Editor" in My Drive and its subfolders; another folder or file is
picked in Google's file picker. Projects in Google Drive open from any computer. A project, on this
computer or in Google Drive, is only written when you save it (**Save**, Ctrl+S, or **Save as…**);
until then your changes are kept in this browser, so a crash or reload loses nothing. Nothing is copied between the two: **Save as…** makes a copy elsewhere and continues there.
Without Google the editor works as before and loads nothing from Google.

The editor only sees what it saved itself in Google Drive, and what you pick in Google's file picker
(scope `drive.file`), never the rest of your Drive.

Google Drive is only offered in builds with a Google OAuth client id and an API key:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the
   **Google Drive API** and the **Google Picker API**.
2. Set up the OAuth consent screen (External) with the scope `.../auth/drive.file`, and publish it.
3. Create an OAuth client id of type **Web application**. Add the site's origin (`https://vanbassum.github.io`)
   and `http://localhost:5173` as authorized JavaScript origins.
4. Create an API key, restricted to the Google Picker API and to the websites `https://vanbassum.github.io/*`
   and `http://localhost:5173/*`.
5. Put both in the repository variables `GOOGLE_CLIENT_ID` and `GOOGLE_API_KEY` (Settings → Secrets and
   variables → Actions → Variables), and locally in `.env.local` as `VITE_GOOGLE_CLIENT_ID=...` and
   `VITE_GOOGLE_API_KEY=...`.
