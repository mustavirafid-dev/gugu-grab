// popup.js - the "any site" front door.
//
// The helper already hands any http(s) URL to yt-dlp, which understands
// 1800+ sites. So this file adds no per-site scraping: it just takes a link
// and posts it. That keeps it working when Facebook or Instagram redesign
// their DOM, which is the whole reason it is a popup and not a content script.

// Video quality is a height in pixels; audio quality is a bitrate in kbps.
// They are separate lists because "1080p" means nothing for an MP3 and
// "192 kbps" means nothing for an MP4.
const QUALITIES_VIDEO = [
  ["best", "Best available"],
  ["2160", "2160p 4K"],
  ["1440", "1440p"],
  ["1080", "1080p"],
  ["720", "720p"],
  ["480", "480p"],
  ["360", "360p (small)"],
  ["240", "240p (smaller)"],
  ["144", "144p (smallest)"],
];

const QUALITIES_AUDIO = [
  ["320", "320 kbps (best)"],
  ["192", "192 kbps"],
  ["128", "128 kbps (small)"],
  ["96", "96 kbps (smallest)"],
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
let quality = "320";
let qualityVideo = "1080";
let qualityAudio = "320";
let pollTimer = null;

// ---------------------------------------------------------------- prefs ---

function savePrefs() {
  try {
    chrome.storage.local.set({ format, qualityVideo, qualityAudio });
  } catch (e) {
    console.warn("[Gugu] could not save prefs:", e?.message);
  }
}

// Rebuild the dropdown for the current format: heights for video, bitrates
// for audio. Keeping one shared list meant an MP3 could be asked for "1080p".
function fillQualities() {
  const list = format === "mp4" ? QUALITIES_VIDEO : QUALITIES_AUDIO;
  const sel = $("quality");
  sel.textContent = "";
  for (const [value, label] of list) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  if (!list.some(([v]) => v === quality)) {
    quality = list[0][0];
    if (format === "mp4") qualityVideo = quality;
    else qualityAudio = quality;
  }
  sel.value = quality;
}

function syncFormatUI() {
  for (const b of document.querySelectorAll("#seg button")) {
    b.classList.toggle("on", b.dataset.fmt === format);
  }
  // Both formats have a quality: a height for MP4, a bitrate for MP3.
  $("quality").disabled = false;
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
    if (job.size) bits.push(job.size);
    if (job.eta) bits.push("ETA " + job.eta);
    // A retry keeps the percentage: the bytes already fetched are kept, so the
    // bar should not jump back to zero - but say that it is retrying.
    if (String(job.stage || "").toLowerCase() === "retrying") bits.push("retrying");
    $("msg").textContent = bits.join("  ·  ");
    return;
  }

  bar.classList.add("indeterminate");

  // Jobs run one at a time on purpose (two downloads writing the same file
  // deadlocked once). Say where this one is instead of looking stalled.
  if (typeof job.ahead === "number" && job.ahead > 0) {
    $("msg").textContent =
      "Queued — " + job.ahead + (job.ahead === 1 ? " job" : " jobs") + " ahead";
    return;
  }

  const stage = String(job.stage || "").toLowerCase();
  const label =
    stage === "retrying"
      ? "Connection dropped — retrying…"
      : stage === "merging"
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

function humanSize(n) {
  if (!n || n < 1024) return "";
  const units = ["KB", "MB", "GB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 10 ? 0 : 1) + " " + units[i];
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
      showStatus(
        "ok",
        "Saved — " + (job.name || "file") +
          (job.bytes ? "  ·  " + humanSize(job.bytes) : "")
      );
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
  let prefs = { format: "mp3", qualityVideo: "1080", qualityAudio: "320" };
  try {
    prefs = await chrome.storage.local.get(prefs);
  } catch (e) {
    console.warn("[Gugu] storage unavailable:", e?.message);
  }
  format = prefs.format === "mp4" ? "mp4" : "mp3";
  qualityVideo = prefs.qualityVideo || "1080";
  qualityAudio = prefs.qualityAudio || "320";
  quality = format === "mp4" ? qualityVideo : qualityAudio;

  $("quality").addEventListener("change", () => {
    quality = $("quality").value;
    if (format === "mp4") qualityVideo = quality;
    else qualityAudio = quality;
    savePrefs();
  });

  fillQualities();
  syncFormatUI();

  for (const b of document.querySelectorAll("#seg button")) {
    b.addEventListener("click", () => {
      format = b.dataset.fmt;
      quality = format === "mp4" ? qualityVideo : qualityAudio;
      fillQualities();
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
    }
  } catch {
    /* no activeTab grant - the box stays empty, which is fine */
  }

  // Closing the popup does not stop a download, so reattach to whatever is
  // running. Without this, opening the popup mid-job looked like nothing had
  // ever been started.
  try {
    const live = await chrome.runtime.sendMessage({ type: "ytg:active" });
    if (live?.id && live.status) {
      setBusy(true);
      showProgress(live);
      poll(live.id);
      return;
    }
  } catch {
    /* helper down - the Grab button will report it */
  }
  $("url").focus();
}

document.addEventListener("DOMContentLoaded", init);
