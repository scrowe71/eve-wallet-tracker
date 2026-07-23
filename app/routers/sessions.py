from types import SimpleNamespace
from datetime import timedelta

from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Session as IncomeSession, Character, WalletEntry, LootEntry
from app.services.session_builder import rebuild_sessions
from app.main_support import templates

router = APIRouter(tags=["sessions"])

FLEET_GROUP_START_TOLERANCE = timedelta(minutes=20)
EVENT_GROUP_TOLERANCE_SECONDS = 300  # group multi-character fleet payouts within 5 minutes


def _compact_isk(value: float) -> str:
    try:
        v = float(value or 0)
    except Exception:
        v = 0
    sign = '-' if v < 0 else ''
    v = abs(v)
    if v >= 1_000_000_000:
        text = f"{v/1_000_000_000:.1f}B"
    elif v >= 1_000_000:
        text = f"{v/1_000_000:.0f}M"
    elif v >= 1_000:
        text = f"{v/1_000:.0f}K"
    else:
        text = f"{v:.0f}"
    return f"{sign}{text}"


def _elapsed_label(minutes: float) -> str:
    minutes = max(float(minutes or 0), 0)
    h = int(minutes // 60)
    m = int(round(minutes % 60))
    if h and m:
        return f"{h}h {m}m"
    if h:
        return f"{h}h"
    return f"{m}m"


def _is_ratting_bounty_event(event):
    ref = (event.get("event") or "").lower()
    desc = (event.get("description") or "").lower()
    return (
        ref == "bounty_prizes"
        or ref == "freelance_jobs_reward"
        or "bounty prizes" in desc
        or "freelance jobs" in desc
    )


def _is_ratting_ess_event(event):
    ref = (event.get("event") or "").lower()
    desc = (event.get("description") or "").lower()
    return ref == "ess_escrow_transfer" or "encounter surveillance system" in desc


def _event_kind(event):
    if _is_ratting_bounty_event(event):
        return "bounty"
    if _is_ratting_ess_event(event):
        return "ess"
    if (event.get("event") or "").lower() == "loot":
        return "loot"
    return "other"


def _group_nearby_events(events, *, tolerance_seconds=EVENT_GROUP_TOLERANCE_SECONDS):
    """Group nearby same-kind events into one chart event.

    Fleet sessions can contain several characters receiving the same payout cycle within
    seconds of each other.  The chart should treat those as a single combined fleet data
    point instead of incrementing the 20-minute cycle once per character.
    """
    events = sorted(events, key=lambda e: e["time"])
    grouped = []
    active = None

    def flush():
        nonlocal active
        if not active:
            return
        count = active.pop("count", 1)
        if count > 1:
            if active["kind"] == "bounty":
                active["description"] = f"Fleet bounty cycle ({count} entries)"
            elif active["kind"] == "ess":
                active["description"] = f"Fleet ESS payout ({count} entries)"
            elif active["kind"] == "loot":
                active["description"] = f"Loot batch ({count} items)"
            else:
                active["description"] = f"Combined event ({count} entries)"
        grouped.append(active)
        active = None

    for event in events:
        kind = _event_kind(event)
        if active is None:
            active = {**event, "kind": kind, "count": 1}
            continue

        seconds_apart = abs((event["time"] - active["time"]).total_seconds())
        # Loot pasted as a batch should be grouped by exact timestamp.  Wallet fleet
        # payouts get a wider grouping window because different characters can land a
        # few seconds/minutes apart in the journal.
        tolerance = 1 if kind == "loot" else tolerance_seconds
        same_group = kind == active["kind"] and seconds_apart <= tolerance

        if same_group:
            # Keep the earliest timestamp as the chart point time, and add values.
            if event["time"] < active["time"]:
                active["time"] = event["time"]
            active["amount"] += float(event.get("amount") or 0)
            active["count"] += 1
            if event.get("character_id") and event.get("character_id") != active.get("character_id"):
                active["character_id"] = None
        else:
            flush()
            active = {**event, "kind": kind, "count": 1}

    flush()
    return grouped


def _is_manual_loot(entry):
    return (getattr(entry, "price_source", "") or "").lower() == "manual isk"


def _group_loot_events(loot_entries):
    """Collapse non-manual loot rows entered at the same timestamp into chart events.

    Manual ISK loot is intentionally excluded here.  It is distributed smoothly
    across the full session chart instead of creating a late spike when the user
    happened to enter the manual value.
    """
    grouped = {}
    for entry in loot_entries:
        if not entry.loot_date or _is_manual_loot(entry):
            continue
        # Group all same-timestamp loot rows together for fleet/session charts.
        key = entry.loot_date.replace(microsecond=0)
        if key not in grouped:
            grouped[key] = {
                "time": entry.loot_date,
                "character_id": None,
                "event": "Loot",
                "description": "Loot batch",
                "amount": 0.0,
                "item_count": 0,
            }
        grouped[key]["amount"] += float(entry.calculated_value or 0)
        grouped[key]["item_count"] += 1
    for event in grouped.values():
        count = event.get("item_count", 0)
        event["description"] = f"Loot batch ({count} item{'s' if count != 1 else ''})"
    return list(grouped.values())

def _build_session_chart(session, wallet_entries, loot_entries):
    raw_events = []
    for entry in wallet_entries:
        if not entry.entry_date:
            continue
        raw_events.append({
            "time": entry.entry_date,
            "character_id": entry.character_id,
            "event": entry.ref_type or "Wallet",
            "description": entry.description or "",
            "amount": float(entry.amount or 0),
        })

    raw_events.extend(_group_loot_events(loot_entries))
    raw_events = _group_nearby_events(raw_events)
    raw_events.sort(key=lambda x: x["time"])

    # First pass: calculate each event's x-axis position.  This may differ from actual
    # wall-clock ordering for ratting because bounty rows represent 20-minute earning
    # cycles and ESS rows use the latest bounty cycle plus their payout offset.
    timed_events = []
    ratting_cycle_count = 0
    latest_ratting_cycle_minutes = 0.0
    latest_ratting_actual_minutes = 0.0

    for seq, event in enumerate(raw_events):
        actual_elapsed_seconds = max((event["time"] - session.start_time).total_seconds(), 0)
        actual_elapsed_minutes = actual_elapsed_seconds / 60.0

        if _is_ratting_bounty_event(event):
            ratting_cycle_count += 1
            effective_minutes = ratting_cycle_count * 20.0
            latest_ratting_cycle_minutes = effective_minutes
            latest_ratting_actual_minutes = actual_elapsed_minutes
            elapsed_basis = "20-minute ratting bounty cycle"
        elif _is_ratting_ess_event(event) and latest_ratting_cycle_minutes > 0:
            offset_after_latest_bounty = max(actual_elapsed_minutes - latest_ratting_actual_minutes, 0.0)
            effective_minutes = latest_ratting_cycle_minutes + offset_after_latest_bounty
            elapsed_basis = "ESS payout: ratting cycle time plus ESS payout offset"
        else:
            effective_minutes = max(actual_elapsed_minutes, 1.0)
            elapsed_basis = "actual elapsed session time"

        timed_events.append({
            **event,
            "seq": seq,
            "elapsed_minutes": effective_minutes,
            "elapsed_label": _elapsed_label(effective_minutes),
            "actual_elapsed_minutes": actual_elapsed_minutes,
            "actual_elapsed_label": _elapsed_label(actual_elapsed_minutes),
            "elapsed_basis": elapsed_basis,
        })

    # Draw and calculate cumulative values in x-axis order.
    timed_events.sort(key=lambda p: (p["elapsed_minutes"], p["time"], p["seq"]))

    manual_loot_total = sum(float(entry.calculated_value or 0) for entry in loot_entries if _is_manual_loot(entry))
    max_minutes = max((max(p["elapsed_minutes"] for p in timed_events) if timed_events else 0), 20.0, 1.0)

    # Manual ISK values represent after-the-fact loot/value estimates for the session.
    # Spread them linearly across the full effective session time so the chart reflects
    # the session's average earning rate instead of creating a large late spike at the
    # time the user typed the manual value.
    cumulative = 0.0
    points = []
    for event in timed_events:
        cumulative += event["amount"]
        manual_contribution = manual_loot_total * min(max(event["elapsed_minutes"] / max_minutes, 0.0), 1.0)
        displayed_cumulative = cumulative + manual_contribution
        effective_hours = max(event["elapsed_minutes"] / 60.0, 1.0 / 60.0)
        isk_per_hour = displayed_cumulative / effective_hours
        points.append({
            **event,
            "cumulative": displayed_cumulative,
            "raw_cumulative": cumulative,
            "manual_distributed": manual_contribution,
            "isk_per_hour": isk_per_hour,
            "rate_label": f"{_compact_isk(isk_per_hour)}/hr",
            "amount_label": _compact_isk(event["amount"]),
            "cumulative_label": _compact_isk(displayed_cumulative),
        })

    if manual_loot_total and points and points[-1]["elapsed_minutes"] < max_minutes:
        displayed_cumulative = cumulative + manual_loot_total
        effective_hours = max(max_minutes / 60.0, 1.0 / 60.0)
        isk_per_hour = displayed_cumulative / effective_hours
        points.append({
            "time": session.end_time,
            "character_id": None,
            "event": "Manual Loot Allocation",
            "description": "Manual loot value distributed across the full session",
            "amount": 0.0,
            "seq": len(timed_events) + 1,
            "elapsed_minutes": max_minutes,
            "elapsed_label": _elapsed_label(max_minutes),
            "actual_elapsed_minutes": max_minutes,
            "actual_elapsed_label": _elapsed_label(max_minutes),
            "elapsed_basis": "manual loot distributed across full session",
            "cumulative": displayed_cumulative,
            "raw_cumulative": cumulative,
            "manual_distributed": manual_loot_total,
            "isk_per_hour": isk_per_hour,
            "rate_label": f"{_compact_isk(isk_per_hour)}/hr",
            "amount_label": "0",
            "cumulative_label": _compact_isk(displayed_cumulative),
        })

    if not points:
        if manual_loot_total:
            max_minutes = max((session.end_time - session.start_time).total_seconds() / 60.0, 20.0, 1.0)
            effective_hours = max(max_minutes / 60.0, 1.0 / 60.0)
            isk_per_hour = manual_loot_total / effective_hours
            points = [{
                "time": session.end_time,
                "character_id": None,
                "event": "Manual Loot Allocation",
                "description": "Manual loot value distributed across the full session",
                "amount": 0.0,
                "seq": 1,
                "elapsed_minutes": max_minutes,
                "elapsed_label": _elapsed_label(max_minutes),
                "actual_elapsed_minutes": max_minutes,
                "actual_elapsed_label": _elapsed_label(max_minutes),
                "elapsed_basis": "manual loot distributed across full session",
                "cumulative": manual_loot_total,
                "raw_cumulative": 0.0,
                "manual_distributed": manual_loot_total,
                "isk_per_hour": isk_per_hour,
                "rate_label": f"{_compact_isk(isk_per_hour)}/hr",
                "amount_label": "0",
                "cumulative_label": _compact_isk(manual_loot_total),
            }]
        else:
            return {"points": [], "svg_points": [], "x_ticks": [], "y_ticks": [], "max_minutes": 1, "max_rate": 1}

    max_rate = max(max(p["isk_per_hour"] for p in points), 1)
    min_rate = min(min(p["isk_per_hour"] for p in points), 0)

    width = 1000
    height = 420
    margin_left = 88
    margin_right = 30
    margin_top = 34
    margin_bottom = 58
    plot_w = width - margin_left - margin_right
    plot_h = height - margin_top - margin_bottom

    def sx(minutes):
        return margin_left + (float(minutes) / max_minutes) * plot_w

    rate_span = max_rate - min_rate or 1

    def sy(rate):
        return margin_top + (max_rate - float(rate)) / rate_span * plot_h

    n = len(points)
    local_extreme_indices = set()
    if n >= 3:
        for i in range(1, n - 1):
            prev_v = points[i - 1]["isk_per_hour"]
            this_v = points[i]["isk_per_hour"]
            next_v = points[i + 1]["isk_per_hour"]
            if (this_v >= prev_v and this_v >= next_v) or (this_v <= prev_v and this_v <= next_v):
                local_extreme_indices.add(i)

    if n <= 12:
        label_indices = set(range(n))
    elif n <= 30:
        label_indices = set(range(0, n, 3))
        label_indices.update(local_extreme_indices)
        label_indices.add(n - 1)
    else:
        label_indices = set(range(0, n, 5))
        label_indices.update(local_extreme_indices)
        label_indices.add(n - 1)

    if len(label_indices) > 18:
        kept = {0, n - 1}
        step = max(1, n // 14)
        kept.update(range(0, n, step))
        kept.add(max(range(n), key=lambda i: points[i]["isk_per_hour"]))
        kept.add(min(range(n), key=lambda i: points[i]["isk_per_hour"]))
        label_indices = kept

    svg_points = []
    for i, pnt in enumerate(points):
        x = sx(pnt["elapsed_minutes"])
        y = sy(pnt["isk_per_hour"])
        label_dy = -12 if i % 2 == 0 else 20
        svg_points.append({
            **pnt,
            "x": round(x, 2),
            "y": round(y, 2),
            "label_y": round(max(12, min(height - margin_bottom + 18, y + label_dy)), 2),
            "show_label": i in label_indices,
        })

    line_path = " ".join(f"{p['x']},{p['y']}" for p in svg_points)

    tick_count = 5
    x_ticks = []
    for i in range(tick_count + 1):
        minutes = max_minutes * i / tick_count
        x_ticks.append({"x": round(sx(minutes), 2), "label": _elapsed_label(minutes)})

    y_ticks = []
    for i in range(tick_count + 1):
        rate = min_rate + (rate_span * i / tick_count)
        y_ticks.append({"y": round(sy(rate), 2), "label": f"{_compact_isk(rate)}/hr"})

    return {
        "points": points,
        "svg_points": svg_points,
        "line_path": line_path,
        "x_ticks": x_ticks,
        "y_ticks": y_ticks,
        "width": width,
        "height": height,
        "margin_left": margin_left,
        "margin_right": margin_right,
        "margin_top": margin_top,
        "margin_bottom": margin_bottom,
        "plot_w": plot_w,
        "plot_h": plot_h,
        "max_minutes": max_minutes,
        "max_rate": max_rate,
    }


def _user_characters(db: Session, user_id: int | str):
    rows = db.query(Character).filter(Character.user_id == int(user_id)).all()
    return rows, {c.character_id: c.character_name for c in rows}


def _format_character_list(session_rows, characters):
    names = []
    for s in session_rows:
        name = characters.get(s.source_character_id, str(s.source_character_id))
        if name not in names:
            names.append(name)
    if len(names) <= 3:
        return ", ".join(names)
    return f"{len(names)} chars: " + ", ".join(names[:3]) + ", ..."


def _sessions_overlap(a_start, a_end, b_start, b_end):
    return min(a_end, b_end) >= max(a_start, b_start)


def _build_fleet_groups(rows, characters):
    """Group similar overlapping per-character sessions for fleet display.

    The database still stores individual character sessions.  The UI groups sessions
    with the same activity and near-identical start timing into one fleet session so
    smartbombing/multibox fleet income is viewed as one combined session.
    """
    groups = []
    for s in sorted(rows, key=lambda x: (x.activity_type or "", x.start_time)):
        placed = False
        for g in groups:
            if g["activity_type"] != s.activity_type:
                continue
            start_close = abs((s.start_time - g["anchor_start"]).total_seconds()) <= FLEET_GROUP_START_TOLERANCE.total_seconds()
            overlaps = _sessions_overlap(s.start_time, s.end_time, g["start_time"], g["end_time"])
            if start_close and overlaps:
                g["sessions"].append(s)
                g["ids"].append(s.id)
                g["start_time"] = min(g["start_time"], s.start_time)
                g["end_time"] = max(g["end_time"], s.end_time)
                g["wallet_income"] += float(s.wallet_income or 0)
                g["loot_value"] += float(s.loot_value or 0)
                g["total_value"] += float(s.total_value or 0)
                placed = True
                break
        if not placed:
            groups.append({
                "anchor_start": s.start_time,
                "start_time": s.start_time,
                "end_time": s.end_time,
                "activity_type": s.activity_type,
                "sessions": [s],
                "ids": [s.id],
                "wallet_income": float(s.wallet_income or 0),
                "loot_value": float(s.loot_value or 0),
                "total_value": float(s.total_value or 0),
            })

    result = []
    for idx, g in enumerate(groups, start=1):
        duration_seconds = max((g["end_time"] - g["start_time"]).total_seconds(), 0)
        isk_per_hour = g["total_value"] * 3600 / duration_seconds if duration_seconds > 0 else 0
        ids = ",".join(str(i) for i in sorted(g["ids"]))
        result.append(SimpleNamespace(
            group_id=ids,
            start_time=g["start_time"],
            end_time=g["end_time"],
            activity_type=g["activity_type"],
            wallet_income=g["wallet_income"],
            loot_value=g["loot_value"],
            total_value=g["total_value"],
            isk_per_hour=isk_per_hour,
            character_count=len(g["ids"]),
            character_label=_format_character_list(g["sessions"], characters),
            details_url=f"/sessions/fleet?ids={ids}",
        ))
    result.sort(key=lambda g: g.start_time, reverse=True)
    return result


@router.get("/sessions", response_class=HTMLResponse)
def sessions(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    q = (
        db.query(IncomeSession)
        .join(Character, IncomeSession.source_character_id == Character.character_id)
        .filter(Character.user_id == int(user_id))
    )
    rows = q.order_by(IncomeSession.start_time.desc()).limit(500).all()
    _, characters = _user_characters(db, user_id)
    fleet_groups = _build_fleet_groups(rows, characters)
    return templates.TemplateResponse("sessions.html", {
        "request": request,
        "session_groups": fleet_groups,
        "characters": characters,
        "timezone_name": request.session.get("timezone", "UTC"),
    })


@router.post("/sessions/rebuild")
def rebuild(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    rebuild_sessions(db, user_id=user_id, timezone_name=request.session.get("timezone", "UTC"))
    return RedirectResponse("/sessions", status_code=303)


def _load_fleet_sessions(ids: str, user_id: int | str, db: Session):
    try:
        session_ids = [int(x) for x in (ids or "").split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id list")
    if not session_ids:
        raise HTTPException(status_code=400, detail="No sessions selected")

    character_ids = [c.character_id for c in db.query(Character).filter(Character.user_id == int(user_id)).all()]
    sessions = (
        db.query(IncomeSession)
        .filter(IncomeSession.id.in_(session_ids))
        .filter(IncomeSession.source_character_id.in_(character_ids))
        .order_by(IncomeSession.start_time.asc())
        .all()
    )
    if not sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    return sessions, character_ids


@router.get("/sessions/fleet", response_class=HTMLResponse)
def fleet_session_detail(ids: str, request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)

    sessions, character_ids = _load_fleet_sessions(ids, user_id, db)
    _, characters = _user_characters(db, user_id)
    session_ids = [s.id for s in sessions]

    wallet_entries = (
        db.query(WalletEntry)
        .filter(WalletEntry.session_id.in_(session_ids))
        .filter(WalletEntry.character_id.in_(character_ids))
        .order_by(WalletEntry.entry_date.asc(), WalletEntry.character_id.asc())
        .all()
    )
    loot_entries = (
        db.query(LootEntry)
        .filter(LootEntry.session_id.in_(session_ids))
        .filter(LootEntry.character_id.in_(character_ids))
        .order_by(LootEntry.loot_date.asc(), LootEntry.character_id.asc())
        .all()
    )

    start_time = min(s.start_time for s in sessions)
    end_time = max(s.end_time for s in sessions)
    wallet_income = sum(float(s.wallet_income or 0) for s in sessions)
    loot_value = sum(float(s.loot_value or 0) for s in sessions)
    total_value = wallet_income + loot_value
    activity_type = sessions[0].activity_type if sessions else ""

    combined_session = SimpleNamespace(
        id=ids,
        activity_type=activity_type,
        session_type="Fleet Session" if len(sessions) > 1 else "Single Character",
        source_character_id=None if len(sessions) > 1 else sessions[0].source_character_id,
        start_time=start_time,
        end_time=end_time,
        wallet_income=wallet_income,
        loot_value=loot_value,
        total_value=total_value,
    )

    wallet_by_character = {}
    for entry in wallet_entries:
        name = characters.get(entry.character_id, str(entry.character_id))
        wallet_by_character[name] = wallet_by_character.get(name, 0) + float(entry.amount or 0)

    loot_by_character = {}
    for entry in loot_entries:
        name = characters.get(entry.character_id, str(entry.character_id or ""))
        loot_by_character[name] = loot_by_character.get(name, 0) + float(entry.calculated_value or 0)

    duration_seconds = max((end_time - start_time).total_seconds(), 0)
    duration_hours = duration_seconds / 3600 if duration_seconds else 0
    isk_per_hour = total_value / duration_hours if duration_hours > 0 else 0
    session_chart = _build_session_chart(combined_session, wallet_entries, loot_entries)
    character_label = _format_character_list(sessions, characters)

    return templates.TemplateResponse("session_detail.html", {
        "request": request,
        "session": combined_session,
        "session_label": f"Fleet Session ({len(sessions)} character{'s' if len(sessions) != 1 else ''})" if len(sessions) > 1 else f"Session #{sessions[0].id}",
        "character_label": character_label,
        "wallet_entries": wallet_entries,
        "loot_entries": loot_entries,
        "characters": characters,
        "wallet_by_character": wallet_by_character,
        "loot_by_character": loot_by_character,
        "duration_hours": duration_hours,
        "isk_per_hour": isk_per_hour,
        "session_chart": session_chart,
        "timezone_name": request.session.get("timezone", "UTC"),
    })


@router.get("/sessions/{session_id}", response_class=HTMLResponse)
def session_detail(session_id: int, request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)

    character_ids = [c.character_id for c in db.query(Character).filter(Character.user_id == int(user_id)).all()]
    characters_q = db.query(Character).filter(Character.user_id == int(user_id)).all()
    characters = {c.character_id: c.character_name for c in characters_q}

    session = (
        db.query(IncomeSession)
        .filter(IncomeSession.id == session_id)
        .filter(IncomeSession.source_character_id.in_(character_ids))
        .first()
    )
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    wallet_entries = (
        db.query(WalletEntry)
        .filter(WalletEntry.session_id == session.id)
        .filter(WalletEntry.character_id.in_(character_ids))
        .order_by(WalletEntry.entry_date.asc())
        .all()
    )
    loot_entries = (
        db.query(LootEntry)
        .filter(LootEntry.session_id == session.id)
        .filter(LootEntry.character_id.in_(character_ids))
        .order_by(LootEntry.loot_date.asc())
        .all()
    )

    wallet_by_character = {}
    for entry in wallet_entries:
        name = characters.get(entry.character_id, str(entry.character_id))
        wallet_by_character[name] = wallet_by_character.get(name, 0) + float(entry.amount or 0)

    loot_by_character = {}
    for entry in loot_entries:
        name = characters.get(entry.character_id, str(entry.character_id or ""))
        loot_by_character[name] = loot_by_character.get(name, 0) + float(entry.calculated_value or 0)

    duration_seconds = max((session.end_time - session.start_time).total_seconds(), 0)
    duration_hours = duration_seconds / 3600 if duration_seconds else 0
    isk_per_hour = float(session.total_value or 0) / duration_hours if duration_hours > 0 else 0
    session_chart = _build_session_chart(session, wallet_entries, loot_entries)

    return templates.TemplateResponse("session_detail.html", {
        "request": request,
        "session": session,
        "session_label": f"Session #{session.id}",
        "character_label": characters.get(session.source_character_id, session.source_character_id),
        "wallet_entries": wallet_entries,
        "loot_entries": loot_entries,
        "characters": characters,
        "wallet_by_character": wallet_by_character,
        "loot_by_character": loot_by_character,
        "duration_hours": duration_hours,
        "isk_per_hour": isk_per_hour,
        "session_chart": session_chart,
        "timezone_name": request.session.get("timezone", "UTC"),
    })
