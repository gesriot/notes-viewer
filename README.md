# Notes Viewer

A clean, high-fidelity Markdown vault viewer that uses web technologies for rendering (similar to VS Code Markdown preview pane).

- Sidebar with tag search (AND tokens, like the original TUI)
- Excellent HTML rendering: real tables, typography, images, code highlighting, KaTeX math
- No editor – pure viewer
- Reuses your vault layout (notes/ + images/)

## Install

Grab the latest build from the [Releases](https://github.com/gesriot/notes-viewer/releases) page.

### macOS

The app is not notarized, so macOS quarantines it after download. Copy it to
`Applications`, then clear the quarantine flag once:

```bash
xattr -dr com.apple.quarantine /Applications/notes-viewer.app
```

### Windows

Download the portable `.zip`, extract it, and run `notes-viewer.exe` – keep the
`vault` folder next to the executable.

## Run (development)

```bash
cd notes-viewer

# install once
npm install

# run
npm run tauri dev
```

## Build

```bash
npm run tauri build
```

The built app includes the copied `vault` (if you keep it in resources).

## Controls (keyboard)

- `/` – focus search
- `↑` `↓` / `j` `k` – select note
- `Space` / `b` – scroll preview
- `[` `]` – cycle images in current note (highlights + scrolls)
- `o` – open first/current image externally
- `Ctrl/Cmd + R` – reload vault
- Click images in preview to open them

## Notes location

The app looks for a `vault/` folder next to the binary (or in resources when bundled).

Your original `vault/notes` and `vault/images` were copied here.

## Tech

- Tauri 2 (Rust backend + webview)
- Vite + TypeScript frontend
- marked + highlight.js + KaTeX (for beautiful rendering like VS Code preview)
- Full HTML/CSS for the preview (real tables, proper math, crisp images)

This gives you desktop-app visuals much closer to VS Code / Obsidian reading view than the terminal version.
