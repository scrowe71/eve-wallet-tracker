from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.config import settings

connect_args = {"check_same_thread": False} if settings.DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(settings.DATABASE_URL, connect_args=connect_args, future=True)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False, future=True)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    from app import models  # noqa
    Base.metadata.create_all(bind=engine)
    if settings.DATABASE_URL.startswith("sqlite"):
        _ensure_sqlite_loot_columns()

def _ensure_sqlite_loot_columns():
    """Small SQLite migration helper for early milestones.

    SQLite create_all does not add columns to existing tables, so this adds the
    nullable loot columns needed by the loot valuation milestone without forcing
    a database reset.
    """
    with engine.begin() as conn:
        try:
            rows = conn.execute(text("PRAGMA table_info(loot_entries)")).mappings().all()
        except Exception:
            return
        existing = {row["name"] for row in rows}
        migrations = {
            "character_id": "ALTER TABLE loot_entries ADD COLUMN character_id INTEGER",
            "loot_date": "ALTER TABLE loot_entries ADD COLUMN loot_date DATETIME",
            "activity_type": "ALTER TABLE loot_entries ADD COLUMN activity_type VARCHAR(50)",
        }
        for column, sql in migrations.items():
            if column not in existing:
                conn.execute(text(sql))
