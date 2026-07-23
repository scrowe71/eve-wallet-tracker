from fastapi import APIRouter, Request, Depends
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Character
from app.main_support import templates

router = APIRouter(tags=["characters"])

@router.get("/characters", response_class=HTMLResponse)
def characters(request: Request, linked: int | None = None, db: Session = Depends(get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return RedirectResponse("/auth/login", status_code=303)
    rows = db.query(Character).filter(Character.user_id == int(user_id)).order_by(Character.character_name).all()
    return templates.TemplateResponse("characters.html", {"request": request, "characters": rows, "linked": linked, "logged_in": True})
