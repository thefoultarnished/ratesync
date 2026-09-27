// popup.js

async function checkImdbLogin() {
  const [c1, c2] = await Promise.all([
    chrome.cookies.getAll({ domain: ".imdb.com" }),
    chrome.cookies.getAll({ domain: "www.imdb.com" }),
  ]);
  return c1.some((c) => c.name === "at-main") || c2.some((c) => c.name === "at-main");
}

function openImdbLogin() {
  chrome.tabs.create({ url: "https://www.imdb.com/login" });
}

// TMDb v3 API keys are 32 hex chars; v4 Read Access Tokens are long JWT-style strings.
function isTmdbV3Key(key) {
  return /^[0-9a-f]{32}$/i.test(String(key).trim());
}

// Fallback link for syncs where no IMDb id was resolved, so the user can still open
// the film on Letterboxd from a failed entry.
function getLetterboxdUrl(entry) {
  if (entry.letterboxdFilmId) return `https://letterboxd.com/film/film:${entry.letterboxdFilmId}/`;
  if (entry.productionId) return `https://letterboxd.com/film/${entry.productionId}/`;
  return null;
}

function renderStars(rating) {
  const value = Number(rating);
  // A sync can fail before we ever learned the rating (e.g. the value could not be
  // read from Letterboxd) — show a dash rather than five empty stars.
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    return '<span class="log-stars">—</span>';
  }
  const val   = value / 2;
  const full  = Math.floor(val);
  const half  = (val % 1) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return (
    '<span class="log-stars">' +
    '<span class="star-full">★</span>'.repeat(full) +
    (half ? '<span class="star-half">★</span>' : '') +
    '<span class="star-empty">★</span>'.repeat(empty) +
    '</span>'
  );
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Mirrors background.js's sameFilm(): matches on whichever identifier both entries have.
function sameFilm(a, b) {
  if (a.imdbId && b.imdbId && /^tt\d+$/.test(a.imdbId) && a.imdbId === b.imdbId) return true;
  if (a.letterboxdFilmId && b.letterboxdFilmId && a.letterboxdFilmId === b.letterboxdFilmId) return true;
  if (a.productionId && b.productionId && a.productionId === b.productionId) return true;
  return false;
}

function canRetry(entry, syncLog) {
  const structurallyRetryable = !entry.success
    && Number.isInteger(entry.rating)
    && entry.rating >= 1
    && entry.rating <= 10
    && (
      /^tt\d+$/.test(entry.imdbId || "")
      || entry.letterboxdFilmId
      || entry.productionId
      || entry.logEntryId
    );
  if (!structurallyRetryable) return false;
  // A newer successful sync of the same film means retrying would only resubmit a
  // stale rating — background.js refuses this too, so hide the now-dead button.
  return !syncLog.some((other) => other.success && other.timestamp > entry.timestamp && sameFilm(other, entry));
}

function sendRetry(entry) {
  console.debug("[RateSync Popup] sending retry", {
    filmTitle: entry?.filmTitle,
    imdbId: entry?.imdbId,
    rating: entry?.rating,
    letterboxdFilmId: entry?.letterboxdFilmId,
    productionId: entry?.productionId,
    logEntryId: entry?.logEntryId,
    timestamp: entry?.timestamp,
  });
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "retry-sync", entry }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Retry failed."));
        return;
      }
      resolve(response);
    });
  });
}

async function retryEntry(entry, button) {
  button.disabled = true;
  button.setAttribute("aria-label", "Retrying failed sync");
  const status = document.getElementById("retryStatus");
  try {
    const response = await sendRetry(entry);
    console.debug("[RateSync Popup] retry response", response);
  } catch (err) {
    console.warn("[RateSync Popup] retry failed", {
      message: err.message,
      entry,
    });
    // render() below rebuilds #logList from scratch, so anything shown on the button
    // itself would vanish before it could be seen — this lives outside that list.
    if (status) {
      status.textContent = `Retry failed: ${err.message}`;
      status.className = "settings-status err";
      clearTimeout(status._rsClearTimer);
      status._rsClearTimer = setTimeout(() => { status.textContent = ""; }, 4000);
    }
  } finally {
    await render();
  }
}

async function render() {
  const dot         = document.getElementById("statusDot");
  const statusText  = document.getElementById("statusText");
  const logList     = document.getElementById("logList");
  const totalCount  = document.getElementById("totalCount");

  const [loggedIn, { syncLog = [], showFailedOnly = false, showUniqueOnly = false }] = await Promise.all([
    checkImdbLogin(),
    chrome.storage.local.get(["syncLog", "showFailedOnly", "showUniqueOnly"]),
  ]);

  const pill = document.querySelector(".status-pill");
  if (loggedIn) {
    dot.className = "dot ok";
    statusText.textContent = "IMDb connected";
    pill.style.cursor = "";
    pill.setAttribute("role", "status");
    pill.removeAttribute("tabindex");
    pill.onclick = null;
    pill.onkeydown = null;
  } else {
    dot.className = "dot warn";
    statusText.textContent = "Log in to IMDb";
    pill.style.cursor = "pointer";
    pill.setAttribute("role", "button");
    pill.setAttribute("tabindex", "0");
    pill.onclick = openImdbLogin;
    pill.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openImdbLogin();
    };
  }

  const statsBar = document.getElementById("statsBar");
  if (syncLog.length > 0) {
    const successful = syncLog.filter(e => e.success);
    const successRate = Math.round((successful.length / syncLog.length) * 100);
    const ratedSuccessful = successful.filter((e) => Number.isFinite(e.rating));
    const avgRating = ratedSuccessful.length
      ? (ratedSuccessful.reduce((sum, e) => sum + e.rating, 0) / ratedSuccessful.length / 2).toFixed(1)
      : null;
    // "Synced" counts successes only; failures are reflected in the success rate.
    document.getElementById("statTotal").textContent = successful.length;
    document.getElementById("statSuccess").textContent = `${successRate}%`;
    document.getElementById("statAvg").textContent = avgRating ? `★ ${avgRating}/5` : "—";
    statsBar.classList.add("visible");
  } else {
    statsBar.classList.remove("visible");
  }

  let filteredLog = syncLog;
  if (showFailedOnly) {
    filteredLog = syncLog.filter((e) => !e.success);
  } else if (showUniqueOnly) {
    const seen = new Set();
    filteredLog = syncLog.filter((e) => {
      const key = e.imdbId || e.filmTitle;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const failedCount = syncLog.filter((e) => !e.success).length;
  const uniqueCount = new Set(syncLog.map((e) => e.imdbId || e.filmTitle)).size;
  const allCount = syncLog.length;

  const countAllEl = document.getElementById("countAll");
  const countUniqueEl = document.getElementById("countUnique");
  const countFailedEl = document.getElementById("countFailed");
  if (countAllEl) countAllEl.textContent = String(allCount);
  if (countUniqueEl) countUniqueEl.textContent = String(uniqueCount);
  if (countFailedEl) countFailedEl.textContent = String(failedCount);

  const currentMode = showFailedOnly ? "failed" : showUniqueOnly ? "unique" : "all";
  const filterLabelEl = document.getElementById("filterCurrentLabel");
  if (filterLabelEl) {
    if (currentMode === "failed") filterLabelEl.textContent = `Failed (${failedCount})`;
    else if (currentMode === "unique") filterLabelEl.textContent = `Unique (${uniqueCount})`;
    else filterLabelEl.textContent = `All (${allCount})`;
  }

  const dropdown = document.getElementById("filterDropdown");
  dropdown?.classList.toggle("has-failed-active", currentMode === "failed");

  document.querySelectorAll(".filter-dropdown-option").forEach((opt) => {
    const isSelected = opt.getAttribute("data-value") === currentMode;
    opt.classList.toggle("selected", isSelected);
    opt.setAttribute("aria-pressed", String(isSelected));
  });

  if (filteredLog.length === 0) {
    logList.innerHTML = `
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">${showFailedOnly ? "✓" : "&starf;"}</div>
        ${showFailedOnly ? "No failed syncs." : "No syncs yet.<br>Rate a film on Letterboxd."}
      </div>`;
    if (totalCount) totalCount.textContent = "";
  } else {
    const isFiltered = showFailedOnly || showUniqueOnly;
    if (totalCount) totalCount.textContent = isFiltered ? `${filteredLog.length} shown` : `${filteredLog.length} total`;

    logList.innerHTML = "";
    filteredLog.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "log-item";

      const statusDot = document.createElement("div");
      statusDot.className = `log-status ${entry.success ? "ok" : "err"}`;

      const body = document.createElement("div");
      body.className = "log-body";

      const title = document.createElement("span");
      title.className = "log-title";
      title.textContent = entry.filmTitle || entry.imdbId || "Unknown film";
      title.title = title.textContent;
      body.appendChild(title);

      if (!entry.success && entry.error) {
        const errEl = document.createElement("div");
        errEl.className = "log-error";
        errEl.textContent = entry.error;
        errEl.title = entry.error;
        body.appendChild(errEl);
      }

      const meta = document.createElement("span");
      meta.className = "log-meta";
      meta.innerHTML = `${renderStars(entry.rating)}<span class="log-time">${timeAgo(entry.timestamp)}</span>`;

      const targetUrl = (entry.imdbId && /^tt\d+$/.test(entry.imdbId))
        ? `https://www.imdb.com/title/${entry.imdbId}/`
        : getLetterboxdUrl(entry);
      if (targetUrl) {
        item.classList.add("clickable");
        item.setAttribute("role", "link");
        item.setAttribute("tabindex", "0");
        const openTarget = () => chrome.tabs.create({ url: targetUrl });
        item.addEventListener("click", openTarget);
        item.addEventListener("keydown", (event) => {
          // Ignore keys bubbling up from the retry button — it's a real <button> and
          // already handles its own Enter/Space; this is only for the row itself.
          if (event.target !== item) return;
          if (event.key !== "Enter") return;
          event.preventDefault();
          openTarget();
        });
      }

      item.append(statusDot, body, meta);

      if (canRetry(entry, syncLog)) {
        const retryBtn = document.createElement("button");
        retryBtn.className = "retry-btn";
        retryBtn.type = "button";
        retryBtn.title = "Retry sync";
        retryBtn.setAttribute("aria-label", `Retry sync for ${entry.filmTitle || entry.imdbId || "this film"}`);
        retryBtn.innerHTML = `
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-2.64-6.36"/>
            <path d="M21 3v6h-6"/>
          </svg>`;
        retryBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          retryEntry(entry, retryBtn);
        });
        item.appendChild(retryBtn);
      }

      logList.appendChild(item);
    });
  }
}

// Re-render when user returns to the popup after logging into IMDb in another tab
window.addEventListener("focus", render);

// ── Clear log (two-click confirmation) ──
const clearBtn = document.getElementById("clearBtn");
let clearPending = false;
let clearTimer = null;

clearBtn.addEventListener("click", async () => {
  if (!clearPending) {
    clearPending = true;
    clearBtn.textContent = "Sure?";
    clearBtn.classList.add("confirm");
    clearTimer = setTimeout(() => {
      clearPending = false;
      clearBtn.textContent = "Clear";
      clearBtn.classList.remove("confirm");
    }, 2500);
    return;
  }
  clearTimeout(clearTimer);
  clearPending = false;
  clearBtn.textContent = "Clear";
  clearBtn.classList.remove("confirm");
  await chrome.storage.local.set({ syncLog: [] });
  render();
});

// ── Settings panel ──
const settingsBtn     = document.getElementById("settingsBtn");
const backBtn         = document.getElementById("backBtn");
const mainView        = document.getElementById("mainView");
const settingsSection = document.getElementById("settingsSection");
const tmdbKeyInput    = document.getElementById("tmdbKeyInput");
const saveKeyBtn      = document.getElementById("saveKeyBtn");
const saveStatus      = document.getElementById("saveStatus");
const removeKeyBtn    = document.getElementById("removeKeyBtn");

async function openSettings() {
  mainView.style.display = "none";
  settingsSection.classList.add("visible");
  settingsBtn.classList.add("active");
  const { tmdbApiKey, tmdbEnabled, autoOpenImdb = false, showToasts = true, imdbFallbackEnabled = true } = await chrome.storage.local.get([
    "tmdbApiKey",
    "tmdbEnabled",
    "autoOpenImdb",
    "showToasts",
    "imdbFallbackEnabled",
  ]);
  // Never set explicitly (e.g. upgraded from a version without the toggle): on if a key
  // is already saved, so an existing setup keeps working; off otherwise.
  const tmdbOn = tmdbEnabled ?? Boolean(tmdbApiKey);
  document.getElementById("tmdbToggle").checked = tmdbOn;
  document.getElementById("tmdbFields").hidden = !tmdbOn;
  if (tmdbApiKey) tmdbKeyInput.value = tmdbApiKey;
  removeKeyBtn.style.display = tmdbApiKey ? "" : "none";
  const toastsToggle = document.getElementById("showToastsToggle");
  if (toastsToggle) toastsToggle.checked = showToasts;
  const autoOpenEl = document.getElementById("autoOpenToggle");
  if (autoOpenEl) autoOpenEl.checked = autoOpenImdb;
  const fallbackEl = document.getElementById("imdbFallbackToggle");
  if (fallbackEl) fallbackEl.checked = imdbFallbackEnabled;
}

function closeSettings() {
  settingsSection.classList.remove("visible");
  mainView.style.display = "";
  settingsBtn.classList.remove("active");
}

settingsBtn.addEventListener("click", () => {
  settingsSection.classList.contains("visible") ? closeSettings() : openSettings();
});

backBtn.addEventListener("click", closeSettings);

const filterDropdown = document.getElementById("filterDropdown");
const filterDropdownBtn = document.getElementById("filterDropdownBtn");

filterDropdownBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  const isOpen = filterDropdown.classList.toggle("open");
  filterDropdownBtn.setAttribute("aria-expanded", String(isOpen));
});

document.querySelectorAll(".filter-dropdown-option").forEach((opt) => {
  opt.addEventListener("click", async (e) => {
    e.stopPropagation();
    const mode = opt.getAttribute("data-value");
    const showFailedOnly = mode === "failed";
    const showUniqueOnly = mode === "unique";
    await chrome.storage.local.set({ showFailedOnly, showUniqueOnly });
    filterDropdown?.classList.remove("open");
    filterDropdownBtn?.setAttribute("aria-expanded", "false");
    render();
  });
});

document.addEventListener("click", (e) => {
  if (filterDropdown && !filterDropdown.contains(e.target)) {
    filterDropdown.classList.remove("open");
    filterDropdownBtn?.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && filterDropdown?.classList.contains("open")) {
    filterDropdown.classList.remove("open");
    filterDropdownBtn?.setAttribute("aria-expanded", "false");
    filterDropdownBtn?.focus();
  }
});

chrome.storage.local.get("showToasts").then(({ showToasts = true }) => {
  const toggle = document.getElementById("showToastsToggle");
  if (toggle) {
    toggle.checked = showToasts;
    toggle.addEventListener("change", async (e) => {
      await chrome.storage.local.set({ showToasts: e.target.checked });
    });
  }
});

document.getElementById("autoOpenToggle").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ autoOpenImdb: e.target.checked });
});

document.getElementById("tmdbToggle").addEventListener("change", async (e) => {
  // Off hides the key fields but keeps a saved key, so turning it back on needs no re-entry.
  document.getElementById("tmdbFields").hidden = !e.target.checked;
  await chrome.storage.local.set({ tmdbEnabled: e.target.checked });
});

document.getElementById("imdbFallbackToggle")?.addEventListener("change", async (e) => {
  await chrome.storage.local.set({ imdbFallbackEnabled: e.target.checked });
});

removeKeyBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("tmdbApiKey");
  tmdbKeyInput.value = "";
  removeKeyBtn.style.display = "none";
  saveStatus.textContent = "Token removed.";
  saveStatus.className = "settings-status ok";
  setTimeout(() => { saveStatus.textContent = ""; }, 2000);
});

document.getElementById("toggleVisibility").addEventListener("click", () => {
  const input = document.getElementById("tmdbKeyInput");
  const icon  = document.getElementById("eyeIcon");
  const show  = input.type === "password";
  input.type  = show ? "text" : "password";
  icon.innerHTML = show
    ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
       <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
       <line x1="1" y1="1" x2="23" y2="23"/>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
       <circle cx="12" cy="12" r="3"/>`;
  document.getElementById("toggleVisibility").setAttribute("aria-label", show ? "Hide API key" : "Show API key");
});

document.getElementById("tmdbHowToBtn").addEventListener("click", () => {
  const el  = document.getElementById("tmdbInstructions");
  const btn = document.getElementById("tmdbHowToBtn");
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "";
  btn.textContent  = open ? "How to get one? ▸" : "How to get one? ▾";
});

document.getElementById("kofiBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: "https://ko-fi.com/thefoultarnished" });
});

const FEEDBACK_FORM_URL = "https://tally.so/r/68oB5B";
for (const id of ["feedbackLink", "settingsFeedbackLink"]) {
  document.getElementById(id)?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: FEEDBACK_FORM_URL });
  });
}

// Bundled with the extension (see scripts/pack.py), not an external link — opened the
// same way so a click doesn't navigate the popup itself away. Two entry points: the
// version tag in the header, and the "Changelog" link in Settings.
for (const id of ["appVersion", "changelogLink"]) {
  document.getElementById(id)?.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("changelogs.html") });
  });
}

document.getElementById("tmdbHomeLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://www.themoviedb.org" });
});

document.getElementById("tmdbApiLink").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "https://www.themoviedb.org/settings/api" });
});

saveKeyBtn.addEventListener("click", async () => {
  const key = tmdbKeyInput.value.trim();

  // The TMDb key is optional: most Letterboxd pages expose an IMDb link directly, so the
  // extension syncs fine without one. Saving an empty field is therefore a valid "keep
  // running without a fallback key" state instead of an error.
  if (!key) {
    await chrome.storage.local.remove("tmdbApiKey");
    tmdbKeyInput.value = "";
    removeKeyBtn.style.display = "none";
    saveStatus.textContent = "Saved — no TMDb key stored.";
    saveStatus.className = "settings-status ok";
    saveKeyBtn.disabled = false;
    setTimeout(() => { saveStatus.textContent = ""; }, 2000);
    return;
  }

  saveKeyBtn.disabled = true;
  saveStatus.textContent = "Validating…";
  saveStatus.className = "settings-status";

  try {
    // v4 Read Access Tokens authenticate as a Bearer token; standard 32-char v3 API keys
    // only work as an ?api_key= query parameter (they are rejected as Bearer tokens).
    const isV3Key = isTmdbV3Key(key);
    const resp = await fetch(
      isV3Key
        ? `https://api.themoviedb.org/3/authentication?api_key=${encodeURIComponent(key)}`
        : "https://api.themoviedb.org/3/authentication",
      isV3Key ? {} : { headers: { Authorization: `Bearer ${key}` } }
    );
    const data = await resp.json();
    if (!resp.ok || !data.success) throw new Error();
  } catch {
    saveStatus.textContent = "Invalid token.";
    saveStatus.className = "settings-status err";
    saveKeyBtn.disabled = false;
    return;
  }

  await chrome.storage.local.set({ tmdbApiKey: key });
  saveStatus.textContent = "Saved.";
  saveStatus.className = "settings-status ok";
  removeKeyBtn.style.display = "";
  saveKeyBtn.disabled = false;
  setTimeout(() => { saveStatus.textContent = ""; }, 2000);
});

try {
  const version = chrome.runtime.getManifest()?.version;
  if (version) {
    const vEl = document.getElementById("appVersion");
    if (vEl) vEl.textContent = `v${version}`;
    const svEl = document.getElementById("settingsVersion");
    if (svEl) svEl.textContent = `RateSync v${version}`;
  }
} catch {
  /* ignore */
}
render();
