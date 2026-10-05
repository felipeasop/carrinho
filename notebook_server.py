#!/usr/bin/env python3
"""Serve o painel no notebook e encaminha as rotas existentes da ESP32-CAM."""

import argparse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Timer
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener


WEB_DIR = Path(__file__).resolve().parent / "web"
ROUTES = {
    ("GET", "/status"),
    ("GET", "/capture"),
    ("GET", "/step-status"),
    ("POST", "/arm"),
    ("POST", "/step"),
    ("POST", "/stop"),
}
OPENER = build_opener(ProxyHandler({}))


class Handler(BaseHTTPRequestHandler):
    esp_url = "http://192.168.4.1"

    def log_message(self, _format, *args):
        pass  # Capturas frequentes nao precisam ocupar o terminal.

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def send_data(self, status, data, content_type, frame_id=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if frame_id is not None:
            self.send_header("X-Frame-Id", frame_id)
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def handle_request(self):
        route = urlsplit(self.path)
        if (self.command, route.path) in ROUTES:
            self.proxy(route)
            return

        if self.command == "GET" and route.path in ("/", "/app.js"):
            path = WEB_DIR / ("index.html" if route.path == "/" else "app.js")
            content_type = (
                "text/html; charset=utf-8"
                if route.path == "/"
                else "text/javascript; charset=utf-8"
            )
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
        url = self.esp_url + route.path
        if route.query:
            url += "?" + route.query
        request = Request(
            url,
            data=b"" if self.command == "POST" else None,
            method=self.command,
            headers={"Cache-Control": "no-store"},
        )
        try:
            with OPENER.open(request, timeout=2.0) as response:
                self.send_data(
                    response.status,
                    response.read(),
                    response.headers.get("Content-Type", "application/octet-stream"),
                    response.headers.get("X-Frame-Id"),
                )
        except HTTPError as exc:
            self.send_data(
                exc.code,
                exc.read(),
                exc.headers.get("Content-Type", "text/plain; charset=utf-8"),
            )
        except (URLError, TimeoutError, OSError) as exc:
            message = f"ESP32 indisponivel em {self.esp_url}: {exc}"
            self.send_data(502, message.encode(), "text/plain; charset=utf-8")


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
