#!/usr/bin/env python3
r"""
helper.py - local download helper for the YT Audio Grab extension.

Listens on 127.0.0.1:8765, accepts jobs from the browser extension, and runs
yt-dlp + ffmpeg to save audio (MP3) or video (MP4) into the inbox folder.

Run it, then click the button on any YouTube page.

    python helper.py              # default port 8765, inbox = D:\GUGU BTS\Music\_inbox
    python helper.py --port 9000
    python helper.py --inbox "D:\\Music"

Keep this window open while you browse. Ctrl+C to stop.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.4.1"
ALLOWED_ORIGIN_PREFIXES = ("chrome-extension://", "moz-extension://")
LOOPBACK_PREFIXES = ("http://127.0.0.1:", "http://localhost:", "http://[::1]:")

JOBS = {}
JOBS_LOCK = threading.Lock()
INBOX = None
PORT = 8765
MAX_JOBS = 200
OPEN_FOLDER = True
_open_state = {"opened": False, "saved": 0}

CONFIG_PATH = Path(__file__).resolve().parent / "config.json"


def default_inbox():
    return Path(os.environ.get("USERPROFILE", ".")) / "Music" / "Gugu Grab"


def load_config():
    if CONFIG_PATH.exists():
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except Exception as e:
            print(f"  (config.json unreadable: {e})", flush=True)
    return {}


def save_config(cfg):
    try:
        CONFIG_PATH.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return True
    except Exception as e:
        print(f"  (could not write config.json: {e})", flush=True)
        return False


def log(msg):
    stamp = time.strftime("%H:%M:%S")
    print(f"[{stamp}] {msg}", flush=True)


def safe(name, limit=150):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name)
    name = re.sub(r"\s+", " ", name).strip(" .")
    return name[:limit].rstrip(" .") or "untitled"


MEDIA_EXT = (".mp3", ".mp4", ".m4a", ".webm", ".opus", ".flac")


def build_cmd(url, fmt):
    # %(title,id) = title, falling back to the video id if the title is empty
    out_tmpl = str(INBOX / "%(title,id).140B [%(id)s].%(ext)s")
    cmd = [
        sys.executable, "-m", "yt_dlp",
        "--no-playlist",
        "--newline",
        "--no-warnings",
        "--no-mtime",
        "--no-overwrites",
        "--continue",
        "--windows-filenames",
        "--output", out_tmpl,
    ]
    if fmt == "mp4":
        cmd += [
            "--format", "bv*[height<=1080]+ba/b[height<=1080]/b",
            "--merge-output-format", "mp4",
            "--embed-metadata",
        ]
    else:
        cmd += [
            "--extract-audio",
            "--audio-format", "mp3",
            "--audio-quality", "320K",
            "--embed-metadata",
            "--embed-thumbnail",
            "--convert-thumbnails", "jpg",
        ]
    cmd.append(url)
    return cmd


def snapshot():
    """Map of filename -> size, so we can detect what a job produced without
    trusting subprocess stdout (which mangles non-ASCII on Windows consoles)."""
    try:
        return {p.name: p.stat().st_size for p in INBOX.iterdir() if p.is_file()}
    except OSError:
        return {}


def tidy_name(name):
    """Strip the stray leading space you get when a title is empty."""
    return re.sub(r"^\s*\[\w[\w-]*\]", lambda m: m.group(0).lstrip(), name).strip()


def announce_saved(src):
    """Make a successful save impossible to miss in the console."""
    try:
        mb = src.stat().st_size / (1024 * 1024)
    except OSError:
        mb = 0.0
    _open_state["saved"] += 1
    n = _open_state["saved"]

    print("", flush=True)
    print("  " + "=" * 60, flush=True)
    print(f"    SAVED  #{n}      {mb:.1f} MB      {time.strftime('%H:%M:%S')}", flush=True)
    print(f"    {src.name}", flush=True)
    print(f"    -> {src.parent}", flush=True)
    print("  " + "=" * 60, flush=True)
    print("", flush=True)

    if OPEN_FOLDER and not _open_state["opened"]:
        _open_state["opened"] = True
        try:
            subprocess.Popen(["explorer", str(src.parent)], close_fds=True)
            print("  (opened the folder for you - only happens once)", flush=True)
        except Exception as e:
            print(f"  (could not open the folder: {e})", flush=True)


def run_job(job_id, url, fmt):
    with JOBS_LOCK:
        JOBS[job_id].update(status="running", started=time.time())
    log(f"job {job_id[:8]} start  fmt={fmt}  {url}")

    before = snapshot()
    proc = subprocess.run(
        build_cmd(url, fmt),
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    after = snapshot()

    # anything new on disk is a product of this job
    new_media = [
        n for n in after
        if n not in before and n.lower().endswith(MEDIA_EXT)
    ]
    combined = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()
    err_line = next((ln.strip() for ln in combined.splitlines() if "ERROR" in ln), "")

    with JOBS_LOCK:
        j = JOBS[job_id]
        j["ended"] = time.time()

        if new_media:
            # newest file wins
            pick = max(new_media, key=lambda n: after.get(n, 0))
            src = INBOX / pick
            clean = tidy_name(pick)
            if clean != pick:
                try:
                    src.rename(INBOX / clean)
                    src = INBOX / clean
                except OSError:
                    pass
            j.update(status="done", file=str(src), name=src.name)
            announce_saved(src)
            return

        # nothing new: either it was already there, or it genuinely failed
        if proc.returncode == 0 or "has already been" in combined:
            j.update(status="done", file="", name="already in inbox")
            log(f"job {job_id[:8]} skip   already present")
            return

        err = err_line or combined[-400:] or f"yt-dlp exited {proc.returncode}"
        j.update(status="error", error=err)
        log(f"job {job_id[:8]} error  {err[:200]}")


def prune_jobs():
    with JOBS_LOCK:
        if len(JOBS) <= MAX_JOBS:
            return
        finished = sorted(
            (j for j in JOBS.values() if j["status"] in ("done", "error")),
            key=lambda j: j.get("ended", 0),
        )
        for j in finished[: len(JOBS) - MAX_JOBS]:
            JOBS.pop(j["id"], None)


def setup_page(current: Path) -> str:
    """Tiny local page so a new user only has to pick a folder."""
    home = Path(os.environ.get("USERPROFILE", "."))
    picks = []
    for label, p in [
        ("Music / Gugu Grab", home / "Music" / "Gugu Grab"),
        ("Music", home / "Music"),
        ("Downloads", home / "Downloads"),
        ("Desktop", home / "Desktop"),
        ("Videos", home / "Videos"),
    ]:
        if p.parent.exists():
            picks.append((label, str(p)))

    buttons = "".join(
        f'<button class="pick" data-path="{p}">{label}<span>{p}</span></button>'
        for label, p in picks
    )

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Gugu Grab - choose a folder</title>
<style>
  :root {{ color-scheme: light; }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; padding:40px 20px; font-family:-apple-system,"Segoe UI",Roboto,sans-serif;
         background:#f6f7f9; color:#111; }}
  .card {{ max-width:640px; margin:0 auto; background:#fff; border-radius:14px;
           padding:32px; box-shadow:0 2px 20px rgba(0,0,0,.08); }}
  h1 {{ font-size:21px; margin:0 0 6px; }}
  .sub {{ color:#666; font-size:14px; margin-bottom:24px; }}
  .label {{ font-size:12px; text-transform:uppercase; letter-spacing:.6px;
            color:#888; margin:22px 0 8px; font-weight:600; }}
  .pick {{ display:block; width:100%; text-align:left; padding:12px 14px; margin-bottom:8px;
           border:1px solid #e2e4e8; border-radius:9px; background:#fafbfc; cursor:pointer;
           font-size:14px; font-family:inherit; }}
  .pick:hover {{ background:#f0f4ff; border-color:#b9c8ff; }}
  .pick span {{ display:block; color:#8a8f98; font-size:12px; margin-top:3px;
                word-break:break-all; }}
  input[type=text] {{ width:100%; padding:11px 13px; border:1px solid #d9dce1;
                      border-radius:9px; font-size:14px; font-family:inherit; }}
  .row {{ display:flex; gap:10px; margin-top:12px; }}
  .save {{ flex:0 0 auto; padding:11px 22px; border:0; border-radius:9px;
           background:#ff0033; color:#fff; font-size:14px; font-weight:600; cursor:pointer; }}
  .save:hover {{ background:#e6002d; }}
  .cur {{ background:#eef7ee; border:1px solid #cfe6cf; padding:12px 14px;
          border-radius:9px; font-size:13px; word-break:break-all; }}
  .ok {{ color:#1a7f37; font-weight:600; }}
  .note {{ margin-top:26px; padding-top:18px; border-top:1px solid #eee;
           font-size:12.5px; color:#777; line-height:1.6; }}
</style></head>
<body><div class="card">
  <h1>Gugu Grab</h1>
  <div class="sub">Choose where your downloads should be saved. That's the only setting.</div>

  <div class="label">Currently saving to</div>
  <div class="cur" id="cur">{current}</div>

  <div class="label">Pick a folder</div>
  {buttons}

  <div class="label">Or type any path</div>
  <div class="row">
    <input type="text" id="custom" placeholder="D:\\Music\\Gugu Grab">
    <button class="save" id="save">Save</button>
  </div>

  <div class="note">
    You can close this tab after saving. The browser buttons work immediately -
    no restart needed. To change the folder later, open
    <b>http://127.0.0.1:8765/setup</b> again.
  </div>
</div>
<script>
  const cur = document.getElementById('cur');
  const custom = document.getElementById('custom');

  async function apply(path) {{
    if (!path) return;
    cur.textContent = 'saving...';
    try {{
      const r = await fetch('/config', {{
        method: 'POST',
        headers: {{ 'Content-Type': 'application/json' }},
        body: JSON.stringify({{ folder: path }})
      }});
      const j = await r.json();
      if (r.ok) {{
        cur.textContent = j.inbox;
        cur.className = 'cur ok';
      }} else {{
        cur.textContent = 'error: ' + (j.error || r.status);
        cur.className = 'cur';
      }}
    }} catch (e) {{
      cur.textContent = 'error: ' + e.message;
    }}
  }}

  document.querySelectorAll('.pick').forEach(b => {{
    b.addEventListener('click', () => apply(b.dataset.path));
  }});
  document.getElementById('save').addEventListener('click', () => apply(custom.value.trim()));
  custom.addEventListener('keydown', e => {{ if (e.key === 'Enter') apply(custom.value.trim()); }});
</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    server_version = f"YTGrabHelper/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # keep the console clean; we log our own lines

    # ---- helpers -------------------------------------------------------
    def origin_ok(self, allow_loopback=False):
        origin = self.headers.get("Origin", "")
        if not origin:
            return True                      # curl / local scripts
        if origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            return True
        if allow_loopback and origin.startswith(LOOPBACK_PREFIXES):
            return True                      # the /setup page itself
        return False

    def cors(self):
        origin = self.headers.get("Origin", "")
        if origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")

    def reply(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.cors()
        self.end_headers()
        self.wfile.write(body)

    def body_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def handle_config(self):
        """Called from the /setup page - this is the only setting a new user touches."""
        global INBOX
        data = self.body_json()
        folder = (data.get("folder") or "").strip().strip('"').strip("'")
        if not folder:
            self.reply(400, {"error": "folder is required"})
            return

        folder = os.path.expandvars(os.path.expanduser(folder))
        target = Path(folder)
        if not target.is_absolute():
            self.reply(400, {"error": "give a full path, like D:\\Music\\Gugu Grab"})
            return
        try:
            target.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            self.reply(400, {"error": f"cannot create that folder: {e}"})
            return

        INBOX = target
        cfg = load_config()
        cfg["inbox"] = str(target)
        save_config(cfg)
        log(f"folder set  -> {target}")
        self.reply(200, {"ok": True, "inbox": str(target)})

    # ---- routes --------------------------------------------------------
    def do_OPTIONS(self):
        if not self.origin_ok(allow_loopback=True):
            self.reply(403, {"error": "origin not allowed"})
            return
        self.send_response(204)
        self.cors()
        # Chrome Private Network Access: extension -> loopback needs an explicit opt-in
        if (self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if not self.origin_ok():
            self.reply(403, {"error": "origin not allowed"})
            return

        if self.path in ("/setup", "/setup/"):
            body = setup_page(INBOX).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if self.path == "/health":
            self.reply(200, {
                "ok": True, "version": VERSION,
                "inbox": str(INBOX), "jobs": len(JOBS),
            })
            return

        if self.path == "/jobs":
            with JOBS_LOCK:
                items = sorted(JOBS.values(), key=lambda j: j.get("started", 0), reverse=True)
            self.reply(200, {"jobs": items[:50]})
            return

        m = re.match(r"^/jobs/([0-9a-f\-]+)$", self.path)
        if m:
            with JOBS_LOCK:
                job = JOBS.get(m.group(1))
            if not job:
                self.reply(404, {"error": "no such job"})
            else:
                self.reply(200, job)
            return

        self.reply(404, {"error": "not found"})

    def do_POST(self):
        # /config is called by the local /setup page, so loopback is fine here.
        if self.path == "/config":
            if not self.origin_ok(allow_loopback=True):
                self.reply(403, {"error": "origin not allowed"})
                return
            self.handle_config()
            return

        # /download is extension-only - no web page may trigger a download.
        if not self.origin_ok():
            self.reply(403, {"error": "origin not allowed"})
            return

        if self.path != "/download":
            self.reply(404, {"error": "not found"})
            return

        data = self.body_json()
        url = (data.get("url") or "").strip()
        fmt = data.get("format", "mp3")

        if not re.match(r"^https?://", url):
            self.reply(400, {"error": "url must start with http(s)://"})
            return
        if fmt not in ("mp3", "mp4"):
            fmt = "mp3"

        job_id = str(uuid.uuid4())
        with JOBS_LOCK:
            JOBS[job_id] = {
                "id": job_id, "url": url, "format": fmt,
                "status": "pending", "file": "", "name": "",
                "error": "", "started": time.time(), "ended": 0,
            }
        threading.Thread(target=run_job, args=(job_id, url, fmt), daemon=True).start()
        prune_jobs()
        self.reply(202, {"id": job_id, "status": "pending"})


class QuietServer(ThreadingHTTPServer):
    """Browsers drop keep-alive sockets constantly; that is not an error and
    must not print a traceback or look like a crash."""

    daemon_threads = True
    # Must stay False. On Windows SO_REUSEADDR lets a second process bind the
    # SAME port, which silently gives you two helpers fighting over requests.
    allow_reuse_address = False

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError,
                            BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def probe_existing(port):
    """Is another helper already answering on this port?"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def main():
    global INBOX, PORT, OPEN_FOLDER

    ap = argparse.ArgumentParser(description="Local helper for Gugu Grab")
    ap.add_argument("--port", type=int, default=int(os.environ.get("YTG_PORT", 8765)))
    ap.add_argument("--inbox", default=None,
                    help="override the save folder (otherwise config.json is used)")
    ap.add_argument("--no-open-folder", action="store_true",
                    help="do not pop the folder open after the first save")
    ap.add_argument("--no-browser", action="store_true",
                    help="do not open the folder-picker page on first run")
    ap.add_argument("--setup", action="store_true",
                    help="open the folder-picker page even if a folder is configured")
    args = ap.parse_args()

    PORT = args.port
    OPEN_FOLDER = not args.no_open_folder

    cfg = load_config()
    first_run = not CONFIG_PATH.exists()

    if args.inbox:
        INBOX = Path(os.path.expandvars(args.inbox))
    elif cfg.get("inbox"):
        INBOX = Path(cfg["inbox"])
    else:
        INBOX = default_inbox()
    INBOX.mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run([sys.executable, "-m", "yt_dlp", "--version"],
                       capture_output=True, check=True)
    except Exception:
        sys.exit("yt-dlp is not installed for this Python. Run: python -m pip install -U yt-dlp")

    # Refuse to start twice. A silent second instance is worse than an error.
    existing = probe_existing(PORT)
    if existing:
        print("")
        print(f"  A helper is ALREADY running on port {PORT}.", flush=True)
        print(f"  version {existing.get('version')}  ->  {existing.get('inbox')}", flush=True)
        print("")
        print("  Nothing to do - just use the browser buttons.", flush=True)
        print(f"  To change the folder: http://127.0.0.1:{PORT}/setup", flush=True)
        print("")
        sys.exit(0)

    try:
        srv = QuietServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        print("")
        print(f"  Cannot listen on port {PORT}: {e}", flush=True)
        print("  Something else is using it. Try a different port:", flush=True)
        print(f"    python helper.py --port {PORT + 1}", flush=True)
        print("")
        sys.exit(1)
    print("=" * 62)
    print(f"  Gugu Grab helper v{VERSION}")
    print(f"  listening   http://127.0.0.1:{PORT}")
    print(f"  saving to   {INBOX}")
    print(f"  change it   http://127.0.0.1:{PORT}/setup")
    print("  every finished download prints a big SAVED block below")
    print("  keep this window open - Ctrl+C to stop")
    print("=" * 62)

    if (first_run or args.setup) and not args.no_browser:
        def _open_picker():
            time.sleep(1.2)
            try:
                webbrowser.open(f"http://127.0.0.1:{PORT}/setup")
                print("  (opened the folder picker in your browser)", flush=True)
            except Exception:
                print(f"  open http://127.0.0.1:{PORT}/setup to choose a folder", flush=True)
        threading.Thread(target=_open_picker, daemon=True).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
