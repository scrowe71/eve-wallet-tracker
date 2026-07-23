from fastapi import APIRouter, Request, Depends
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Session as IncomeSession, Character
from app.main_support import templates
from app.utils.timezone import dashboard_range_bounds_utc, local_date_bounds_to_utc
from app.routers.sessions import _build_fleet_groups, _user_characters

router = APIRouter(tags=["dashboard"])


def _dashboard_bounds(request: Request):
    tz_name = request.session.get("timezone", "UTC")
    range_value = request.query_params.get("range", "today")
    if range_value == "custom":
        start, end = local_date_bounds_to_utc(
            request.query_params.get("start_date"),
            request.query_params.get("end_date"),
            tz_name,
        )
        _, _, tz_abbrev = dashboard_range_bounds_utc("today", tz_name)
        return start, end, tz_abbrev, range_value
    start, end, tz_abbrev = dashboard_range_bounds_utc(range_value, tz_name)
    return start, end, tz_abbrev, range_value


@router.get("/", response_class=HTMLResponse)
def dashboard(request: Request, db: Session = Depends(get_db)):
    tz_name = request.session.get("timezone", "UTC")
    start, end, tz_abbrev, selected_range = _dashboard_bounds(request)

    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    q = (
        db.query(IncomeSession)
        .join(Character, IncomeSession.source_character_id == Character.character_id)
        .filter(Character.user_id == int(user_id))
    )
    if start:
        q = q.filter(IncomeSession.start_time >= start)
    if end:
        q = q.filter(IncomeSession.start_time <= end)
    sessions = q.all()

    # Dashboard totals should use the same fleet-session grouping as the Sessions page.
    # The database stores per-character sessions, but multibox/smartbombing fleets are
    # one earning session in the UI and reporting layer.
    _, characters = _user_characters(db, user_id)
    fleet_groups = _build_fleet_groups(sessions, characters)

    wallet = sum(g.wallet_income or 0 for g in fleet_groups)
    loot = sum(g.loot_value or 0 for g in fleet_groups)
    total = sum(g.total_value or 0 for g in fleet_groups)
    hours = sum(max((g.end_time - g.start_time).total_seconds() / 3600, 0.01) for g in fleet_groups)
    # Income by Activity is wallet income by activity plus a separate Loot Value category.
    # This keeps the activity table additive: Ratting + Incursions + Missions + Loot Value = Total Value.
    by_activity = {"Ratting": 0, "Incursions": 0, "Missions": 0, "Loot Value": loot}

    character_contributions = {}
    for s in sessions:
        activity = s.activity_type or "Unclassified"
        wallet_value = s.wallet_income or 0
        total_value = s.total_value or 0
        loot_value = s.loot_value or 0
        by_activity[activity] = by_activity.get(activity, 0) + wallet_value

        character_id = s.source_character_id
        character_name = characters.get(character_id, "Unknown Character")
        if character_name not in character_contributions:
            character_contributions[character_name] = {
                "character": character_name,
                "total": 0,
                "Ratting": 0,
                "Incursions": 0,
                "Missions": 0,
                "Loot Value": 0,
            }
        character_contributions[character_name]["total"] += total_value
        character_contributions[character_name]["Loot Value"] += loot_value
        if activity in ("Ratting", "Incursions", "Missions"):
            character_contributions[character_name][activity] += wallet_value

    character_contributions = sorted(
        character_contributions.values(),
        key=lambda row: row["total"],
        reverse=True,
    )

    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "selected_range": selected_range,
        "start_date": request.query_params.get("start_date", ""),
        "end_date": request.query_params.get("end_date", ""),
        "wallet": wallet,
        "loot": loot,
        "total": total,
        "isk_hour": total / hours if hours else 0,
        "session_count": len(fleet_groups),
        "by_activity": by_activity,
        "character_contributions": character_contributions,
        "timezone_name": tz_name,
        "timezone_abbrev": tz_abbrev,
    })
