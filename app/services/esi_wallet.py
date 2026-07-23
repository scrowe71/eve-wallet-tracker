from datetime import datetime, timedelta
import requests
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from app.config import settings
from app.models import Character, WalletEntry
from app.services.eve_sso import refresh_access_token, token_expires_at

ESI_BASE = "https://esi.evetech.net/latest"

# Only true activity income belongs in reports/sessions. Day-to-day transfers,
# donations, withdrawals, fees, taxes, purchases, and other spending remain visible
# in Raw Data but are excluded from dashboard/session/ISK-hour calculations.
EXCLUDED_REF_TYPES = {
    "player_donation",
    "corporation_account_withdrawal",
    "daily_goal_payouts",
    "market_escrow",
    "contract_brokers_fee",
    "asset_safety_recovery_tax",
    "jump_clone_activation_fee",
    "jump_clone_installation_fee",
    "repair_bill",
    "skill_purchase",
    "structure_gate_jump",
    # Tax rows are excluded because observed ESI imports are already net of tax.
    # Keeping separate tax rows in calculations would double-subtract.
    "corporate_reward_tax",
    "corporation_tax",
}

REF_ACTIVITY_MAP = {
    "bounty_prizes": "Ratting",
    "ess_escrow_transfer": "Ratting",
    "freelance_jobs_reward": "Ratting",
    "freelance_jobs_reward_corporation_tax": "Ratting",
    "agent_mission_reward": "Missions",
    "agent_mission_time_bonus_reward": "Missions",
    "mission_reward": "Missions",
    "mission_time_bonus_reward": "Missions",
    "incursion_payout": "Incursions",
    "corporate_reward_payout": "Incursions",
}

def classify_wallet_entry(ref_type: str, description: str | None = None) -> str | None:
    lower = (ref_type or "").lower()
    desc = (description or "").lower()

    if lower in EXCLUDED_REF_TYPES:
        return None

    # Manual transfers/donations are normal day-to-day ISK movement, not income.
    if "deposited cash" in desc or "player donation" in desc:
        return None

    # Tax rows are not activity income. The imported reward rows are already net
    # in the observed journal data, so separate tax rows must not be counted.
    if "tax on concord rewards" in desc or "tax on pirate bounties" in desc:
        return None

    # Incursion payouts appear in the wallet journal as CONCORD service rewards.
    # Example: "CONCORD rewarded Misumii for services performed."
    if "concord rewarded" in desc and "for services performed" in desc:
        return "Incursions"

    if lower in REF_ACTIVITY_MAP:
        return REF_ACTIVITY_MAP[lower]
    if "bounty" in lower or "ess" in lower:
        return "Ratting"
    if "mission" in lower:
        return "Missions"
    if "incursion" in lower or "concord" in lower:
        return "Incursions"
    return None

def classify_ref_type(ref_type: str) -> str | None:
    return classify_wallet_entry(ref_type, None)

def ensure_valid_access_token(db: Session, character: Character) -> str:
    now = datetime.utcnow()
    if character.access_token and character.token_expires_at and character.token_expires_at > now + timedelta(minutes=2):
        return character.access_token
    if not character.refresh_token:
        raise RuntimeError(f"{character.character_name} has no refresh token")
    tokens = refresh_access_token(character.refresh_token)
    character.access_token = tokens["access_token"]
    if tokens.get("refresh_token"):
        character.refresh_token = tokens["refresh_token"]
    character.token_expires_at = token_expires_at(tokens)
    db.commit()
    db.refresh(character)
    return character.access_token

def sync_character_wallet(db: Session, character: Character) -> dict:
    now = datetime.utcnow()
    cooldown = timedelta(minutes=settings.ESI_SYNC_COOLDOWN_MINUTES)
    if character.last_wallet_sync_at and now - character.last_wallet_sync_at < cooldown:
        return {"character": character.character_name, "status": "skipped", "inserted": 0, "reason": "cooldown"}

    access_token = ensure_valid_access_token(db, character)
    inserted = 0
    page = 1
    while True:
        url = f"{ESI_BASE}/characters/{character.character_id}/wallet/journal/"
        r = requests.get(url, headers={"Authorization": f"Bearer {access_token}", "User-Agent": "EVEWalletTracker/1.0"}, params={"page": page}, timeout=30)
        if r.status_code == 404:
            break
        r.raise_for_status()
        rows = r.json()
        if not rows:
            break
        for item in rows:
            amount = float(item.get("amount") or 0)
            if amount <= 0:
                continue
            entry = WalletEntry(
                esi_journal_id=int(item["id"]),
                character_id=character.character_id,
                entry_date=datetime.fromisoformat(item["date"].replace("Z", "+00:00")).replace(tzinfo=None),
                ref_type=item.get("ref_type", ""),
                description=item.get("description"),
                amount=amount,
                balance=float(item["balance"]) if item.get("balance") is not None else None,
                activity_type=classify_wallet_entry(item.get("ref_type", ""), item.get("description")),
            )
            db.add(entry)
            try:
                db.commit()
                inserted += 1
            except IntegrityError:
                db.rollback()
        if len(rows) < 1000:
            break
        page += 1
    character.last_wallet_sync_at = now
    db.commit()
    return {"character": character.character_name, "status": "synced", "inserted": inserted}
