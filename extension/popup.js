// popup.js - the "any site" front door.
//
// The helper already hands any http(s) URL to yt-dlp, which understands
// 1800+ sites. So this file adds no per-site scraping: it just takes a link
// and posts it. That keeps it working when Facebook or Instagram redesign
// their DOM, which is the whole reason it is a popup and not a content script.

const QUALITIES = [
  ["best", "Best available"],
  ["2160", "2160p 4K"],
  ["1440", "1440p"],
  ["1080", "1080p"],
  ["720", "720p"],
  ["480", "480p"],
];

// Only prefill the box when the open tab plausibly holds a single video.
// Prefilling a search page or a home feed would just be noise.
const VIDEO_HINT = new RegExp(
  [
    "youtube\\.com/(watch|shorts|live)",
    "youtu\\.be/",
    "instagram\\.com/(p|reel|reels|tv)/",
    "facebook\\.com/.+/videos?/",
    "fb\\.watch/",
    "tiktok\\.com/.+/video/",
    "vimeo\\.com/\\d",
    "(twitter|x)\\.com/.+/status/",
    "soundcloud\\.com/",
    "dailymotion\\.com/video/",
    "twitch\\.tv/videos/",
    "bilibili\\.com/video/",
    "b23\\.tv/",
    "douyin\\.com/video/",
    "v\\.qq\\.com/x/",
    "youku\\.com/v_show/",
    "iqiyi\\.com/v_",
    "weibo\\.com/(tv|detail)/",
  ].join("|"),
  "i"
);

const $ = (id) => document.getElementById(id);

let format = "mp3";
let quality = "1080";
let pollTimer = null;

// ---------------------------------------------------------------- prefs ---

function savePrefs() {
  try {
    chrome.storage.local.set({ format, quality });
  } catch (e) {
    console.warn("[Gugu] could not save prefs:", e?.message);
  }
}

function syncFormatUI() {
  for (const b of document.querySelectorAll("#seg button")) {
    b.classList.toggle("on", b.dataset.fmt === format);
  }
  // Quality only applies to video; for MP3 the helper always writes 320 kbps.
  $("quality").disabled = format !== "mp4";
}

// --------------------------------------------------------------- status ---

function showStatus(kind, text, indeterminate) {
  const box = $("status");
  const bar = $("bar");
  const fill = $("fill");
  box.hidden = false;
  $("msg").className = kind === "ok" ? "ok" : kind === "err" ? "err" : "";
  $("msg").textContent = text;
  $("msg").title = "";
  bar.classList.toggle("indeterminate", !!indeterminate);
  if (indeterminate) {
    fill.style.width = "";
  } else {
    fill.style.width = "0%";
  }
}

function showProgress(job) {
  const bar = $("bar");
  const fill = $("fill");
  $("status").hidden = false;
  $("msg").className = "";

  if (typeof job.percent === "number" && job.percent > 0) {
    bar.classList.remove("indeterminate");
    fill.style.width = Math.min(100, job.percent) + "%";
    const bits = [Math.floor(job.percent) + "%"];
    if (job.speed) bits.push(job.speed);
    if (job.eta) bits.push("ETA " + job.eta);
    $("msg").textContent = bits.join("  ·  ");
    return;
  }

  bar.classList.add("indeterminate");
  const stage = String(job.stage || "").toLowerCase();
  const label =
    stage === "merging"
      ? "Merging video and audio…"
      : stage === "converting"
      ? "Converting to MP3…"
      : stage === "tagging"
      ? "Writing metadata…"
      : stage === "downloading"
      ? "Downloading…"
      : "Reading the link…";
  // Elapsed time is the only proof of life before the first percentage.
  const secs = typeof job.elapsed === "number" ? Math.floor(job.elapsed) : 0;
  $("msg").textContent = secs > 0 ? label + "  " + secs + "s" : label;
}

function setBusy(busy) {
  $("go").disabled = busy;
  $("go").textContent = busy ? "Working…" : "Grab";
}

// --------------------------------------------------------------- polling ---

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function poll(id) {
  stopPolling();
  let ticks = 0;
  let misses = 0;

  pollTimer = setInterval(async () => {
    if (++ticks > 1800) {
      stopPolling();
      setBusy(false);
      showStatus("err", "Timed out after 30 minutes.");
      return;
    }

    let job;
    try {
      job = await chrome.runtime.sendMessage({ type: "ytg:job", id });
    } catch {
      return; // transient - the worker may be waking up
    }

    // A reply with no status is not a job: it is either the helper being
    // unreachable or a 404 because the helper was restarted mid-job. Bail out
    // after a few tries instead of spinning silently for half an hour.
    if (!job || !job.status) {
      if (++misses < 4) return;
      stopPolling();
      setBusy(false);
      const why = String(job?.error || "");
      showStatus(
        "err",
        /no such job/i.test(why)
          ? "The helper was restarted — the job is gone. Try again."
          : why
          ? "Helper not responding — is the black window still open?"
          : "Lost contact with the helper. Try again."
      );
      return;
    }
    misses = 0;

    if (job.status === "pending" || job.status === "running") {
      showProgress(job);
      return;
    }
    if (job.status === "done") {
      stopPolling();
      setBusy(false);
      // showStatus() resets the bar to 0%, so fill it afterwards.
      showStatus("ok", "Saved — " + (job.name || "file"));
      $("bar").classList.remove("indeterminate");
      $("fill").style.width = "100%";
      return;
    }
    if (job.status === "error") {
      stopPolling();
      setBusy(false);
      showStatus("err", job.error || "Download failed.");
      // Hover the message for yt-dlp's own wording.
      $("msg").title = job.error_raw || "";
    }
  }, 1000);
}

// ------------------------------------------------------------------ grab ---

async function onGrab() {
  const url = $("url").value.trim();

  if (!/^https?:\/\//i.test(url)) {
    showStatus("err", "Paste a full link — it should start with http:// or https://");
    return;
  }

  stopPolling();
  setBusy(true);
  showStatus("info", "Sending to the helper…", true);

  let res;
  try {
    res = await chrome.runtime.sendMessage({ type: "ytg:grab", url, format, quality });
  } catch (e) {
    res = { ok: false, error: String(e?.message || e) };
  }

  if (!res || !res.ok) {
    setBusy(false);
    showStatus("err", res?.error || "Could not reach the helper. Is it running?");
    return;
  }

  poll(res.id);
}

// ------------------------------------------------------------------ init ---

async function init() {
  let prefs = { format: "mp3", quality: "1080" };
  try {
    prefs = await chrome.storage.local.get(prefs);
  } catch (e) {
    console.warn("[Gugu] storage unavailable:", e?.message);
  }
  format = prefs.format === "mp4" ? "mp4" : "mp3";
  quality = prefs.quality || "1080";

  const sel = $("quality");
  for (const [value, label] of QUALITIES) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  if (!QUALITIES.some(([v]) => v === quality)) quality = "1080";
  sel.value = quality;
  sel.addEventListener("change", () => {
    quality = sel.value;
    savePrefs();
  });

  syncFormatUI();

  for (const b of document.querySelectorAll("#seg button")) {
    b.addEventListener("click", () => {
      format = b.dataset.fmt;
      syncFormatUI();
      savePrefs();
    });
  }

  $("go").addEventListener("click", onGrab);
  $("url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onGrab();
  });

  // Prefill from the current tab when it looks like a single video.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && VIDEO_HINT.test(tab.url)) {
      $("url").value = tab.url;
      $("go").focus();
      return;
    }
  } catch {
    /* no activeTab grant - the box stays empty, which is fine */
  }
  $("url").focus();
}

document.addEventListener("DOMContentLoaded", init);
