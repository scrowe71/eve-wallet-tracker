from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse, StreamingResponse, RedirectResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Character, WalletEntry
from app.main_support import templates
from app.utils.timezone import local_date_bounds_to_utc, format_local, format_utc

router = APIRouter(tags=["raw-data"])


def _parse_date(value: Optional[str], end_of_day: bool = False) -> Optional[datetime]:
    if not value:
        return None
    try:
        parsed = datetime.strptime(value, "%Y-%m-%d")
        if end_of_day:
            return parsed + timedelta(days=1)
        return parsed
    except ValueError:
        return None


def _wallet_query(
    db: Session,
    user_id: int,
    character_id: Optional[int],
    ref_type: Optional[str],
    activity_type: Optional[str],
    amount_filter: str,
    start_date: Optional[str],
    end_date: Optional[str],
    search: Optional[str],
    timezone_name: str = "UTC",
):
    query = (
        db.query(WalletEntry, Character)
        .join(Character, WalletEntry.character_id == Character.character_id)
        .filter(Character.user_id == user_id)
    )

    if character_id:
        query = query.filter(WalletEntry.character_id == character_id)
    if ref_type:
        query = query.filter(WalletEntry.ref_type == ref_type)
    if activity_type:
        if activity_type == "Uncategorized":
            query = query.filter(or_(WalletEntry.activity_type.is_(None), WalletEntry.activity_type == ""))
        else:
            query = query.filter(WalletEntry.activity_type == activity_type)

    start, end = local_date_bounds_to_utc(start_date, end_date, timezone_name)
    if start:
        query = query.filter(WalletEntry.entry_date >= start)
    if end:
        query = query.filter(WalletEntry.entry_date < end)

    if amount_filter == "positive":
        query = query.filter(WalletEntry.amount > 0)
    elif amount_filter == "negative":
        query = query.filter(WalletEntry.amount < 0)
    elif amount_filter == "zero":
        query = query.filter(WalletEntry.amount == 0)

    if search:
        like = f"%{search.strip()}%"
        query = query.filter(or_(WalletEntry.description.ilike(like), WalletEntry.ref_type.ilike(like)))

    return query


@router.get("/raw-data", response_class=HTMLResponse)
def raw_data_page(
    request: Request,
    db: Session = Depends(get_db),
    character_id: Optional[int] = Query(default=None),
    ref_type: Optional[str] = Query(default=None),
    activity_type: Optional[str] = Query(default=None),
    amount_filter: str = Query(default="all"),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    page: int = Query(default=1, ge=1),
):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)

    user_id = int(user_id)
    characters = db.query(Character).filter(Character.user_id == user_id).order_by(Character.character_name).all()
    ref_types = [r[0] for r in db.query(WalletEntry.ref_type).join(Character, WalletEntry.character_id == Character.character_id).filter(Character.user_id == user_id).distinct().order_by(WalletEntry.ref_type).all()]
    activity_types = [r[0] for r in db.query(WalletEntry.activity_type).join(Character, WalletEntry.character_id == Character.character_id).filter(Character.user_id == user_id, WalletEntry.activity_type.isnot(None)).distinct().order_by(WalletEntry.activity_type).all()]

    per_page = 100
    tz_name = request.session.get("timezone", "UTC")
    query = _wallet_query(db, user_id, character_id, ref_type, activity_type, amount_filter, start_date, end_date, search, tz_name)
    total_rows = query.count()
    rows = (
        query.order_by(WalletEntry.entry_date.desc(), WalletEntry.esi_journal_id.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
        .all()
    )

    total_pages = max(1, (total_rows + per_page - 1) // per_page)
    params = {
        "character_id": character_id or "",
        "ref_type": ref_type or "",
        "activity_type": activity_type or "",
        "amount_filter": amount_filter,
        "start_date": start_date or "",
        "end_date": end_date or "",
        "search": search or "",
    }

    return templates.TemplateResponse(
        "raw_data.html",
        {
            "request": request,
            "logged_out": False,
            "rows": rows,
            "characters": characters,
            "ref_types": ref_types,
            "activity_types": activity_types,
            "params": params,
            "page": page,
            "total_pages": total_pages,
            "total_rows": total_rows,
            "per_page": per_page,
            "timezone_name": tz_name,
        },
    )


@router.get("/raw-data/export")
def raw_data_export(
    request: Request,
    db: Session = Depends(get_db),
    character_id: Optional[int] = Query(default=None),
    ref_type: Optional[str] = Query(default=None),
    activity_type: Optional[str] = Query(default=None),
    amount_filter: str = Query(default="all"),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Local Date", "EVE Time UTC", "Character", "Ref Type", "Description", "Amount", "Balance", "Activity Type", "Session ID", "ESI Journal ID"])

    tz_name = request.session.get("timezone", "UTC")
    query = _wallet_query(db, int(user_id), character_id, ref_type, activity_type, amount_filter, start_date, end_date, search, tz_name)
    for entry, character in query.order_by(WalletEntry.entry_date.desc(), WalletEntry.esi_journal_id.desc()).all():
            writer.writerow([
                format_local(entry.entry_date, tz_name),
                format_utc(entry.entry_date),
                character.character_name,
                entry.ref_type,
                entry.description or "",
                entry.amount,
                entry.balance if entry.balance is not None else "",
                entry.activity_type or "",
                entry.session_id or "",
                entry.esi_journal_id,
            ])

    output.seek(0)
    filename = f"evewallet_raw_data_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
