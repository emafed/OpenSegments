from __future__ import annotations

import math
from datetime import datetime, timezone

import fitparse
import numpy as np

from .geo import cumulative_distances

SEMICIRCLE_TO_DEG = 180.0 / (2 ** 31)

POWER_KEYS = ("power", "rp_power", "running_power", "real_power", "power_watts", "watts")

POWER_EXCLUDE = (
    "phase", "accumulated", "avg", "max", "min", "normalized", "threshold",
    "stress", "balance", "position", "smoothness", "torque", "work", "lap",
)

SPORT_NAMES = {
    0: "generico",
    1: "corsa",
    2: "bici",
    3: "transizione",
    4: "nuoto",
    5: "basket",
    6: "calcio",
    7: "tennis",
    8: "alpinismo",
    9: "escursionismo",
    10: "yoga",
    11: "pesi",
    12: "canoa",
    13: "remo",
    14: "pattinaggio",
    15: "arrampicata",
    16: "ciclismo indoor",
    17: "pattini in linea",
    18: "sci alpino",
    19: "snowboard",
    20: "equitazione",
    21: "golf",
    22: "deltaplano",
    23: "hockey",
    24: "caccia",
    25: "kayak",
    26: "kitesurf",
    27: "orienteering",
    28: "polo",
    29: "rugby",
    30: "vela",
    31: "tiro",
    32: "pattinaggio su ghiaccio",
    33: "sci di fondo",
    34: "sci",
    35: "corda",
    36: "surf",
    37: "ping pong",
    38: "pallavolo",
    39: "camminata",
    41: "wakeboard",
    42: "ginnastica",
    44: "ciclismo virtuale",
    46: "corsa",
    47: "bici",
    48: "bici",
    49: "bici",
    50: "bici",
    51: "bici",
    52: "bici",
    53: "bici",
    254: "tutti",
}


def _num(value):
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return v


def _semicircles(value):
    v = _num(value)
    if v is None:
        return None
    if abs(v) > 90.0:
        v = v * SEMICIRCLE_TO_DEG
    if not (-90.0 <= v <= 90.0):
        return None
    return v


def _power_value(values: dict):
    lowered = {str(k).lower(): v for k, v in values.items()}
    for key in POWER_KEYS:
        if key in lowered:
            n = _num(lowered[key])
            if n is not None:
                return n
    for name, val in lowered.items():
        if "power" not in name:
            continue
        if any(bad in name for bad in POWER_EXCLUDE):
            continue
        n = _num(val)
        if n is not None:
            return n
    return None


def _sport_name(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        code = int(value)
    except (TypeError, ValueError):
        return None
    return SPORT_NAMES.get(code, f"sport {code}")


def _as_utc(value):
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _resample_1s(arrays: dict) -> dict:
    t = np.asarray(arrays["t"], dtype=np.float64)
    n = t.size
    if n < 2:
        return {}
    dt = np.diff(t)
    if dt.size and np.allclose(dt, 1.0, atol=0.05) and abs(float(t[0])) < 0.05:
        return {}
    duration = float(t[-1])
    if duration <= 0:
        return {}
    grid = np.arange(0.0, math.floor(duration) + 1.0, 1.0)
    out = {"t": grid}
    for key in ("lat", "lon", "alt", "speed", "hr", "cadence", "power", "temp", "dist"):
        arr = np.asarray(arrays[key], dtype=np.float64)
        valid = np.isfinite(arr)
        if valid.sum() < 2:
            out[key] = np.full(grid.size, np.nan)
            continue
        tv = t[valid]
        vv = arr[valid]
        uniq, idx = np.unique(tv, return_index=True)
        tv = uniq
        vv = vv[idx]
        out[key] = np.interp(grid, tv, vv)
        if key in ("lat", "lon"):
            pos = np.searchsorted(tv, grid)
            left = np.clip(pos - 1, 0, tv.size - 1)
            right = np.clip(pos, 0, tv.size - 1)
            gap = np.minimum(np.abs(grid - tv[left]), np.abs(tv[right] - grid))
            out[key][gap > 10.0] = np.nan
    dist = out["dist"]
    good = np.isfinite(dist)
    if good.any():
        filled = np.interp(np.arange(dist.size), np.where(good)[0], dist[good])
        out["dist"] = np.maximum.accumulate(filled)
    return out


def parse_fit(path) -> dict:
    fit = fitparse.FitFile(str(path))
    records = list(fit.get_messages("record"))
    if not records:
        raise ValueError("il file non contiene record di traccia")
    n = len(records)
    lat = np.full(n, np.nan)
    lon = np.full(n, np.nan)
    alt = np.full(n, np.nan)
    speed = np.full(n, np.nan)
    hr = np.full(n, np.nan)
    cadence = np.full(n, np.nan)
    power = np.full(n, np.nan)
    temp = np.full(n, np.nan)
    dist = np.full(n, np.nan)
    raw_times: list[datetime | None] = [None] * n

    for i, msg in enumerate(records):
        v = msg.get_values()
        plat = _semicircles(v.get("position_lat"))
        plon = _semicircles(v.get("position_long"))
        lat[i] = plat if plat is not None else np.nan
        lon[i] = plon if plon is not None else np.nan

        a = _num(v.get("enhanced_altitude"))
        if a is None:
            a = _num(v.get("altitude"))
        alt[i] = a if a is not None else np.nan

        s = _num(v.get("enhanced_speed"))
        if s is None:
            s = _num(v.get("speed"))
        speed[i] = s if s is not None else np.nan

        h = _num(v.get("heart_rate"))
        hr[i] = h if h is not None else np.nan
        c = _num(v.get("cadence"))
        cadence[i] = c if c is not None else np.nan
        p = _power_value(v)
        power[i] = p if p is not None else np.nan
        tp = _num(v.get("temperature"))
        temp[i] = tp if tp is not None else np.nan
        d = _num(v.get("distance"))
        dist[i] = d if d is not None else np.nan

        ts = _as_utc(v.get("timestamp"))
        if ts is not None:
            raw_times[i] = ts

    known = [t for t in raw_times if t is not None]
    if known:
        base = min(known)
        t = np.full(n, np.nan)
        for i, ts in enumerate(raw_times):
            if ts is not None:
                t[i] = (ts - base).total_seconds()
        good = np.isfinite(t)
        if good.sum() >= 2:
            t = np.interp(np.arange(n), np.where(good)[0], t[good])
        else:
            t = np.arange(n, dtype=float)
        start_time = base
    else:
        t = np.arange(n, dtype=float)
        start_time = None

    sessions = list(fit.get_messages("session"))
    session = sessions[0].get_values() if sessions else {}
    if start_time is None:
        start_time = _as_utc(session.get("start_time"))

    cum = cumulative_distances(lat, lon)
    distance_m = _num(session.get("total_distance"))
    if distance_m is None or distance_m <= 0:
        distance_m = float(cum[-1]) if n else 0.0
    duration_s = _num(session.get("total_elapsed_time"))
    if duration_s is None:
        duration_s = _num(session.get("total_timer_time"))
    if duration_s is None or duration_s <= 0:
        duration_s = float(t[-1]) if n else 0.0

    result = {
        "lat": lat,
        "lon": lon,
        "alt": alt,
        "speed": speed,
        "hr": hr,
        "cadence": cadence,
        "power": power,
        "temp": temp,
        "t": t,
        "dist": cum,
        "start_time": start_time,
        "sport": _sport_name(session.get("sport")),
        "distance_m": float(distance_m),
        "duration_s": float(duration_s),
    }
    result.update(_resample_1s(result))
    return result
