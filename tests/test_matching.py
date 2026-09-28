import math
import pathlib

import numpy as np
import pytest

from app import config, indexing
from app.db import db, init_db
from app.matching import (
    _coverage,
    _find_endpoint_pass,
    _find_endpoint_passes,
    normalize_params,
    search,
    sport_values,
)


def make_track(n=1000, step_m=10.0, heading_deg=90.0, speed_mps=10.0):
    lat0, lon0 = 45.0, 9.0
    h = math.radians(heading_deg)
    dx = math.sin(h) * step_m
    dy = math.cos(h) * step_m
    lat = lat0 + np.cumsum(np.full(n, dy)) / 111320.0
    lon = lon0 + np.cumsum(np.full(n, dx)) / (111320.0 * math.cos(math.radians(lat0)))
    return {
        "lat": lat,
        "lon": lon,
        "dist": np.arange(n) * step_m,
        "t": np.arange(n) * (step_m / speed_mps),
        "hr": np.full(n, 140.0),
    }


def test_endpoint_pass_forward():
    arr = make_track()
    p = normalize_params({"strategy": "endpoints", "direction": "same", "check_heading": True})
    start_pt = (arr["lat"][100], arr["lon"][100])
    end_pt = (arr["lat"][600], arr["lon"][600])
    info = _find_endpoint_pass(arr, start_pt, end_pt, p, 5000.0, 90.0, 90.0)
    assert info is not None
    assert abs(info["start_idx"] - 100) <= 1
    assert abs(info["end_idx"] - 600) <= 1
    assert info["reversed"] is False
    assert info["d_start_m"] < 1.0


def test_endpoint_pass_wrong_direction():
    arr = make_track()
    p_same = normalize_params({"strategy": "endpoints", "direction": "same"})
    start_pt = (arr["lat"][600], arr["lon"][600])
    end_pt = (arr["lat"][100], arr["lon"][100])
    assert _find_endpoint_pass(arr, start_pt, end_pt, p_same, 5000.0, 270.0, 270.0) is None
    p_both = normalize_params({"strategy": "endpoints", "direction": "both"})
    info = _find_endpoint_pass(arr, start_pt, end_pt, p_both, 5000.0, None, None)
    assert info is not None
    assert info["reversed"] is True
    assert info["start_idx"] == 100
    assert info["end_idx"] == 600


def test_endpoint_pass_gap_bounds():
    arr = make_track()
    p = normalize_params({"strategy": "endpoints", "direction": "same", "check_heading": False})
    start_pt = (arr["lat"][100], arr["lon"][100])
    end_pt = (arr["lat"][110], arr["lon"][110])
    assert _find_endpoint_pass(arr, start_pt, end_pt, p, 5000.0, None, None) is None


def test_endpoint_pass_length_tolerance():
    arr = make_track()
    p = normalize_params({"strategy": "endpoints", "check_heading": False})
    start_pt = (arr["lat"][100], arr["lon"][100])
    end_pt = (arr["lat"][600], arr["lon"][600])
    assert _find_endpoint_pass(arr, start_pt, end_pt, p, 5000.0, None, None) is not None
    assert _find_endpoint_pass(arr, start_pt, end_pt, p, 10000.0, None, None) is None
    strict = normalize_params({"strategy": "endpoints", "check_heading": False, "length_tol": 0.1})
    assert _find_endpoint_pass(arr, start_pt, end_pt, strict, 6500.0, None, None) is None


def test_sport_values_grouping():
    assert "running" in sport_values("corsa")
    assert "corsa" in sport_values("running")
    assert "bici" in sport_values("cycling")
    assert "cycling" in sport_values("bici")
    assert sport_values(None) is None
    assert sport_values("pallavolo") == ["pallavolo"]


def test_coverage_full_and_partial():
    arr = make_track()
    ref_lat = arr["lat"][100:601]
    ref_lon = arr["lon"][100:601]
    cov, window = _coverage(arr, ref_lat, ref_lon, 25.0)
    assert cov > 0.99
    assert window is not None
    ref_lat2 = np.concatenate([ref_lat, arr["lat"][-1] + np.linspace(0.001, 0.01, 50)])
    ref_lon2 = np.concatenate([ref_lon, np.full(50, arr["lon"][-1])])
    cov2, _ = _coverage(arr, ref_lat2, ref_lon2, 25.0)
    assert 0.8 < cov2 < 1.0


def test_coverage_geometric_ignores_direction():
    arr = make_track()
    ref_lat = arr["lat"][100:601][::-1]
    ref_lon = arr["lon"][100:601][::-1]
    cov, window = _coverage(arr, ref_lat, ref_lon, 25.0)
    assert cov > 0.99
    assert window is not None


def test_single_traversal_no_duplicates():
    arr = make_track()
    p = normalize_params({"strategy": "endpoints", "direction": "same", "check_heading": True})
    start_pt = (arr["lat"][100], arr["lon"][100])
    end_pt = (arr["lat"][600], arr["lon"][600])
    passes = _find_endpoint_passes(arr, start_pt, end_pt, p, 5000.0, 90.0, 90.0)
    assert len(passes) == 1
    assert abs(passes[0]["start_idx"] - 100) <= 1
    assert abs(passes[0]["end_idx"] - 600) <= 1


def test_multiple_passes_out_and_back():
    out = make_track(n=1000, step_m=10.0, heading_deg=90.0)
    back = make_track(n=1000, step_m=10.0, heading_deg=270.0)
    back_lat = back["lat"] - back["lat"][0] + out["lat"][-1]
    back_lon = back["lon"] - back["lon"][0] + out["lon"][-1]
    n = 2000
    arr = {
        "lat": np.concatenate([out["lat"], back_lat]),
        "lon": np.concatenate([out["lon"], back_lon]),
        "dist": np.arange(n) * 10.0,
        "t": np.arange(n) * 1.0,
        "hr": np.full(n, 140.0),
    }
    start_pt = (arr["lat"][100], arr["lon"][100])
    end_pt = (arr["lat"][600], arr["lon"][600])

    p_both = normalize_params({"strategy": "endpoints", "direction": "both", "check_heading": True})
    passes = _find_endpoint_passes(arr, start_pt, end_pt, p_both, 5000.0, 90.0, 90.0)
    assert len(passes) == 2
    fwd = [x for x in passes if not x["reversed"]]
    rev = [x for x in passes if x["reversed"]]
    assert len(fwd) == 1
    assert len(rev) == 1
    assert abs(fwd[0]["start_idx"] - 100) <= 1
    assert abs(fwd[0]["end_idx"] - 600) <= 1
    assert abs(rev[0]["start_idx"] - 1399) <= 2
    assert abs(rev[0]["end_idx"] - 1899) <= 2

    p_same = normalize_params({"strategy": "endpoints", "direction": "same", "check_heading": True})
    passes_same = _find_endpoint_passes(arr, start_pt, end_pt, p_same, 5000.0, 90.0, 90.0)
    assert len(passes_same) == 1
    assert not passes_same[0]["reversed"]


def test_double_out_and_back_same_direction_two_passes():
    n = 1000
    step = 10.0
    east = np.arange(n) * step
    west = east[::-1]
    xs = np.concatenate([east, west, east, west])
    total = xs.size
    lat0, lon0 = 45.0, 9.0
    lat = np.full(total, lat0)
    lon = lon0 + xs / (111320.0 * math.cos(math.radians(lat0)))
    dist = np.cumsum(np.concatenate([[0.0], np.abs(np.diff(xs))]))
    arr = {
        "lat": lat,
        "lon": lon,
        "dist": dist,
        "t": np.arange(total) * 1.0,
        "hr": np.full(total, 140.0),
    }
    start_pt = (lat[100], lon[100])
    end_pt = (lat[600], lon[600])

    p_same = normalize_params({"strategy": "endpoints", "direction": "same", "check_heading": True})
    passes = _find_endpoint_passes(arr, start_pt, end_pt, p_same, 5000.0, 90.0, 90.0)
    assert len(passes) == 2
    assert all(not x["reversed"] for x in passes)
    assert passes[0]["start_idx"] == 100
    assert passes[0]["end_idx"] == 600
    assert passes[1]["start_idx"] == 2100
    assert passes[1]["end_idx"] == 2600

    p_both = normalize_params({"strategy": "endpoints", "direction": "both", "check_heading": True})
    passes_both = _find_endpoint_passes(arr, start_pt, end_pt, p_both, 5000.0, 90.0, 90.0)
    assert len(passes_both) == 4
    assert sum(1 for x in passes_both if x["reversed"]) == 2
    assert sum(1 for x in passes_both if not x["reversed"]) == 2


def test_normalize_params_validation():
    with pytest.raises(Exception):
        normalize_params({"strategy": "nope"})
    with pytest.raises(Exception):
        normalize_params({"tolerance_m": 9999})
    p = normalize_params({"coverage_min": 80})
    assert abs(p["coverage_min"] - 0.8) < 1e-9


@pytest.fixture()
def indexed_env(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "CACHE_DIR", tmp_path / "data" / "cache")
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "data" / "app.db")
    monkeypatch.setattr(config, "FILES_DIR", pathlib.Path(__file__).resolve().parent.parent / "files")
    init_db()
    files = sorted(config.FILES_DIR.glob("*.fit"))
    if not files:
        pytest.skip("nessun file FIT di esempio")
    for f in files:
        indexing._index_one(f, force=False)
    return files


def test_real_files_indexed(indexed_env):
    with db() as conn:
        n = conn.execute("SELECT COUNT(*) FROM activities WHERE error IS NULL").fetchone()[0]
        n_coarse = conn.execute("SELECT COUNT(*) FROM coarse_points").fetchone()[0]
    assert n == len(indexed_env)
    assert n_coarse > 0


def test_search_finds_source(indexed_env):
    with db() as conn:
        aid = conn.execute("SELECT id FROM activities ORDER BY id LIMIT 1").fetchone()["id"]
    res = search(aid, 100, 400, {"strategy": "endpoints", "tolerance_m": 25})
    assert res["segment"]["length_m"] > 0
    ids = [r["activity_id"] for r in res["results"]]
    assert aid in ids
    src = next(r for r in res["results"] if r["activity_id"] == aid)
    assert src["is_source"]
    assert src["duration_s"] > 0
    assert src["is_best"] in (True, False)


def test_search_overlap_strategy(indexed_env):
    with db() as conn:
        aid = conn.execute("SELECT id FROM activities ORDER BY id LIMIT 1").fetchone()["id"]
    res = search(
        aid,
        100,
        400,
        {"strategy": "overlap", "tolerance_m": 25, "coverage_min": 0.8, "direction": "same"},
    )
    src = next((r for r in res["results"] if r["activity_id"] == aid), None)
    assert src is not None
    assert src["coverage"] is not None and src["coverage"] > 0.9


def test_search_both_strategy(indexed_env):
    with db() as conn:
        aid = conn.execute("SELECT id FROM activities ORDER BY id LIMIT 1").fetchone()["id"]
    res = search(
        aid,
        100,
        400,
        {"strategy": "both", "tolerance_m": 25, "coverage_min": 0.8, "direction": "same"},
    )
    src = next((r for r in res["results"] if r["activity_id"] == aid), None)
    assert src is not None


def test_search_too_short_segment(indexed_env):
    with db() as conn:
        aid = conn.execute("SELECT id FROM activities ORDER BY id LIMIT 1").fetchone()["id"]
    with pytest.raises(Exception):
        search(aid, 100, 101, {})
