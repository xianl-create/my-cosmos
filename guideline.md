# Project Rules and Regulations

This document outlines the core rules and regulations that must be followed when working on code updates for this project. These rules ensure consistency, maintainability, and proper functionality across all features.

---

## Core Conversation Guidelines (Law to Abide)

**These rules apply to every agent and every conversation. They must be followed always.**

### 1. Never Jeopardize Existing Setup

- **Do not** change, break, or remove existing pages, existing functions, or elements that are **outside** the specific target of the current work.
- Each conversation has a **target**: one or more functions, pages, or UI elements to add, revise, or remove.
- **Only** modify code that directly serves that target. Leave all other setup, pages, and functions untouched unless explicitly required for the goal.
- If a change might affect existing behavior, ensure backward compatibility and that current callers/usages still work as before.

### 2. One Goal Per Conversation Until It Is Closed

- Each conversation is about **one or several** functions/features to **add**, **revise**, or **remove**.
- **State the goal** at the start (or as soon as it is clear) and keep it visible until the work is done.
- The thread/issue is **not closed** until:
  - The stated goal is achieved, and
  - Any related tests or checks are satisfied.
- Do not drift into unrelated changes; finish the current goal before starting another.

### 3. Keep the Project Overview Summary Up to Date

- Maintain an **overview summary** of the project’s functions, progress, and current stage.
- This summary is the **single source of truth** for what the app does and how it is structured.
- **When adding, revising, or removing features:** update the overview (and this guideline’s “Application Pages and Key Components” section, or any dedicated PROJECT_OVERVIEW / README section) so that:
  - Main functions and pages are listed and described,
  - Current progress and stage are clear,
  - New or changed behavior is documented.
- The overview should always reflect the **current** state of the project.

---

## Rule for All Agents: Preserve Existing Behavior

**Whatever agent works on this project: existing functions must NOT be affected by new additions and revisions.**

- Do not change the behavior, return values, or side effects of existing functions when adding or revising code.
- New features must be implemented by adding new functions or new code paths, not by altering existing ones unless a change is explicitly required and documented.
- When modifying existing code is unavoidable, ensure backward compatibility and that all current callers and usages continue to work as before.
- Test that existing functionality still works after any change.

---

## Mandatory Pre-Change Protocol (Regression & Data-Loss Prevention)

**This protocol is non-negotiable and applies to every bug fix and every new feature, however small. The recurring failure mode on this project is "fixing one thing quietly breaks another." These steps exist to make that impossible. Do not skip a step because the change "looks trivial" — the one-line edits are the ones that have broken things.**

### Step 0 — Orient before you touch anything
1. **Read the app's identity.** This app is a single-user-per-browser, single-page app for visualizing tasks/agents as nested D3 visualizations, with a zero-dependency Node server. It has these screens: **Login**, **Wizard**, **Home** (force graph), **Calendar**, **Progress**, **Path Behind**, **Notes**, **Tree** (`pagetree`), **Agents** (`pageagents`), **Interstellar** (`pageinterstellar`), **Settings**. Screens are sibling `<div class="screen">`/view containers toggled by `swView()`; `currentView` holds the active one.
2. **Read the section of this guideline for every page your change can touch** (see “Application Pages and Key Components”). If the page isn’t documented yet, inventory it from the code first and add it here.
3. **Read `CLAUDE.md`** for the architecture and the storage model. The three big files are `index.html` (all DOM), `js/app.js` (entire client, no modules — globals `G`, `CU`, `ST`, `viewStack`, `expandedId`/`expandedIds`), `css/app.css` (frozen baseline).
4. **State the target** explicitly: the exact function(s)/element(s)/page(s) you will change, and nothing else.

### Step 1 — Map the blast radius (before editing)
1. **Find every caller** of any function you will modify (`grep -n "functionName" js/app.js`). A behavior or signature change must keep every caller working.
2. **Identify shared state** your change reads or writes (`G`, `CU`, `pageAgentsArchive`, `expandedIds`, `viewStack`, `currentView`, `nodeSelectorId`, `keysProcessed`, slot arrays, …). Shared state is how a "local" fix leaks into other pages — e.g. a global keydown handler that lacks a `currentView` guard will fire on every page.
3. **Prefer additive change.** Add a new function / new code path. Do **not** change the signature, return value, or side effects of an existing function unless that *is* the stated target.

### Step 2 — Respect the freeze and the conventions
- **Do not edit `css/app.css` or inline styles in `index.html`** for logic-only work (see `.cursor/rules/frozen-app-styles.mdc`). Style dynamically-created DOM via JS only.
- **Match surrounding code** (naming, density, idioms). No new dependencies, no bundler, no module system.
- **Keyboard handlers must guard by `currentView`** so a shortcut for one page cannot act on another. **Empty-space/background clicks** should reset focus/selection per the page’s pattern.

### Step 3 — Protect user data (highest priority — never lose data)
User data is **real**, not fixtures. Losing it is the worst possible outcome — rank it above any feature.
- **Two stores, different rules:**
  - **Canonical user graph** `data/{user}_data.json` (`G`: nodes, edges, workspaces, displayName, plus per-user UI prefs like `theme`, `todoActiveTab`, `agentsTimeCapsule`). Written whole via `POST /api/data/:user` (atomic temp-file + rename). Arbitrary top-level fields **do** round-trip here — this is the safe place to persist new per-user state without a server change.
  - **Agents archive** `data/{user}/agents/manifest.json` + per-agent `detail.json` (`pageAgentsArchive`). The server **only persists whitelisted fields** (`version/summary/graph/agentSlugs`, and per-agent `slug/name/runs/runGroups/collabLog/kind/...`). **Top-level archive fields the server doesn’t know about (e.g. `openTerminals`) are dropped on save** — adding a new persisted archive field requires editing `scripts/server.js` *and* a server restart. When in doubt, persist new UI state in `G` instead.
- **Never** reformat, sort, or "clean" data files; the server rewrites them and treats a payload without a graph as corrupt and recovers from savepoints.
- **Never** delete or overwrite a user file you didn’t create or that contradicts how it was described — surface it instead. Empty/missing user files are recovered from `data/savepoints/` by the server; don’t "tidy" them.
- **Guards that already exist and must stay working:** the server refuses to overwrite a populated agents archive with an empty one (auto-backup); the client skips flushing an empty archive when the last load failed. Don’t weaken these.
- **All data mutations go through `svWithUndo()`** so undo/redo works; direct `sv()` skips the undo stack (use it only for non-undoable UI prefs). Keep both legacy migration paths working (`ProgressTracker→MyCosmos` localStorage keys; `~/.progress-tracker`/`~/.my-cosmos`→project `data/`).

### Step 4 — Verify against the running behavior (not just the diff)
1. `node --check js/app.js` must pass.
2. **Exercise the changed behavior** and confirm it does what was asked.
3. **Spot-check the adjacent behavior you could have affected** — the other branches of the handler you touched, the other callers of the function you changed, the same feature on other pages. State explicitly what you verified.
4. If you cannot run the real app, drive the **actual shipped code** (not a re-implementation) in a harness and report the observations. Never claim a fix works without evidence.

### Pre-flight checklist (answer all before finishing)
- [ ] I read the guideline section(s) for every page this change can touch.
- [ ] I listed every caller of each function I changed; all still work.
- [ ] I added new code paths instead of altering existing behavior/signatures (or documented why a change was unavoidable and kept it backward-compatible).
- [ ] No `css/app.css` / inline-style edits for logic-only work.
- [ ] Keyboard/global handlers I touched are guarded by `currentView`; no leakage to other pages.
- [ ] New persisted state goes to a store that actually round-trips it (`G` for arbitrary per-user state; agents archive only with a matching `server.js` change); no user data can be dropped, reformatted, or overwritten.
- [ ] `node --check` passes; I exercised the change **and** spot-checked adjacent/related behavior, and reported what I verified.
- [ ] I updated this guideline’s page inventory if the change added/removed/altered a page, element, or persisted field.

---

## Modal Window Style Standard

**All pop-up windows in this project must follow the same style as the calendar event edit pop-up window (`m-cal-event`).**

**Required Elements:**
- Use the `.mo` class for the modal container with `id="m-[feature-name]"`
- Use the `.md` class for the modal dialog content
- Include a title (`<h3>`) at the top
- Use `.fg` class for form groups with `.lbl` for labels and `.inp` for inputs
- Include action buttons in a `.md-act` container with Cancel and action buttons
- Use `clMo('m-[feature-name]')` to close the modal
- Use `setupModalKeyboardNavigation('m-[feature-name]')` for keyboard navigation
- The background calendar/page should remain scrollable when the modal is open

**Example Structure:**
```html
<div class="mo" id="m-feature-name">
  <div class="md">
    <h3>Feature Title</h3>
    <div class="fg">
      <label class="lbl">Label</label>
      <input class="inp" id="feature-input">
    </div>
    <div class="md-act">
      <button class="btn btn-g" onclick="clMo('m-feature-name')">Cancel</button>
      <button class="btn btn-p" onclick="saveFeature()">Save</button>
    </div>
  </div>
</div>
```

**⚠️ DO NOT CREATE:** Custom modal styles or pop-up windows that deviate from this standard.

## 0. Application Pages and Key Components

This section provides a comprehensive overview of each page in the application, its key components, and critical functions that must be preserved when making future additions.

### Page 1: Login Page (`scr-login`)

**Purpose:** User authentication and user selection for accessing the application.

**Key Components:**
- Login input field (`#lg-name`) - accepts user name
- Login button - triggers `doLogin()`
- User selection list (`#ul`) - shows previously used users
- Import/Export buttons - for data management

**Critical Functions:**
- `initLg()` - Initializes login screen and loads user list
- `doLogin()` - Validates and processes login
- `loginAs(u, dn)` - Handles user login and data loading
- `updateLoginSelection()` - Updates the user selection UI
- `deleteUser(u)` - Deletes a user account
- `archiveUser(u)` - Archives a user account
- `importFromDataFolder()` - Imports users from data folder
- `exportAllToDataFolder()` - Exports all users to data folder

**Data Flow:**
- Loads user data from File System Access API via `ST.load(CU)`
- If data exists, loads into `G` object and shows main app
- If no data, shows onboarding wizard

**⚠️ DO NOT MODIFY:** Login flow, user data loading, or authentication logic without ensuring backward compatibility.

---

### Page 2: Onboarding/Wizard Page (`scr-wiz`)

**Purpose:** Guides new users through initial setup by creating categories and tasks.

**Key Components:**
- Step indicator dots (`#wdots`) - shows current step
- Step content area (`#wbod`) - displays step-specific content
- Navigation buttons (Back/Next) - step navigation

**Critical Functions:**
- `initWiz()` - Initializes wizard state
- `rWiz()` - Renders current wizard step
- `rW1(el)` - Renders step 1: Category creation
- `rW2(el)` - Renders step 2: Color and task assignment
- `rW3(el)` - Renders step 3: Category nesting structure
- `aWC()` - Adds a category
- `aWT()` - Adds a task to current category
- `wBack()` - Goes to previous step
- `wNext()` - Advances to next step or completes setup
- `genNet()` - Generates initial network from wizard data

**Data Structure:**
- `wCats` - Array of category objects with `id`, `name`, `color`, `tasks`, `parentId`
- `wStep` - Current step index (0, 1, or 2)
- `wAT` - Active tab index for step 2

**⚠️ DO NOT MODIFY:** Wizard step flow, category/task creation logic, or the final network generation without testing the complete onboarding experience.

---

### Page 3: Main App - Home View (`scr-app` with `view='home'`)

**Purpose:** Main network visualization where users interact with their task nodes as a graph.

**Key Components:**
- **Left Sidebar (`#ls`):**
  - Workspace tabs - navigation between different workspaces
  - View switcher icons (Home, Progress, Calendar, Path Behind, Settings)
  - Add workspace button
- **Center Canvas (`#canvas`):**
  - SVG graph (`#graph-svg`) - D3.js force-directed graph visualization
  - Top search zone (`#s-zone`) - search input for nodes
  - Bottom input zone (`#b-zone`) - quick-add input for new nodes
  - Tooltip (`#tooltip`) - shows node information on hover
  - Legend and stats overlays
- **Top Bar (`#top-bar`):**
  - Breadcrumb navigation (`#tb-bc`)
  - Back button (`#tb-back`)
  - Auto-save toggle (`#tb-as`)
  - Undo/Redo buttons
  - Savepoint button
  - Exit button
- **Right Panel (`#rp`):**
  - Task list (`#rp-body`) - hierarchical task tree
  - Search container (`#rp-search-container`) - search in right panel
  - To-do list section (`#rp-todo-section`) - today's tasks

**Critical Functions:**
- `initApp()` - Initializes the main application, sets up D3 simulation, event handlers
- `render()` - **CRITICAL** - Renders the network graph, nodes, links, and spheres
- `swView(view)` - Switches between different views (home, calendar, progress, etc.)
- `enterN(id)` - Enters/expands a node's sphere
- `goUp()` - Goes up one level in navigation
- `goRoot()` - Returns to root level
- `navTo(id)` - Navigates to a specific node
- `autoZoom()` - Automatically adjusts zoom and may expand nodes
- `zFit()` - Zooms to fit all visible nodes
- `updateBackgroundColor()` - Updates background based on theme
- `doSearch()` - Executes search and highlights matching nodes
- `qAdd()` - Quick-adds a new node from bottom input
- `rPanel()` - Renders the right panel task list
- `renderTreeItem(n, depth)` - Renders a single task item in the tree
- `initializeNodeSelector()` - Initializes node selector on biggest node

**Data Structures:**
- `G.nodes` - Array of all node objects
- `G.edges` - Array of all edge objects
- `viewStack` - Array tracking navigation hierarchy
- `expandedId` - Currently expanded node ID
- `expandedIds` - Set of all expanded node IDs
- `rpLevel` - Right panel navigation level

**⚠️ DO NOT MODIFY:**
- `render()` function without ensuring all node interactions still work
- Node selection logic (`initializeNodeSelector()`)
- Navigation functions (`enterN()`, `goUp()`, `goRoot()`) without testing all navigation paths
- Auto-zoom logic without preserving the auto-expansion prevention mechanism
- Sphere expansion/collapse behavior

---

### Page 4: Calendar View (`view='calendar'`)

**Purpose:** Calendar interface for scheduling and viewing events tied to tasks.

**Key Components:**
- Calendar header (`#calendar-header`) - week navigation and timezone selector
- Calendar time grid (`#calendar-time-grid`) - main calendar display
- Scroll container (`#calendar-scroll-container`) - handles infinite scrolling
- Timezone dropdown - timezone selection

**Critical Functions:**
- `renderCalendar()` - **CRITICAL** - Renders the entire calendar view with events
- `calendarPrevWeek()` - Navigates to previous week
- `calendarNextWeek()` - Navigates to next week
- `toggleTimezoneDropdown()` - Shows/hides timezone selector
- `setTimezone(tz)` - Sets calendar timezone
- `openCalendarEventModal(dateStr)` - Opens modal to add event
- `openEditCalendarEvent(id)` - Opens modal to edit existing event
- `saveCalendarEvent()` - Saves new or edited calendar event
- `addCalendarEvent(dateStr)` - Adds event to calendar

**Data Structures:**
- `G.calendar` - Array of calendar event objects
- `calendarDate` - Current calendar date
- `calendarScrollLeft` - Horizontal scroll position
- `calendarScrollTop` - Vertical scroll position

**Calendar Event Object Structure:**
- `id` - Unique event ID
- `title` - Event title
- `start` - Start datetime (ISO string)
- `end` - End datetime (ISO string)
- `nodeId` - Associated task node ID (if linked)
- `category` - Event category
- `location` - Event location
- `link` - Event URL
- `repeat` - Recurrence pattern
- `notes` - Event notes

**⚠️ DO NOT MODIFY:**
- `renderCalendar()` without ensuring infinite scrolling still works
- Event creation/editing logic without maintaining task synchronization
- Timezone handling without testing all timezone options
- Scroll position restoration logic

---

### Page 5: Progress View (`view='progress'`)

**Purpose:** Visual progress tracking with to-do list and progress charts.

**Key Components:**
- Progress header (`#progress-header`) - view title
- To-do list container (`#progress-todo-list-container`) - left sidebar with tasks
- Progress chart container (`#progress-chart-container`) - right side with D3 charts
- To-do list (`#progress-todo-list`) - draggable, numbered task list
- Progress chart SVG (`#progress-chart-svg`) - D3 bar chart visualization

**Critical Functions:**
- `renderProgress()` - **CRITICAL** - Renders the entire progress view
- `renderProgressChart(todos)` - Renders D3 bar chart for task progress
- `getDragAfterElement(container, y)` - Helper for drag-and-drop positioning
- `getTodayTodos()` - Gets ordered list of today's to-do tasks
- `addToTodoList(nodeId)` - Adds task to to-do list
- `removeFromTodoList(nodeId)` - Removes task from to-do list

**Data Flow:**
- Reads from `G.nodes` filtered by to-do list membership
- Uses `G.nodeOrder` to maintain task order
- Timer data from `node.timer` object drives progress visualization

**⚠️ DO NOT MODIFY:**
- `renderProgress()` without ensuring chart updates correctly
- Drag-and-drop functionality for task reordering
- Progress calculation logic
- Timer integration with progress bars

---

### Page 6: Path Behind View (`view='pathbehind'`)

**Purpose:** Visualizes completed tasks as a network graph showing what has been accomplished.

**Key Components:**
- Path Behind header (`#pathbehind-header`) - view controls
- Date selector (`#pathbehind-date-selector`) - filter by specific day
- Goal box (`#pathbehind-goal-box`) - displays daily goals
- Path Behind SVG (`#pathbehind-svg`) - D3 network visualization

**Critical Functions:**
- `renderPathBehind()` - **CRITICAL** - Renders completed tasks network
- Filters completed nodes: `G.nodes.filter(n => n.status === 'completed')`
- Filters completed edges connecting completed nodes
- Supports "View All" mode or filtering by specific date

**Data Structures:**
- `pathbehindSvg` - D3 selection of SVG element
- `pathbehindG` - Main D3 group
- `pathbehindLinkG` - Links group
- `pathbehindNodeG` - Nodes group
- `pathbehindZoom` - D3 zoom behavior
- `pathbehindViewMode` - 'all' or 'day'

**⚠️ DO NOT MODIFY:**
- `renderPathBehind()` without ensuring completed task filtering works correctly
- Date filtering logic
- Network visualization rendering

---

### Page 7: Settings View (`view='settings'`)

**Purpose:** User preferences, account settings, and customization options.

**Key Components:**
- Display name input (`#st-dn`)
- Account info display (`#st-account`)
- Auto-save toggle (`#st-as`)
- Sound effects toggle (`#st-sound`)
- Theme selector - Galaxy (default) or Bright
- Background color picker
- Keyboard shortcuts customization

**Critical Functions:**
- `populateSettings()` - Loads current settings into UI
- `saveSettings()` - Saves all settings to `G` object
- `setTheme(theme)` - Applies theme (galaxy/bright)
- `setBackgroundColor(color)` - Sets background color
- `applyTheme(theme)` - Applies CSS theme variables
- `setShortcut(shortcutId, inputEl)` - Sets custom keyboard shortcut
- `getKeyComboString(e)` - Converts key event to string
- `getDefaultShortcut(id)` - Gets default shortcut value

**Data Storage:**
- Settings stored in `G` object:
  - `G.displayName` - User display name
  - `G.autoSave` - Auto-save enabled/disabled
  - `G.soundEffects` - Sound effects enabled/disabled
  - `G.theme` - Current theme ('galaxy' or 'bright')
  - `G.backgroundColor` - Custom background color
  - `G.shortcuts` - Custom keyboard shortcuts object

**⚠️ DO NOT MODIFY:**
- Settings save/load logic without ensuring persistence works
- Theme application without testing both themes
- Keyboard shortcut customization without ensuring shortcuts still work

---

### Page 8: Notes View (`view='notes'`)

**Purpose:** Dedicated page for viewing and editing notes, either linked to tasks or standalone.

**Key Components:**
- Notes catalog (`#notes-catalog`) - sidebar listing all notes
- Notes editor (`#notes-editor`) - main content area for editing
- Notes search - search within notes
- Group-by-task toggle - organize notes by task hierarchy

**Critical Functions:**
- `renderNotes()` - **CRITICAL** - Renders the notes sidebar and catalog
- `buildNoteEntries()` - Builds the list of note entries to display
- `openNoteEditor(nodeId, dateKey)` - Opens a note for editing
- `getNoteContentForNode(n, dateKey)` - Retrieves note content
- `saveCurrentNoteEditorContent()` - Saves editor content to node

**Note Page Display Rule (CRITICAL):**
The note page must **only** include:
1. **Task-associated notes with non-empty content** - A task node that exists on the home page must have actual note content (not empty, whitespace, or placeholder HTML like `<p><br></p>`) to appear in the note page.
2. **Stand-alone notes** - Notes that have no associated task (no parent in task tree, not shown on home page). These are displayed regardless of content.

**Exclusion rule:** If a task node exists on the home page but its note has no meaningful content, that task's note must **not** appear in the note page sidebar or catalog.

**Data Flow:**
- Note content stored in `node.postEventNotes` or `node.postEventNotesByDate[dateKey]`
- `buildNoteEntries()` determines what appears; it must filter out task notes with empty content
- Stand-alone notes (nodes with `parentId=null` or without task properties) are included per their note data

**⚠️ DO NOT MODIFY:**
- `buildNoteEntries()` without preserving the empty-content exclusion for task notes
- Note content retrieval logic without ensuring stand-alone notes remain visible

---

### Page 9: Tree View (`view='pagetree'`)

**Container:** `#pagetree-view`; SVG canvas `#pagetree-svg`. Header `#pagetree-header` (title + a Refresh button calling `renderPageTree()`).

**Purpose:** A read-only D3 **tree** of the current workspace’s node hierarchy (same nesting as the Home graph), excluding `notesTabOnly` nodes. A flat, scrollable map of everything under the current workspace.

**Key components & functions:**
- `renderPageTree()` — render orchestrator (builds the SVG, D3 zoom, layout, draw).
- `collectPageTreeNodes()` — gathers workspace nodes by walking from the root via `cPid()`/`ch(pid)`.
- `layoutPageTreeHierarchy(nodes)` — D3 hierarchy + tree layout (node box ~216×92).
- `pageTreeCurvedLinkPath(...)` — Bézier parent→child links.

**Operations:** drag to pan; Ctrl/⌘+wheel to zoom (≈0.12×–4×); auto-fit on first render; **click a node** → `swView('home')` then `navTo(id)` (open it on Home); **click the workspace root bar** → `swView('home')` then `goRoot()`.

**Data:** none of its own — reads `G.nodes` for the current workspace `G.cws`. Pure projection of Home data; safe to re-render anytime.

---

### Page 10: Agents View (`view='pageagents'`)

**Container:** `#pageagents-view`. This is the most complex page — a crew of local/remote "agents" you chat with or run shell terminals in, with a logs/history visualization. Treat every sub-area below as independently breakable.

**A. Header (`#pageagents-header`):** title + **time-capsule toggle** `#pageagents-timecapsule-btn` (`pageAgentsToggleTimeCapsule()`), dark/pale when off, vibrant when on. When on, the set of open chat/terminal windows is remembered (in `G.agentsOpenChatSlots`, gated by `G.agentsTimeCapsule`) and reopened on next login via `pageAgentsRestoreOpenWindows()` (called from `pageAgentsOnAgentsViewShown()`); the conversation text rides along free because it is rebuilt from each agent’s persisted `runs[]`.

**B. Crew deck (`#pageagents-play` → `#pageagents-play-world`, world ~4000×2400):** a 2D playground of agent **sprites**.
- Controls: ⚙️ crew chooser `#pageagents-crew-chooser-btn` (roster/load-list); search box `#pageagents-crew-search-box`/`-input`; minimap `#pageagents-play-minimap` (click to jump); zoom buttons (−/+/⊙).
- Functions: `pageAgentsRecenterOverview()` (zoom to cover-floor + center on centroid — this is the **Space-key overview**, and the same overview shown on view-open); `pageAgentsBindPlayWorldEvents()` (deck-background mousedown clears crew focus **and blurs a focused text input** so Space recenters); `pageAgentsSetFocus(slug)`/`pageAgentsApplyCrewSelection(slug,opts)` (select a crew member → open/raise its chat column); `pageAgentsActivateAgent`/`pageAgentsDeactivateAgent` (deck visibility via `rec.active`); sprite working animation `pageAgentsSetAgentWorkingUi`/`beginSpriteWorking`/`endSpriteWorking`.
- Operations: click a sprite to focus/select it; click empty deck to deselect; **Space** = recenter overview (only when not typing in an input); drag/zoom/minimap to navigate.

**C. Session setup & model:** `#pageagents-past-agent` (load existing agent), `#pageagents-agent-name`, `#pageagents-context`; **model selector `#pageagents-model`** with backends: local stub, `local-gpt2`, Ollama, custom OpenAI-style, custom Claude, and **Terminal**. `pageAgentsModelChange()` shows/hides API-key fields and persists them to `localStorage` (`expandAgents_*`). New-agent setup panel writes `goalMd`/`approachMd`/`taskNodeIds`.

**D. Chat strip (`#pageagents-chat-strip`):** horizontal row of **chat slots** and **terminal slots**, plus the `+` add button `#pageagents-chat-add-slot`.
- Chat: `pageAgentsAddEmptyChatSlot()`, `pageAgentsCloseChatSlot(i)`, `pageAgentsSlotIndexForSlugOrAssign(slug)`; per-slot state in `pageAgentsSlotSlug[]`/`pageAgentsSlotState[]`; a run is recorded via `pageAgentsRegisterRun(agent,task,out,model)`.
- Terminal: `pageAgentsBuildTerminalSlot(slug)` (xterm.js + WebSocket `/ws/terminal`). Typed commands are captured from the keystroke buffer (`cmdBuffer`, with an escape-sequence state machine; falls back to a screen snapshot for history-recall/TUI/Ctrl-edited lines) and become `run.task`; output is read from the rendered screen. **Every command must arm the settle timer (`armSettleTimer`) after `beginSpriteWorking()`** so a no-output command still clears the working light. Buffer/waitlist: type in the buffer textarea, **Space+Enter to queue**; `pageAgentsDispatchNextTerminalCommand(slug)` drains one at a time (busy-gated).
- Both chat and terminal slots share the **chatbox gesture model** (click-center, hold-1s-drag along the strip) — features targeting "each chatbox" must include terminals.

**E. Logs & history (`#pageagents-panel-wrap`):** tab bar `#pageagents-tabs`; `pageAgentsRenderTabs()` + `pageAgentsRenderActiveTab()`.
- **Summary tab** `#pageagents-tab-summary`: agents tree SVG `#pageagents-summary-svg` (`pageAgentsRenderSummaryTree()`) + activity feed `#pageagents-summary-feed`.
- **Agent tab** `#pageagents-tab-agent`: lineage tree `#pageagents-agent-tree-svg` (`pageAgentsRenderAgentTabTree(slug)`), with a **Map view toggle `#pageagents-agent-mapview-btn`** (`pageAgentsRenderAgentMapIntoSvg` — clusters that agent’s past requests by goal and lays them out as a **draggable tree**: relationship edges become parent→child links via `pageAgentsBuildGoalTree`, nodes drag to rearrange, and clicking a goal opens its full request history via `pageAgentsShowMapGoal`); runs/outputs `#pageagents-agent-detail-out`; collaboration log `#pageagents-agent-collab`; Set-up modal via `openAgentSetupModal(slug)`.

**DATA (read Step 3 of the Pre-Change Protocol before touching):**
- In-memory: `pageAgentsArchive = {version, summary[], graph{nodes,edges}, agents{}, openTerminals[]}`.
- Persistence: server `GET/POST /api/agents-data/:user` → `data/<user>/agents/manifest.json` + per-agent `detail.json`; `file://` fallback `localStorage['myCosmos_agents_<user>']`. **The server only persists whitelisted fields** — new top-level archive fields are dropped unless `scripts/server.js` is updated and restarted.
- Per-agent `rec`: `slug, name, kind('chat'|'terminal'), runs[]{ts,task,output,model}, runGroups[], collabLog[], goalMd, approachMd, collaborators[], taskNodeIds[], active, transcript(terminal), preferredModel, hiddenFromLoadList`.
- Time-capsule fields live in the **user graph `G`** (not the archive): `G.agentsTimeCapsule`, `G.agentsOpenChatSlots`.
- Recovery history: empty-archive overwrites are refused server-side (auto-backup); empty flushes are skipped client-side when a load failed. Keep these guards intact.

**⚠️ DO NOT BREAK:** currently-running agent chats/terminals (don’t restart sockets or reset slots as a side effect); the chatbox gesture model; the settle-timer guarantee (no stuck working light); the time-capsule restore (don’t let an empty roster overwrite a saved one); xterm copy/paste inside terminals.

---

### Page 11: Interstellar View (`view='pageinterstellar'`)

**Container:** `#pageinterstellar-view`; header `#pageinterstellar-header`; results `#pageinterstellar-results`; status `#pageinterstellar-status`.

**Purpose:** Browse free/low-cost local events. Live listings come from the bundled server proxy (Ticketmaster Discovery API; the server holds the key); offline it renders demo rows.

**Controls & functions:** location input `#pageinterstellar-location`; optional key `#pageinterstellar-tm-key`; **Search** → `pageInterstellarSearch()` (POST `/api/interstellar-events` `{city,lat?,lng?,tmApiKey}` → `{events[],source,hint}`; on failure renders 5 demo rows); **Use my location** → `pageInterstellarUseLocation()` (geolocation → `window.__pageInterstellarLat/Lng`); `pageInterstellarRestoreLocal()` hydrates fields on open.

**Data:** `localStorage` only — `expandInterstellar_city`, `expandInterstellar_tm`. No user-graph data; safe to re-render.

---

### Shared Components and Functions

**Modals:**
- Node edit modal (`#m-node`) - `openAdd()`, `openEdit(id)`, `saveMo()`
- Connection modal (`#m-conn`) - `openConn(s, t)`, `saveConn()`
- Workspace modal (`#m-ws`) - `addWS()`, `saveWS()`
- Calendar event modal (`#m-cal-event`) - `openCalendarEventModal()`, `saveCalendarEvent()`
- Timer modal (`#timer-modal`) - `openTimer(nodeId)`, `setTimer(mins)`, `clTimer()`
- Timer alert (`#timer-alert`) - `showTimerAlert(n)`

**Data Management:**
- `sv()` - Auto-save function (calls `ST.save(CU, G)`)
- `svWithUndo()` - Save with undo state tracking
  - **MUST be used** for all data modifications to enable undo/redo
  - Saves current state before making changes
  - All save functions (saveMo, saveCalendarEvent, saveNoteEdit, saveNewNote, saveNotes, autoSaveNotes, etc.) use this
- `saveState()` - Saves current state for undo/redo
  - Called by `svWithUndo()` to push state to undo stack
  - Maintains up to 10 undo states (maxUndo)
  - Clears redo stack when new action is performed
- `doUndo()` - Undoes last action
  - Restores previous state from undo stack
  - Refreshes all views (render, rPanel, renderTodoList, renderNotes, renderCalendar, renderTBDMicroTabs)
  - Updates undo/redo button states
- `doRedo()` - Redoes last undone action
  - Restores state from redo stack
  - Refreshes all views (render, rPanel, renderTodoList, renderNotes, renderCalendar, renderTBDMicroTabs)
  - Updates undo/redo button states
- `doSavepoint()` - Creates manual savepoint

**Right Panel Functions:**
- `rPanel()` - Main right panel renderer
- `renderTreeItem(n, depth)` - Renders task tree item
- `renderCompletedTaskItem(n)` - Renders completed task item
- `addFromPanel(parentId, text, isLeafTask)` - Adds task from panel
- `toggleLeafTask(nodeId, idx, checkbox)` - Toggles task completion
- `renderTodoList()` - Renders to-do list section
- `setupTaskDragAndDrop()` - Sets up drag-and-drop for tasks
- `openNP(id)` - Opens notes panel
- `toggleNotes(id)` - Toggles notes display
- `saveNotes(id, text)` - Saves notes to node

**⚠️ CRITICAL PRESERVATION RULES:**

1. **Never modify core rendering functions** (`render()`, `renderCalendar()`, `renderProgress()`, `renderPathBehind()`) without:
   - Testing all related interactions
   - Ensuring data flow remains intact
   - Verifying performance is not degraded

2. **Never modify navigation functions** (`swView()`, `enterN()`, `goUp()`, `goRoot()`) without:
   - Testing all view transitions
   - Ensuring state is properly reset/restored
   - Verifying keyboard shortcuts still work

3. **Never modify data save/load functions** (`sv()`, `ST.save()`, `ST.load()`) without:
   - Ensuring backward compatibility
   - Testing data migration if structure changes
   - Verifying auto-save still works

4. **When adding new features:**
   - Add new functions, don't modify existing ones unless necessary
   - Preserve all existing function signatures
   - Test all pages after modifications
   - Update this documentation if adding new pages or major components

5. **View switching logic:**
   - Always call `swView(view)` to switch views
   - Each view's render function is called automatically
   - Ensure proper cleanup (clear intervals, reset state) when switching views

---

## 1. Task and Node Structure

- **Each task is represented as a node**
- **Each task can contain many sub-tasks**
- **A node can contain many sub-nodes**
- The hierarchical structure allows for unlimited nesting of tasks within tasks
- All nodes follow the same data structure and behavior regardless of their level in the hierarchy
- **Node Attributes:**
  - Each node has multiple attributes: `id`, `name`, `color`, `description`, `status`, `parentId`, `wsId`, `progress`, `notes`, `sphereOpen`, `timer`, `completedAt`, `calendar` info, `TBD`, etc.
  - The `sphereOpen` property tracks whether the node's sphere is currently expanded (true) or closed (false)
  - The `TBD` property tracks "To Be Determined" scheduling status - defaults to `'none'`, but when set to a date (ISO string), indicates the task has been scheduled as a calendar event
  - All node attributes are automatically saved to a local folder using the File System Access API
  - Data is saved in JSON format to `{username}_data.json` in the selected directory
  - Auto-save is enabled by default and triggers after any node modification
  - Data persists across sessions and is loaded automatically on login

## 2. Consistent Node Interactions Across All Levels

**All nodes, regardless of their level, must have consistent interaction features:**

- **Clicking on a node expands its sphere** to show its content nodes (sub-nodes)
- **Content nodes are fully interactive** and behave exactly like their parent nodes:
  - Content nodes are clickable in the same way as parent nodes
  - Content nodes can be expanded to show their own content nodes
  - Content nodes can be dragged, edited, and manipulated
  - Content nodes support all the same features as parent nodes (checkboxes, timers, notes, etc.)
- **No special cases or exceptions** should be made for nodes at different levels
- The interaction model must remain consistent throughout the entire hierarchy

## 3. Main Space Interaction

- **The area where nodes and spheres exist is called the "main space"**
- **Clicking on empty space in the main space resets to root view (home page)**
  - Closes all spheres
  - Resets `viewStack` to `[]` (empty array)
  - Resets `expandedId` to `null`
  - Clears `expandedIds` Set
  - Resets `rpLevel` to `0`
  - Calls `zFit()` to zoom out and show all top-level nodes
  - Highlights all top-level nodes briefly (1.5 seconds) with the `focused` class
- The empty space detection must accurately distinguish between:
  - Clicks on nodes
  - Clicks on spheres (expanded node areas)
  - Clicks on content nodes within spheres
  - Clicks on truly empty background areas
- **Node Status Tracking:**
  - Each node has a `sphereOpen` property (boolean) that tracks whether its sphere is currently open
  - When a node is clicked and its sphere opens, set `node.sphereOpen = true` and call `sv()` to auto-save
  - When clicking on empty space, all nodes with `sphereOpen = true` must be set to `sphereOpen = false` and call `sv()` to auto-save
  - This status is automatically saved with the node data and persists across sessions
  - On data load, initialize `sphereOpen = false` for any nodes that don't have this property
- **Auto-Expansion Prevention Logic (CRITICAL):**
  - **Problem:** When clicking empty space to reset to root view, `autoZoom()` must NOT auto-expand nodes immediately after
  - **Why it happens:** After resetting to root and calling `zFit()`, `autoZoom()` may detect that nodes take up >60% of screen and try to auto-expand, creating a frustrating loop where spheres close then immediately reopen
  - **Prevention mechanism:**
    1. Before calling `zFit()` when resetting to root, set `window._preventAutoExpand = true`
    2. After `zFit()` completes, wait 2 seconds, then set `window._preventAutoExpand = false` to allow normal autoZoom behavior to resume
  - **autoZoom() conditions for auto-expansion (MUST include all of these):**
    - `coverage > 0.6` (nodes take up more than 60% of screen)
    - `expandedIds.size === 0` (no spheres currently open)
    - `expandedId === null` (no primary expanded node)
    - **`viewStack.length > 0`** (NOT at root level - user wants to see all top-level nodes at root)
    - **`!window._preventAutoExpand`** (not during intentional reset to root)
    - `ns.length > 0` (nodes exist)
  - **Correct implementation:**
    ```javascript
    else if(coverage>0.6&&expandedIds.size===0&&!expandedId&&viewStack.length>0&&!window._preventAutoExpand&&ns.length>0){
      // Find the largest node and expand it
      const largest=ns.reduce((a,b)=>nR(a)>nR(b)?a:b);
      if(largest){
        enterN(largest.id);
        setTimeout(()=>{if(sim)autoZoom()},100);
        return;
      }
    }
    ```
  - **Common mistakes to avoid:**
    - ❌ Forgetting to check `viewStack.length > 0` - will auto-expand at root level
    - ❌ Forgetting to check `!window._preventAutoExpand` - will auto-expand immediately after reset
    - ❌ Not setting the flag before `zFit()` - flag won't be active when `autoZoom()` runs
    - ❌ Not clearing the flag after delay - normal auto-expansion will be permanently disabled

## 4. Sphere Zoom Behavior

- **Clicking on a node opens its sphere** to show content nodes
- **Clicking on the sphere again (but not on content nodes) zooms into that node**
- When zoomed in:
  - The node's sphere takes over the main space
  - All content nodes become the main nodes displayed
  - The view transitions smoothly to show the new level
  - This allows for drilling down into task hierarchies

## 5. Node Selector Behavior

- **The selector always falls on the biggest node at the current level**
  - When the application initializes, the selector automatically selects the biggest node (by radius) from all visible nodes at the current level
  - When zooming out (going up a level), the selector automatically falls on the biggest node at the new level
  - When zooming into a node (going down a level), the selector automatically falls on the biggest node at the new level
  - The selector is indicated by a red outline around the selected node
  - The selector does not affect node positions or network orientation - it is purely visual
- **Selector initialization:**
  - `initializeNodeSelector()` function finds the biggest node by comparing node radii using `nR()` function
  - Must be called after any level change (zoom in/out, navigation)
  - Must be called after `render()` completes to ensure nodes are positioned
  - Typically called with a timeout (200-400ms) after level changes to allow simulation to settle
- **Level change triggers:**
  - `goUp()` - must call `initializeNodeSelector()` after rendering
  - `enterN()` when drilling down (when `expandedId===id`) - must call `initializeNodeSelector()` after rendering
  - Space + Up Arrow - calls `goUp()` then `initializeNodeSelector()`
  - Space + Down Arrow - calls `enterN()` then `initializeNodeSelector()`
  - Enter key on expanded node - calls `enterN()` then `initializeNodeSelector()`
  - Clicking empty space to close spheres - calls `initializeNodeSelector()` after render

## 6. Calendar and Task Integration

- **Calendar events are tied to tasks**
- **When a task is completed:**
  - It automatically shows up in the calendar as a completed event
  - The event appears at the time the task was completed
  - If a timer was active, the event spans the timer duration
  - If no timer, the event spans 30 minutes ending at completion time
- **When an event is added to the calendar:**
  - A new task is automatically created in the task tab
  - A corresponding node is created in the main space
  - The task and node are linked to the calendar event
- **Bidirectional synchronization** must be maintained between calendar events and tasks
- **Auto-center requirement:** When a task is checked or unchecked, the main screen must automatically center on that task's corresponding node (within 300ms delay for checked, 100ms for unchecked)
- **Timer integration:**
  - **When a timer is started on a task:** The main screen must automatically expand to show that task's corresponding node (call `enterN(nodeId)` before showing timer animation)
  - The node should be visible and centered when the timer starts
- **TBD (To Be Determined) Feature:**
  - All tasks have a `TBD` property that defaults to `'none'`
  - TBD is controlled via a checkbox in the task edit modal, located below the Buffer property
  - When TBD checkbox is checked, a calendar event is created for that task (defaults to 9 AM today, 1 hour duration)
  - When TBD is set (not 'none'), the task's `calendarDate` is set and the task appears in the calendar
  - TBD events appear as floating "micro event tabs" in the calendar header, positioned around the calendar title in empty spaces
  - These micro tabs are clickable and open the calendar event for editing (or the task edit modal if no calendar event exists)
  - Unchecking the TBD checkbox sets TBD back to 'none' but preserves the calendarDate if it exists

## 8. Calendar Display and Interaction

### Visual Structure
- **Each row is marked with vertical lines** to delineate time slots
- **The first column shows the time** (24-hour format)
- **A dropdown tab specifies time zone**, defaulting to EST (Eastern Standard Time)
- **Today's date is highlighted** for easy identification

### Navigation
- **Calendar can scroll vertically** to show all 24 hours (24 rows)
- **Calendar can scroll horizontally** to show previous and future days
- **Pressing the space bar recenters the view to today**

### Event Addition
- **Hovering the mouse over calendar cells** lights up the corresponding date/time cell
- This visual feedback facilitates easy event addition
- Clicking on a cell should allow adding an event at that specific time

## 7. Keyboard Shortcuts

All keyboard shortcuts work globally unless the user is typing in an input field, textarea, or select element.

### View Navigation

- **Tab**: Switch between pages
  - Cycles through: home → calendar → pathbehind → settings → home
  - Works globally when not in an input field

- **Space**: Center the view
  - **On home view**: Centers to show all nodes (keeps spheres open)
  - **On calendar view**: Centers on today's date
  - **In search mode**: Resets search view

- **Double Space (Space+Space)**: Toggle bottom input box
  - First double-press: Shows and focuses the bottom input box
  - Second double-press: Hides the bottom input box
  - 400ms threshold for double-press detection

- **Command/Ctrl key**: Toggle bottom input box
  - Pressing Command (Mac) or Ctrl (Windows/Linux) toggles the bottom input box visibility
  - Same functionality as Double Space

### Node Navigation and Selection

- **Arrow Keys (↑ ↓ ← →)**: Navigate the selector to the closest node in the specified direction
  - Only moves the selector spatially - does not open or close nodes
  - Works on the home view when nodes are visible
  - If no nodes are available, falls back to general keyboard navigation through focusable elements
  - Up/Down arrows move vertically, Left/Right arrows move horizontally

- **Space + Up Arrow**: Zoom out and go up a level
  - Moves up in the navigation hierarchy
  - Selector automatically falls on the biggest node at the new level
  - Uses time-based detection (500ms window) for reliable key combination detection

- **Space + Down Arrow**: Zoom into the selected node and go down a level
  - Drills down into the selected node's sphere
  - Selector automatically falls on the biggest node at the new level
  - Uses time-based detection (500ms window) for reliable key combination detection

### Node Interaction

- **Enter**: Context-dependent node interaction
  - **On selected node (not expanded)**: Opens the node's sphere
  - **On selected node (already expanded)**: Drills down into the sphere (goes deeper a level)
  - **On node under cursor**: Toggles the node's sphere (opens if closed, closes if open)
  - **If no node selected**: Closes all opened spheres at current level
  - Selector automatically falls on the biggest node after level changes
  - Does not work when focus is in the right panel (task bar)

- **Enter + Space**: Toggle all nodes at current level
  - If all nodes are expanded: Closes all nodes
  - If not all nodes are expanded: Opens all nodes at the current level
  - Selector automatically falls on the biggest node after toggling

- **Escape**: Multi-purpose back/close command
  - **Priority order**:
    1. Closes any open modals (edit modal, timer modal, timer alert)
    2. Exits connection mode (if active)
    3. Closes expanded node (if a node is expanded)
    4. Exits search mode (if in search mode)
    5. Goes up one level (if in a deeper level with viewStack items)

- **Backspace**: Go up one level
  - Works if a node is expanded or if in a deeper level (viewStack has items)
  - Equivalent to clicking the "← Back" button

### File Operations

- **Ctrl/Cmd + S**: Create a savepoint
  - Saves current state as a backup
  - Shows a savepoint confirmation message ("💾 Savepoint!")

- **Ctrl/Cmd + Z**: Undo last action
  - Reverts the most recent change
  - Updates undo/redo button states in the toolbar
  - **All actions are undoable** — every data-mutating function in this codebase MUST call `svWithUndo()` *before* mutating `G` (the user graph) so a pre-mutation snapshot lands on the undo stack. The list below is illustrative, not exhaustive:
    - Creating, editing, or deleting tasks/events
    - Changing task properties (type, routine, priority, buffer, TBD)
    - Editing notes content (in notes editor or right panel)
    - Editing event properties (title, time, location, notes, post-event notes)
    - Changing task categories/nesting
    - **To-do list moves**: add/remove on today's list, add/remove on the pool, and pool ↔ today transfers
    - Any other data modification in the app
  - Automatically refreshes all views (home page, calendar, notes, todo list) after undo

- **Ctrl/Cmd + Shift + Z** or **Ctrl/Cmd + Y**: Redo last undone action
  - Restores the most recently undone change
  - Updates undo/redo button states in the toolbar
  - **All undone actions can be redone**
  - Automatically refreshes all views (home page, calendar, notes, todo list) after redo

### Input Field Shortcuts

- **Enter**: Submit/activate (when in input fields)
  - **Login name input**: Submit login
  - **Category name input**: Add category
  - **Search input**: Execute search
  - **Bottom task input**: Add new task
  - **Task input in right panel**: Add task to selected node
  - **Notes textarea**: Save notes (Enter without Shift, Shift+Enter for new line)
  - **Node rename input**: Finish renaming
  - **Modal inputs**: Submit form or activate default button

- **Escape**: Cancel/close (when in input fields)
  - **Search input**: Exit search mode and blur input
  - **Node rename input**: Cancel renaming
  - **Modal inputs**: Close modal
  - **Shortcut customization**: Cancel shortcut change and restore previous value

### Page Scrolling

- **Arrow Keys (↑↓←→)**: Scroll pages
  - **On settings page**: Arrow keys scroll the settings content vertically (Up/Down) or horizontally (Left/Right)
  - **On calendar page**: Arrow keys scroll the calendar view vertically (Up/Down) or horizontally (Left/Right)
  - Scroll amount: 50 pixels per keypress
  - Only works when not in an input field and when not on home view

### General Keyboard Navigation

- **Arrow Keys**: Navigate through focusable elements
  - When not on home view or when nodes are not available
  - Moves focus between buttons, inputs, and other interactive elements
  - Up/Down arrows move vertically, Left/Right arrows move horizontally
  - Nodes are excluded from focusable elements to prevent conflicts
  - On settings and calendar pages, arrow keys scroll the page instead of navigating focus

- **Enter**: Activate focused element
  - Clicks buttons, submits forms, activates links
  - Works with keyboard navigation to provide full keyboard accessibility
  - Activates default button in modals if available

### Shortcut Customization

- All keyboard shortcuts can be customized in the Settings page
- Click "Change" next to any shortcut and press the desired key combination
- Press Escape to cancel customization and restore the previous value
- Custom shortcuts are saved to `G.shortcuts` and persist across sessions
- Default shortcuts are restored if no custom shortcut is set

### Notes

- All shortcuts are disabled when typing in input fields, textareas, or select elements
- The selector (red outline) always falls on the biggest node at the current level after any navigation or level change
- Keyboard shortcuts work consistently across all levels of the node hierarchy
- Zoom actions (mouse wheel or pinch) automatically expand nodes or drill down when appropriate
- Space key combinations use time-based detection (500ms window) for more reliable detection
- Double Space uses a 400ms threshold for double-press detection

## 9. UI Elements and Layout

### Home Page Elements

#### 1. Top Search Input Box
- **Location:** Top of the page
- **Function:** Search for tasks/nodes by text
- **Behavior:** Filters and highlights matching nodes in the main space
- **Scope:** Searches across all node levels and names

#### 2. Bottom Task Creation Input Box
- **Location:** Bottom of the page
- **Function:** Create new tasks (nodes)
- **Behavior:** 
  - Creates new nodes in the current node space
  - New nodes appear in the main space immediately
  - New tasks are added to the task tab automatically
- **Context:** Respects the current level/space context

#### 3. Top Bar
- **Location:** Top of the page
- **Contains:** Essential buttons for:
  - **Save:** Saves current state
  - **Exit:** Exits/closes the application
  - **Settings:** Opens settings panel
  - Other essential utility functions
- **Visibility:** Always visible at the top

#### 4. Left Sidebar
- **Location:** Left side of the page
- **Contains icons:**
  - **"Home" icon** (replaces home icon): Navigates to the main/home page
  - **Calendar icon:** Opens the calendar page with events
    - Events can be added, removed, shown, and edited
  - **Settings icon:** Opens account info and settings for making edits
- **Behavior:** Icons provide navigation between different views/pages

#### 5. Right Sidebar (Task Tab)
- **Location:** Right side of the page
- **Top Bar Section:**
  - Shows the current level (node space name)
  - **Left arrow:** Navigates up a level of tasks
  - **Right arrow:** Navigates down a level of tasks
  - **Hide Completed Toggle (👁️/👁️‍🗨️):** Located next to Categories dropdown
    - Default state: Off (shows completed tasks)
    - When enabled: Hides completed tasks from task lists and network plot
    - Toggle persists across sessions (saved to localStorage)
    - Only visible in Categories view (root level)
- **Unpack All Icon:**
  - Located beneath the top bar
  - **Function:** Expands all tasks in the task tab
  - **Behavior:** When clicked, all task tabs drop down to show their content tasks
  - **Toggle:** Clicking again collapses all expanded tasks
  - **Implementation requirement:** Must check that nodeIds array exists and has length before processing. Only expands nodes that have children.
- **Task Tabs:**
  - Display all tasks at the top level
  - Each task tab shows:
    - **Default state:** Only shows text describing the task (task name takes full width)
    - **Hover state:** Shows 5 functional icons (positioned absolutely on the right):
      1. **Notes icon:** Add/edit notes for the task
      2. **Timer icon:** Set/manage timer for the task
      3. **Settings icon:** Edit task settings and properties
      4. **Trash icon:** Delete the task
      5. **Drop-down icon:** Expand/collapse to show content tasks
  - **Visibility:** Icons only appear on hover (opacity:0 with pointer-events:none by default, opacity:1 with pointer-events:auto on hover); task text takes full width when icons are hidden
  - **Layout requirement:** Icons must be positioned absolutely so they don't affect text width when hidden
  - **Completed tasks:** When a task is checked off (completed), all 5 icons remain clickable and functional, including the cross (×) to remove from to-do list and trash (🗑) to delete
  - **To-do list icons:**
    - **Cross (×):** Removes task from to-do list only (task remains in task list above)
    - **Trash (🗑):** Deletes task from both to-do list and task list (permanent deletion)

#### 6. To-Do List Section
- **Location:** Bottom of right sidebar (below task tabs)
- **Two tabs** at the top of the section, both pointing at the same panel below:
  - **"Today's to-do list"** (default) — text title (`#rp-todo-tab-today`); click to switch back from the pool tab. Active tab is full opacity; idle tab is dimmed.
  - **Pool icon** (`#rp-todo-tab-pool-btn`) — a transparent button (no outline box) carrying the cyberpunk Pool SVG. Click to view the pool. When active, the SVG gets full opacity + a subtle purple `drop-shadow` glow + a 1.05× scale to read as "selected". When idle the SVG dims to 0.62 opacity.
- **Functionality (today tab):**
  - Displays tasks added to "Today's to-do list" (persists across days, not date-restricted).
  - Each task shows checkbox, color dot, name, progress percentage, and timer if active.
  - **Hover actions (right-aligned, appear on row hover):** Notes, Timer, Settings, Trash, **Pool** (move to pool — work on this sometime soon, not today), Cross (remove from list).
  - **Pool action button** uses the cyberpunk Pool SVG inside an `.rt-act.rt-act--icon` chip (tighter padding, flex-centered SVG).
  - **Drag and drop:** Tasks can be reordered within the to-do list.
- **Functionality (pool tab):**
  - Displays tasks parked for "sometime soon" but not for today. Same row layout as today tab.
  - The hover-action row swaps the **Pool** icon for a **Promote-to-today** icon (sunrise SVG): clicking moves the task back into today's list.
  - The Cross (×) on a pool row removes the task from the pool only (task itself is preserved).
  - No "Add task…" input row in the pool tab; tasks enter the pool only by being moved there from today.
- **Hover tooltip:** Dwelling the cursor for **1 second** on any row in either tab pops up a tooltip showing the task's full name (bold) and description (capped at 600 chars). The tooltip is positioned next to the cursor, clamped to the viewport, and is dismissed by `mouseout` (off the row), clicks, drags, wheel, or keystrokes. Only one tooltip is ever shown.
- **Task actions when completed:**
  - All hover icons (Notes, Timer, Settings, Trash, Pool / Promote, Cross) remain clickable and functional.
  - Icons appear with reduced opacity (0.3) but remain interactive.
  - Cross (×) removes task from the active list (today or pool) only.
  - Trash (🗑) deletes the task from both lists and from the main task list (permanent deletion).
- **Undo / redo:** Every pool operation is a tracked operation:
  - Moving a task from today → pool (`moveTodoToPool`)
  - Moving a task from pool → today (`movePoolToToday`)
  - Adding to / removing from either list (`addToTodoList`, `removeFromTodoList`, `addToPool`, `removeFromPool`)
  - Each calls `svWithUndo()` before mutating state, so **Ctrl/Cmd + Z** restores the previous arrangement and **Ctrl/Cmd + Shift + Z / Ctrl/Cmd + Y** redoes it. The tab visual (which tab is active) is not part of the snapshot — undo restores list contents, not your current viewing tab.
- **Persistence:** Both lists live on the user JSON — `G.todoList` for today, `G.todoPool` for the pool. The active tab is `G.todoActiveTab` (`'today' | 'pool'`). Loaders ensure `G.todoPool` is an array and `G.todoActiveTab` falls back to `'today'`.
- **Auto-hide:** Section hides only when both today and pool lists are empty AND the today tab is active.

### Calendar Page Elements

#### Calendar Functionality
- **Must function identically to MacBook Calendar and Google Calendar**
- **All standard calendar functionalities must be preserved:**
  - Add events
  - Edit events
  - Delete events
  - View events
  - Drag and drop events
  - Resize events
  - Recurring events (if applicable)
  - Event details and descriptions

#### Time Display
- **Shows exact time across 24 hours per day**
- **Each hour is clearly marked**
- **Time column on the left** shows all 24 hours

#### Scrolling
The calendar has **two independent scrollers** that work together:

1. **Horizontal Scroller (Left/Right):**
   - Shows **one week at a time** (7 days: Sunday through Saturday)
   - Scrolls left and right to navigate between different weeks
   - When scrolling near the left edge (<10% from start), loads earlier weeks (jumps back 14 days)
   - When scrolling near the right edge (>90% from end), loads later weeks (jumps forward 14 days)
   - The date/day columns in the header **change** as you scroll horizontally to show the new week
   - This allows infinite horizontal scrolling through weeks
   - The calendar re-renders with the new week's dates when scrolling near edges

2. **Vertical Scroller (Up/Down):**
   - Scrolls up and down to show different hours of the day
   - Renders **10 cycles of 24 hours** (240 hours total) for infinite vertical scrolling
   - All cycles show the **SAME dates** (the current week) - only the time slots repeat
   - The date/day columns in the header **remain fixed** when scrolling vertically
   - This allows infinite vertical scrolling through hours while keeping the week constant
   - Vertical scrolling does NOT trigger calendar re-renders - it only scrolls through pre-rendered hours

**Key Behavior:**
- **Date columns stay fixed** when scrolling vertically (like Google Calendar/Mac Calendar)
- **Only horizontal scrolling changes the visible week/dates**
- **Vertical scrolling only changes which hours are visible** within the current week
- The header shows the current week's dates and does not change during vertical scrolling
- Smooth scrolling with proper viewport management
- Scroll position (both horizontal and vertical) is tracked and restored when calendar re-renders
- Horizontal scroll position is preserved when jumping between weeks

#### Visual Structure
- Follows the specifications in Section 6 (Calendar Display and Interaction)
- Maintains consistency with standard calendar applications

## General Development Guidelines

### Code Consistency
- Maintain consistent naming conventions
- Follow the existing code structure and patterns
- Ensure all node interactions work the same way at all levels
- Keep UI elements consistent across all pages

### Testing Requirements
- Test interactions at all node levels
- Verify sphere expansion and collapse behavior
- Test calendar-task synchronization
- Verify main space click detection accuracy
- Test all UI elements (search, input boxes, sidebars, buttons)
- Verify hover states and icon visibility
- Test calendar functionality matches standard calendar apps

### User Experience
- All interactions should feel smooth and responsive
- Visual feedback should be clear and immediate
- Error states should be handled gracefully
- The interface should remain intuitive across all features
- Hover states should be responsive and clear
- Icons should be easily recognizable and consistent

### UI Element Behavior
- **Hover states:** Must be responsive and provide clear visual feedback
- **Icon visibility:** Icons should only appear when appropriate (e.g., on hover for task tabs)
- **Navigation:** All navigation elements should work consistently
- **Input boxes:** Should provide clear feedback and validation
- **Sidebars:** Should remain accessible and not obstruct main content

---

## 10. Icon Design Standards - Cyberpunk Cartoon Style

**All icons in this project must follow the cyberpunk cartoon aesthetic to maintain visual consistency.**

### Style Overview

Icons should have a **cyberpunk cartoon** appearance with:
- **Bold, stylized shapes** with strong visual impact
- **Vibrant gradients** using the project's color palette
- **Decorative elements** (dots, accents, glow effects)
- **Multiple layers** for depth and visual interest
- **Playful yet technical** aesthetic

### Color Palette

**Primary Colors:**
- **Purple/Blue Gradient:** `#6C63FF` (primary purple) to `#8b84ff` (lighter purple)
- **Gold Accents:** `#FFD700` (gold) and `#FF8C00` (orange-gold)
- **Stroke Colors:** Use primary colors for strokes (purple/blue variants)

**Gradient Definitions:**
```svg
<defs>
  <linearGradient id="iconGrad" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" style="stop-color:#6C63FF;stop-opacity:1"/>
    <stop offset="100%" style="stop-color:#8b84ff;stop-opacity:1"/>
  </linearGradient>
</defs>
```

### Design Elements

**Required Elements:**
1. **Gradient Fills:** Main shapes should use linear gradients (purple/blue)
2. **Decorative Dots:** Add small gold circles (`#FFD700`) for visual interest
   - Size: 0.8-1.2px radius
   - Opacity: 0.7-0.9
   - Position: Strategically placed for balance
3. **Multiple Layers:** Use stroke + fill combinations for depth
4. **Bold Strokes:** Stroke width typically 1.2-1.5px
5. **Glow Effects:** Optional double-layered strokes for connection lines (base color + gold accent)

**Optional Elements:**
- **Accent Lines:** Thin decorative lines in gold or purple
- **Dashed Patterns:** For secondary connections or effects
- **Opacity Variations:** Use opacity 0.5-0.9 for layered effects

### Technical Specifications

**SVG Structure:**
```svg
<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block">
  <defs>
    <!-- Gradients here -->
  </defs>
  <!-- Icon paths/shapes here -->
</svg>
```

**ViewBox:** Always use `viewBox="0 0 24 24"` for consistency
**Size:** Icons in top bar should be 20x20px
**Display:** Always include `style="display:block"` to prevent inline spacing issues

### Icon Examples

**Good Icon Examples:**

1. **Priority Star Icon:**
   - Gradient-filled star shape
   - Gold center dot
   - Multiple decorative gold dots
   - Bold stroke with orange accent

2. **Filter/Show By Icon:**
   - Gradient-filled funnel shape
   - Gold decorative dots on sides
   - Accent lines in gold
   - Multiple layers for depth

3. **Network/Bring Edges Icon:**
   - Gradient-filled circular nodes
   - Gold center dots in each node
   - Double-layered connection lines (base + gold glow)
   - Dashed diagonal connections for network feel

4. **Pool Icon** (to-do list pool tab + per-row "move to pool" action):
   - Gradient-filled outer basin ellipse with purple stroke
   - Dark inner water ellipse with lighter purple stroke for depth
   - Two gold wave ripples (bold + faint, both `stroke-linecap="round"`) inside the basin
   - Three gold "splash" dots above the rim for visual interest
   - Lives in JS as `POOL_ICON_SVG(size)` in `js/app.js`. Rendered inline at 20×20 in the tab button (no outline box around the button) and 14×14 inside `.rt-act.rt-act--icon` chips on each task row.

5. **Promote-to-Today Icon** (per-row pool action: send pool task back to today):
   - Gradient-filled half-disc "sun" rising from a purple horizon line
   - Gold sun centre + three gold rays (top, top-left, top-right)
   - Lives in JS as `POOL_PROMOTE_ICON_SVG(size)` in `js/app.js`. Rendered inline at 14×14 inside `.rt-act.rt-act--icon` chips on pool rows.

### Design Checklist

When creating a new icon, ensure:
- [ ] Uses gradient fills (purple/blue) for main shapes
- [ ] Includes at least one gold decorative element (dot, line, or accent)
- [ ] Has multiple layers (fill + stroke, or multiple shapes)
- [ ] Uses bold strokes (1.2-1.5px)
- [ ] Follows SVG structure with proper viewBox
- [ ] Matches the playful yet technical cyberpunk aesthetic
- [ ] Is recognizable at small sizes (20x20px)

### Common Mistakes to Avoid

- ❌ **Flat colors only** - Always use gradients
- ❌ **No decorative elements** - Add gold dots or accents
- ❌ **Single layer designs** - Use multiple layers for depth
- ❌ **Thin strokes** - Use bold strokes (1.2px minimum)
- ❌ **Inconsistent viewBox** - Always use `viewBox="0 0 24 24"`
- ❌ **Missing gradients** - Define gradients in `<defs>` section

### Reference Icons

Study these existing icons for style reference:
- Priority star icon (`#tb-priority`)
- Show by filter icon (`#tb-showby-btn`)
- Bring edges icon (`#tb-bring-edges-btn`)
- Auto-save lever icon (`#tb-as`)

**⚠️ DO NOT CREATE:** Icons that deviate from the cyberpunk cartoon style. All icons must maintain visual consistency with the existing design language.

---

**Last Updated:** 2024
**Version:** 2.0

