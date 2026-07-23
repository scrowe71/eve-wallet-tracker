from __future__ import annotations

import logging
import os
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn
import webview

HOST = "127.0.0.1"
PORT = 8765


def resource_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent


def data_root() -> Path:
    base = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    root = base / "EVEWalletTracker"
    (root / "data").mkdir(parents=True, exist_ok=True)
    (root / "logs").mkdir(parents=True, exist_ok=True)
    return root


def configure_runtime() -> None:
    root = resource_root()
    os.chdir(root)
    os.environ.setdefault("EVEWALLET_DATA_DIR", str(data_root()))

    log_path = data_root() / "logs" / "desktop.log"
    logging.basicConfig(
        filename=log_path,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def wait_for_server(timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((HOST, PORT), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def start_server(server: uvicorn.Server) -> None:
    server.run()


def main() -> int:
    configure_runtime()

    from app.main import app

    config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=start_server, args=(server,), daemon=True)
    thread.start()

    if not wait_for_server():
        webbrowser.open((data_root() / "logs" / "desktop.log").as_uri())
        raise RuntimeError("The local EVE Wallet Tracker service did not start.")

    window = webview.create_window(
        "EVE Wallet Tracker",
        f"http://{HOST}:{PORT}",
        width=1440,
        height=940,
        min_size=(1050, 700),
    )

    try:
        webview.start(debug=False)
    finally:
        server.should_exit = True
        thread.join(timeout=5)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
