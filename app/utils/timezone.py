from __future__ import annotations

from datetime import datetime, timedelta, time, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZ = "UTC"


def safe_zoneinfo(tz_name: str | None) -> ZoneInfo:
    if not tz_name:
        return ZoneInfo(DEFAULT_TZ)
    try:
        return ZoneInfo(tz_name)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def ensure_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def to_local(dt: datetime | None, tz_name: str | None) -> datetime | None:
    dt = ensure_utc(dt)
    if dt is None:
        return None
    return dt.astimezone(safe_zoneinfo(tz_name))


def format_local(dt: datetime | None, tz_name: str | None, include_tz: bool = True) -> str:
    local = to_local(dt, tz_name)
    if not local:
        return ""
    if include_tz:
        return local.strftime("%Y-%m-%d %I:%M:%S %p %Z")
    return local.strftime("%Y-%m-%d %I:%M:%S %p")


def format_utc(dt: datetime | None) -> str:
    utc = ensure_utc(dt)
    if not utc:
        return ""
    return utc.strftime("%Y-%m-%d %H:%M:%S UTC")


def local_date_bounds_to_utc(start_date: str | None, end_date: str | None, tz_name: str | None):
    tz = safe_zoneinfo(tz_name)
    start_utc = None
    end_utc = None
    if start_date:
        try:
            d = datetime.strptime(start_date, "%Y-%m-%d").date()
            start_utc = datetime.combine(d, time.min, tzinfo=tz).astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            pass
    if end_date:
        try:
            d = datetime.strptime(end_date, "%Y-%m-%d").date()
            end_utc = (datetime.combine(d, time.min, tzinfo=tz) + timedelta(days=1)).astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            pass
    return start_utc, end_utc


def dashboard_range_bounds_utc(range_value: str, tz_name: str | None):
    tz = safe_zoneinfo(tz_name)
    now_local = datetime.now(tz)
    today_start_local = datetime.combine(now_local.date(), time.min, tzinfo=tz)
    if range_value == "yesterday":
        start_local = today_start_local - timedelta(days=1)
        end_local = today_start_local
    elif range_value == "7":
        start_local = now_local - timedelta(days=7)
        end_local = now_local
    elif range_value == "30":
        start_local = now_local - timedelta(days=30)
        end_local = now_local
    else:
        start_local = today_start_local
        end_local = now_local
    return (
        start_local.astimezone(timezone.utc).replace(tzinfo=None),
        end_local.astimezone(timezone.utc).replace(tzinfo=None),
        now_local.tzname(),
    )


def parse_local_datetime_to_utc(value: str | None, tz_name: str | None) -> datetime | None:
    """Parse datetime-local input from the browser's timezone into naive UTC."""
    if not value:
        return None
    tz = safe_zoneinfo(tz_name)
    for fmt in ("%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            local = datetime.strptime(value, fmt).replace(tzinfo=tz)
            return local.astimezone(timezone.utc).replace(tzinfo=None)
        except ValueError:
            continue
    return None
