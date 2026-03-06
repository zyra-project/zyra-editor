# Zyra Editor UI Overhaul Plan

## Problems to Fix

1. **Canvas drag drags the entire page** — The React Flow canvas sits in a flex layout without proper isolation; pointer events leak to the outer container, causing the whole viewport to scroll/drag.
2. **YAML panel fights for space with the node inspector** — Both ArgPanel (300px) and YamlPanel (420px) are absolutely positioned on the right and can overlap or crowd the canvas.
3. **Inspector escapes the editor area into the header** — ArgPanel uses `position: absolute; right: 0` with no top constraint, so it can extend above the main editing region into the toolbar.
4. **No integrated output/logging per node** — Logs are in a separate bottom panel with tabs. You have to context-switch away from the node you're inspecting to see its output. n8n shows input/output data directly in the node detail panel.
5. **No light/dark mode** — Everything is hardcoded to dark hex values across 8+ files with inline styles.
6. **Rough overall feel** — No CSS framework, no design tokens, no consistent spacing/radius system. Pure inline styles everywhere.

---

## Phase 1: Layout & Containment Fixes

### 1.1 Isolate the canvas viewport

- Wrap the ReactFlow container in a div with `overflow: hidden; position: relative; flex: 1` and explicitly set `pointer-events` so drag events don't propagate.
- Add `style={{ width: '100%', height: '100%' }}` on the ReactFlow element itself.
- Set `panOnDrag={true}` and `selectionOnDrag={false}` explicitly to prevent ambiguous drag behavior.

### 1.2 Contain panels within the editor region

- Change the main layout from a single flex row to a CSS Grid with named regions:
  ```
  "toolbar  toolbar  toolbar"   40px
  "palette  canvas   detail"    1fr
  "palette  logs     logs"      auto
  ```
- The `detail` column is 0px when no panel is open, 340px for ArgPanel, or 440px for YamlPanel — using `grid-template-columns` transitions.
- This guarantees panels can never escape their grid area into the toolbar row.
- ArgPanel and YamlPanel become grid children instead of absolutely positioned overlays.

### 1.3 Collapsible palette sidebar

- Add a collapse toggle (hamburger or `<<` / `>>` icon) at the top of NodePalette.
- When collapsed, palette shrinks to ~48px showing only stage category icons.
- Gives more canvas room on small screens.

---

## Phase 2: Unified Node Detail Panel (n8n-inspired)

### 2.1 Replace ArgPanel with a tabbed NodeDetailPanel

Create a new `NodeDetailPanel.tsx` that replaces `ArgPanel.tsx`. When a node is selected, this panel slides in on the right with tabs:

| Tab | Contents |
|-----|----------|
| **Settings** | All argument fields (current ArgPanel content), plus node label editor, CLI command preview |
| **Input** | Descriptions of input ports — what types they accept, what's connected, data flowing in |
| **Output** | Descriptions of output ports, plus execution results: stdout, stderr, exit code, elapsed time |

- The **Output tab** absorbs what's currently in `LogPanel.tsx` for the selected node. This is the biggest UX win — you see a node's config and output in one place, just like n8n.
- Each tab shows a status badge (green check, red X, spinner) so you know at a glance.

### 2.2 Rework LogPanel into a global execution console

- LogPanel becomes a thin, collapsible bottom bar showing only pipeline-wide execution progress (e.g., "3/7 steps complete, 1 failed").
- Clicking a node name in this summary opens that node's detail panel Output tab.
- Remove the per-node tab system from LogPanel — that responsibility moves to NodeDetailPanel.

### 2.3 Port descriptions and data-flow hints

- In ZyraNode, add small hover tooltips on port handles showing: port name, accepted types, and whether it's connected.
- In NodeDetailPanel Input/Output tabs, list connected ports with the connected peer's label and status.

---

## Phase 3: Theme System (Light + Dark Mode)

### 3.1 Introduce CSS custom properties (design tokens)

Create a `theme.css` file with two sets of CSS variables:

```css
:root, [data-theme="dark"] {
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-tertiary: #1a1a2e;
  --bg-node: #16213e;
  --text-primary: #c9d1d9;
  --text-secondary: #8b949e;
  --text-muted: #484f58;
  --border-default: #30363d;
  --border-muted: #21262d;
  --accent-blue: #58a6ff;
  --accent-green: #3fb950;
  --accent-red: #f85149;
  --handle-input: #58a6ff;
  --handle-output: #3fb950;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 12px;
  --space-lg: 16px;
  --space-xl: 24px;
  --font-mono: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
}

[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f6f8fa;
  --bg-tertiary: #f0f3f6;
  --bg-node: #ffffff;
  --text-primary: #1f2328;
  --text-secondary: #656d76;
  --text-muted: #8b949e;
  --border-default: #d0d7de;
  --border-muted: #d8dee4;
  --accent-blue: #0969da;
  --accent-green: #1a7f37;
  --accent-red: #cf222e;
  --handle-input: #0969da;
  --handle-output: #1a7f37;
  /* radius + spacing stay the same */
}
```

### 3.2 Replace all inline style hex values

- Systematically replace every hardcoded color in all components with `var(--token-name)`.
- This is the largest mechanical change — touches every file.
- Keep inline styles for layout (flex, grid, position) but move colors and typography to CSS variables.

### 3.3 Theme toggle in Toolbar

- Add a sun/moon icon toggle in the Toolbar.
- Persists choice to `localStorage`.
- Sets `data-theme` attribute on `<html>` element.
- Default to dark (matches current behavior) or respect `prefers-color-scheme`.

---

## Phase 4: Visual Polish

### 4.1 Improve node appearance

- Round node corners more (`border-radius: 8px`).
- Add subtle box shadow for depth (`0 2px 8px rgba(0,0,0,0.3)` in dark, lighter in light mode).
- Smoother status transitions (CSS transition on border-color and background).
- Cleaner port handles — slightly larger circles with a subtle ring on hover.

### 4.2 Better edge styling

- Use `smoothstep` or `bezier` edge type instead of default for cleaner curves.
- Animated edges only when pipeline is running (not always).
- Hover highlight on edges with a glow effect.

### 4.3 Improved toolbar

- Group related actions: left group (pipeline ops: Dry Run, Run, Cancel), center (title/status), right group (YAML toggle, theme toggle, settings).
- Subtle separator lines between groups.
- Tooltip on every button.

### 4.4 Keyboard shortcuts

- `Escape` — deselect node / close detail panel
- `Delete` / `Backspace` — delete selected node
- `Cmd+S` / `Ctrl+S` — export YAML
- `Space` — toggle canvas pan mode (n8n pattern)

---

## Phase 5: YAML Panel Rework

### 5.1 Convert to a drawer/modal instead of a competing side panel

- Instead of fighting for the right column with the node inspector, the YAML panel becomes a slide-over drawer that overlays the canvas from the right (or a modal).
- Semi-transparent backdrop so you can still see the canvas.
- Wider (600px) for comfortable YAML editing.
- Or: make it a bottom panel that replaces the log bar, since those two are never needed simultaneously.

### 5.2 Syntax highlighting

- Add a lightweight code editor (CodeMirror 6 or Monaco) for the YAML textarea.
- Syntax highlighting, line numbers, better tab handling.
- Error gutter markers for parse errors instead of the red bar.

---

## Implementation Order & Priority

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| **P0** | 1.1 — Fix canvas isolation | Small | Fixes the #1 reported bug |
| **P0** | 1.2 — Grid layout + panel containment | Medium | Fixes inspector escaping header |
| **P1** | 3.1–3.2 — Theme tokens + variable swap | Medium-Large | Enables light mode, cleaner code |
| **P1** | 2.1 — Tabbed NodeDetailPanel | Large | Biggest UX improvement |
| **P1** | 2.2 — Slim LogPanel | Medium | Complements the detail panel |
| **P2** | 3.3 — Theme toggle | Small | Light/dark switching |
| **P2** | 4.1–4.3 — Visual polish | Medium | Professional feel |
| **P2** | 1.3 — Collapsible palette | Small | Nice-to-have |
| **P3** | 5.1–5.2 — YAML drawer + syntax highlight | Medium | New dependency (CodeMirror) |
| **P3** | 4.4 — Keyboard shortcuts | Small | Power-user feature |
| **P3** | 2.3 — Port tooltips/descriptions | Small | Nice-to-have |

---

## Files Affected

| File | Changes |
|------|---------|
| `App.tsx` | Grid layout, panel orchestration, theme provider |
| `ZyraNode.tsx` | Theme tokens, visual polish, port tooltips |
| `ArgPanel.tsx` | **Replaced** by `NodeDetailPanel.tsx` |
| `NodeDetailPanel.tsx` | **New** — tabbed Settings/Input/Output panel |
| `NodePalette.tsx` | Theme tokens, collapsible state |
| `LogPanel.tsx` | Slim down to pipeline-wide summary |
| `Toolbar.tsx` | Theme toggle, button grouping, polish |
| `YamlPanel.tsx` | Convert to drawer/modal overlay |
| `theme.css` | **New** — CSS custom properties for light/dark |
| `useTheme.ts` | **New** — theme toggle hook + localStorage |
| `main.tsx` | Import theme.css |

## No New Dependencies (Phases 1–4)

All changes through Phase 4 use only existing dependencies (React, @xyflow/react, js-yaml). Phase 5 would introduce CodeMirror 6 for YAML syntax highlighting — that can be deferred.
