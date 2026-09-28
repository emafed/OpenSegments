import zipfile
from io import BytesIO

import pytest

from app import config, garmin


def _fit_bytes(marker=b"FITDATA"):
    return b"\x00" * 8 + b".FIT" + marker


def test_extract_fit_from_zip():
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("activity.fit", _fit_bytes(b"ZIP"))
    assert garmin._extract_fit(buf.getvalue()) == _fit_bytes(b"ZIP")


def test_extract_fit_raw():
    assert garmin._extract_fit(_fit_bytes()) == _fit_bytes()


def test_extract_fit_invalid():
    with pytest.raises(ValueError):
        garmin._extract_fit(b"not a fit file")


def test_has_gps_flag():
    assert garmin._has_gps({"hasPolyline": True})
    assert not garmin._has_gps({"hasPolyline": False})
    assert garmin._has_gps({"startLatitude": 45.0})
    assert garmin._has_gps({})


def test_norm_date():
    assert garmin._norm_date("2026-09-27") == "2026-09-27"
    assert garmin._norm_date("2026-09-27T10:00:00") == "2026-09-27"
    assert garmin._norm_date("non-data") is None
    assert garmin._norm_date(None) is None
    assert garmin._norm_date("") is None


def test_settings_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "GARMIN_CONFIG", tmp_path / "garmin_config.json")
    garmin.save_settings({"email": "a@b.c", "gps_only": False, "sport": "running"})
    settings = garmin.load_settings()
    assert settings["email"] == "a@b.c"
    assert settings["gps_only"] is False
    assert settings["sport"] == "running"
    assert settings["auto_sync"] is True


def test_load_settings_missing_file(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "GARMIN_CONFIG", tmp_path / "missing.json")
    settings = garmin.load_settings()
    assert settings["email"] == ""
    assert settings["gps_only"] is True
    assert settings["last_sync"] is None
