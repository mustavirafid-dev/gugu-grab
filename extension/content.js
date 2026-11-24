// content.js - Gugu Grab 1.1.0
// Injects MP3 / MP4 buttons into YouTube's action bar (and a floating pill on
// Shorts). Re-checks on SPA navigation and on DOM churn.

const VERSION = "1.1.0";
const TAG = "[Gugu]";
const WRAP_ID = "ytg-wrap";
const TOAST_ID = "ytg-toast";

let lastHref = "";

console.log(`${TAG} content script v${VERSION} loaded on ${location.pathname}`);

// ---------------------------------------------------------------- helpers ---

function currentUrl() {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("v");
    if (v) return "https://www.youtube.com/watch?v=" + v;
    const s = location.pathname.match(/^\/shorts\/([\w-]{6,})/);
    if (s) return "https://www.youtube.com/shorts/" + s[1];
  } catch (e) {
    console.warn(TAG, "url parse failed", e);
  }
  return null;
}

function isShorts() {
  return location.pathname.startsWith("/shorts/");
}

async function send(message) {
  try {
    const res = await chrome.runtime.sendMessage(message);
    if (res === undefined) {
      return { ok: false, error: "no reply from background - reload the extension" };
    }
    return res;
  } catch (e) {
    const m = String(e?.message || e);
    console.warn(TAG, "sendMessage failed:", m);
    if (/context invalidated|Receiving end does not exist/i.test(m)) {
      return { ok: false, error: "extension was reloaded - refresh this page (F5)" };
    }
    return { ok: false, error: m };
  }
}

function toast(message, kind = "info") {
  document.getElementById(TOAST_ID)?.remove();
  const el = document.createElement("div");
  el.id = TOAST_ID;
  el.className = "ytg-toast ytg-toast--" + kind;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("ytg-toast--in"));
  setTimeout(() => {
    el.classList.remove("ytg-toast--in");
    setTimeout(() => el.remove(), 300);
  }, kind === "error" ? 7000 : 4000);
}

// ----------------------------------------------------------------- button ---

function makeButton(label, format, primary) {
  const b = document.createElement("button");
  b.className = "ytg-btn" + (primary ? " ytg-btn--primary" : "");
  b.type = "button";
  b.textContent = label;
  b.dataset.label = label;
  b.dataset.format = format;
  b.title =
    format === "mp3"
      ? "Gugu Grab: save audio as MP3 320k"
      : "Gugu Grab: save video as MP4 (up to 1080p)";

  b.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    if (b.dataset.busy === "1") return;

    const url = currentUrl();
    if (!url) {
      toast("Not on a video page", "error");
      return;
    }

    b.dataset.busy = "1";
    b.textContent = "...";
    b.classList.add("ytg-busy");

    console.log(`${TAG} click ${format} -> ${url}`);
    const res = await send({ type: "ytg:grab", url, format });
    console.log(`${TAG} response`, res);

    b.dataset.busy = "0";
    b.classList.remove("ytg-busy");

    if (!res || !res.ok) {
      b.textContent = "\u2715";
      setTimeout(() => { b.textContent = b.dataset.label; }, 2500);
      toast(res?.error || "Could not reach the helper", "error");
    } else {
      b.textContent = "\u2713";
      setTimeout(() => { b.textContent = b.dataset.label; }, 1800);
      toast("Queued - " + (format === "mp3" ? "MP3" : "MP4"), "info");
    }
  });

  return b;
}

function buildWrap() {
  const wrap = document.createElement("div");
  wrap.id = WRAP_ID;
  wrap.className = "ytg-wrap";
  wrap.appendChild(makeButton("MP3", "mp3", true));
  wrap.appendChild(makeButton("MP4", "mp4", false));
  return wrap;
}

function mountPoint() {
  return (
    document.querySelector("#top-level-buttons-computed") ||
    document.querySelector("ytd-watch-metadata #actions-inner") ||
    document.querySelector("ytd-watch-metadata #actions") ||
    null
  );
}

function inject() {
  if (!currentUrl()) return;
  if (document.getElementById(WRAP_ID)) return;

  const host = mountPoint();
  const wrap = buildWrap();

  if (host && !isShorts()) {
    host.appendChild(wrap);
    console.log(TAG, "buttons mounted in action bar");
  } else {
    wrap.classList.add("ytg-wrap--floating");
    if (isShorts()) wrap.classList.add("ytg-wrap--shorts");
    document.body.appendChild(wrap);
    console.log(TAG, "buttons mounted as floating pill (shorts:", isShorts(), ")");
  }
}

function tick() {
  if (location.href !== lastHref) {
    lastHref = location.href;
    document.getElementById(WRAP_ID)?.remove();
  }
  inject();
}

// --------------------------------------------------------------- feedback ---

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "ytg:done") {
    toast("Saved: " + msg.name, "ok");
  } else if (msg?.type === "ytg:error") {
    toast("Failed: " + msg.error, "error");
  }
});

tick();
setInterval(tick, 1000);
document.addEventListener("yt-navigate-finish", () => setTimeout(tick, 120));
