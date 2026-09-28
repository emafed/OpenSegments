from __future__ import annotations

import json
import threading
import time
import zipfile
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path

from . import config
from .db import db
from .indexing import now_iso, scan_status, start_scan

try:
    from garminconnect import (
        Garmin,
        GarminConnectAuthenticationError,
        GarminConnectConnectionError,
        GarminConnectTooManyRequestsError,
    )

    GARMIN_AVAILABLE = True
except ImportError:  # pragma: no cover - dipendenza mancante
    Garmin = None
    GarminConnectAuthenticationError = Exception
    GarminConnectConnectionError = Exception
    GarminConnectTooManyRequestsError = Exception
    GARMIN_AVAILABLE = False

PAGE_SIZE = 100
DOWNLOAD_DELAY_S = 0.8
DOWNLOAD_RETRIES = 3
MFA_TIMEOUT_S = 300
FIRST_ACTIVITY_DATE = "2006-01-01"
INCREMENTAL_OVERLAP_DAYS = 3

DEFAULT_SETTINGS = {
    "email": "",
    "auto_sync": True,
    "gps_only": True,
    "sport": "",
    "last_sync": None,
}

_login_lock = threading.Lock()
_login = {
    "state": "idle",
    "error": None,
    "mfa_pending": False,
    "display_name": None,
    "started_at": None,
}
_mfa_event = threading.Event()
_mfa_code: str | None = None
_client = None

_sync_lock = threading.Lock()
_sync = {
    "running": False,
    "phase": "idle",
    "mode": None,
    "total": 0,
    "done": 0,
    "downloaded": 0,
    "skipped": 0,
    "failed": 0,
    "filtered": 0,
    "current": "",
    "message": "",
    "error": None,
    "cancel": False,
    "started_at": None,
    "finished_at": None,
}


def load_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    try:
        raw = json.loads(config.GARMIN_CONFIG.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for key in DEFAULT_SETTINGS:
                if key in raw:
                    settings[key] = raw[key]
    except (OSError, ValueError):
        pass
    return settings


def save_settings(settings: dict) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    data = {key: settings.get(key, DEFAULT_SETTINGS[key]) for key in DEFAULT_SETTINGS}
    tmp = config.GARMIN_CONFIG.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(config.GARMIN_CONFIG)


def update_settings(**changes) -> dict:
    settings = load_settings()
    for key, value in changes.items():
        if key in DEFAULT_SETTINGS and value is not None:
            settings[key] = value
    save_settings(settings)
    return settings


def _prompt_mfa() -> str:
    global _mfa_code
    _mfa_event.clear()
    _mfa_code = None
    with _login_lock:
        _login["mfa_pending"] = True
        _login["state"] = "mfa"
    if not _mfa_event.wait(timeout=MFA_TIMEOUT_S):
        with _login_lock:
            _login["mfa_pending"] = False
            _login["state"] = "error"
            _login["error"] = "Tempo scaduto in attesa del codice MFA"
        raise GarminConnectAuthenticationError("Timeout MFA")
    code = _mfa_code or ""
    _mfa_code = None
    with _login_lock:
        _login["mfa_pending"] = False
        _login["state"] = "connecting"
    return code


def submit_mfa(code: str) -> bool:
    global _mfa_code
    with _login_lock:
        if not _login["mfa_pending"]:
            return False
    _mfa_code = (code or "").strip()
    _mfa_event.set()
    return True


def start_login(email: str, password: str) -> bool:
    if not GARMIN_AVAILABLE:
        raise RuntimeError("libreria garminconnect non installata")
    with _login_lock:
        if _login["state"] in ("connecting", "mfa"):
            return False
        _login.update(
            state="connecting",
            error=None,
            mfa_pending=False,
            display_name=None,
            started_at=now_iso(),
        )
    threading.Thread(target=_login_worker, args=(email, password), daemon=True).start()
    return True


def _login_worker(email: str, password: str) -> None:
    global _client
    try:
        client = Garmin(email=email, password=password, prompt_mfa=_prompt_mfa)
        client.login(str(config.GARMIN_TOKENSTORE))
        _client = client
        name = email
        try:
            name = client.get_full_name() or email
        except Exception:
            pass
        settings = load_settings()
        settings["email"] = email
        save_settings(settings)
        with _login_lock:
            _login.update(
                state="logged_in", error=None, mfa_pending=False, display_name=name
            )
    except Exception as exc:
        with _login_lock:
            _login.update(state="error", error=str(exc), mfa_pending=False)


def login_from_tokens() -> bool:
    global _client
    if not GARMIN_AVAILABLE or not config.GARMIN_TOKENSTORE.exists():
        return False
    with _login_lock:
        _login.update(state="connecting", error=None, mfa_pending=False)
    try:
        client = Garmin()
        client.login(str(config.GARMIN_TOKENSTORE))
    except Exception as exc:
        with _login_lock:
            _login.update(
                state="error",
                error=f"Accesso automatico non riuscito: {exc}",
                mfa_pending=False,
            )
        return False
    _client = client
    with _login_lock:
        _login.update(state="logged_in", error=None, mfa_pending=False)
    return True


def logout() -> None:
    global _client
    cancel_sync()
    client = _client
    _client = None
    if client is not None:
        try:
            client.logout(str(config.GARMIN_TOKENSTORE))
        except Exception:
            pass
    try:
        config.GARMIN_TOKENSTORE.unlink(missing_ok=True)
    except OSError:
        pass
    with _login_lock:
        _login.update(state="idle", error=None, mfa_pending=False, display_name=None)


def sync_status() -> dict:
    with _sync_lock:
        return dict(_sync)


def status() -> dict:
    settings = load_settings()
    with _login_lock:
        login_state = dict(_login)
    synced = 0
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM garmin_sync WHERE status='downloaded'"
            ).fetchone()
            synced = int(row["n"]) if row else 0
    except Exception:
        pass
    return {
        "available": GARMIN_AVAILABLE,
        "email": settings["email"],
        "auto_sync": bool(settings["auto_sync"]),
        "gps_only": bool(settings["gps_only"]),
        "sport": settings["sport"] or "",
        "last_sync": settings.get("last_sync"),
        "token_saved": config.GARMIN_TOKENSTORE.exists(),
        "logged_in": _client is not None,
        "login_state": login_state["state"],
        "login_error": login_state["error"],
        "display_name": login_state["display_name"],
        "mfa_pending": login_state["mfa_pending"],
        "synced": synced,
        "sync": sync_status(),
    }


def cancel_sync() -> bool:
    with _sync_lock:
        if not _sync["running"]:
            return False
        _sync["cancel"] = True
        return True


def start_sync(
    mode: str = "incremental",
    start_date: str | None = None,
    end_date: str | None = None,
) -> bool:
    with _sync_lock:
        if _sync["running"]:
            return False
        _sync.update(
            running=True,
            phase="listing",
            mode=mode,
            total=0,
            done=0,
            downloaded=0,
            skipped=0,
            failed=0,
            filtered=0,
            current="",
            message="Lettura elenco attività da Garmin Connect...",
            error=None,
            cancel=False,
            started_at=now_iso(),
            finished_at=None,
        )
    threading.Thread(
        target=_sync_worker, args=(mode, start_date, end_date), daemon=True
    ).start()
    return True


def _set(**values) -> None:
    with _sync_lock:
        _sync.update(values)


def _sync_worker(mode: str, start_date: str | None, end_date: str | None) -> None:
    try:
        client = _client
        if client is None:
            raise RuntimeError("non connesso a Garmin Connect")
        settings = load_settings()
        if mode == "incremental":
            start_date = _incremental_since()
            end_date = None
        activities = _list_activities(
            client, start_date, end_date, settings.get("sport") or None
        )
        if settings["gps_only"]:
            with_gps = [a for a in activities if _has_gps(a)]
            filtered = len(activities) - len(with_gps)
            activities = with_gps
        else:
            filtered = 0
        total = len(activities)
        _set(
            total=total,
            filtered=filtered,
            phase="downloading",
            message=f"Download di {total} attività da Garmin Connect...",
        )
        downloaded = 0
        skipped = 0
        failed = 0
        for act in activities:
            with _sync_lock:
                cancelled = _sync["cancel"]
            if cancelled:
                break
            try:
                gid = int(act["activityId"])
            except (KeyError, TypeError, ValueError):
                failed += 1
                continue
            label = (
                act.get("activityName") or act.get("startTimeLocal") or str(gid)
            )
            _set(current=label)
            if _already_downloaded(gid):
                skipped += 1
            else:
                try:
                    path = _download_one(client, gid)
                    _record_activity(act, "downloaded", file_path=str(path))
                    downloaded += 1
                except Exception as exc:
                    _record_activity(act, "failed", error=str(exc))
                    failed += 1
            _set(
                done=downloaded + skipped + failed,
                downloaded=downloaded,
                skipped=skipped,
                failed=failed,
            )
            time.sleep(DOWNLOAD_DELAY_S)
        settings = load_settings()
        settings["last_sync"] = now_iso()
        save_settings(settings)
        if downloaded:
            _set(
                phase="indexing",
                current="",
                message=f"Indicizzazione di {downloaded} nuovi file FIT...",
            )
            _run_index()
        _set(
            phase="done",
            running=False,
            current="",
            cancel=False,
            finished_at=now_iso(),
            message=(
                f"Completato: {downloaded} scaricate, {skipped} già presenti, "
                f"{failed} errori"
            ),
        )
    except Exception as exc:
        _set(
            phase="error",
            running=False,
            current="",
            cancel=False,
            error=str(exc),
            finished_at=now_iso(),
        )


def _list_activities(client, start_date, end_date, sport) -> list:
    start_date = _norm_date(start_date)
    end_date = _norm_date(end_date)
    if start_date or end_date:
        return client.get_activities_by_date(
            start_date or FIRST_ACTIVITY_DATE, end_date, activitytype=sport
        )
    activities: list = []
    offset = 0
    while True:
        page = client.get_activities(offset, PAGE_SIZE, activitytype=sport)
        if isinstance(page, dict):
            page = page.get("activityList") or []
        if not page:
            break
        activities.extend(page)
        if len(page) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
        time.sleep(0.2)
    return activities


def _norm_date(value) -> str | None:
    if not value:
        return None
    value = str(value).strip()
    try:
        datetime.strptime(value[:10], "%Y-%m-%d")
    except ValueError:
        return None
    return value[:10]


def _incremental_since() -> str:
    last = None
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT MAX(start_time) AS x FROM garmin_sync "
                "WHERE status='downloaded' AND start_time IS NOT NULL"
            ).fetchone()
            last = row["x"] if row else None
    except Exception:
        last = None
    if not last:
        return FIRST_ACTIVITY_DATE
    try:
        day = datetime.strptime(str(last)[:10], "%Y-%m-%d").date()
    except ValueError:
        return FIRST_ACTIVITY_DATE
    return (day - timedelta(days=INCREMENTAL_OVERLAP_DAYS)).isoformat()


def _has_gps(act) -> bool:
    value = act.get("hasPolyline")
    if isinstance(value, bool):
        return value
    return (
        act.get("startLatitude") is not None
        or act.get("startLongitude") is not None
        or "hasPolyline" not in act
    )


def _already_downloaded(gid: int) -> bool:
    row = None
    try:
        with db() as conn:
            row = conn.execute(
                "SELECT file_path, status FROM garmin_sync WHERE garmin_id = ?",
                (gid,),
            ).fetchone()
    except Exception:
        row = None
    if row and row["status"] == "downloaded" and row["file_path"]:
        return Path(row["file_path"]).exists()
    return (config.GARMIN_DIR / f"{gid}.fit").exists()


def _download_one(client, gid: int) -> Path:
    data = None
    last_exc: Exception | None = None
    for attempt in range(DOWNLOAD_RETRIES):
        try:
            data = client.download_activity(
                str(gid), Garmin.ActivityDownloadFormat.ORIGINAL
            )
            break
        except GarminConnectTooManyRequestsError as exc:
            last_exc = exc
            time.sleep(30 * (attempt + 1))
        except GarminConnectConnectionError as exc:
            last_exc = exc
            time.sleep(2 * (attempt + 1))
    if data is None:
        raise last_exc or RuntimeError("download non riuscito")
    fit_bytes = _extract_fit(data)
    config.GARMIN_DIR.mkdir(parents=True, exist_ok=True)
    path = config.GARMIN_DIR / f"{gid}.fit"
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(fit_bytes)
    tmp.replace(path)
    return path


def _extract_fit(data: bytes) -> bytes:
    if data[:4] == b"PK\x03\x04":
        with zipfile.ZipFile(BytesIO(data)) as archive:
            names = [n for n in archive.namelist() if n.lower().endswith(".fit")]
            if not names:
                raise ValueError("nessun file FIT nell'archivio scaricato")
            return archive.read(names[0])
    if len(data) >= 12 and data[8:12] == b".FIT":
        return data
    raise ValueError("formato del download non riconosciuto")


def _record_activity(
    act, status: str, file_path: str | None = None, error: str | None = None
) -> None:
    sport = None
    type_info = act.get("activityType")
    if isinstance(type_info, dict):
        sport = type_info.get("typeKey")
    with db() as conn:
        conn.execute(
            """
            INSERT OR REPLACE INTO garmin_sync
                (garmin_id, name, start_time, sport, has_gps, file_path, status,
                 error, synced_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (
                int(act["activityId"]),
                act.get("activityName"),
                act.get("startTimeLocal"),
                sport,
                1 if _has_gps(act) else 0,
                file_path,
                status,
                error,
                now_iso(),
            ),
        )


def _run_index() -> None:
    for _ in range(600):
        with _sync_lock:
            if _sync["cancel"]:
                return
        if not scan_status()["running"]:
            break
        time.sleep(1)
    if not start_scan(force=False):
        return
    for _ in range(7200):
        with _sync_lock:
            if _sync["cancel"]:
                return
        if not scan_status()["running"]:
            return
        time.sleep(1)


def auto_sync_on_startup() -> None:
    if not GARMIN_AVAILABLE or not config.GARMIN_TOKENSTORE.exists():
        return

    def worker() -> None:
        if not login_from_tokens():
            return
        settings = load_settings()
        if settings.get("auto_sync") and settings.get("last_sync"):
            start_sync("incremental")

    threading.Thread(target=worker, daemon=True).start()
