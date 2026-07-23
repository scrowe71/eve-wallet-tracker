import secrets
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, Character
from app.services.eve_sso import build_authorize_url, exchange_code_for_token, character_info_from_token, token_expires_at

router = APIRouter(prefix="/auth", tags=["auth"])


def _begin_sso(request: Request, mode: str):
    state = secrets.token_urlsafe(32)
    request.session["eve_sso_state"] = state
    request.session["eve_sso_mode"] = mode
    return RedirectResponse(build_authorize_url(state))


@router.get("/login")
def login(request: Request):
    """Log in with EVE SSO. If the character is new, create a local user."""
    return _begin_sso(request, "login")


@router.get("/add-character")
def add_character(request: Request):
    """Link an additional EVE character to the current logged-in account group."""
    if not request.session.get("user_id"):
        return RedirectResponse("/auth/login", status_code=303)
    return _begin_sso(request, "add_character")


@router.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse("/", status_code=303)


@router.get("/callback")
def callback(request: Request, code: str | None = None, state: str | None = None, db: Session = Depends(get_db)):
    expected = request.session.get("eve_sso_state")
    if not expected or state != expected:
        raise HTTPException(status_code=400, detail="Invalid EVE SSO state")
    if not code:
        raise HTTPException(status_code=400, detail="Missing EVE SSO code")

    tokens = exchange_code_for_token(code)
    info = character_info_from_token(tokens["access_token"])
    character_id = info["character_id"]
    character_name = info["character_name"]
    owner_hash = info.get("owner_hash")

    mode = request.session.get("eve_sso_mode") or "login"
    current_user_id = request.session.get("user_id")

    character = db.query(Character).filter(Character.character_id == character_id).first()

    if mode == "add_character":
        if not current_user_id:
            request.session.clear()
            raise HTTPException(status_code=400, detail="Login required before adding a character.")
        user = db.query(User).filter(User.id == int(current_user_id)).first()
        if not user:
            request.session.clear()
            raise HTTPException(status_code=400, detail="Login session expired. Log in again.")
        if character and character.user_id != user.id:
            raise HTTPException(status_code=400, detail="That EVE character is already linked to another local user.")
    else:
        if character:
            user = db.query(User).filter(User.id == character.user_id).first()
        else:
            user = db.query(User).filter(User.eve_character_id == character_id).first()
            if not user:
                user = User(eve_character_id=character_id, eve_character_name=character_name, owner_hash=owner_hash)
                db.add(user)
                db.flush()
        request.session["user_id"] = user.id
        request.session["user_character_name"] = user.eve_character_name

    if not character:
        character = Character(user_id=user.id, character_id=character_id, character_name=character_name)
        db.add(character)

    character.user_id = user.id
    character.character_name = character_name
    character.owner_hash = owner_hash
    character.access_token = tokens.get("access_token")
    character.refresh_token = tokens.get("refresh_token")
    character.token_expires_at = token_expires_at(tokens)

    # Keep the user's displayed name fresh if this login is their primary character.
    if user.eve_character_id == character_id:
        user.eve_character_name = character_name
        user.owner_hash = owner_hash
        request.session["user_character_name"] = character_name

    db.commit()
    request.session.pop("eve_sso_state", None)
    request.session.pop("eve_sso_mode", None)
    return RedirectResponse("/characters?linked=1", status_code=303)
