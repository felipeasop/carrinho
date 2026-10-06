#!/usr/bin/env python3
"""Serve o painel no notebook e encaminha as rotas existentes da ESP32-CAM."""

import argparse
import json
import time
import webbrowser
from collections import deque
from http.client import HTTPException
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Timer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener


PANEL_DIR = Path(__file__).resolve().parent / "painel"
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/algoritmo.js": ("algoritmo.js", "text/javascript; charset=utf-8"),
}
ROUTES = {
    ("GET", "/status"),
    ("GET", "/capture"),
    ("GET", "/step-status"),
    ("POST", "/arm"),
    ("POST", "/step"),
    ("POST", "/stop"),
}
OPENER = build_opener(ProxyHandler({}))
STARTED_AT = time.time()
EVENTS = deque(maxlen=80)
EVENTS_LOCK = Lock()
REQUEST_COUNT = 0
FAILURE_COUNT = 0


def record_event(event):
    global REQUEST_COUNT, FAILURE_COUNT
    with EVENTS_LOCK:
        REQUEST_COUNT += 1
        if event["result"] != "ok":
            FAILURE_COUNT += 1
        event["request"] = REQUEST_COUNT
        EVENTS.append(event)
    if event["result"] != "ok" or event["elapsed_ms"] >= 500:
        print(json.dumps(event, ensure_ascii=False), flush=True)


class Handler(BaseHTTPRequestHandler):
    esp_url = "http://192.168.4.1"

    def log_message(self, _format, *args):
        pass  # Capturas frequentes nao precisam ocupar o terminal.

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def send_data(self, status, data, content_type, frame_id=None):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            if frame_id is not None:
                self.send_header("X-Frame-Id", frame_id)
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            return False
        return True

    def handle_request(self):
        route = urlsplit(self.path)
        if self.command == "GET" and route.path == "/diagnostico":
            with EVENTS_LOCK:
                payload = {"server": "notebook_server.py", "uptime_s": round(time.time() - STARTED_AT, 1),
                           "requests": REQUEST_COUNT, "failures": FAILURE_COUNT, "esp_url": self.esp_url,
                           "recent": list(EVENTS)}
            self.send_data(200, json.dumps(payload, ensure_ascii=False).encode(), "application/json; charset=utf-8")
            return
        if (self.command, route.path) in ROUTES:
            self.proxy(route)
            return

        if self.command == "GET" and route.path in STATIC_FILES:
            filename, content_type = STATIC_FILES[route.path]
            path = PANEL_DIR / filename
            try:
                self.send_data(200, path.read_bytes(), content_type)
            except OSError as exc:
                self.send_data(500, str(exc).encode(), "text/plain; charset=utf-8")
            return

        if self.command == "GET" and route.path == "/favicon.ico":
            self.send_data(204, b"", "text/plain")
            return
        self.send_data(404, b"Rota nao encontrada", "text/plain; charset=utf-8")

    def proxy(self, route):
        started = time.monotonic()
        url = self.esp_url + route.path
        if route.query:
            url += "?" + route.query
        request = Request(
            url,
            data=b"" if self.command == "POST" else None,
            method=self.command,
            headers={"Cache-Control": "no-store"},
        )
        frame_id = None
        detail = ""
        try:
            with OPENER.open(request, timeout=2.0) as response:
                status = response.status
                body = response.read()
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                frame_id = response.headers.get("X-Frame-Id")
                result = "ok"
        except HTTPError as exc:
            try:
                body = exc.read()
                status = exc.code
                content_type = exc.headers.get("Content-Type", "text/plain; charset=utf-8")
                result = "esp_http_error"
                detail = body.decode("utf-8", errors="replace")[:160]
            except (OSError, HTTPException) as read_error:
                status = 502
                detail = f"{type(read_error).__name__}: {read_error}"
                body = f"Resposta incompleta da ESP32: {detail}".encode()
                content_type = "text/plain; charset=utf-8"
                result = "esp_response_incomplete"
        except (URLError, TimeoutError, OSError, HTTPException) as exc:
            status = 502
            detail = f"{type(exc).__name__}: {exc}"
            body = f"ESP32 indisponivel em {self.esp_url}: {exc}".encode()
            content_type = "text/plain; charset=utf-8"
            result = "esp_unreachable"
        except Exception as exc:
            status = 500
            detail = f"{type(exc).__name__}: {exc}"
            body = f"Erro interno do proxy: {detail}".encode()
            content_type = "text/plain; charset=utf-8"
            result = "proxy_error"
        delivered = self.send_data(status, body, content_type, frame_id)
        if not delivered:
            result += "+browser_disconnected"
        elapsed = round((time.monotonic() - started) * 1000, 1)
        record_event({"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "method": self.command,
                      "path": route.path, "status": status, "result": result, "elapsed_ms": elapsed,
                      "client": self.client_address[0], "frame_id": frame_id, "detail": detail})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--esp-url", default="http://192.168.4.1")
    parser.add_argument("--no-open", action="store_true", help="nao abrir o navegador")
    args = parser.parse_args()

    target = urlsplit(args.esp_url)
    if target.scheme != "http" or not target.netloc or target.path not in ("", "/"):
        parser.error("--esp-url deve ser como http://192.168.4.1")
    Handler.esp_url = args.esp_url.rstrip("/")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    panel_url = f"http://{args.host}:{args.port}/"
    print(f"Painel local: {panel_url}", flush=True)
    print(f"ESP32: {Handler.esp_url} | Ctrl+C para encerrar", flush=True)
    if not args.no_open:
        opener = Timer(0.3, webbrowser.open_new_tab, args=(panel_url,))
        opener.daemon = True
        opener.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
