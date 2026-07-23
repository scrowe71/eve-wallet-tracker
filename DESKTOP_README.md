# EVE Wallet Tracker Desktop — First Conversion Build

This package runs the existing FastAPI application entirely on a Windows PC. It starts a local-only service on `127.0.0.1:8765` and displays the existing interface in a desktop window.

## What this eliminates

After migration and testing, the DigitalOcean server, Nginx, Certbot, public domain, systemd service, SSH, and WinSCP deployment are no longer required for EVE Wallet Tracker.

## Important EVE developer setting

Add this exact callback URL to the EVE developer application:

`http://127.0.0.1:8765/auth/callback`

Do not remove the current web callback until the desktop edition is tested and your data is migrated.

## First test on Windows

1. Install Python 3.12 x64 if it is not installed.
2. Run `configure_desktop.bat` and enter the EVE client ID, EVE client secret, and Janice API key.
3. Run `run_desktop_dev.bat`.
4. Sign in through EVE SSO and verify Dashboard, Characters, Sync, Sessions, and Loot.

Settings and data are stored under:

`%LOCALAPPDATA%\EVEWalletTracker`

The database is stored at:

`%LOCALAPPDATA%\EVEWalletTracker\data\evewallet.db`

Logs are stored at:

`%LOCALAPPDATA%\EVEWalletTracker\logs\desktop.log`

## Migrate the server database

On the Linux server, stop the service briefly and copy the database:

```bash
sudo systemctl stop evewallet
sudo cp /opt/evewallet/data/evewallet.db /tmp/evewallet.db
sudo chown $USER:$USER /tmp/evewallet.db
sudo systemctl start evewallet
```

Download `/tmp/evewallet.db` using WinSCP. On Windows, from a command prompt opened in this package:

```bat
.venv\Scripts\python.exe import_server_data.py "C:\path\to\evewallet.db"
```

The importer backs up an existing desktop database before replacing it.

## Build the Windows application

Run:

`build_windows.bat`

The executable folder will be created at:

`dist\EVE Wallet Tracker\`

This first build is a portable desktop folder. An installer can be added after the local version is tested with the migrated database and EVE SSO.

## Remote server shutdown

Do not cancel the server until the desktop version has been tested and the database has been backed up. Once confirmed, the server can be stopped with:

```bash
sudo systemctl disable --now evewallet
```

Nginx and the droplet can then be retired if they host nothing else.
