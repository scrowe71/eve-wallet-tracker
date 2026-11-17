"""Turn the old evewallet.db (SQLite, from the DigitalOcean droplet) into a SQL
file of INSERT statements that can be loaded into the D1 database.

Usage:
    python scripts/sqlite_to_d1.py path/to/evewallet.db d1-data.sql

The output contains your characters' ESI refresh tokens. Do not commit it.
"""
import sqlite3
import sys

TABLES = ["users", "app_settings", "characters", "sessions", "wallet_entries", "loot_entries"]
ROWS_PER_INSERT = 50


def literal(value):
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, bytes):
        return "X'" + value.hex() + "'"
    return "'" + str(value).replace("'", "''") + "'"


def main(src, dest):
    con = sqlite3.connect(src)
    with open(dest, "w", encoding="utf-8", newline="\n") as out:
        out.write("-- Data exported from the original EVE Wallet Tracker SQLite database.\n")
        for table in TABLES:
            cols = [row[1] for row in con.execute(f"PRAGMA table_info({table})")]
            col_list = ", ".join(f'"{c}"' for c in cols)
            rows = con.execute(f"SELECT {col_list} FROM {table} ORDER BY rowid").fetchall()
            out.write(f"\n-- {table}: {len(rows)} rows\n")
            for i in range(0, len(rows), ROWS_PER_INSERT):
                chunk = rows[i:i + ROWS_PER_INSERT]
                values = ",\n".join("(" + ", ".join(literal(v) for v in row) + ")" for row in chunk)
                out.write(f"INSERT INTO {table} ({col_list}) VALUES\n{values};\n")
    print(f"Wrote {dest}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
