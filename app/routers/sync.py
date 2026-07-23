from datetime import datetime, timedelta
from fastapi import APIRouter, Request, Depends
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.config import settings
from app.models import Character, Setting
from app.services.esi_wallet import sync_character_wallet
from app.services.session_builder import rebuild_sessions
from app.main_support import templates

router = APIRouter(tags=["sync"])

def status_for(c: Character):
    if not c.last_wallet_sync_at:
        return "Ready", "Now"
    next_time = c.last_wallet_sync_at + timedelta(minutes=settings.ESI_SYNC_COOLDOWN_MINUTES)
    if datetime.utcnow() >= next_time:
        return "Ready", "Now"
    remaining = next_time - datetime.utcnow()
    mins = max(1, int(remaining.total_seconds() // 60) + 1)
    return f"Cooldown", f"{mins} min"



def _sync_status_for_user(db: Session, user_id: int):
    chars = db.query(Character).filter(Character.user_id == int(user_id)).order_by(Character.character_name).all()
    now = datetime.utcnow()
    last_syncs = [c.last_wallet_sync_at for c in chars if c.last_wallet_sync_at]
    last_sync = max(last_syncs) if last_syncs else None
    ready_chars = []
    seconds_remaining_values = []
    for c in chars:
        if not c.last_wallet_sync_at:
            ready_chars.append(c)
            seconds_remaining_values.append(0)
            continue
        next_time = c.last_wallet_sync_at + timedelta(minutes=settings.ESI_SYNC_COOLDOWN_MINUTES)
        remaining = max(0, int((next_time - now).total_seconds()))
        seconds_remaining_values.append(remaining)
        if remaining <= 0:
            ready_chars.append(c)
    seconds_remaining = min(seconds_remaining_values) if seconds_remaining_values else 0
    auto_setting = db.get(Setting, f"auto_sync_enabled:{user_id}")
    auto_enabled = (auto_setting.value == "1") if auto_setting else False
    return {
        "auto_enabled": auto_enabled,
        "allowed": len(ready_chars) > 0,
        "seconds_remaining": seconds_remaining,
        "last_sync": last_sync.isoformat() + "Z" if last_sync else None,
        "ready_count": len(ready_chars),
        "character_count": len(chars),
    }

@router.get("/api/sync/status")
def api_sync_status(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return JSONResponse({"authenticated": False}, status_code=401)
    data = _sync_status_for_user(db, int(user_id))
    data["authenticated"] = True
    return data

@router.post("/api/sync/auto-toggle")
async def api_auto_sync_toggle(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return JSONResponse({"authenticated": False}, status_code=401)
    payload = await request.json()
    enabled = bool(payload.get("enabled"))
    key = f"auto_sync_enabled:{int(user_id)}"
    setting = db.get(Setting, key)
    if setting:
        setting.value = "1" if enabled else "0"
    else:
        db.add(Setting(key=key, value="1" if enabled else "0"))
    db.commit()
    data = _sync_status_for_user(db, int(user_id))
    data["authenticated"] = True
    return data

@router.post("/api/sync/auto-run")
def api_auto_sync_run(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return JSONResponse({"authenticated": False}, status_code=401)
    user_id_int = int(user_id)
    status = _sync_status_for_user(db, user_id_int)
    if not status.get("allowed"):
        status.update({"authenticated": True, "ran": False, "reason": "cooldown"})
        return status

    results = []
    inserted_total = 0
    for c in db.query(Character).filter(Character.user_id == user_id_int).order_by(Character.character_name).all():
        try:
            result = sync_character_wallet(db, c)
            results.append(result)
            try:
                inserted_total += int(result.get("inserted") or 0)
            except Exception:
                pass
        except Exception as e:
            results.append({"character": c.character_name, "status": "error", "inserted": 0, "reason": str(e)})

    sessions_created = 0
    if inserted_total > 0:
        sessions_created = rebuild_sessions(db, user_id=user_id_int, timezone_name=request.session.get("timezone", "UTC"))

    new_status = _sync_status_for_user(db, user_id_int)
    new_status.update({
        "authenticated": True,
        "ran": True,
        "inserted_total": inserted_total,
        "sessions_created": sessions_created,
        "characters": results,
        "message": "Auto sync complete." if inserted_total else "Auto sync complete. No new wallet entries.",
    })
    return new_status

@router.get("/sync", response_class=HTMLResponse)
def sync_page(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    chars = db.query(Character).filter(Character.user_id == int(user_id)).order_by(Character.character_name).all()
    rows = []
    any_ready = False
    for c in chars:
        s, next_available = status_for(c)
        any_ready = any_ready or s == "Ready"
        rows.append({"character": c, "status": s, "next_available": next_available})
    return templates.TemplateResponse("sync.html", {"request": request, "rows": rows, "any_ready": any_ready, "results": request.session.pop("sync_results", None)})

@router.post("/sync")
def sync_all(request: Request, db: Session = Depends(get_db)):
    results = []
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    for c in db.query(Character).filter(Character.user_id == int(user_id)).order_by(Character.character_name).all():
        try:
            results.append(sync_character_wallet(db, c))
        except Exception as e:
            results.append({"character": c.character_name, "status": "error", "inserted": 0, "reason": str(e)})
    created = rebuild_sessions(db, user_id=user_id, timezone_name=request.session.get("timezone", "UTC"))
    request.session["sync_results"] = {"characters": results, "sessions_created": created}
    return RedirectResponse("/sync", status_code=303)

@router.post("/sync/rebuild-sessions")
def rebuild_sessions_only(request: Request, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    created = rebuild_sessions(db, user_id=user_id, timezone_name=request.session.get("timezone", "UTC"))
    request.session["sync_results"] = {"mode": "rebuild", "sessions_created": created, "characters": [], "message": "Sessions rebuilt from existing wallet data. No ESI sync was performed."}
    return RedirectResponse("/sync", status_code=303)
