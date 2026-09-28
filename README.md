# OpenSegments

Local platform for analyzing your FIT files: reverse segment search across your activities, side-by-side comparison of efforts, and parameter analysis of a single activity. No login, no cloud service: it runs entirely on your PC (the only outbound connection is to Garmin Connect if you enable the import).

## What it does

- Indexes `.fit` files from the `files\` folder (including subfolders).
- **Garmin Connect mode** (selectable from the header): sign in with your account, import your history with a progress bar, and automatically sync new activities on every startup. FIT files are downloaded to `files\garmin\` and indexed like any other file.
- Select a segment on an activity in two ways:
  - click on the map (start and end, with snapping to real GPS points and fine adjustment);
  - two-handle time selector below the map (drag the handles to isolate the section).
- Search all indexed activities for the ones passing over that segment (strategies: start+end in order, track overlap, both).
- Strava-style comparison: list of activities on the segment, up to **5 activities at the same time** (the 5 fastest efforts are added on first load; you can then select/deselect from the list), toggle attributes on/off (speed, **pace per km**, HR, **efficiency (EF)**, cadence, elevation, power, temperature, grade, and **elevation profile** as a gray area), separate charts or a single chart with all metrics. The activity list has a funnel icon menu to **filter by date and sort by date or time**.
- Synchronized cursor: hovering a chart draws a vertical line on all charts, and the point values of each activity at that position (distance or time) are shown in a fixed column on the right of the **Single chart** (with no cursor it shows segment averages; each value's dot has the metric color); on the map, one dot per tracked activity follows the selected position and disappears when the mouse leaves the chart.
- Single chart, Strava style: one band per metric with its own scale (pace is inverted: faster at the top), scale labels per band, and a magnifier icon on every chart (the chart expands into the app area, closes with X or Esc; it does not trigger system fullscreen); even when expanded, the attribute chips stay in the chart title so you can add or remove metrics. The **Elevation** chip adds the elevation profile as a gray area at the bottom (in comparisons it uses the source activity's profile).
- Default attributes by sport: running → **pace** + **HR**, cycling → **speed** + **HR** (other sports: speed + pace).
- Single activity analysis: parameter charts of the activity over the isolated segment, with a button to search for the same segment across all activities.
- **Trend** of parameters: from the search results, the button with the chart icon opens the tab of the same name; each activity in the results is a column on the horizontal axis (left to right, in the chosen order and with the Compare filters) and the attributes enabled through the chips (speed, **pace**, HR, **efficiency (EF)**, cadence, elevation, power, temperature, grade) are plotted on the vertical axis, each with its own color and scale. Values appear in the fixed column on the right (activity averages without the cursor, activity value under the cursor, as in the Single chart); click a point to center that effort on the map. At the bottom, a two-handle selector, similar to the segment one, **narrows the date range**: drag the handles or the bar to move the window (numbers and scales adapt to the selected period), or press **All dates** to see everything again.
- Segment saving: the segment and the matches found are stored in SQLite and reloaded instantly on later launches. Recompute with a button.
- If an activity passes over the same segment multiple times (e.g. out and back), each effort is a separate result with the suffix `_1`, `_2`, `_3` (e.g. `Sab_26_09_2026_2`) both in the search results and in the comparison selector, so you can pick and compare the individual effort.
- Activity update: incremental scan ("Refresh") or full scan ("Force refresh").
- Chart zoom: drag the mouse on a chart to select a range and zoom into that section; the zoom also updates the yellow segment selector (and vice versa), and it works in both travel directions; the **Reset zoom** button (or double-click on the chart) returns to the full view.
- Match search is limited to the same sport as the source activity (running only searches runs, cycling only rides; can be disabled with "Same sport only" in the settings) and to the same segment length (adjustable maximum deviation, default ±25%), so false matches with very different lengths are excluded.
- Hidden **⚙** menu (top right): chart height, spacing, horizontal and vertical scale, axis text size, icon-based layout selector (above/below, side by side, map popup), and show/hide map. All settings panels open on top of the interface, with **X to close** and **↺ to restore the initial values**; preferences (charts, search, layout, sorting) are **saved automatically to the database on every change**, with no save button.
- Flexible layout: map above/below or beside the panels, with a **draggable divider between map and panels** (proportions are remembered per view) and automatic resizing of map and charts; map in a mobile popup, closable (with a bubble to reopen it), resizable sidebar.
- Indexing progress bar in the header (current files and percentage).

## Architecture

```
Browser (http://127.0.0.1:8000)
│  static frontend: HTML + CSS + vanilla JS
│  Leaflet (map, online OSM tiles) + Chart.js (charts), libraries stored locally
│
▼
FastAPI / uvicorn  ──────────────►  SQLite  data/app.db
│  REST API /api/*                   ├─ activities        activity metadata
│  background scanning               ├─ coarse_points     decimated GPS points (~250 m)
│  search with R-tree pre-filter     ├─ coarse_rtree      spatial index (R*Tree)
│  Garmin import (garminconnect)     ├─ segments          saved segments
│                                    ├─ segment_matches   matches found (results cache)
│                                    ├─ garmin_sync       already-downloaded Garmin activity IDs
│                                    └─ preferences       persistent UI preferences
│
├── track cache  data/cache/{id}.npz
│      compressed arrays per activity: lat, lon, t, dist, alt, speed, hr,
│      cadence, power, temp (NaN where the data is missing)
│
├── Garmin tokens  data/garmin_tokens.json  (created only on first login)
│
└── activities folder  files\   (original .fit files, never modified)
       └── garmin\             (FIT files downloaded from Garmin Connect)
```

**Backend** (`app/`)

| File | Role |
|---|---|
| `main.py` | FastAPI API, activity/search/segment endpoints |
| `fitio.py` | FIT parsing (fitparse): GPS, time, HR, cadence, power, elevation, temperature; guaranteed resampling to **1 point/second** |
| `geo.py` | haversine/equirectangular distances, bearing, cumulative values |
| `db.py` | SQLite schema (WAL) and connections |
| `indexing.py` | folder scan, npz cache and R-tree index building, track reading |
| `matching.py` | match search strategies and coverage computation |
| `garmin.py` | Garmin Connect login (tokens, MFA), bulk/incremental import and sync status |
| `config.py` | paths and default parameters |

**Frontend** (`static/`)

| File | Role |
|---|---|
| `index.html` | UI structure (sidebar, segment bar always visible at the top, map, Analysis/Compare/Trend tabs) |
| `app.js` | UI logic, Leaflet map, sliders, Chart.js charts, synchronized cursor |
| `style.css` | dark theme |
| `vendor/` | Leaflet and Chart.js downloaded locally (no CDN) |

**Search flow**: the reference segment is the portion of the source activity's track. Candidates are pre-filtered with the R-tree index (radius = tolerance + decimated point spacing), then verified against the full tracks. There are three strategies:

- `endpoints` (default): the track passes near the start point and then near the end point, in the same sequence, with a heading (compass) check and track length between (1 - deviation) and (1 + deviation) times the segment length (default ±25%);
- `overlap`: at least the required coverage percentage (default 80%) of the segment points stays within tolerance;
- `both`: both conditions.

Tolerance, direction (same way / both), coverage, maximum length deviation, "same sport only" filter, and compass check are configurable from the UI. The "best time" is the match with the minimum duration.

## Requirements

- Windows 10/11.
- Python 3.12 (installable with `winget install Python.Python.3.12`).
- Internet connection for the OpenStreetMap map tiles (everything else is local, except Garmin mode).
- Input format: `.fit` files only (also from Strava exports).
- For Garmin mode: a Garmin Connect account and an internet connection. Login uses the unofficial API via the `garminconnect` library (installed with the dependencies); if Garmin changes its services it may temporarily stop working.

## Installation

From a terminal in the project folder:

```powershell
winget install Python.Python.3.12
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Alternatively, the first run of `run.bat` creates the virtual environment and installs the dependencies by itself.

## Running

```powershell
.\run.bat
```

`run.bat` opens the browser at `http://127.0.0.1:8000` and starts the server. The terminal window stays open even when the server is stopped (Ctrl+C) or if an error occurs, so you can read the messages. To start it manually:

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

To stop the server: `Ctrl+C` in the terminal, close the window, or run **`stop.bat`** (useful if the server was started in the background or you can no longer find the window). `stop.bat` locates and terminates the server process.

## Active services

| Service | Where | Notes |
|---|---|---|
| FastAPI/uvicorn HTTP server | `127.0.0.1:8000` | local only, not exposed on the network |
| SQLite database (WAL) | `data/app.db` | activities, spatial index, segments, matches |
| Track cache | `data/cache/*.npz` | compressed arrays, rebuildable with "Force refresh" |
| File scan | `files\` (recursive) | background thread, status via `/api/scan/status` |
| Garmin sync | `data/garmin_tokens.json` + Garmin API | requires internet and login; status via `/api/garmin/status` |
| Map tiles | `tile.openstreetmap.org` | external service, requires internet |

### Main API endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/status` | GET | general status and last scan |
| `/api/scan?force=` | POST | start scan (incremental or full) |
| `/api/scan/status` | GET | scan progress |
| `/api/preferences` | GET/POST | persistent UI preferences (charts, search, layout, sorting) |
| `/api/activities` | GET | list of indexed activities |
| `/api/activities/{id}/track` | GET | track (range, fields, decimation, grade) |
| `/api/segment/search` | POST | search matches on the segment |
| `/api/segments` | GET/POST | list / save segment + matches |
| `/api/segments/{id}` | GET/DELETE | details with matches / deletion |
| `/api/garmin/status` | GET | Garmin account, login, and sync status |
| `/api/garmin/login` | POST | login (email + password; MFA via `/api/garmin/mfa`) |
| `/api/garmin/mfa` | POST | submit the requested MFA code |
| `/api/garmin/logout` | POST | log out and remove the local token |
| `/api/garmin/sync` | POST | start import (`bulk` with date range, or `incremental`) |
| `/api/garmin/sync/status` | GET | import/sync progress |
| `/api/garmin/sync/cancel` | POST | cancel the running sync |
| `/api/garmin/settings` | POST | preferences (auto sync, GPS only, sport filter) |

## How to use it

1. Open the **⚙** menu in the top right and use **Aggiorna** (Refresh) — or **Forza refresh** (Force refresh) on first use — to index the files in `files\`.
2. **Garmin Connect mode**: from the **⚙** menu choose "Garmin Connect".
   - On first use, sign in with email and password; if the account has two-step verification, the MFA code field appears. The password is never saved: only the session token remains in `data\garmin_tokens.json`.
   - On later launches, login happens automatically with the saved token (no password prompt): if the token is no longer valid, the login panel opens with the error message.
   - **Importa storico** (Import history): downloads activities (all of them, or only the selected date range) with tracked progress and a Cancel button. The FIT files go to `files\garmin\` and are indexed automatically.
   - **Sincronizza** (Sync): downloads only new activities. With "Sync automatically at startup" enabled, the check starts by itself on every program launch (after the first import).
   - From the **⚙** menu you can limit the import to GPS activities only, filter by sport, and log out.
3. Select an activity from the sidebar: its track appears on the map.
4. Isolate the segment with the bar always visible at the top: click "Select on map" (A and B) or drag the handles of the **time selector**. Drag the **yellow bar** of the selector to move the segment forward/backward while keeping duration and length; adjust with the ◀▶ arrows or by dragging the A/B markers. The search settings (strategy, tolerance, direction, coverage, length deviation, same sport only, compass) are in the gear menu to the right of the bar.
5. Choose:
   - **Cerca passaggi** (Search matches): finds all activities that passed over the segment; results appear in the Compare tab in a collapsible panel, and the segment can be saved to have it ready in the future;
   - **Analisi attività** (Activity analysis, tab of the same name): parameter charts of the activity over the selected section; from here, "Search this segment across activities".
6. In the **Confronto** (Compare) tab: on first load the **5 fastest efforts** on the segment are added; you can select/deselect activities from the list (maximum 5 at a time, "Prime 5" (Top 5) adds the first 5 of the filtered list) and use the funnel icon to filter by date or sort by date/time, toggle attributes with the chips, choose the X axis (distance or time) and the **Grafico unico** (Single chart) option (all metrics in one banded chart).
7. Hover the charts: cursor and point values are synchronized across all curves; in the **Single chart** the values appear fixed in the right-hand column (segment averages without the cursor, point values under the cursor) and one dot per activity follows the map selection. Charts are colored by metric (speed blue, pace lime, HR red, efficiency EF pink, cadence purple, elevation green, power orange, temperature light blue, grade yellow) and activities are distinguished by line style. The **Efficienza (EF)** (Efficiency) chart plots speed in m/min divided by heart rate: higher = more efficient. To enlarge a section, **drag the mouse** on a chart: on release the zoom is applied to all charts and the yellow segment selector updates accordingly (it also works on matches in the reverse direction); use **Rimuovi zoom** (Reset zoom) or double-click to return to the full view. The magnifier icon on each chart opens that chart in the full app area (close with X or Esc). With the **⚙** icon next to the tabs you adjust charts, layout, and map.
8. **Layout and screen**: drag the sidebar edge to resize it and the **divider between map and panels** to adjust the space (map above/below or beside); from the **⚙** icon next to the tabs choose the icon view Above/below (Sopra/sotto), Side by side (Affiancati — map and panels next to each other), or Map popup (Mappa popup — map as a movable, resizable window, closable with × and reopenable with the "Mappa" bubble), plus **show/hide map**.

## Tests

```powershell
.venv\Scripts\python.exe -m pytest tests -q
```

35 tests: geometry (distances, bearing), matching strategies on synthetic tracks (including length deviation and sport filter), integration on real FIT files, and Garmin import helpers (FIT extraction, filters, preferences).

## Notes

- Data extracted from FIT files is resampled to **1 point per second** (linear interpolation); GPS gaps longer than 10 seconds are left empty to avoid inventing positions. If a file was not recorded at 1 Hz, point indexes change after a refresh: saved segments remain valid but should be recomputed.
- `.fit` files are never modified; the index can be rebuilt by deleting `data\` (this also removes Garmin tokens and sync preferences).
- Power only appears if the file contains it (a power meter is required): besides the standard `power` field, running power recorded as a developer field (e.g. `RP_Power`) is also read. To update the flag of already-indexed activities, use **Forza refresh** (Force refresh).
- To change the port, edit `run.bat` (the `--port` parameter).
- Renamed or moved activity: it is removed from the index on the next scan; saved segments that use it as source remain but can no longer be loaded (delete them with the ×).
- Garmin mode: this is an unofficial client (the `garminconnect` library), so it requires internet and may ask you to log in again if Garmin invalidates the token. The password is used only for login and is never written to disk; the `data\garmin_tokens.json` file must be treated like a password.
- Garmin import: already-downloaded IDs are not downloaded again; activities deleted from Garmin are not removed locally; activities without GPS are excluded by default. "Cancel" stops the current download; already-saved activities remain.
- FIT files downloaded from Garmin live in `files\garmin\` and should not be renamed/moved manually.

## Privacy and repository notes

This project is designed to run locally and to keep your personal data out of version control. Before publishing on GitHub, never commit the following:

- `data\` — SQLite database, track cache, Garmin tokens, and saved preferences (personal and secret data);
- `files\` — your original FIT activities and the Garmin downloads (personal data);
- `.venv\`, `__pycache__\`, `.pytest_cache\` — generated artifacts;
- `*.log` — server logs.

A `.gitignore` covering all of these is included in the repository.