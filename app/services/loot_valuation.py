from __future__ import annotations

from datetime import datetime
from sqlalchemy.orm import Session
from app.models import LootEntry, Session as IncomeSession, Character

SUPPORTED_PRICE_SOURCES = ("Jita Buy", "Jita Sell")
SUPPORTED_ACTIVITIES = ("Ratting", "Incursions", "Missions")


def calculate_loot_value(quantity: int, jita_price: float, valuation_percentage: float) -> float:
    quantity = max(int(quantity or 0), 0)
    jita_price = max(float(jita_price or 0), 0)
    valuation_percentage = max(float(valuation_percentage or 0), 0)
    return quantity * jita_price * (valuation_percentage / 100.0)


def find_matching_session(db: Session, character_id: int | None, loot_date: datetime | None, activity_type: str | None) -> IncomeSession | None:
    if not character_id or not loot_date:
        return None
    q = db.query(IncomeSession).filter(
        IncomeSession.source_character_id == character_id,
        IncomeSession.start_time <= loot_date,
        IncomeSession.end_time >= loot_date,
    )
    if activity_type:
        q = q.filter(IncomeSession.activity_type == activity_type)
    return q.order_by(IncomeSession.start_time.desc()).first()


def recalculate_session_loot(db: Session, session_id: int) -> None:
    session = db.query(IncomeSession).filter(IncomeSession.id == session_id).first()
    if not session:
        return
    loot_total = db.query(LootEntry).filter(LootEntry.session_id == session_id).all()
    session.loot_value = sum(row.calculated_value or 0 for row in loot_total)
    session.total_value = (session.wallet_income or 0) + (session.loot_value or 0)


def reattach_and_recalculate_loot(db: Session, user_id: int | str | None = None) -> None:
    """Attach dated loot rows to matching rebuilt sessions and refresh totals."""
    session_q = db.query(IncomeSession)
    character_q = db.query(Character)
    if user_id:
        character_q = character_q.filter(Character.user_id == int(user_id))
        character_ids = [row.character_id for row in character_q.all()]
        if not character_ids:
            return
        session_q = session_q.filter(IncomeSession.source_character_id.in_(character_ids))
        loot_q = db.query(LootEntry).filter(LootEntry.character_id.in_(character_ids))
    else:
        loot_q = db.query(LootEntry)

    sessions = session_q.all()
    for session in sessions:
        session.loot_value = 0
        session.total_value = session.wallet_income or 0

    for loot in loot_q.all():
        if user_id:
            # Local import avoids a module-level circular dependency.
            from app.services.session_resolver import resolve_current_session
            match = resolve_current_session(db, int(user_id), loot.character_id, loot.loot_date, loot.activity_type)
        else:
            match = find_matching_session(db, loot.character_id, loot.loot_date, loot.activity_type)
        loot.session_id = match.id if match else None
        if match:
            loot.activity_type = match.activity_type

    db.flush()

    touched = {row.session_id for row in loot_q.all() if row.session_id}
    for sid in touched:
        recalculate_session_loot(db, sid)
    db.commit()
