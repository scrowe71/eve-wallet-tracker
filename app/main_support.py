from fastapi.templating import Jinja2Templates
from app.utils.timezone import format_local, format_utc

templates = Jinja2Templates(directory="app/templates")

def format_isk(value):
    try:
        return f"{float(value):,.0f} ISK"
    except Exception:
        return "0 ISK"

def localtime_filter(value, tz_name=None):
    return format_local(value, tz_name)

def evetime_filter(value):
    return format_utc(value)

templates.env.filters["isk"] = format_isk
templates.env.filters["localtime"] = localtime_filter
templates.env.filters["evetime"] = evetime_filter
