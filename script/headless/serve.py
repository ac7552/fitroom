"""Serves the repo for the headless 3D harness (render.mjs), with the page's import-map paths:
/lib/* -> app/javascript/lib/*, /vendor/* -> vendor/javascript/*, /models/* -> public/models/*,
/samples/* -> public/samples/*, /harness/* -> script/headless/*, and /fixtures/* -> test/fixtures/files/*.

    python3 script/headless/serve.py 8787
"""

import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
MAP = {
    "/lib/": ROOT / "app/javascript/lib",
    "/controllers/": ROOT / "app/javascript/controllers",
    "/vendor/": ROOT / "vendor/javascript",
    "/models/": ROOT / "public/models",
    "/samples/": ROOT / "public/samples",
    "/harness/": ROOT / "script/headless",
    "/fixtures/": ROOT / "test/fixtures/files",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        path = path.split("?", 1)[0]
        for prefix, folder in MAP.items():
            if path.startswith(prefix):
                file = folder / path[len(prefix):]
                # Import-map modules are named without their extension ("lib/stage").
                if not file.exists() and file.with_suffix(".js").exists():
                    file = file.with_suffix(".js")
                return str(file)
        return str(ROOT / "script/headless" / path.lstrip("/"))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def guess_type(self, path):
        if str(path).endswith((".js", ".mjs")):
            return "text/javascript"
        return super().guess_type(path)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
