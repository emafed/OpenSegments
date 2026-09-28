# OpenSegments

Local platform for analyzing your FIT files: reverse segment search across your activities, side-by-side comparison of efforts, and parameter analysis of a single activity. No login, no cloud service: it runs entirely on your PC (the only outbound connection is to Garmin Connect if you enable the import).

## What it does

- Indexes `.fit` files from the `files\` folder (including subfolders), with incremental ("Refresh") or full ("Force refresh") scans.
- **Garmin Connect mode**: sign in with your account, import your history, and automatically sync new activities on every startup. FIT files are downloaded to `files\garmin\` and indexed like any other file.
- Select a segment on an activity by clicking on the map (A/B points) or with the two-handle time selector.
- Search all indexed activities for the ones passing over that segment (strategies: endpoints in order, track overlap, both), with same-sport and length-deviation filters.
- Strava-style comparison of up to **5 activities at a time**, with toggleable metrics (speed, **pace per km**, HR, **efficiency (EF)**, cadence, elevation, power, temperature, grade, elevation profile), separate charts or a single chart with all metrics, a synchronized cursor, and date filtering/sorting.
- Single activity analysis: parameter charts of the activity over the isolated segment.
- **Trend** tab: plots each activity from the search results on the horizontal axis and the selected metrics on the vertical axis, with a date-range selector.
- Segment and matches are saved in SQLite and reloaded instantly on later launches.
- UI preferences (charts, search, layout, sorting) are saved automatically to the database, with flexible map/chart layout options.

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
2. **Garmin Connect mode**: from the **⚙** menu choose "Garmin Connect" and sign in (MFA code if enabled; the password is never saved, only the session token in `data\garmin_tokens.json`). Use **Importa storico** (Import history) for the full or date-range import and **Sincronizza** (Sync) for new activities; later launches log in automatically.
3. Select an activity from the sidebar: its track appears on the map.
4. Isolate the segment with the bar at the top: click "Select on map" (A and B) or drag the handles of the **time selector**; move it with the yellow bar or the ◀▶ arrows. Search settings (strategy, tolerance, direction, coverage, length deviation, same sport only, compass) are in the gear menu to the right of the bar.
5. Choose **Cerca passaggi** (Search matches) to find all activities that passed over the segment (results appear in the Compare tab and the segment can be saved), or **Analisi attività** (Activity analysis) for parameter charts of the selected section.
6. In the **Confronto** (Compare) tab, compare up to **5 activities** (the 5 fastest are added on first load), toggle metrics with the chips, filter by date or sort by date/time with the funnel icon, and choose the X axis or the **Grafico unico** (Single chart) view. Hovering the charts synchronizes the cursor and point values, dragging zooms into a range, and the magnifier icon expands a chart.
7. **Layout**: drag the sidebar edge and the map/panels divider to resize them, or use the **⚙** icon next to the tabs to switch layout (above/below, side by side, map popup) and show/hide the map.

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