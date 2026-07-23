from datetime import datetime, timedelta
import csv
import io
from urllib.parse import urlencode
from fastapi import APIRouter, Request, Depends, Form
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from sqlalchemy.orm import Session
from app.database import get_db
from app.config import settings
from app.models import LootEntry, Setting, Session as IncomeSession, Character, WalletEntry
from app.main_support import templates
from app.services.loot_valuation import calculate_loot_value, find_matching_session, recalculate_session_loot, SUPPORTED_PRICE_SOURCES
from app.services.market_pricing import resolve_inventory_type, get_jita_price, PricingError
from app.services.janice_pricing import price_items as janice_price_items, JanicePricingError
from app.services.session_resolver import resolve_current_session, repair_unmatched_loot
from app.utils.timezone import dashboard_range_bounds_utc, local_date_bounds_to_utc, format_local, format_utc

router = APIRouter(tags=["pages"])


def _setting(db: Session, key: str, default: str) -> str:
    row = db.query(Setting).filter(Setting.key == key).first()
    return row.value if row else default


def _set_setting(db: Session, key: str, value: str) -> None:
    row = db.query(Setting).filter(Setting.key == key).first()
    if row:
        row.value = value
    else:
        db.add(Setting(key=key, value=value))


def _loot_context(request: Request, db: Session, preview: dict | None = None, form_values: dict | None = None):
    user_id = request.session.get("user_id")
    tz_name = request.session.get("timezone", "UTC")

    if not user_id:
        characters_q = db.query(Character).filter(False)
        entries_q = db.query(LootEntry).filter(False)
    else:
        characters_q = db.query(Character).filter(Character.user_id == int(user_id))
        character_ids = [c.character_id for c in characters_q.all()]
        characters_q = db.query(Character).filter(Character.user_id == int(user_id))
        entries_q = db.query(LootEntry)
        if character_ids:
            entries_q = entries_q.filter(LootEntry.character_id.in_(character_ids))
        else:
            entries_q = entries_q.filter(False)

    characters = characters_q.order_by(Character.character_name).all()
    character_map = {c.character_id: c.character_name for c in characters}
    entries = entries_q.order_by(LootEntry.created_at.desc()).limit(200).all()

    default_source = _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE)
    default_pct = _setting(db, "loot_valuation_percentage", str(settings.DEFAULT_LOOT_PERCENTAGE))

    return {
        "request": request,
        "characters": characters,
        "character_map": character_map,
        "entries": entries,
        "settings": settings,
        "default_source": default_source,
        "default_pct": default_pct,
        "price_sources": (*SUPPORTED_PRICE_SOURCES, "Janice Buy"),
        "timezone_name": tz_name,
        "preview": preview,
        "form_values": form_values or {},
    }


def _parse_loot_lines(raw_text: str):
    """Parse pasted loot lines.

    Supported formats:
      Item Name<TAB>Quantity
      Item Name    Quantity
      Item Name<TAB>Quantity<TAB>Jita Price  (optional)
    """
    items = []
    errors = []
    for line_no, original in enumerate((raw_text or "").splitlines(), start=1):
        line = original.strip()
        if not line:
            continue
        parts = [p.strip() for p in line.split("\t") if p.strip()]
        if len(parts) >= 2:
            item_name = parts[0]
            qty_text = parts[1]
            price_text = parts[2] if len(parts) >= 3 else ""
        else:
            # If the final whitespace-separated token is a whole number, treat it
            # as the quantity. Otherwise the whole line is the item name and the
            # quantity defaults to 1. This preserves EVE item names that contain
            # numbers, such as "Imperial Navy 1600mm Steel Plates".
            split = line.rsplit(None, 1)
            if len(split) == 2 and split[1].replace(",", "").isdigit():
                item_name, qty_text = split[0].strip(), split[1].strip()
            else:
                item_name, qty_text = line.strip(), "1"
            price_text = ""

        try:
            quantity = int(qty_text.replace(",", ""))
            if quantity < 1:
                raise ValueError()
        except ValueError:
            errors.append(f"Line {line_no}: quantity must be a whole number: {original}")
            continue

        jita_price = 0.0
        if price_text:
            try:
                jita_price = float(price_text.replace(",", ""))
                if jita_price < 0:
                    raise ValueError()
            except ValueError:
                errors.append(f"Line {line_no}: Jita price must be numeric if provided: {original}")
                continue

        if not item_name:
            errors.append(f"Line {line_no}: item name is blank: {original}")
            continue

        items.append({
            "item_name": item_name,
            "quantity": quantity,
            "jita_price": jita_price,
        })
    if not items and not errors:
        errors.append("Paste at least one item line.")
    return items, errors


def _bulk_preview_context(request: Request, db: Session, *, preview_items=None, parse_errors=None, form_values=None, calculated=False):
    ctx = _loot_context(request, db, preview=None, form_values=form_values or {})
    ctx["preview_items"] = preview_items or []
    ctx["parse_errors"] = parse_errors or []
    ctx["calculated"] = calculated
    ctx["preview_total"] = sum(float(row.get("calculated_value") or 0) for row in (preview_items or []))
    return ctx


def _parse_manual_isk_amount(raw_value: str) -> float:
    """Parse a manually entered ISK amount.

    Accepts values like:
      125000000
      125,000,000
      125000000 ISK
      125m / 1.2b / 750k
    """
    text = str(raw_value or "").strip().lower().replace(",", "")
    text = text.replace("isk", "").strip()
    if not text:
        raise ValueError("Amount is required.")

    multiplier = 1.0
    if text.endswith("b"):
        multiplier = 1_000_000_000.0
        text = text[:-1].strip()
    elif text.endswith("m"):
        multiplier = 1_000_000.0
        text = text[:-1].strip()
    elif text.endswith("k"):
        multiplier = 1_000.0
        text = text[:-1].strip()

    amount = float(text) * multiplier
    if amount <= 0:
        raise ValueError("Amount must be greater than zero.")
    return amount


def _find_latest_session_for_manual_loot(db: Session, character_id: int, loot_date: datetime) -> IncomeSession | None:
    """Find the best session for a manually entered loot value.

    Manual loot is commonly entered after the fleet/site is finished.  First try
    an exact in-session match.  If that fails, attach it to the latest session
    for that character when the loot was entered within the normal session
    timeout window after the session ended.
    """
    match = find_matching_session(db, character_id, loot_date, None)
    if match:
        return match

    timeout = timedelta(hours=getattr(settings, "SESSION_TIMEOUT_HOURS", 3))
    latest = (
        db.query(IncomeSession)
        .filter(IncomeSession.source_character_id == character_id)
        .filter(IncomeSession.end_time <= loot_date)
        .order_by(IncomeSession.end_time.desc())
        .first()
    )
    if latest and loot_date - latest.end_time <= timeout:
        return latest
    return latest


@router.get("/loot", response_class=HTMLResponse)
def loot(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    repair_unmatched_loot(db, int(user_id))
    return templates.TemplateResponse("loot.html", _bulk_preview_context(request, db))


@router.post("/loot/preview", response_class=HTMLResponse)
async def preview_loot(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    character_id = int(form.get("character_id") or 0)
    loot_text = str(form.get("loot_text") or "")
    price_source = str(form.get("price_source") or _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE))
    valuation_percentage = float(form.get("valuation_percentage") or _setting(db, "loot_valuation_percentage", str(settings.DEFAULT_LOOT_PERCENTAGE)))

    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    character = db.query(Character).filter(Character.user_id == int(user_id), Character.character_id == character_id).first()
    if not character:
        return Response("Character is not linked to the logged-in user.", status_code=403)

    allowed_sources = (*SUPPORTED_PRICE_SOURCES, "Janice Buy")
    price_source = price_source if price_source in allowed_sources else _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE)
    items, errors = _parse_loot_lines(loot_text)
    preview_items = []
    for row in items:
        preview_items.append({
            "character_id": character_id,
            "character_name": character.character_name if character else str(character_id),
            "item_name": row["item_name"],
            "quantity": int(row["quantity"]),
            "jita_price": float(row.get("jita_price") or 0),
            "price_source": price_source,
            "valuation_percentage": float(valuation_percentage),
            "calculated_value": calculate_loot_value(row["quantity"], row.get("jita_price") or 0, valuation_percentage),
        })
    form_values = {
        "character_id": character_id,
        "loot_text": loot_text,
        "price_source": price_source,
        "valuation_percentage": valuation_percentage,
    }
    return templates.TemplateResponse("loot.html", _bulk_preview_context(request, db, preview_items=preview_items, parse_errors=errors, form_values=form_values, calculated=False))


@router.post("/loot/calculate", response_class=HTMLResponse)
async def calculate_bulk_loot(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    character_id = int(form.get("character_id") or 0)
    price_source = str(form.get("price_source") or _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE))
    valuation_percentage = float(form.get("valuation_percentage") or _setting(db, "loot_valuation_percentage", str(settings.DEFAULT_LOOT_PERCENTAGE)))
    item_names = [str(x).strip() for x in form.getlist("item_name")]
    quantities = form.getlist("quantity")

    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    character = db.query(Character).filter(Character.user_id == int(user_id), Character.character_id == character_id).first()
    if not character:
        return Response("Character is not linked to the logged-in user.", status_code=403)

    allowed_sources = (*SUPPORTED_PRICE_SOURCES, "Janice Buy")
    price_source = price_source if price_source in allowed_sources else _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE)
    errors = []
    preview_items = []
    janice_prices = {}
    if price_source == "Janice Buy":
        try:
            janice_prices = janice_price_items([name for name in item_names if name])
        except JanicePricingError as exc:
            errors.append(str(exc))

    for idx, item_name in enumerate(item_names):
        if not item_name:
            continue
        try:
            quantity = int(str(quantities[idx]).replace(",", ""))
            if quantity < 1:
                raise ValueError()
        except Exception:
            errors.append(f"Row {idx + 1}: quantity must be a whole number.")
            quantity = 0

        type_id = None
        jita_price = 0.0
        price_note = ""
        if item_name and quantity and not errors:
            try:
                if price_source == "Janice Buy":
                    priced = janice_prices.get(item_name.casefold())
                    if not priced:
                        raise JanicePricingError("Item was not returned by Janice.")
                    type_id = priced.type_id
                    jita_price = priced.buy_price
                    price_note = "Janice Jita immediate buy"
                else:
                    resolved = resolve_inventory_type(item_name)
                    type_id = resolved.type_id
                    priced = get_jita_price(type_id, price_source)
                    jita_price = priced.price
                    price_note = priced.location_note
            except (PricingError, JanicePricingError) as exc:
                errors.append(f"Row {idx + 1}: {item_name}: {exc}")
            except Exception as exc:
                errors.append(f"Row {idx + 1}: {item_name}: pricing failed: {exc}")

        preview_items.append({
            "character_id": character_id,
            "character_name": character.character_name,
            "item_name": item_name,
            "type_id": type_id,
            "quantity": quantity,
            "jita_price": jita_price,
            "price_note": price_note,
            "price_source": price_source,
            "valuation_percentage": float(valuation_percentage),
            "calculated_value": calculate_loot_value(quantity, jita_price, valuation_percentage),
        })
    return templates.TemplateResponse("loot.html", _bulk_preview_context(request, db, preview_items=preview_items, parse_errors=errors, form_values={"character_id": character_id, "price_source": price_source, "valuation_percentage": valuation_percentage}, calculated=(len(errors) == 0)))


@router.post("/loot/manual")
async def add_manual_loot(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)

    character_id = int(form.get("manual_character_id") or 0)
    item_name = str(form.get("manual_description") or "Manual Loot Value").strip() or "Manual Loot Value"
    raw_amount = str(form.get("manual_isk_amount") or "")

    owned = db.query(Character).filter(Character.user_id == int(user_id), Character.character_id == character_id).first()
    if not owned:
        return Response("Character is not linked to the logged-in user.", status_code=403)

    try:
        value = _parse_manual_isk_amount(raw_amount)
    except Exception as exc:
        ctx = _bulk_preview_context(
            request,
            db,
            parse_errors=[f"Manual loot amount error: {exc}"],
            form_values={"manual_character_id": character_id, "manual_description": item_name, "manual_isk_amount": raw_amount},
        )
        return templates.TemplateResponse("loot.html", ctx, status_code=400)

    loot_date = datetime.utcnow()
    matched_session = resolve_current_session(db, int(user_id), character_id, loot_date)
    activity_type = matched_session.activity_type if matched_session else None

    entry = LootEntry(
        session_id=matched_session.id if matched_session else None,
        character_id=character_id,
        loot_date=loot_date,
        activity_type=activity_type,
        item_name=item_name,
        type_id=None,
        quantity=1,
        jita_price=value,
        price_source="Manual ISK",
        valuation_percentage=100,
        calculated_value=value,
    )
    db.add(entry)
    db.flush()
    if matched_session:
        recalculate_session_loot(db, matched_session.id)
    db.commit()
    return RedirectResponse("/loot", status_code=303)


@router.post("/loot")
async def add_loot(request: Request, db: Session = Depends(get_db)):
    form = await request.form()
    character_id = int(form.get("character_id") or 0)
    price_source = str(form.get("price_source") or _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE))
    valuation_percentage = float(form.get("valuation_percentage") or _setting(db, "loot_valuation_percentage", str(settings.DEFAULT_LOOT_PERCENTAGE)))
    item_names = form.getlist("item_name")
    type_ids = form.getlist("type_id")
    quantities = form.getlist("quantity")
    jita_prices = form.getlist("jita_price")

    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    owned = db.query(Character).filter(Character.user_id == int(user_id), Character.character_id == character_id).first()
    if not owned:
        return Response("Character is not linked to the logged-in user.", status_code=403)

    loot_date = datetime.utcnow()
    allowed_sources = (*SUPPORTED_PRICE_SOURCES, "Janice Buy")
    price_source = price_source if price_source in allowed_sources else _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE)
    matched_session = resolve_current_session(db, int(user_id), character_id, loot_date)
    touched_sessions = set()

    for idx, item_name in enumerate(item_names):
        item_name = str(item_name).strip()
        if not item_name:
            continue
        quantity = int(str(quantities[idx]).replace(",", ""))
        type_id = int(str(type_ids[idx] or "0")) if idx < len(type_ids) and str(type_ids[idx] or "").isdigit() else None
        jita_price = float(str(jita_prices[idx]).replace(",", ""))
        value = calculate_loot_value(quantity, jita_price, valuation_percentage)
        entry = LootEntry(
            session_id=matched_session.id if matched_session else None,
            character_id=character_id,
            loot_date=loot_date,
            activity_type=matched_session.activity_type if matched_session else None,
            item_name=item_name,
            type_id=type_id,
            quantity=quantity,
            jita_price=jita_price,
            price_source=price_source,
            valuation_percentage=valuation_percentage,
            calculated_value=value,
        )
        db.add(entry)
        if matched_session:
            touched_sessions.add(matched_session.id)

    db.flush()
    for sid in touched_sessions:
        recalculate_session_loot(db, sid)
    db.commit()
    return RedirectResponse("/loot", status_code=303)


@router.post("/loot/{loot_id}/delete")
def delete_loot(loot_id: int, request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    q = (
        db.query(LootEntry)
        .join(Character, LootEntry.character_id == Character.character_id)
        .filter(LootEntry.id == loot_id, Character.user_id == int(user_id))
    )
    entry = q.first()
    if not entry:
        return RedirectResponse("/loot", status_code=303)
    session_id = entry.session_id
    db.delete(entry)
    db.flush()
    if session_id:
        recalculate_session_loot(db, session_id)
    db.commit()
    return RedirectResponse("/loot", status_code=303)



def _owned_character_ids(db: Session, user_id: int):
    return [c.character_id for c in db.query(Character).filter(Character.user_id == int(user_id)).all()]


def _report_bounds(request: Request):
    tz_name = request.session.get("timezone", "UTC")
    range_value = request.query_params.get("range", "30")
    if range_value == "custom":
        start, end = local_date_bounds_to_utc(request.query_params.get("start_date"), request.query_params.get("end_date"), tz_name)
        _, _, tz_abbrev = dashboard_range_bounds_utc("today", tz_name)
        return start, end, tz_name, tz_abbrev, range_value
    start, end, tz_abbrev = dashboard_range_bounds_utc(range_value, tz_name)
    return start, end, tz_name, tz_abbrev, range_value


def _filtered_sessions(db: Session, user_id: int, start, end, character_id: str | None, activity: str | None):
    q = (
        db.query(IncomeSession)
        .join(Character, IncomeSession.source_character_id == Character.character_id)
        .filter(Character.user_id == int(user_id))
    )
    if start:
        q = q.filter(IncomeSession.start_time >= start)
    if end:
        q = q.filter(IncomeSession.start_time <= end)
    if character_id:
        try:
            q = q.filter(IncomeSession.source_character_id == int(character_id))
        except ValueError:
            pass
    if activity and activity != "All":
        q = q.filter(IncomeSession.activity_type == activity)
    return q.order_by(IncomeSession.start_time.desc()).all()


def _report_context(request: Request, db: Session):
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    start, end, tz_name, tz_abbrev, range_value = _report_bounds(request)
    character_id = request.query_params.get("character_id") or ""
    activity = request.query_params.get("activity") or "All"
    characters = db.query(Character).filter(Character.user_id == int(user_id)).order_by(Character.character_name).all()
    character_map = {c.character_id: c.character_name for c in characters}
    sessions = _filtered_sessions(db, int(user_id), start, end, character_id, activity)

    total_wallet = sum(s.wallet_income or 0 for s in sessions)
    total_loot = sum(s.loot_value or 0 for s in sessions)
    total_value = sum(s.total_value or 0 for s in sessions)
    total_hours = sum(max((s.end_time - s.start_time).total_seconds() / 3600, 0.01) for s in sessions)

    by_activity = {}
    by_character = {}
    for srow in sessions:
        act = srow.activity_type or "Unclassified"
        if act not in by_activity:
            by_activity[act] = {"activity": act, "sessions": 0, "wallet": 0, "loot": 0, "total": 0, "hours": 0}
        hours = max((srow.end_time - srow.start_time).total_seconds() / 3600, 0.01)
        by_activity[act]["sessions"] += 1
        by_activity[act]["wallet"] += srow.wallet_income or 0
        by_activity[act]["loot"] += srow.loot_value or 0
        by_activity[act]["total"] += srow.total_value or 0
        by_activity[act]["hours"] += hours

        cname = character_map.get(srow.source_character_id, "Unknown Character")
        if cname not in by_character:
            by_character[cname] = {"character": cname, "sessions": 0, "wallet": 0, "loot": 0, "total": 0, "hours": 0, "Ratting": 0, "Incursions": 0, "Missions": 0}
        by_character[cname]["sessions"] += 1
        by_character[cname]["wallet"] += srow.wallet_income or 0
        by_character[cname]["loot"] += srow.loot_value or 0
        by_character[cname]["total"] += srow.total_value or 0
        by_character[cname]["hours"] += hours
        if act in ("Ratting", "Incursions", "Missions"):
            by_character[cname][act] += srow.wallet_income or 0

    def qs(export_type=None):
        params = {
            "range": range_value,
            "character_id": character_id,
            "activity": activity,
        }
        if range_value == "custom":
            params["start_date"] = request.query_params.get("start_date", "")
            params["end_date"] = request.query_params.get("end_date", "")
        if export_type:
            params["type"] = export_type
        return urlencode({k: v for k, v in params.items() if v not in (None, "")})

    return {
        "request": request,
        "characters": characters,
        "character_map": character_map,
        "sessions": sessions[:200],
        "activity_rows": sorted(by_activity.values(), key=lambda r: r["total"], reverse=True),
        "character_rows": sorted(by_character.values(), key=lambda r: r["total"], reverse=True),
        "total_wallet": total_wallet,
        "total_loot": total_loot,
        "total_value": total_value,
        "total_hours": total_hours,
        "isk_hour": total_value / total_hours if total_hours else 0,
        "selected_range": range_value,
        "selected_character_id": character_id,
        "selected_activity": activity,
        "start_date": request.query_params.get("start_date", ""),
        "end_date": request.query_params.get("end_date", ""),
        "timezone_name": tz_name,
        "timezone_abbrev": tz_abbrev,
        "qs": qs,
    }


def _csv_response(filename: str, headers: list[str], rows: list[list]):
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(headers)
    writer.writerows(rows)
    return Response(
        out.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/reports", response_class=HTMLResponse)
def reports(request: Request, db: Session = Depends(get_db)):
    if not request.session.get("user_id"):
        return RedirectResponse("/auth/login", status_code=303)
    ctx = _report_context(request, db)
    return templates.TemplateResponse("reports.html", ctx)


@router.get("/reports/export")
def reports_export(request: Request, type: str = "sessions", db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    ctx = _report_context(request, db)
    start, end, tz_name, _, _ = _report_bounds(request)
    character_id = request.query_params.get("character_id") or ""
    activity = request.query_params.get("activity") or "All"
    character_ids = _owned_character_ids(db, int(user_id))
    character_map = ctx["character_map"]

    if type == "activity":
        rows = []
        for r in ctx["activity_rows"]:
            hours = r["hours"] or 0
            rows.append([r["activity"], r["sessions"], round(r["wallet"], 2), round(r["loot"], 2), round(r["total"], 2), round(hours, 4), round((r["total"] / hours) if hours else 0, 2)])
        return _csv_response("evewallet_activity_report.csv", ["Activity", "Sessions", "Wallet Income", "Loot Value", "Total Value", "Hours", "ISK/Hour"], rows)

    if type == "characters":
        rows = []
        for r in ctx["character_rows"]:
            hours = r["hours"] or 0
            rows.append([r["character"], r["sessions"], round(r["wallet"], 2), round(r["loot"], 2), round(r["total"], 2), round(r["Ratting"], 2), round(r["Incursions"], 2), round(r["Missions"], 2), round(hours, 4), round((r["total"] / hours) if hours else 0, 2)])
        return _csv_response("evewallet_character_report.csv", ["Character", "Sessions", "Wallet Income", "Loot Value", "Total Value", "Ratting", "Incursions", "Missions", "Hours", "ISK/Hour"], rows)

    if type == "raw_wallet":
        q = db.query(WalletEntry).filter(WalletEntry.character_id.in_(character_ids))
        if start:
            q = q.filter(WalletEntry.entry_date >= start)
        if end:
            q = q.filter(WalletEntry.entry_date <= end)
        if character_id:
            try: q = q.filter(WalletEntry.character_id == int(character_id))
            except ValueError: pass
        if activity and activity != "All":
            q = q.filter(WalletEntry.activity_type == activity)
        entries = q.order_by(WalletEntry.entry_date.desc()).all()
        rows = [[format_local(e.entry_date, tz_name), format_utc(e.entry_date), character_map.get(e.character_id, e.character_id), e.ref_type, e.description or "", round(e.amount or 0, 2), round(e.balance or 0, 2), e.activity_type or "", e.session_id or "", e.esi_journal_id] for e in entries]
        return _csv_response("evewallet_raw_wallet_entries.csv", ["Local Time", "EVE Time", "Character", "Ref Type", "Description", "Amount", "Balance", "Activity", "Session", "ESI ID"], rows)

    if type == "loot":
        q = db.query(LootEntry).filter(LootEntry.character_id.in_(character_ids))
        if start:
            q = q.filter(LootEntry.loot_date >= start)
        if end:
            q = q.filter(LootEntry.loot_date <= end)
        if character_id:
            try: q = q.filter(LootEntry.character_id == int(character_id))
            except ValueError: pass
        if activity and activity != "All":
            q = q.filter(LootEntry.activity_type == activity)
        entries = q.order_by(LootEntry.loot_date.desc()).all()
        rows = [[format_local(e.loot_date, tz_name), format_utc(e.loot_date), character_map.get(e.character_id, e.character_id), e.session_id or "", e.activity_type or "", e.item_name, e.type_id or "", e.quantity, e.price_source, round(e.jita_price or 0, 2), e.valuation_percentage, round(e.calculated_value or 0, 2)] for e in entries]
        return _csv_response("evewallet_loot_entries.csv", ["Local Time", "EVE Time", "Character", "Session", "Activity", "Item", "Type ID", "Quantity", "Price Source", "Jita Price", "Valuation %", "Calculated Value"], rows)

    # Default: sessions export
    rows = []
    for srow in ctx["sessions"]:
        hours = max((srow.end_time - srow.start_time).total_seconds() / 3600, 0.01)
        rows.append([srow.id, character_map.get(srow.source_character_id, srow.source_character_id), srow.activity_type, format_local(srow.start_time, tz_name), format_local(srow.end_time, tz_name), round(hours, 4), round(srow.wallet_income or 0, 2), round(srow.loot_value or 0, 2), round(srow.total_value or 0, 2), round((srow.total_value or 0) / hours, 2)])
    return _csv_response("evewallet_sessions_report.csv", ["Session ID", "Character", "Activity", "Start Local", "End Local", "Hours", "Wallet Income", "Loot Value", "Total Value", "ISK/Hour"], rows)


@router.get("/settings", response_class=HTMLResponse)
def settings_page(request: Request, db: Session = Depends(get_db)):
    if not request.session.get("user_id"):
        return RedirectResponse("/auth/login", status_code=303)
    return templates.TemplateResponse("settings.html", {
        "request": request,
        "settings": settings,
        "loot_price_source": _setting(db, "loot_price_source", settings.DEFAULT_LOOT_PRICE_SOURCE),
        "loot_valuation_percentage": _setting(db, "loot_valuation_percentage", str(settings.DEFAULT_LOOT_PERCENTAGE)),
        "price_sources": (*SUPPORTED_PRICE_SOURCES, "Janice Buy"),
    })


@router.post("/settings/loot")
def save_loot_settings(request: Request, price_source: str = Form(...), valuation_percentage: float = Form(...), db: Session = Depends(get_db)):
    if not request.session.get("user_id"):
        return RedirectResponse("/auth/login", status_code=303)
    if price_source not in SUPPORTED_PRICE_SOURCES:
        price_source = settings.DEFAULT_LOOT_PRICE_SOURCE
    valuation_percentage = max(float(valuation_percentage or 0), 0)
    _set_setting(db, "loot_price_source", price_source)
    _set_setting(db, "loot_valuation_percentage", str(valuation_percentage))
    db.commit()
    return RedirectResponse("/settings", status_code=303)


@router.get("/about", response_class=HTMLResponse)
def about_page(request: Request):
    return templates.TemplateResponse("about.html", {"request": request})
