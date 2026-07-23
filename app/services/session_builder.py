from datetime import timedelta
from sqlalchemy.orm import Session
from app.config import settings
from app.models import WalletEntry, Session as IncomeSession, LootEntry, Character
from app.services.esi_wallet import classify_wallet_entry
from app.utils.timezone import to_local
from app.services.loot_valuation import reattach_and_recalculate_loot

SUPPORTED = {"Ratting", "Incursions", "Missions"}


def rebuild_sessions(db: Session, user_id: int | str | None = None, timezone_name: str = "UTC"):
    """Rebuild generated sessions from existing wallet rows.

    ESI timestamps stay stored in UTC.  The 3-hour gap is calculated from the
    same instant converted into the user's browser timezone. This keeps the
    rebuild behavior aligned with the dates/times the user sees in the UI while
    preserving UTC storage for reliable ESI syncing.
    """
    query = db.query(WalletEntry)
    if user_id:
        query = query.join(Character, WalletEntry.character_id == Character.character_id).filter(Character.user_id == int(user_id))

    # Reclassify existing wallet rows first so rule changes apply to already-synced data.
    for entry in query.all():
        entry.activity_type = classify_wallet_entry(entry.ref_type, entry.description)
    db.commit()

    # Delete only the sessions for this user when a user is supplied.
    if user_id:
        user_character_ids = [row[0] for row in db.query(Character.character_id).filter(Character.user_id == int(user_id)).all()]
        if user_character_ids:
            db.query(IncomeSession).filter(IncomeSession.source_character_id.in_(user_character_ids)).delete(synchronize_session=False)
            db.query(WalletEntry).filter(WalletEntry.character_id.in_(user_character_ids)).update({WalletEntry.session_id: None}, synchronize_session=False)
    else:
        db.query(IncomeSession).delete()
        db.query(WalletEntry).update({WalletEntry.session_id: None})
    db.commit()

    created = 0
    timeout = timedelta(hours=settings.SESSION_TIMEOUT_HOURS)

    character_query = db.query(WalletEntry.character_id).filter(WalletEntry.activity_type.in_(SUPPORTED)).distinct()
    if user_id:
        character_query = character_query.join(Character, WalletEntry.character_id == Character.character_id).filter(Character.user_id == int(user_id))
    character_ids = [row[0] for row in character_query.all()]

    for character_id in character_ids:
        for activity in SUPPORTED:
            entries = db.query(WalletEntry).filter(
                WalletEntry.character_id == character_id,
                WalletEntry.activity_type == activity,
            ).order_by(WalletEntry.entry_date).all()
            current = []
            prev_local = None
            for entry in entries:
                entry_local = to_local(entry.entry_date, timezone_name)
                if prev_local and entry_local and entry_local - prev_local >= timeout:
                    created += _create_session(db, character_id, activity, current)
                    current = []
                current.append(entry)
                prev_local = entry_local
            if current:
                created += _create_session(db, character_id, activity, current)

    # Reattach manual loot entries to the newly rebuilt sessions and refresh
    # session loot/total values. This prevents session rebuilds from orphaning
    # loot entries added by the user.
    reattach_and_recalculate_loot(db, user_id=user_id)
    return created


def _create_session(db: Session, character_id: int, activity: str, entries: list[WalletEntry]) -> int:
    if not entries:
        return 0
    start = min(e.entry_date for e in entries)
    end = max(e.entry_date for e in entries)
    wallet_income = sum(e.amount for e in entries)
    s = IncomeSession(
        activity_type=activity,
        session_type="Single Character",
        source_character_id=character_id,
        start_time=start,
        end_time=end,
        wallet_income=wallet_income,
        loot_value=0,
        total_value=wallet_income,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    for e in entries:
        e.session_id = s.id
    db.commit()
    return 1
