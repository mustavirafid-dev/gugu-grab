# Gugu Grab

**One-click MP3 / MP4 buttons inside YouTube. No account, no ads, no cloud, nothing uploaded.**

Gugu Grab adds two buttons to every YouTube video and Short — `MP3` and `MP4`. Click one, the file is saved to a folder you pick. The audio conversion, metadata tagging and cover-art embedding happen on your own machine.

It is a thin browser extension plus a small local helper that drives [yt-dlp](https://github.com/yt-dlp/yt-dlp) and `ffmpeg`. Nothing leaves your computer.

```
YouTube page  ──►  extension  ──►  127.0.0.1:8765  ──►  yt-dlp + ffmpeg  ──►  your folder
                (button)          (local helper)        (download + convert)
```

---

## Why this exists

Most "YouTube downloader" extensions either want an account, show ads, upload your links to someone's server, or break the moment YouTube changes its markup.

| | Gugu Grab | Typical downloader site |
|---|---|---|
| Account required | no | usually |
| Ads | none | yes |
| Your URLs sent to a third party | never | always |
| Works on Shorts | yes | sometimes |
| Output quality | MP3 320 kbps / MP4 1080p | capped or paid |
| Cost | free | freemium |

---

## Install (Windows 10/11 + Chrome or Edge)

**1. Run the setup**

Double-click `setup.bat`. It finds Python, installs `yt-dlp`, checks for `ffmpeg`, and optionally sets the helper to start with Windows.

**2. Pick a save folder**

A browser tab opens at `http://127.0.0.1:8765/setup`. Choose a folder (or type any path) and click **Save**.

**3. Load the extension**

`setup.bat` prints the path. Then:

- open `chrome://extensions`
- turn on **Developer mode** (top right)
- click **Load unpacked**
- select the `extension` folder inside this one

Open any YouTube video. The buttons appear next to Share. On Shorts they float on the left side.

---

## Usage

Click `MP3` or `MP4`. The button shows `…` while working, `✓` when saved, `✕` on failure. A toast tells you the filename.

Change the save folder any time: <http://127.0.0.1:8765/setup>

Files are named after the video title plus the video ID, so re-downloading the same video is detected and skipped rather than duplicated.

---

## Requirements

| | |
|---|---|
| OS | Windows 10 / 11 |
| Browser | Chrome, Edge, or any Chromium build (Manifest V3) |
| Python | 3.9+ — `setup.bat` finds an existing install or tells you what to get |
| ffmpeg | needed for MP3 conversion and cover art — `setup.bat` warns if missing |
| yt-dlp | installed automatically by `setup.bat` |

---

## How it works

A browser extension **cannot** download and convert audio by itself — there is no stream API and extensions cannot execute binaries. So the work is split:

- **`extension/`** — Manifest V3. Injects the buttons, sends the video URL to the helper, polls for progress, shows the toast. All network calls happen in the background worker, not the content script, so page CSP cannot block them.
- **`helper.py`** — a `ThreadingHTTPServer` on `127.0.0.1:8765`. Accepts jobs, runs `yt-dlp` in a thread, and detects the finished file by diffing a directory snapshot (never by parsing console output, which mangles non-ASCII filenames on Windows).
- **`setup.ps1` / `start-helper.bat` / `uninstall.bat`** — install, run, remove.

### Security model

- The helper binds to **loopback only**. Nothing on your network can reach it.
- `POST /download` accepts **only** `chrome-extension://` and `moz-extension://` origins — a random website cannot make your machine download something.
- `POST /config` additionally accepts the loopback setup page, so the folder picker works.
- Only one helper can hold the port; a second instance refuses and says so.

---

## Troubleshooting

**Buttons say "helper not running"** — the helper stopped. Run `start-helper.bat` and leave the window open.

**Buttons don't appear at all** — reload the extension at `chrome://extensions`, then hard-refresh the YouTube tab (Ctrl+Shift+R). Content scripts do not reinject into tabs that were already open.

**A download fails** — press F12 on the YouTube tab, open Console, and look for lines starting with `[Gugu]`. The helper window also prints a `SAVED` block for every success and the exact error for every failure.

**Non-ASCII titles look odd in a player** — expected on Windows console; the file on disk is correct. Verify with `ffprobe`.

---

## Legal

This is a UI over `yt-dlp`, which you can use directly without this project. It does not bypass DRM, paywalls or access controls, and it runs entirely on your machine with no server component.

**You are responsible for what you download.** Downloading copyrighted material without permission may be illegal where you live and violates YouTube's Terms of Service. Use it for content you own, content licensed for reuse (Creative Commons, public domain), or content you have explicit permission to copy.

Provided as-is under the MIT licence, with no warranty of any kind.

## Licence

MIT — see [LICENSE](LICENSE).
