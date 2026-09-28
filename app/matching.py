from __future__ import annotations

import numpy as np

from . import config
from .db import db
from .geo import angle_diff, bearing, dist_to_point
from .indexing import load_arrays

STRATEGIES = ("endpoints", "overlap", "both")

DEFAULT_PARAMS = {
    "strategy": "endpoints",
    "tolerance_m": config.TOLERANCE_M,
    "direction": "same",
    "coverage_min": config.COVERAGE_MIN,
    "max_gap_factor": config.MAX_GAP_FACTOR,
    "length_tol": config.LENGTH_TOL,
    "same_sport": True,
    "check_heading": True,
    "heading_tol_deg": config.HEADING_TOL_DEG,
}

SPORT_GROUPS = {
    "running": {"running", "run", "trail_running", "treadmill_running", "track_running", "corsa"},
    "cycling": {
        "cycling", "bike", "biking", "road_biking", "mountain_biking", "gravel_cycling",
        "virtual_ride", "indoor_cycling", "e_bike_fitness", "e_bike_mountain", "commuting",
        "bici", "ciclismo indoor", "ciclismo virtuale",
    },
    "walking": {"walking", "casual_walking", "speed_walking", "camminata"},
    "hiking": {"hiking", "mountaineering", "escursionismo", "alpinismo"},
    "swimming": {"swimming", "lap_swimming", "open_water_swimming", "nuoto"},
}


def sport_values(sport) -> list[str] | None:
    s = (sport or "").strip().lower()
    if not s:
        return None
    for group in SPORT_GROUPS.values():
        if s in group:
            return sorted(group)
    return [s]



class SegmentError(ValueError):
    pass


def normalize_params(params) -> dict:
    p = dict(DEFAULT_PARAMS)
    if params:
        for key in DEFAULT_PARAMS:
            if key in params and params[key] is not None:
                p[key] = params[key]
    p["strategy"] = str(p["strategy"])
    if p["strategy"] not in STRATEGIES:
        raise SegmentError("strategia non valida")
    p["tolerance_m"] = float(p["tolerance_m"])
    if not (1.0 <= p["tolerance_m"] <= 500.0):
        raise SegmentError("tolleranza fuori range (1-500 m)")
    p["direction"] = str(p["direction"])
    if p["direction"] not in ("same", "both"):
        raise SegmentError("direzione non valida")
    p["coverage_min"] = float(p["coverage_min"])
    if p["coverage_min"] > 1.0:
        p["coverage_min"] = p["coverage_min"] / 100.0
    if not (0.05 <= p["coverage_min"] <= 1.0):
        raise SegmentError("coverage minima fuori range (5-100%)")
    p["max_gap_factor"] = float(p["max_gap_factor"])
    if p["max_gap_factor"] < 1.0:
        raise SegmentError("fattore gap non valido")
    p["length_tol"] = float(p["length_tol"])
    if not (0.05 <= p["length_tol"] <= 0.75):
        raise SegmentError("scarto lunghezza fuori range (5-75%)")
    p["same_sport"] = bool(p["same_sport"])
    p["check_heading"] = bool(p["check_heading"])
    p["heading_tol_deg"] = float(p["heading_tol_deg"])
    return p


def _heading(arr, i: int, forward: bool = True, look_m: float = 15.0):
    lat = arr["lat"]
    lon = arr["lon"]
    dist = arr["dist"]
    n = len(lat)
    if n < 2 or i < 0 or i >= n:
        return None
    if not (np.isfinite(lat[i]) and np.isfinite(lon[i])):
        return None
    if forward:
        j = i
        limit = min(n - 1, i + 2000)
        while j < limit and (
            not np.isfinite(lat[j]) or not np.isfinite(lon[j]) or dist[j] - dist[i] < look_m
        ):
            j += 1
        if j == i or j >= n or not np.isfinite(lat[j]) or not np.isfinite(lon[j]):
            return None
        if dist[j] - dist[i] < look_m * 0.2:
            return None
        return float(bearing(lat[i], lon[i], lat[j], lon[j]))
    j = i
    limit = max(0, i - 2000)
    while j > limit and (
        not np.isfinite(lat[j]) or not np.isfinite(lon[j]) or dist[i] - dist[j] < look_m
    ):
        j -= 1
    if j == i or j < 0 or not np.isfinite(lat[j]) or not np.isfinite(lon[j]):
        return None
    if dist[i] - dist[j] < look_m * 0.2:
        return None
    return float(bearing(lat[j], lon[j], lat[i], lon[i]))


def _find_endpoint_passes(arr, start_pt, end_pt, p, ref_len, ref_h_start, ref_h_end, max_passes=20):
    lat = arr["lat"]
    lon = arr["lon"]
    dist = arr["dist"]
    t = arr["t"]
    tol = p["tolerance_m"]
    d_s = dist_to_point(lat, lon, start_pt[0], start_pt[1])
    d_e = dist_to_point(lat, lon, end_pt[0], end_pt[1])
    cand_s = np.where(d_s <= tol)[0]
    cand_e = np.where(d_e <= tol)[0]
    if cand_s.size == 0 or cand_e.size == 0:
        return []
    cand_s = cand_s[np.argsort(d_s[cand_s])][:40]
    cand_e = cand_e[np.argsort(d_e[cand_e])][:40]
    same = p["direction"] == "same"
    lo_gap = max(0.5, 1.0 - p["length_tol"]) * ref_len
    hi_gap = min(p["max_gap_factor"], 1.0 + p["length_tol"]) * ref_len
    heading_fwd = {}
    heading_bwd = {}

    def h_at(idx, forward):
        cache = heading_fwd if forward else heading_bwd
        if idx not in cache:
            cache[idx] = _heading(arr, idx, forward=forward)
        return cache[idx]

    pairs = []
    for s in cand_s:
        for e in cand_e:
            if same:
                if e <= s:
                    continue
                gap = float(dist[e] - dist[s])
            else:
                if e == s:
                    continue
                gap = float(abs(dist[e] - dist[s]))
            if gap < lo_gap or gap > hi_gap:
                continue
            if same:
                if t[e] <= t[s]:
                    continue
            elif t[e] == t[s]:
                continue
            if p["check_heading"] and ref_h_start is not None and ref_h_end is not None:
                hs = h_at(int(s), True)
                he = h_at(int(e), False)
                if hs is None or he is None:
                    continue
                if same:
                    if angle_diff(hs, ref_h_start) > p["heading_tol_deg"]:
                        continue
                    if angle_diff(he, ref_h_end) > p["heading_tol_deg"]:
                        continue
                else:
                    d1 = min(angle_diff(hs, ref_h_start), angle_diff(hs, (ref_h_start + 180.0) % 360.0))
                    d2 = min(angle_diff(he, ref_h_end), angle_diff(he, (ref_h_end + 180.0) % 360.0))
                    if d1 > p["heading_tol_deg"] or d2 > p["heading_tol_deg"]:
                        continue
            if same or e > s:
                win_s, win_e, rev = int(s), int(e), False
            else:
                win_s, win_e, rev = int(e), int(s), True
            pairs.append(
                {
                    "score": float(d_s[s]) + float(d_e[e]),
                    "start_idx": win_s,
                    "end_idx": win_e,
                    "reversed": rev,
                    "d_start_m": float(d_s[s]),
                    "d_end_m": float(d_e[e]),
                }
            )
    if not pairs:
        return []
    pairs.sort(key=lambda x: x["score"])
    chosen = []
    for cand in pairs:
        a, b = cand["start_idx"], cand["end_idx"]
        overlap = False
        for c in chosen:
            if not (b < c["start_idx"] or a > c["end_idx"]):
                overlap = True
                break
        if overlap:
            continue
        chosen.append(cand)
        if len(chosen) >= max_passes:
            break
    chosen.sort(key=lambda x: x["start_idx"])
    return chosen


def _find_endpoint_pass(arr, start_pt, end_pt, p, ref_len, ref_h_start, ref_h_end):
    passes = _find_endpoint_passes(arr, start_pt, end_pt, p, ref_len, ref_h_start, ref_h_end)
    return passes[0] if passes else None


def _coverage(arr, ref_lat, ref_lon, tol):
    lat = arr["lat"]
    lon = arr["lon"]
    valid = np.isfinite(lat) & np.isfinite(lon)
    idxv = np.where(valid)[0]
    if idxv.size < 2 or ref_lat.size < 2:
        return 0.0, None
    latv = lat[idxv].astype(np.float64)
    lonv = lon[idxv].astype(np.float64)
    lat0 = float(np.mean(ref_lat))
    lon0 = float(np.mean(ref_lon))
    kx = np.cos(np.radians(lat0)) * 6371008.8
    ky = 6371008.8
    xr = (np.radians(ref_lon - lon0) * kx).astype(np.float32)
    yr = (np.radians(ref_lat - lat0) * ky).astype(np.float32)
    xc = (np.radians(lonv - lon0) * kx).astype(np.float32)
    yc = (np.radians(latv - lat0) * ky).astype(np.float32)
    m = ref_lat.size
    mins = np.empty(m, dtype=np.float32)
    bestj = np.empty(m, dtype=np.int64)
    chunk = 64
    for start in range(0, m, chunk):
        stop = min(start + chunk, m)
        dx = xr[start:stop, None] - xc[None, :]
        dy = yr[start:stop, None] - yc[None, :]
        d2 = dx * dx + dy * dy
        j = np.argmin(d2, axis=1)
        mins[start:stop] = np.sqrt(d2[np.arange(stop - start), j])
        bestj[start:stop] = j
    matched = mins <= tol
    coverage = float(matched.mean())
    if not matched.any():
        return coverage, None
    js = bestj[matched]
    return coverage, (int(idxv[js.min()]), int(idxv[js.max()]))


def _prefilter(conn, start_pt, end_pt, refs, tol, strategy, sport=None, same_sport=True):
    max_gap = conn.execute(
        "SELECT COALESCE(MAX(coarse_gap_m), 0) FROM activities WHERE error IS NULL"
    ).fetchone()[0] or 0.0
    radius = tol + float(max_gap)

    sport_vals = sport_values(sport) if same_sport else None
    sport_sql = ""
    sport_args: tuple = ()
    if sport_vals:
        ph = ",".join("?" * len(sport_vals))
        sport_sql = f" AND LOWER(COALESCE(a.sport, '')) IN ({ph})"
        sport_args = tuple(sport_vals)

    def box(lat, lon):
        dlat = radius / 111320.0
        coslat = max(0.05, float(np.cos(np.radians(lat))))
        dlon = radius / (111320.0 * coslat)
        rows = conn.execute(
            "SELECT DISTINCT cp.activity_id FROM coarse_rtree rt "
            "JOIN coarse_points cp ON cp.id = rt.id "
            "JOIN activities a ON a.id = cp.activity_id "
            "WHERE rt.min_lat >= ? AND rt.min_lat <= ? AND rt.min_lon >= ? AND rt.min_lon <= ?"
            + sport_sql,
            (lat - dlat, lat + dlat, lon - dlon, lon + dlon, *sport_args),
        ).fetchall()
        return {r[0] for r in rows}

    if strategy in ("endpoints", "both"):
        ids = box(*start_pt) & box(*end_pt)
    else:
        ref_lat, ref_lon = refs
        lat_c = float(np.mean(ref_lat))
        dlat = radius / 111320.0
        coslat = max(0.05, float(np.cos(np.radians(lat_c))))
        dlon = radius / (111320.0 * coslat)
        rows = conn.execute(
            "SELECT DISTINCT cp.activity_id FROM coarse_rtree rt "
            "JOIN coarse_points cp ON cp.id = rt.id "
            "JOIN activities a ON a.id = cp.activity_id "
            "WHERE rt.min_lat >= ? AND rt.min_lat <= ? AND rt.min_lon >= ? AND rt.min_lon <= ?"
            + sport_sql,
            (
                float(np.min(ref_lat)) - dlat,
                float(np.max(ref_lat)) + dlat,
                float(np.min(ref_lon)) - dlon,
                float(np.max(ref_lon)) + dlon,
                *sport_args,
            ),
        ).fetchall()
        ids = {r[0] for r in rows}

    if not ids:
        return []
    ids = list(ids)

    if strategy in ("endpoints", "both") and len(ids) <= 5000:
        gaps = {
            r["id"]: (r["coarse_gap_m"] or 0.0)
            for r in conn.execute(
                "SELECT id, coarse_gap_m FROM activities WHERE id IN (%s)" % ",".join("?" * len(ids)),
                ids,
            )
        }
        ph = ",".join("?" * len(ids))
        rows = conn.execute(
            f"SELECT activity_id, lat, lon FROM coarse_points WHERE activity_id IN ({ph})", ids
        ).fetchall()
        if rows:
            arr_id = np.array([r[0] for r in rows])
            arr_lat = np.array([r[1] for r in rows])
            arr_lon = np.array([r[2] for r in rows])
            keep = []
            for cid in ids:
                m = arr_id == cid
                if not m.any():
                    continue
                limit = tol + gaps.get(cid, 0.0)
                d1 = dist_to_point(arr_lat[m], arr_lon[m], start_pt[0], start_pt[1])
                if float(np.min(d1)) > limit:
                    continue
                d2 = dist_to_point(arr_lat[m], arr_lon[m], end_pt[0], end_pt[1])
                if float(np.min(d2)) > limit:
                    continue
                keep.append(cid)
            ids = keep
    return ids


def search(activity_id: int, start_idx: int, end_idx: int, params=None) -> dict:
    p = normalize_params(params)
    row, arr = load_arrays(activity_id)
    n = len(arr["lat"])
    start_idx = max(0, min(int(start_idx), n - 1))
    end_idx = max(0, min(int(end_idx), n - 1))
    if start_idx > end_idx:
        start_idx, end_idx = end_idx, start_idx

    lat = arr["lat"][start_idx : end_idx + 1]
    lon = arr["lon"][start_idx : end_idx + 1]
    dist = arr["dist"][start_idx : end_idx + 1]
    t = arr["t"][start_idx : end_idx + 1]
    valid = np.isfinite(lat) & np.isfinite(lon)
    if valid.sum() < 2:
        raise SegmentError("il segmento selezionato non contiene abbastanza punti GPS")
    first = int(np.argmax(valid))
    last = int(len(valid) - 1 - np.argmax(valid[::-1]))
    ref_lat = lat[first : last + 1]
    ref_lon = lon[first : last + 1]
    ref_dist = dist[first : last + 1] - dist[first]
    ref_len = float(ref_dist[-1])
    if ref_len < config.MIN_SEGMENT_LEN_M:
        raise SegmentError(f"segmento troppo corto ({ref_len:.0f} m): allungalo")
    start_pt = (float(lat[first]), float(lon[first]))
    end_pt = (float(lat[last]), float(lon[last]))
    ref_h_start = _heading(arr, start_idx + first, forward=True)
    ref_h_end = _heading(arr, start_idx + last, forward=False)

    segment = {
        "activity_id": activity_id,
        "filename": row["filename"],
        "name": row["name"] or row["filename"],
        "start_idx": start_idx + first,
        "end_idx": start_idx + last,
        "length_m": round(ref_len, 1),
        "start": [start_pt[0], start_pt[1]],
        "end": [end_pt[0], end_pt[1]],
        "ref_heading": None if ref_h_start is None else round(ref_h_start, 1),
        "ref_duration_s": round(float(t[last] - t[first]), 2),
    }

    with db() as conn:
        candidates = _prefilter(
            conn,
            start_pt,
            end_pt,
            (ref_lat, ref_lon),
            p["tolerance_m"],
            p["strategy"],
            row["sport"],
            p["same_sport"],
        )

    results = []
    scanned = 0
    for cid in candidates:
        try:
            crow, carr = load_arrays(cid)
        except KeyError:
            continue
        scanned += 1
        passes = []
        coverage = None
        window = None
        if p["strategy"] in ("endpoints", "both"):
            passes = _find_endpoint_passes(carr, start_pt, end_pt, p, ref_len, ref_h_start, ref_h_end)
            if not passes:
                continue
        if p["strategy"] in ("overlap", "both"):
            coverage, window = _coverage(carr, ref_lat, ref_lon, p["tolerance_m"])
            if coverage < p["coverage_min"]:
                continue
        if not passes:
            relaxed = dict(p)
            relaxed["max_gap_factor"] = max(p["max_gap_factor"], 1000.0)
            relaxed["check_heading"] = False
            passes = _find_endpoint_passes(carr, start_pt, end_pt, relaxed, ref_len, None, None)
            if not passes and p["direction"] == "both" and window is not None:
                s, e = window
                passes = [
                    {"start_idx": s, "end_idx": e, "reversed": False, "d_start_m": None, "d_end_m": None}
                ]
            if not passes:
                continue
        for info in passes:
            s, e = info["start_idx"], info["end_idx"]
            d_start, d_end = info["d_start_m"], info["d_end_m"]
            reversed_pass = info.get("reversed", False)
            dur = float(carr["t"][e] - carr["t"][s])
            if dur <= 0:
                continue
            seg_dist = float(abs(carr["dist"][e] - carr["dist"][s]))
            avg_speed = seg_dist / dur if dur > 0 else None
            hr = carr["hr"][s : e + 1]
            avg_hr = float(np.nanmean(hr)) if np.isfinite(hr).any() else None
            results.append(
                {
                    "activity_id": cid,
                    "filename": crow["filename"],
                    "name": crow["name"] or crow["filename"],
                    "start_time": crow["start_time"],
                    "sport": crow["sport"],
                    "activity_distance_m": crow["distance_m"],
                    "pass_start_idx": s,
                    "pass_end_idx": e,
                    "duration_s": round(dur, 2),
                    "segment_distance_m": round(seg_dist, 1),
                    "avg_speed_mps": None if avg_speed is None else round(avg_speed, 3),
                    "avg_hr": None if avg_hr is None else round(avg_hr, 1),
                    "coverage": None if coverage is None else round(coverage, 4),
                    "d_start_m": None if d_start is None else round(d_start, 1),
                    "d_end_m": None if d_end is None else round(d_end, 1),
                    "reversed": reversed_pass,
                    "is_source": cid == activity_id,
                }
            )

    results.sort(key=lambda r: (r["duration_s"], r["activity_id"], r["pass_start_idx"]))
    groups = {}
    for r in results:
        groups.setdefault(r["activity_id"], []).append(r)
    for lst in groups.values():
        lst.sort(key=lambda r: r["pass_start_idx"])
        best = min(lst, key=lambda r: r["duration_s"])
        for i, r in enumerate(lst):
            r["pass_number"] = i + 1
            r["pass_count"] = len(lst)
            r["is_activity_best"] = r is best
    for i, r in enumerate(results):
        r["is_best"] = i == 0

    return {
        "segment": segment,
        "params": p,
        "candidates": len(candidates),
        "scanned": scanned,
        "results": results,
    }
