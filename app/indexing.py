from __future__ import annotations

import threading
from datetime import datetime, timezone

import numpy as np

from . import config
from .db import db, init_db
from .fitio import parse_fit
from .geo import haversine

_state = {
    "running": False,
    "force": False,
    "total": 0,
    "done": 0,
    "current": "",
    "indexed": 0,
    "updated": 0,
    "skipped": 0,
    "failed": 0,
    "removed": 0,
    "error": None,
    "started_at": None,
    "finished_at": None,
}
_lock = threading.Lock()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def scan_status() -> dict:
    with _lock:
        return dict(_state)


def start_scan(force: bool = False) -> bool:
    with _lock:
        if _state["running"]:
            return False
        _state.update(
            running=True,
            force=force,
            total=0,
            done=0,
            current="",
            indexed=0,
            updated=0,
            skipped=0,
            failed=0,
            removed=0,
            error=None,
            started_at=now_iso(),
            finished_at=None,
        )
    threading.Thread(target=_worker, args=(force,), daemon=True).start()
    return True


def _worker(force: bool) -> None:
    try:
        init_db()
        config.FILES_DIR.mkdir(parents=True, exist_ok=True)
        files = sorted(
            p for p in config.FILES_DIR.rglob("*") if p.is_file() and p.suffix.lower() == ".fit"
        )
        with _lock:
            _state["total"] = len(files)
        seen = set()
        for p in files:
            rp = str(p.resolve())
            seen.add(rp)
            with _lock:
                _state["current"] = p.name
            try:
                outcome = _index_one(p, force)
            except Exception as exc:
                outcome = "failed"
                with _lock:
                    _state["error"] = f"{p.name}: {exc}"
            with _lock:
                _state[outcome] = _state.get(outcome, 0) + 1
                _state["done"] += 1
        removed = _remove_missing(seen)
        with _lock:
            _state["removed"] = removed
    except Exception as exc:
        with _lock:
            _state["error"] = str(exc)
    finally:
        with _lock:
            _state["running"] = False
            _state["current"] = ""
            _state["finished_at"] = now_iso()


def _coarse_points(lat, lon, dist):
    valid = np.isfinite(lat) & np.isfinite(lon)
    idx = np.where(valid)[0]
    if idx.size == 0:
        return idx, 0.0
    d = dist[idx]
    dd = np.diff(d)
    dd = dd[np.isfinite(dd) & (dd > 0.5)]
    spacing = float(np.median(dd)) if dd.size else 10.0
    stride = max(1, int(round(config.COARSE_TARGET_GAP_M / max(spacing, 0.5))))
    keep = idx[::stride]
    if keep[-1] != idx[-1]:
        keep = np.append(keep, idx[-1])
    if keep.size > config.COARSE_MAX_POINTS:
        sub = max(1, int(np.ceil(keep.size / config.COARSE_MAX_POINTS)))
        keep2 = keep[::sub]
        if keep2[-1] != keep[-1]:
            keep2 = np.append(keep2, keep[-1])
        keep = keep2
    gaps = haversine(lat[keep[:-1]], lon[keep[:-1]], lat[keep[1:]], lon[keep[1:]])
    gap = float(np.nanmax(gaps)) if gaps.size else 0.0
    if not np.isfinite(gap):
        gap = 0.0
    return keep, gap


def _delete_coarse(conn, activity_id: int) -> None:
    old = [r[0] for r in conn.execute("SELECT id FROM coarse_points WHERE activity_id = ?", (activity_id,))]
    if old:
        conn.executemany("DELETE FROM coarse_rtree WHERE id = ?", [(i,) for i in old])
    conn.execute("DELETE FROM coarse_points WHERE activity_id = ?", (activity_id,))


def _index_one(path, force: bool) -> str:
    st = path.stat()
    rp = str(path.resolve())
    with db() as conn:
        row = conn.execute("SELECT id, mtime, size FROM activities WHERE path = ?", (rp,)).fetchone()
    if (
        row
        and not force
        and abs(row["mtime"] - st.st_mtime) < 1e-6
        and row["size"] == st.st_size
    ):
        return "skipped"

    try:
        data = parse_fit(path)
    except Exception as exc:
        with db() as conn:
            if row:
                conn.execute(
                    "UPDATE activities SET mtime=?, size=?, error=?, indexed_at=? WHERE id=?",
                    (st.st_mtime, st.st_size, str(exc), now_iso(), row["id"]),
                )
            else:
                conn.execute(
                    "INSERT INTO activities(path, filename, mtime, size, error, indexed_at) VALUES(?,?,?,?,?,?)",
                    (rp, path.name, st.st_mtime, st.st_size, str(exc), now_iso()),
                )
        raise

    lat, lon = data["lat"], data["lon"]
    valid = np.isfinite(lat) & np.isfinite(lon)
    has_gps = bool(valid.any())
    start_iso = data["start_time"].isoformat(timespec="seconds") if data["start_time"] else None
    has = {
        "has_gps": int(has_gps),
        "has_speed": int(np.isfinite(data["speed"]).any()),
        "has_hr": int(np.isfinite(data["hr"]).any()),
        "has_cadence": int(np.isfinite(data["cadence"]).any()),
        "has_power": int((np.isfinite(data["power"]) & (data["power"] > 0.0)).any()),
        "has_altitude": int(np.isfinite(data["alt"]).any()),
        "has_temp": int(np.isfinite(data["temp"]).any()),
    }
    bbox = (None, None, None, None)
    if has_gps:
        bbox = (
            float(np.min(lat[valid])),
            float(np.max(lat[valid])),
            float(np.min(lon[valid])),
            float(np.max(lon[valid])),
        )
    if has_gps:
        coarse_idx, coarse_gap = _coarse_points(lat, lon, data["dist"])
    else:
        coarse_idx, coarse_gap = np.array([], dtype=int), 0.0

    config.CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with db() as conn:
        if row:
            aid = row["id"]
            _delete_coarse(conn, aid)
            action = "updated"
        else:
            cur = conn.execute(
                "INSERT INTO activities(path, filename, mtime, size) VALUES(?,?,?,?)",
                (rp, path.name, st.st_mtime, st.st_size),
            )
            aid = cur.lastrowid
            action = "indexed"

        cache_file = f"{aid}.npz"
        np.savez_compressed(
            config.CACHE_DIR / cache_file,
            lat=lat,
            lon=lon,
            t=data["t"],
            dist=data["dist"],
            alt=data["alt"],
            speed=data["speed"],
            hr=data["hr"],
            cadence=data["cadence"],
            power=data["power"],
            temp=data["temp"],
        )

        for idx in coarse_idx:
            cur = conn.execute(
                "INSERT INTO coarse_points(activity_id, idx, lat, lon) VALUES(?,?,?,?)",
                (aid, int(idx), float(lat[idx]), float(lon[idx])),
            )
            conn.execute(
                "INSERT INTO coarse_rtree(id, min_lat, max_lat, min_lon, max_lon) VALUES(?,?,?,?,?)",
                (
                    cur.lastrowid,
                    float(lat[idx]),
                    float(lat[idx]),
                    float(lon[idx]),
                    float(lon[idx]),
                ),
            )

        conn.execute(
            """
            UPDATE activities SET
                filename=?, mtime=?, size=?, cache_file=?, start_time=?, sport=?,
                duration_s=?, distance_m=?, n_points=?, coarse_gap_m=?,
                has_gps=?, has_speed=?, has_hr=?, has_cadence=?, has_power=?,
                has_altitude=?, has_temp=?,
                min_lat=?, max_lat=?, min_lon=?, max_lon=?,
                indexed_at=?, error=NULL
            WHERE id=?
            """,
            (
                path.name,
                st.st_mtime,
                st.st_size,
                cache_file,
                start_iso,
                data["sport"],
                data["duration_s"],
                data["distance_m"],
                int(len(lat)),
                coarse_gap,
                has["has_gps"],
                has["has_speed"],
                has["has_hr"],
                has["has_cadence"],
                has["has_power"],
                has["has_altitude"],
                has["has_temp"],
                bbox[0],
                bbox[1],
                bbox[2],
                bbox[3],
                now_iso(),
                aid,
            ),
        )
    return action


def _remove_missing(seen: set) -> int:
    removed = 0
    with db() as conn:
        rows = conn.execute("SELECT id, path, cache_file FROM activities").fetchall()
        for row in rows:
            if row["path"] in seen:
                continue
            _delete_coarse(conn, row["id"])
            conn.execute("DELETE FROM activities WHERE id = ?", (row["id"],))
            if row["cache_file"]:
                try:
                    (config.CACHE_DIR / row["cache_file"]).unlink(missing_ok=True)
                except OSError:
                    pass
            removed += 1
    return removed


def serialize_activity(row) -> dict:
    d = {k: row[k] for k in row.keys()}
    d.pop("cache_file", None)
    d.pop("path", None)
    return d


def load_arrays(activity_id: int):
    with db() as conn:
        row = conn.execute("SELECT * FROM activities WHERE id = ?", (activity_id,)).fetchone()
    if row is None:
        raise KeyError("attività non trovata")
    if not row["cache_file"]:
        raise KeyError("dati non disponibili per questa attività")
    path = config.CACHE_DIR / row["cache_file"]
    if not path.exists():
        raise KeyError("cache mancante: esegui una nuova scansione")
    with np.load(path) as z:
        arrays = {k: z[k] for k in z.files}
    return row, arrays


def _clean(values, ndigits):
    out = []
    for v in values:
        fv = float(v)
        if not np.isfinite(fv):
            out.append(None)
        else:
            out.append(round(fv, ndigits))
    return out


def compute_gradient(alt, dist, window: float = 30.0):
    alt = np.asarray(alt, dtype=np.float64)
    dist = np.asarray(dist, dtype=np.float64)
    n = alt.size
    out = np.full(n, np.nan)
    if n < 2:
        return out
    valid = np.isfinite(alt) & np.isfinite(dist)
    if valid.sum() < 2:
        return out
    good = np.isfinite(alt)
    av = np.interp(np.arange(n), np.where(good)[0], alt[good])
    left = np.searchsorted(dist, dist - window, side="left")
    right = np.searchsorted(dist, dist + window, side="right") - 1
    left = np.clip(left, 0, n - 1)
    right = np.clip(right, 0, n - 1)
    span = dist[right] - dist[left]
    with np.errstate(invalid="ignore", divide="ignore"):
        grad = np.where(span > 1.0, (av[right] - av[left]) / np.maximum(span, 1e-6) * 100.0, np.nan)
    out[valid] = grad[valid]
    return out


def get_track(
    activity_id: int,
    from_idx=None,
    to_idx=None,
    fields=None,
    max_points=None,
    gradient: bool = False,
) -> dict:
    row, arr = load_arrays(activity_id)
    n = len(arr["lat"])
    a = 0 if from_idx is None else max(0, min(int(from_idx), n - 1))
    b = n - 1 if to_idx is None else max(a, min(int(to_idx), n - 1))
    idx = np.arange(a, b + 1)
    if max_points and idx.size > max_points:
        step = int(np.ceil(idx.size / max_points))
        idx = np.unique(np.concatenate([idx[::step], [b]]))
    lat = arr["lat"][idx]
    lon = arr["lon"][idx]
    t = arr["t"][idx]
    dist = arr["dist"][idx]
    base_dist = float(dist[0]) if dist.size else 0.0
    base_t = float(t[0]) if t.size else 0.0
    payload = {
        "activity": serialize_activity(row),
        "from_idx": int(idx[0]),
        "to_idx": int(idx[-1]),
        "n_total": n,
        "lat": _clean(lat, 6),
        "lon": _clean(lon, 6),
        "t": _clean(t - base_t, 2),
        "dist": _clean(dist - base_dist, 2),
        "dist_abs": _clean(dist, 2),
    }
    requested = set(fields or [])
    if gradient:
        requested.add("gradient")
    for name in requested:
        if name == "gradient":
            payload["gradient"] = _clean(compute_gradient(arr["alt"][idx], dist), 2)
        elif name == "altitude":
            payload["altitude"] = _clean(arr["alt"][idx], 2)
        elif name in ("speed", "hr", "cadence", "power", "temp"):
            payload[name] = _clean(arr[name][idx], 2)
    return payload
