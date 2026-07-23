from fastapi import FastAPI, Request
from fastapi.responses import RedirectResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from app.config import settings
from app.database import init_db
from app.routers import dashboard, auth, characters, sync, sessions, raw_data, simple_pages, timezone
from app.security import is_public_path, current_user_id

app = FastAPI(title=settings.APP_NAME)
app.mount("/static", StaticFiles(directory="app/static"), name="static")

@app.middleware("http")
async def require_eve_login(request: Request, call_next):
    """Require EVE SSO login for every application page and data route.

    Public paths are limited to EVE SSO auth, static assets, favicon, and
    browser timezone detection. This prevents unauthenticated visitors from
    seeing dashboard, character, raw wallet, session, loot, report, or settings
    data.
    """
    path = request.url.path
    if is_public_path(path):
        return await call_next(request)
    if current_user_id(request) is None:
        if request.method.upper() == "GET":
            return RedirectResponse("/auth/login", status_code=303)
        return PlainTextResponse("Login required", status_code=401)
    return await call_next(request)

# SessionMiddleware must be added after the auth middleware is registered so it
# wraps the auth middleware and request.session exists before login checks run.
app.add_middleware(SessionMiddleware, secret_key=settings.SECRET_KEY)

init_db()

app.include_router(dashboard.router)
app.include_router(auth.router)
app.include_router(characters.router)
app.include_router(sync.router)
app.include_router(sessions.router)
app.include_router(raw_data.router)
app.include_router(simple_pages.router)
app.include_router(timezone.router)
