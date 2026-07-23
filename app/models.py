from datetime import datetime
from sqlalchemy import Integer, String, DateTime, Float, Boolean, Text, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.database import Base

class Character(Base):
    __tablename__ = "characters"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    character_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    character_name: Mapped[str] = mapped_column(String(128), index=True)
    owner_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    refresh_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_wallet_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class WalletEntry(Base):
    __tablename__ = "wallet_entries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    esi_journal_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    character_id: Mapped[int] = mapped_column(Integer, ForeignKey("characters.character_id"), index=True)
    entry_date: Mapped[datetime] = mapped_column(DateTime, index=True)
    ref_type: Mapped[str] = mapped_column(String(100), index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    amount: Mapped[float] = mapped_column(Float, default=0)
    balance: Mapped[float | None] = mapped_column(Float, nullable=True)
    activity_type: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    session_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("sessions.id"), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class Session(Base):
    __tablename__ = "sessions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    activity_type: Mapped[str] = mapped_column(String(50), index=True)
    session_type: Mapped[str] = mapped_column(String(50), default="Single Character")
    source_character_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("characters.character_id"), nullable=True, index=True)
    start_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    end_time: Mapped[datetime] = mapped_column(DateTime, index=True)
    fleet_size: Mapped[int] = mapped_column(Integer, default=1)
    apply_fleet_multiplier: Mapped[bool] = mapped_column(Boolean, default=False)
    wallet_income: Mapped[float] = mapped_column(Float, default=0)
    loot_value: Mapped[float] = mapped_column(Float, default=0)
    total_value: Mapped[float] = mapped_column(Float, default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class LootEntry(Base):
    __tablename__ = "loot_entries"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    session_id: Mapped[int] = mapped_column(Integer, ForeignKey("sessions.id"), index=True)
    item_name: Mapped[str] = mapped_column(String(255))
    type_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    price_source: Mapped[str] = mapped_column(String(50))
    jita_price: Mapped[float] = mapped_column(Float, default=0)
    valuation_percentage: Mapped[float] = mapped_column(Float, default=100)
    calculated_value: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
