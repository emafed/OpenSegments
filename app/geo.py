from __future__ import annotations

import math

import numpy as np

EARTH_R = 6371008.8


def haversine(lat1, lon1, lat2, lon2):
    lat1 = np.asarray(lat1, dtype=np.float64)
    lon1 = np.asarray(lon1, dtype=np.float64)
    lat2 = np.asarray(lat2, dtype=np.float64)
    lon2 = np.asarray(lon2, dtype=np.float64)
    p1 = np.radians(lat1)
    p2 = np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(lon2 - lon1)
    a = np.sin(dp / 2.0) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2.0) ** 2
    return 2.0 * EARTH_R * np.arcsin(np.minimum(1.0, np.sqrt(a)))


def cumulative_distances(lat, lon):
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    n = lat.size
    out = np.zeros(n)
    valid = np.isfinite(lat) & np.isfinite(lon)
    idx = np.where(valid)[0]
    if idx.size < 2:
        return out
    d = haversine(lat[idx[:-1]], lon[idx[:-1]], lat[idx[1:]], lon[idx[1:]])
    seg = np.zeros(n)
    seg[idx[1:]] = np.nan_to_num(d, nan=0.0)
    return np.cumsum(seg)


def dist_to_point(lat, lon, plat, plon):
    lat = np.asarray(lat, dtype=np.float64)
    lon = np.asarray(lon, dtype=np.float64)
    x = np.radians(lon - plon) * math.cos(math.radians(plat)) * EARTH_R
    y = np.radians(lat - plat) * EARTH_R
    d = np.hypot(x, y)
    d[~(np.isfinite(lat) & np.isfinite(lon))] = np.inf
    return d


def bearing(lat1, lon1, lat2, lon2):
    p1 = np.radians(np.asarray(lat1, dtype=np.float64))
    p2 = np.radians(np.asarray(lat2, dtype=np.float64))
    dl = np.radians(np.asarray(lon2, dtype=np.float64) - np.asarray(lon1, dtype=np.float64))
    y = np.sin(dl) * np.cos(p2)
    x = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return (np.degrees(np.arctan2(y, x)) + 360.0) % 360.0


def angle_diff(a, b):
    d = np.abs(np.asarray(a, dtype=np.float64) - np.asarray(b, dtype=np.float64)) % 360.0
    return np.minimum(d, 360.0 - d)
