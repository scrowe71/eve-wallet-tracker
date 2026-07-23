from __future__ import annotations

import argparse
import os
import shutil
from datetime import datetime
from pathlib import Path


def desktop_db() -> Path:
    base = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    target = base / "EVEWalletTracker" / "data" / "evewallet.db"
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Import an existing EVE Wallet Tracker SQLite database.")
    parser.add_argument("source", help="Path to the evewallet.db copied from the Linux server")
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"Database not found: {source}")

    target = desktop_db()
    if target.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target.with_name(f"evewallet-before-import-{stamp}.db")
        shutil.copy2(target, backup)
        print(f"Backed up existing desktop database to {backup}")

    shutil.copy2(source, target)
    print(f"Imported {source} to {target}")


if __name__ == "__main__":
    main()
