// background.js - service worker. Owns all network calls to the local helper,
// because content-script fetch is subject to the page CSP.

const HELPER = "http://127.0.0.1:8765";
const POLL_MS = 1200;
const MAX_POLLS = 1500; // ~30 min ceiling
const TAG = "[Gugu]";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeBadge(text, color) {
  // chrome.action is undefined unless manifest declares "action"
  try {
    chrome.action.setBadgeText({ text });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    console.warn(TAG, "badge unavailable:", e.message);
  }
}

function tell(tabId, message) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, message).catch((e) =>
    console.warn(TAG, "could not message tab:", e.message)
  );
}

async function api(path, options) {
  const res = await fetch(HELPER + path, options);
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

async function grab({ url, format, quality, tabId }) {
  let job;
  try {
    job = await api("/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, format, quality })
    });
  } catch (err) {
    const msg = String(err?.message || err);
    console.warn(TAG, "POST failed:", msg);
    const hint = /Failed to fetch|NetworkError|refused|load failed/i.test(msg)
      ? "helper not running - double-click start-helper.bat"
      : msg;
    return { ok: false, error: hint };
  }

  console.log(TAG, "job queued", job.id, format, quality, url);
  watch(job.id, tabId);
  return { ok: true, id: job.id };
}

async function watch(id, tabId) {
  safeBadge("...", "#555");
  for (let i = 0; i < MAX_POLLS; i++) {
    await sleep(POLL_MS);
    let job;
    try {
      job = await api("/jobs/" + id);
    } catch (e) {
      safeBadge("?", "#b00");
      tell(tabId, { type: "ytg:error", error: "lost contact with helper" });
      return;
    }

    if (job.status === "running") {
      if (job.stage || job.percent) {
        safeBadge(job.percent ? Math.floor(job.percent) + "%" : "...", "#555");
        tell(tabId, {
          type: "ytg:progress",
          percent: job.percent,
          speed: job.speed,
          eta: job.eta,
          stage: job.stage
        });
      }
      continue;
    }

    if (job.status === "done") {
      safeBadge("OK", "#1a7f37");
      tell(tabId, {
        type: "ytg:done",
        name: job.name || "saved",
        bytes: job.bytes || 0,
      });
      setTimeout(() => safeBadge("", null), 6000);
      return;
    }
    if (job.status === "error") {
      safeBadge("!", "#c00");
      tell(tabId, { type: "ytg:error", error: job.error || "download failed" });
      setTimeout(() => safeBadge("", null), 9000);
      return;
    }
  }
  safeBadge("!", "#c00");
  tell(tabId, { type: "ytg:error", error: "timed out" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ytg:grab") {
    grab({
      url: msg.url,
      format: msg.format === "mp4" ? "mp4" : "mp3",
      quality: msg.quality || "1080",
      tabId: sender.tab?.id
    }).then(sendResponse);
    return true; // async response
  }

  if (msg?.type === "ytg:ping") {
    api("/health")
      .then((h) => sendResponse({ ok: true, version: h.version, inbox: h.inbox }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  // The popup polls through the worker rather than fetching directly, so the
  // helper keeps a single origin allowlist and the popup needs no host access.
  if (msg?.type === "ytg:job") {
    api("/jobs/" + encodeURIComponent(msg.id))
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }

  if (msg?.type === "ytg:active") {
    // The popup is destroyed on close but the download keeps going, so it asks
    // what is still running and reattaches to it.
    api("/jobs")
      .then((d) => {
        const live = (d.jobs || []).find(
          (j) => j.status === "pending" || j.status === "running"
        );
        sendResponse(live || null);
      })
      .catch((e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }

  return false;
});

console.log(TAG, "service worker up");
