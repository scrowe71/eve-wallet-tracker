from __future__ import annotations

from datetime import datetime, timedelta
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Character, LootEntry, Session as IncomeSession
from app.services.loot_valuation import recalculate_session_loot


def resolve_current_session(
    db: Session,
    user_id: int,
    character_id: int | None,
    event_time: datetime | None = None,
    activity_type: str | None = None,
) -> IncomeSession | None:
    """Resolve one session consistently for every loot import path.

    Priority:
    1. Exact session containing event_time for the selected character.
    2. Exact session containing event_time for any character owned by the user.
    3. Most recently ended owned session within the configured timeout.
    4. Most recent owned session as a final fallback.
    """
    event_time = event_time or datetime.utcnow()
    character_ids = [row[0] for row in db.query(Character.character_id).filter(Character.user_id == int(user_id)).all()]
    if not character_ids:
        return None

    def apply_activity(query):
        return query.filter(IncomeSession.activity_type == activity_type) if activity_type else query

    if character_id in character_ids:
        q = db.query(IncomeSession).filter(
            IncomeSession.source_character_id == character_id,
            IncomeSession.start_time <= event_time,
            IncomeSession.end_time >= event_time,
        )
        exact = apply_activity(q).order_by(IncomeSession.end_time.desc()).first()
        if exact:
            return exact

    q = db.query(IncomeSession).filter(
        IncomeSession.source_character_id.in_(character_ids),
        IncomeSession.start_time <= event_time,
        IncomeSession.end_time >= event_time,
    )
    exact_any = apply_activity(q).order_by(IncomeSession.end_time.desc()).first()
    if exact_any:
        return exact_any

    q = db.query(IncomeSession).filter(
        IncomeSession.source_character_id.in_(character_ids),
        IncomeSession.end_time <= event_time,
    )
    latest = apply_activity(q).order_by(IncomeSession.end_time.desc()).first()
    if latest:
        timeout = timedelta(hours=max(int(settings.SESSION_TIMEOUT_HOURS), 0))
        if event_time - latest.end_time <= timeout:
            return latest

    q = db.query(IncomeSession).filter(IncomeSession.source_character_id.in_(character_ids))
    return apply_activity(q).order_by(IncomeSession.end_time.desc()).first()


def repair_unmatched_loot(db: Session, user_id: int) -> int:
    character_ids = [row[0] for row in db.query(Character.character_id).filter(Character.user_id == int(user_id)).all()]
    if not character_ids:
        return 0
    rows = db.query(LootEntry).filter(
        LootEntry.character_id.in_(character_ids),
        LootEntry.session_id.is_(None),
    ).order_by(LootEntry.loot_date.asc()).all()
    touched: set[int] = set()
    repaired = 0
    for row in rows:
        match = resolve_current_session(db, int(user_id), row.character_id, row.loot_date, row.activity_type)
        if match:
            row.session_id = match.id
            row.activity_type = match.activity_type
            touched.add(match.id)
            repaired += 1
    db.flush()
    for session_id in touched:
        recalculate_session_loot(db, session_id)
    if repaired:
        db.commit()
    return repaired
