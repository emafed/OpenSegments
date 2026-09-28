from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, garmin
from .db import db, init_db, load_preferences, save_preferences
from .indexing import get_track, scan_status, serialize_activity, start_scan
from .matching import SegmentError, search

init_db()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    garmin.auto_sync_on_startup()
    yield


app = FastAPI(title="OpenSegments", lifespan=lifespan)

STATIC_DIR = config.ROOT / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _asset_version() -> str:
    try:
        return str(int(max(p.stat().st_mtime for p in STATIC_DIR.rglob("*") if p.is_file())))
    except ValueError:
        return "0"


@app.get("/")
def index():
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html.replace("__ASSET_V__", _asset_version()))


@app.get("/api/status")
def api_status():
    with db() as conn:
        activities = conn.execute("SELECT COUNT(*) FROM activities WHERE error IS NULL").fetchone()[0]
        errors = conn.execute("SELECT COUNT(*) FROM activities WHERE error IS NOT NULL").fetchone()[0]
        segments = conn.execute("SELECT COUNT(*) FROM segments").fetchone()[0]
    return {
        "activities": activities,
        "errors": errors,
        "segments": segments,
        "files_dir": str(config.FILES_DIR),
        "scan": scan_status(),
    }


@app.post("/api/scan")
def api_scan(force: bool = False):
    started = start_scan(force=force)
    return {"started": started, "status": scan_status()}


@app.get("/api/scan/status")
def api_scan_status():
    return scan_status()


@app.get("/api/preferences")
def api_preferences():
    return load_preferences()


@app.post("/api/preferences")
def api_save_preferences(values: dict):
    if values:
        save_preferences(values)
    return load_preferences()


class GarminLoginRequest(BaseModel):
    email: str
    password: str


class GarminMfaRequest(BaseModel):
    code: str


class GarminSyncRequest(BaseModel):
    mode: str = "incremental"
    start_date: str | None = None
    end_date: str | None = None


class GarminSettingsRequest(BaseModel):
    auto_sync: bool | None = None
    gps_only: bool | None = None
    sport: str | None = None


@app.get("/api/garmin/status")
def api_garmin_status():
    return garmin.status()


@app.post("/api/garmin/login")
def api_garmin_login(req: GarminLoginRequest):
    if not garmin.GARMIN_AVAILABLE:
        raise HTTPException(400, "libreria garminconnect non installata")
    email = req.email.strip()
    if not email or not req.password:
        raise HTTPException(400, "email e password obbligatorie")
    started = garmin.start_login(email, req.password)
    return {"started": started, "status": garmin.status()}


@app.post("/api/garmin/mfa")
def api_garmin_mfa(req: GarminMfaRequest):
    code = req.code.strip()
    if not code:
        raise HTTPException(400, "codice MFA mancante")
    if not garmin.submit_mfa(code):
        raise HTTPException(409, "nessun login in attesa di codice MFA")
    return garmin.status()


@app.post("/api/garmin/logout")
def api_garmin_logout():
    garmin.logout()
    return garmin.status()


@app.post("/api/garmin/sync")
def api_garmin_sync(req: GarminSyncRequest):
    if not garmin.GARMIN_AVAILABLE:
        raise HTTPException(400, "libreria garminconnect non installata")
    if not garmin.status()["logged_in"]:
        raise HTTPException(409, "non connesso a Garmin Connect")
    mode = "bulk" if req.mode == "bulk" else "incremental"
    started = garmin.start_sync(
        mode,
        req.start_date if mode == "bulk" else None,
        req.end_date if mode == "bulk" else None,
    )
    return {"started": started, "status": garmin.sync_status()}


@app.get("/api/garmin/sync/status")
def api_garmin_sync_status():
    return garmin.sync_status()


@app.post("/api/garmin/sync/cancel")
def api_garmin_sync_cancel():
    return {"cancelled": garmin.cancel_sync(), "status": garmin.sync_status()}


@app.post("/api/garmin/settings")
def api_garmin_settings(req: GarminSettingsRequest):
    changes = req.model_dump(exclude_none=True)
    if changes:
        garmin.update_settings(**changes)
    return garmin.status()


@app.get("/api/activities")
def api_activities():
    with db() as conn:
        rows = conn.execute(
            "SELECT * FROM activities ORDER BY COALESCE(start_time, '') DESC, id DESC"
        ).fetchall()
    return [serialize_activity(r) for r in rows]


@app.get("/api/activities/{activity_id}/track")
def api_track(
    activity_id: int,
    from_idx: int | None = None,
    to_idx: int | None = None,
    fields: str | None = None,
    max_points: int | None = None,
    gradient: bool = False,
):
    try:
        return get_track(
            activity_id,
            from_idx,
            to_idx,
            fields.split(",") if fields else None,
            max_points,
            gradient,
        )
    except KeyError as exc:
        raise HTTPException(404, str(exc))


class SegmentSearchRequest(BaseModel):
    activity_id: int
    start_idx: int
    end_idx: int
    strategy: str = "endpoints"
    tolerance_m: float = config.TOLERANCE_M
    direction: str = "same"
    coverage_min: float = config.COVERAGE_MIN
    max_gap_factor: float = config.MAX_GAP_FACTOR
    check_heading: bool = True
    heading_tol_deg: float = config.HEADING_TOL_DEG
    save_segment_id: int | None = None


def _persist_matches(conn, segment_id: int, result: dict) -> None:
    now = _now()
    conn.execute("DELETE FROM segment_matches WHERE segment_id = ?", (segment_id,))
    for r in result["results"]:
        conn.execute(
            """
            INSERT OR REPLACE INTO segment_matches (
                segment_id, activity_id, pass_start_idx, pass_end_idx, duration_s,
                distance_m, avg_speed_mps, avg_hr, coverage, d_start_m, d_end_m,
                is_best, computed_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                segment_id,
                r["activity_id"],
                r["pass_start_idx"],
                r["pass_end_idx"],
                r["duration_s"],
                r["segment_distance_m"],
                r["avg_speed_mps"],
                r["avg_hr"],
                r["coverage"],
                r["d_start_m"],
                r["d_end_m"],
                1 if r.get("is_best") else 0,
                now,
            ),
        )
    conn.execute(
        "UPDATE segments SET params=?, length_m=? WHERE id=?",
        (json.dumps(result["params"]), result["segment"]["length_m"], segment_id),
    )


@app.post("/api/segment/search")
def api_segment_search(req: SegmentSearchRequest):
    try:
        result = search(req.activity_id, req.start_idx, req.end_idx, req.model_dump())
    except SegmentError as exc:
        raise HTTPException(400, str(exc))
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    if req.save_segment_id:
        with db() as conn:
            exists = conn.execute(
                "SELECT id FROM segments WHERE id = ?", (req.save_segment_id,)
            ).fetchone()
            if exists:
                _persist_matches(conn, req.save_segment_id, result)
    return result


class SegmentCreate(BaseModel):
    name: str
    activity_id: int
    start_idx: int
    end_idx: int
    params: dict | None = None


@app.get("/api/segments")
def api_segments():
    with db() as conn:
        rows = conn.execute(
            """
            SELECT s.*, a.filename, a.start_time, a.sport,
                   (SELECT COUNT(*) FROM segment_matches m WHERE m.segment_id = s.id) AS match_count
            FROM segments s
            LEFT JOIN activities a ON a.id = s.activity_id
            ORDER BY s.id DESC
            """
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["params"] = json.loads(d["params"]) if d.get("params") else None
        out.append(d)
    return out


@app.post("/api/segments")
def api_segment_create(req: SegmentCreate):
    try:
        result = search(req.activity_id, req.start_idx, req.end_idx, req.params)
    except SegmentError as exc:
        raise HTTPException(400, str(exc))
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    name = (req.name or "").strip() or "Segmento"
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO segments(name, activity_id, start_idx, end_idx, length_m, created_at, params) VALUES(?,?,?,?,?,?,?)",
            (
                name,
                req.activity_id,
                result["segment"]["start_idx"],
                result["segment"]["end_idx"],
                result["segment"]["length_m"],
                _now(),
                json.dumps(result["params"]),
            ),
        )
        sid = cur.lastrowid
        _persist_matches(conn, sid, result)
    return {"segment_id": sid, "search": result}


@app.get("/api/segments/{segment_id}")
def api_segment_get(segment_id: int):
    with db() as conn:
        seg = conn.execute("SELECT * FROM segments WHERE id = ?", (segment_id,)).fetchone()
        if seg is None:
            raise HTTPException(404, "segmento non trovato")
        matches = conn.execute(
            """
            SELECT m.*, a.filename, a.name, a.start_time, a.sport,
                   a.distance_m AS activity_distance_m
            FROM segment_matches m
            LEFT JOIN activities a ON a.id = m.activity_id
            WHERE m.segment_id = ?
            ORDER BY m.duration_s ASC
            """,
            (segment_id,),
        ).fetchall()
    d = dict(seg)
    d["params"] = json.loads(d["params"]) if d.get("params") else None
    d["results"] = [dict(m) for m in matches]
    return d


@app.delete("/api/segments/{segment_id}")
def api_segment_delete(segment_id: int):
    with db() as conn:
        conn.execute("DELETE FROM segment_matches WHERE segment_id = ?", (segment_id,))
        conn.execute("DELETE FROM segments WHERE id = ?", (segment_id,))
    return {"deleted": segment_id}
