from fastapi import APIRouter, Request, Form
from fastapi.responses import JSONResponse
from zoneinfo import ZoneInfo

router = APIRouter(tags=["timezone"])

@router.post("/timezone")
def set_timezone(request: Request, timezone_name: str = Form(...)):
    try:
        ZoneInfo(timezone_name)
    except Exception:
        timezone_name = "UTC"
    request.session["timezone"] = timezone_name
    return JSONResponse({"ok": True, "timezone": timezone_name})
