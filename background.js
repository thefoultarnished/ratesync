// background.js - intercepts both Letterboxd rating endpoints

const pendingRatings = new Map();
const PENDING_FILM_TTL_MS = 10 * 60 * 1000;
const PENDING_STORAGE_KEY = "pendingRatings";
const IMDB_TAB_STORAGE_KEY = "imdbOpenTabId";
// Set once the IMDb tab has been handed to the user (focused after a *successful*
// rating). Lives in chrome.storage.session so a restarted worker still knows that this
// tab belongs to the user and must never be auto-closed.
const IMDB_TAB_OWNED_KEY = "imdbTabUserOwned";
const IMDB_TAB_RELEASE_ALARM = "ratesync-release-imdb-tab";
const DEBUG_PREFIX = "[RateSync]";

// Chrome terminates an idle Manifest V3 service worker after ~30 seconds, which used to
// wipe this in-flight correlation map (e.g. while a user was still writing a review).
// Every mutation is mirrored into chrome.storage.session, which survives worker restarts
// and is cleared automatically when the browser session ends.
let pendingHydration = null;
let pendingWriteQueue = Promise.resolve();

function hydratePendingRatings() {
  if (!pendingHydration) {
    pendingHydration = chrome.storage.session
      .get(PENDING_STORAGE_KEY)
      .then((stored) => {
        const saved = stored[PENDING_STORAGE_KEY] || {};
        const now = Date.now();
        let restored = 0;
        let dropped = 0;
        for (const [key, value] of Object.entries(saved)) {
          if (pendingRatings.has(key) || !value) continue;
          const expired = key.startsWith("tab-") && value.ts && now - value.ts > PENDING_FILM_TTL_MS;
          if (expired) {
            dropped += 1;
            continue;
          }
          pendingRatings.set(key, value);
          restored += 1;
        }
        if (restored > 0) debug("restored pending ratings after worker restart", { restored });
        // Expired entries were left out of the live map above; write that back now so
        // they're gone from storage too, instead of sitting there until an unrelated
        // future write happens to overwrite this same key.
        if (dropped > 0) return persistPendingRatings();
      })
      .catch((err) => warn("failed to hydrate pending ratings", { error: errorInfo(err) }));
  }
  return pendingHydration;
}

function persistPendingRatings() {
  // Serialize writes so concurrent events cannot persist a stale snapshot.
  pendingWriteQueue = pendingWriteQueue
    .then(() => chrome.storage.session.set({
      [PENDING_STORAGE_KEY]: Object.fromEntries(pendingRatings),
    }))
    .catch((err) => warn("failed to persist pending ratings", { error: errorInfo(err) }));
  return pendingWriteQueue;
}

async function getPendingRating(key) {
  await hydratePendingRatings();
  return pendingRatings.get(key) || null;
}

async function setPendingRating(key, value) {
  await hydratePendingRatings();
  pendingRatings.set(key, value);
  await persistPendingRatings();
}

async function deletePendingRating(key) {
  await hydratePendingRatings();
  if (!pendingRatings.delete(key)) return;
  await persistPendingRatings();
}

// ── Ratings read from inside the page ──────────────────────────────────────
// Chrome never exposes PATCH request bodies to webRequest, and the film page's star
// widget saves with `PATCH /api/v0/me/rate/{id}`. page-hook.js reads the rating in the
// page's own world and page-bridge.js posts it here as `page-rating`, so the request we
// can see can still be paired with the value we cannot. Entries are short-lived and
// consumed on read; the worker stays awake for the whole exchange because both the
// message and the webRequest events keep it alive.
const PAGE_RATING_TTL_MS = 30 * 1000;
// Keyed by tab *and* film, so rating two films in quick succession on one page keeps
// both reports instead of the second replacing the first.
const pageRatings = new Map(); // "tabId|filmId" -> { rating, url, ts } (rating may be null = cleared)

function rateIdFromUrl(url) {
  const match = String(url || "").match(/\/me\/rate\/([^/?#]+)/);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function pageRatingKey(tabId, rateId) {
  return `${tabId}|${rateId}`;
}

function rememberPageRating(tabId, rating, url) {
  if (!Number.isInteger(tabId)) return;
  const rateId = rateIdFromUrl(url);
  if (!rateId) return;
  const now = Date.now();
  for (const [key, entry] of pageRatings) {
    if (now - entry.ts > PAGE_RATING_TTL_MS) pageRatings.delete(key);
  }
  pageRatings.set(pageRatingKey(tabId, rateId), { rating, url: String(url), ts: now });
}

function takePageRating(tabId, rateId) {
  if (!rateId) return null;
  const key = pageRatingKey(tabId, rateId);
  const entry = pageRatings.get(key);
  if (!entry) return null;
  // Consumed on read: a report left behind would be picked up by the *next* rating of
  // the same film and re-submit this value.
  pageRatings.delete(key);
  if (Date.now() - entry.ts > PAGE_RATING_TTL_MS) return null;
  return entry;
}

// The page hook normally reports before the request even leaves, but if the request
// wins the race the capture sits in `awaitingPageRating` until this fills it in.
async function fillAwaitingRating(tabId, rawRating, url) {
  if (!Number.isInteger(tabId)) return false;

  await hydratePendingRatings();
  for (const [key, entry] of pendingRatings) {
    if (!entry || !entry.awaitingPageRating || entry.rating || entry.tabId !== tabId) continue;
    // A report for another film on this tab must not hand its rating to this capture.
    if (entry.rateId !== rateIdFromUrl(url)) continue;

    const rating = parseRating(rawRating, "letterboxd");
    if (!rating) {
      // The page told us the rating was cleared — not a failure, just nothing to do.
      // Drop the correlation here so it cannot surface later as "could not read the
      // rating", and forget the report for the same reason.
      await deletePendingRating(key);
      pageRatings.delete(pageRatingKey(tabId, entry.rateId));
      debug("letterboxd cleared this rating; nothing to sync", { tabId, key });
      return true;
    }

    entry.rating = rating;
    // The report has been handed over — consume it. Leaving it in the map let the
    // *next* rating of the same film pick up this film's previous value.
    pageRatings.delete(pageRatingKey(tabId, entry.rateId));
    await persistPendingRatings();
    showSyncToast(tabId, {
      stage: "start",
      title: "IMDb sync initiated",
      detail: `IMDb rating (converted): ${rating}/10`,
    });
    debug("rating delivered by page hook", { tabId, rating });
    return true;
  }
  return false;
}

function debug(step, data = {}) {
  console.debug(DEBUG_PREFIX, step, data);
}

function warn(step, data = {}) {
  console.warn(DEBUG_PREFIX, step, data);
}

function errorInfo(err) {
  return {
    name: err?.name,
    message: err?.message || String(err),
    stack: err?.stack,
  };
}

async function cleanupPending(details) {
  debug("request cleanup after network error", {
    requestId: details.requestId,
    url: details.url,
    error: details.error,
  });
  const pending = await getPendingRating(details.requestId);
  await deletePendingRating(details.requestId);
  if (pending?.rating) {
    // We already toasted "IMDb sync initiated" for this one — close the loop instead of
    // leaving a dangling "initiated" card with no outcome.
    showSyncToast(details.tabId, {
      stage: "error",
      title: "Sync cancelled",
      detail: "The Letterboxd request failed — nothing was sent to IMDb.",
    });
  }
}

function getUrlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

// Chrome can split a request body across more than one `raw` chunk; concatenating all
// of them (instead of reading only raw[0]) keeps a long body from being silently
// truncated. TextDecoder's `stream: true` handles a multi-byte character split across
// a chunk boundary, and the final no-argument decode() flushes anything left over.
function decodeRawBody(requestBody) {
  const chunks = requestBody?.raw;
  if (!chunks || chunks.length === 0) return null;
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) {
    if (chunk?.bytes) text += decoder.decode(chunk.bytes, { stream: true });
  }
  text += decoder.decode();
  return text || null;
}

function readRequestBody(requestBody) {
  if (requestBody?.formData) return requestBody.formData;
  const text = decodeRawBody(requestBody);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return new URLSearchParams(text);
  }
}

// Tells us whether a parsed body carried a `rating` field at all — `{"rating": null}`
// means the user cleared a rating, which is different from a body we could not read.
function readBodyRating(body) {
  const missing = { found: false, value: null };
  if (body instanceof URLSearchParams) {
    return body.has("rating") ? { found: true, value: body.get("rating") } : missing;
  }
  if (body && typeof body === "object") {
    if ("rating" in body) return { found: true, value: body.rating };
    const form = body.formData;
    if (form && typeof form === "object" && "rating" in form) {
      return { found: true, value: form.rating };
    }
  }
  return missing;
}

function firstValue(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value[0];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function parseRating(value, scale) {
  if (Array.isArray(value)) value = value[0];
  const rating = Number(value);
  if (!Number.isFinite(rating) || rating <= 0) return null;
  const imdbRating = scale === "letterboxd" ? Math.round(rating * 2) : Math.round(rating);
  return Math.min(10, Math.max(1, imdbRating));
}

function parseLogEntryId(url) {
  const path = getUrlPath(url);
  const match = path.match(/\/api\/v0\/(?:production-log-entries|log-entries|log-entry)\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeLetterboxdFilmId(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = String(value).match(/^(?:film:)?(\d+)$/);
  return match ? match[1] : null;
}

function normalizeSlug(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") return null;
  return /^[\w-]+$/.test(value) && !/^\d+$/.test(value) ? value : null;
}

function looksLikeLetterboxdLid(value) {
  return typeof value === "string" && /^[A-Za-z0-9]{2,8}$/.test(value);
}

function findFirstMatch(value, pattern, mapper) {
  if (!value) return null;
  if (typeof value === "string") {
    const match = value.match(pattern);
    return match ? mapper(match) : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findFirstMatch(item, pattern, mapper);
      if (result) return result;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      const result = findFirstMatch(item, pattern, mapper);
      if (result) return result;
    }
  }
  return null;
}

function findFirstUrlMatching(value, pattern) {
  return findFirstMatch(value, pattern, (match) => firstValue(...match.slice(1)));
}

// Finds a TMDb reference anywhere in an API payload. Handles both
// "themoviedb.org/tv/123" style links (type is explicit) and bare "tmdb:123" ids
// (type unknown, assumed to be a movie).
function findFirstTmdbRef(value) {
  return findFirstMatch(
    value,
    /themoviedb\.org\/(movie|tv)\/(\d+)|(?:^|[/:])tmdb:(\d+)\b/i,
    (match) => {
      if (match[2]) return { tmdbId: match[2], mediaType: match[1].toLowerCase() };
      if (match[3]) return { tmdbId: match[3], mediaType: "movie" };
      return null;
    }
  );
}

function getFilmTitleFromApiFilm(data) {
  return firstValue(data?.name, data?.title, data?.film?.name, data?.film?.title);
}

function parseProductionPayload(body) {
  if (!body) {
    debug("log entry request had no readable body");
    return {};
  }
  const getter = body instanceof URLSearchParams
    ? (key) => body.get(key)
    : (key) => body[key];

  const rating = parseRating(firstValue(
    getter("rating"),
    getter("memberRating"),
    getter("ratingValue")
  ), "letterboxd");

  const candidate = firstValue(
    getter("productionId"),
    getter("filmId"),
    getter("viewingableUID"),
    body.production?.id,
    body.production?.slug,
    body.film?.id,
    body.film?.slug
  );

  return {
    rating,
    letterboxdFilmId: normalizeLetterboxdFilmId(candidate),
    productionId: normalizeSlug(candidate),
    rawCandidate: candidate,
    bodyType: body instanceof URLSearchParams ? "urlsearchparams" : "json",
  };
}

// TMDb accepts either a v4 Read Access Token (Bearer header) or a 32-char hex v3 API key
// (query parameter). Detect which one we were given so both formats work end to end.
function isTmdbV3ApiKey(key) {
  return /^[0-9a-f]{32}$/i.test(String(key).trim());
}

function buildTmdbRequest(url, apiKey) {
  const key = String(apiKey).trim();
  if (isTmdbV3ApiKey(key)) {
    return { url: `${url}${url.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(key)}`, init: {} };
  }
  return { url, init: { headers: { Authorization: `Bearer ${key}` } } };
}

async function getTmdbApiKey() {
  const { tmdbApiKey, tmdbEnabled } = await chrome.storage.local.get(["tmdbApiKey", "tmdbEnabled"]);
  // tmdbEnabled is unset until the user first touches the Settings toggle; a saved key
  // alone then means "on", matching how the popup renders the toggle.
  if (tmdbEnabled === false) {
    throw permanentError("TMDb lookup is off. Turn it on in Settings to sync this film.");
  }
  if (!tmdbApiKey) throw permanentError("TMDb API key not set. Turn on TMDb lookup in Settings and add a key.");
  return tmdbApiKey;
}

// Watch for film selection in LOG dialog: fires when user picks a film
// URL contains the numeric film ID we need later
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    const match = details.url.match(/viewingableUID=film:(\d+)/);
    if (!match) return;
    const tabKey = `tab-${details.tabId}`;
    await setPendingRating(tabKey, { filmId: match[1], ts: Date.now() });
    debug("captured log dialog film selection", {
      tabId: details.tabId,
      letterboxdFilmId: match[1],
      url: details.url,
    });
  },
  { urls: ["https://letterboxd.com/s/check-viewingable-relation*"] }
);

// Endpoint 1: film page rating - /s/film:XXXXX/rate/
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.method !== "POST") return;
    const match = details.url.match(/letterboxd\.com\/s\/film[:/](\d+)\/rate/);
    if (!match) return;

    const letterboxdFilmId = match[1];
    try {
      const body = readRequestBody(details.requestBody);
      const rating = parseRating(
        body instanceof URLSearchParams ? body.get("rating") : firstValue(body?.rating, body?.formData?.rating),
        "imdb"
      );
      if (rating) {
        await setPendingRating(details.requestId, { type: "film", letterboxdFilmId, rating });
        showSyncToast(details.tabId, {
          stage: "start",
          title: "IMDb sync initiated",
          detail: `IMDb rating (converted): ${rating}/10`,
        });
        debug("captured film page rating request", {
          requestId: details.requestId,
          tabId: details.tabId,
          letterboxdFilmId,
          rating,
          url: details.url,
        });
      } else {
        debug("ignored film page rating request without rating", {
          requestId: details.requestId,
          tabId: details.tabId,
          letterboxdFilmId,
          url: details.url,
        });
      }
    } catch (e) {
      warn("failed to parse film rating body", {
        requestId: details.requestId,
        tabId: details.tabId,
        url: details.url,
        error: errorInfo(e),
      });
    }
  },
  { urls: ["https://letterboxd.com/s/*"] },
  ["requestBody"]
);

// Endpoint 1b: the film page's React star widget.
// Letterboxd's newer client API sends `PATCH /api/v0/me/rate/{id}` with a JSON body,
// and its rating is in *stars* (1-5 in half steps, null to clear) — not the 0-10
// integer the classic /s/film:ID/rate/ form posted. The id in the path is normally the
// Letterboxd short code (LID, e.g. "2aWW"), which the resolution chain handles as a
// slug first and then via the boxd.it redirect.
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.method !== "POST" && details.method !== "PATCH") return;
    const match = getUrlPath(details.url).match(/\/api\/v0\/me\/rate\/([^/]+)/);
    if (!match) return;

    const rawId = decodeURIComponent(match[1]);
    try {
      const body = readRequestBody(details.requestBody);
      const bodyInfo = readBodyRating(body);
      const fromBody = bodyInfo.found;

      // Chrome does not deliver PATCH bodies to webRequest at all, so in practice the
      // value comes from the page hook rather than from the request itself.
      const hooked = takePageRating(details.tabId, rawId);
      const explicit = fromBody || Boolean(hooked);
      const rawRating = fromBody ? bodyInfo.value : hooked ? hooked.rating : null;
      const rating = explicit ? parseRating(rawRating, "letterboxd") : null;

      const numeric = rawId.match(/^(?:film:)?(\d+)$/);
      const base = numeric
        ? { type: "film", letterboxdFilmId: numeric[1], tabId: details.tabId }
        : { type: "production", productionId: rawId, tabId: details.tabId };

      if (!explicit) {
        // Neither the request nor the hook has given us a value yet — keep the
        // correlation open so the hook message (milliseconds away) can complete it.
        await setPendingRating(details.requestId, {
          ...base,
          rating: null,
          awaitingPageRating: true,
          rateId: rawId,
        });
        debug("me/rate waiting for rating from page hook", {
          requestId: details.requestId,
          tabId: details.tabId,
          rawId,
          url: details.url,
          bodyType: body === null ? "null" : body instanceof URLSearchParams ? "urlencoded" : typeof body,
          bodyKeys: body && typeof body === "object" && !(body instanceof URLSearchParams) ? Object.keys(body) : null,
          requestBodyError: details.requestBody?.error || null,
        });
        return;
      }

      if (!rating) {
        debug("ignored /me/rate unrate request", {
          requestId: details.requestId,
          tabId: details.tabId,
          rawId,
          rawRating,
          url: details.url,
        });
        return;
      }

      // Path id is a LID/slug in practice, but tolerate "film:51875" / bare digits too.
      await setPendingRating(details.requestId, { ...base, rating });
      showSyncToast(details.tabId, {
        stage: "start",
        title: "IMDb sync initiated",
        detail: `IMDb rating (converted): ${rating}/10`,
      });
      debug("captured film page rating request (me/rate)", {
        requestId: details.requestId,
        tabId: details.tabId,
        rawId,
        rating,
        source: fromBody ? "request body" : "page hook",
        url: details.url,
      });
    } catch (e) {
      warn("failed to parse me/rate body", {
        requestId: details.requestId,
        tabId: details.tabId,
        url: details.url,
        error: errorInfo(e),
      });
    }
  },
  { urls: ["https://letterboxd.com/api/v0/*", "https://api.letterboxd.com/*"] },
  ["requestBody"]
);

// Safety net for the next time Letterboxd changes something: any POST/PATCH to
// letterboxd.com that carries a rating we do *not* already handle is logged with its
// URL, so a silent miss shows up in the service worker console instead of nothing.
const HANDLED_RATING_PATH = /\/s\/film[:/]\d+\/rate|\/api\/v0\/(?:me\/rate\/|production-log-entries|log-entries|log-entry)/;
const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"];
const RATING_HOSTS = ["https://letterboxd.com/*", "https://api.letterboxd.com/*"];
// Sign-in and account submissions are dropped before their body is parsed or logged, so
// the safety net can never surface a password or token. No rating is sent on these.
const SENSITIVE_PATH = /login|logout|sign-?in|sign-?up|register|password|auth|token|session/i;
const SENSITIVE_FIELD = /pass|token|secret|auth|credential/i;

function hasSensitiveField(requestBody) {
  if (requestBody?.formData) {
    return Object.keys(requestBody.formData).some((key) => SENSITIVE_FIELD.test(key));
  }
  const text = decodeRawBody(requestBody);
  if (!text) return false;
  // Field-name check only (`"password":` / `password=`); values are never looked at.
  return /(?:pass|token|secret|auth|credential)[\w-]*["']?\s*[:=]/i.test(text);
}
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!WRITE_METHODS.includes(details.method)) return;
    // Every write request, so a miss can be spotted by simply watching the console
    // while rating (verbose level). Hidden by default to keep the log readable.
    debug("write request", { method: details.method, url: details.url });

    const path = getUrlPath(details.url);
    if (HANDLED_RATING_PATH.test(path)) return;
    if (SENSITIVE_PATH.test(path) || hasSensitiveField(details.requestBody)) return;

    const body = readRequestBody(details.requestBody);
    let queryRating = null;
    try {
      queryRating = new URL(details.url).searchParams.get("rating");
    } catch {
      queryRating = null;
    }
    const ratingValue = firstValue(
      queryRating,
      body instanceof URLSearchParams ? body.get("rating") : null,
      body?.rating,
      body?.memberRating,
      body?.ratingValue,
      body?.ratingOutOf10,
      body?.formData?.rating
    );
    if (ratingValue === null || ratingValue === undefined || ratingValue === "") return;
    warn("unhandled rating-bearing request", {
      requestId: details.requestId,
      tabId: details.tabId,
      method: details.method,
      url: details.url,
      ratingValue,
    });
  },
  { urls: RATING_HOSTS },
  ["requestBody"]
);

// Endpoint 2: log/diary entry create/update
chrome.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (details.method !== "POST" && details.method !== "PATCH") return;
    if (!/\/api\/v0\/(?:production-log-entries|log-entries|log-entry)\b/.test(getUrlPath(details.url))) return;

    let parsed;
    try {
      parsed = parseProductionPayload(readRequestBody(details.requestBody));
    } catch (e) {
      warn("failed to parse log entry body", {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        url: details.url,
        error: errorInfo(e),
      });
      return;
    }
    if (parsed.rating) {
      const tabKey = `tab-${details.tabId}`;
      const tabData = await getPendingRating(tabKey);
      // The tab's remembered film selection is only a fallback for a body that names no
      // film at all. It can be left over from an earlier dialog, and since a numeric id
      // wins over productionId at resolution, using it next to the body's own slug/LID
      // would sync the *earlier* film to IMDb.
      const tabFilmFresh = tabData && Date.now() - tabData.ts < PENDING_FILM_TTL_MS;
      const letterboxdFilmId = parsed.letterboxdFilmId
        || (!parsed.productionId && tabFilmFresh ? tabData.filmId : null);
      const entry = {
        type: "production",
        productionId: parsed.productionId,
        letterboxdFilmId,
        logEntryId: parseLogEntryId(details.url),
        rating: parsed.rating,
      };
      // Record the capture before any other storage write. Letterboxd can answer while a
      // write is in flight, and onCompleted must already find this entry by then —
      // otherwise the rating is silently dropped.
      await setPendingRating(details.requestId, entry);
      await deletePendingRating(tabKey);
      showSyncToast(details.tabId, {
        stage: "start",
        title: "IMDb sync initiated",
        detail: `IMDb rating (converted): ${parsed.rating}/10`,
      });
      debug("captured log entry rating request", {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        url: details.url,
        parsed,
        tabData,
        pending: entry,
      });
    } else {
      debug("ignored log entry request without parsed rating", {
        requestId: details.requestId,
        tabId: details.tabId,
        method: details.method,
        url: details.url,
        parsed,
      });
    }
  },
  { urls: ["https://letterboxd.com/api/v0/*", "https://api.letterboxd.com/*"] },
  ["requestBody"]
);

// One automatic second chance, five seconds later. Both halves of a sync lean on
// third parties that occasionally rate-limit or wobble (Letterboxd behind Cloudflare,
// IMDb's GraphQL), and a single delayed retry turns those into a success with no user
// action. A failed first attempt is deliberately silent — no log row, no toast — so the
// user only ever sees the final outcome: synced, or failed with the retry hint.
const SYNC_AUTO_RETRY_ATTEMPTS = 2;
const SYNC_AUTO_RETRY_DELAY_MS = 5000;

// Marks an error that a second attempt could never fix (wrong credentials/config,
// as opposed to a network wobble), so withAutoRetry() can skip the wasted wait.
function permanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

async function withAutoRetry(run, attempts = SYNC_AUTO_RETRY_ATTEMPTS, delayMs = SYNC_AUTO_RETRY_DELAY_MS) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await run(attempt);
    } catch (err) {
      if (attempt >= attempts || err?.permanent) throw err;
      debug("attempt failed; auto-retrying", {
        attempt,
        nextAttemptInMs: delayMs,
        error: errorInfo(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Handle completion for both endpoints
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const pending = await getPendingRating(details.requestId);
    if (!pending) return;
    await deletePendingRating(details.requestId);
    debug("letterboxd rating request completed", {
      requestId: details.requestId,
      statusCode: details.statusCode,
      url: details.url,
      pending,
    });
    if (details.statusCode < 200 || details.statusCode >= 300) {
      warn("letterboxd rating request did not succeed; skipping imdb sync", {
        requestId: details.requestId,
        statusCode: details.statusCode,
        url: details.url,
        pending,
      });
      return;
    }

    let rating = pending.rating || null;
    let filmTitle = null;
    let imdbId = null;

    try {
      // A film-page (PATCH) rating may only have been reported by the page hook. The
      // message is sent before the request leaves, so it has normally arrived by now;
      // this is the last chance to pick it up. Failing here (rather than retrying)
      // matters — no amount of waiting will produce a rating we were never given.
      if (!rating && pending.awaitingPageRating) {
        const pathMatch = getUrlPath(details.url).match(/\/api\/v0\/me\/rate\/([^/]+)/);
        const hooked = takePageRating(
          details.tabId,
          pathMatch ? decodeURIComponent(pathMatch[1]) : ""
        );
        debug("rating lookup at completion", {
          requestId: details.requestId,
          recovered: Boolean(hooked),
          rating: hooked ? hooked.rating : null,
        });
        if (hooked) {
          rating = parseRating(hooked.rating, "letterboxd");
          if (!rating) {
            // The report says the rating was cleared — a no-op, not a failure.
            debug("letterboxd cleared this rating; nothing to sync", {
              requestId: details.requestId,
            });
            return;
          }
        }
      }
      if (!rating) {
        throw new Error(
          "Could not read the rating Letterboxd sent for this film. Reload the Letterboxd page and rate again."
        );
      }

      await withAutoRetry(async () => {
        if (!pending.letterboxdFilmId && !pending.productionId && pending.logEntryId) {
          debug("pending entry missing film id; loading log entry", {
            requestId: details.requestId,
            logEntryId: pending.logEntryId,
          });
          Object.assign(pending, await getFilmFromLogEntry(pending.logEntryId));
          debug("loaded identifiers from log entry", {
            requestId: details.requestId,
            pending,
          });
        }

        if (pending.letterboxdFilmId) {
          debug("resolving imdb id from letterboxd numeric film id", {
            requestId: details.requestId,
            letterboxdFilmId: pending.letterboxdFilmId,
          });
          ({ imdbId, filmTitle } = await getImdbIdFromLetterboxdFilmId(pending.letterboxdFilmId));
        } else if (pending.productionId) {
          debug("resolving imdb id from letterboxd production id", {
            requestId: details.requestId,
            productionId: pending.productionId,
          });
          ({ imdbId, filmTitle } = await getImdbIdFromProductionId(pending.productionId));
        } else {
          throw new Error("Could not identify Letterboxd film from rating update.");
        }

        if (!/^tt\d+$/.test(imdbId)) throw new Error(`Unexpected IMDb ID format: ${imdbId}`);

        debug("submitting imdb rating", {
          requestId: details.requestId,
          filmTitle,
          imdbId,
          rating,
        });
        await submitImdbRating(imdbId, rating);
        await logSync(filmTitle || imdbId, imdbId, rating, true, null, getRetryPayload(pending));
        showSyncToast(details.tabId, {
          stage: "done",
          title: shortToastText(`IMDb rating synced: ${stripYearSuffix(filmTitle) || imdbId}`, 60),
          detail: `IMDb rating (converted): ${rating}/10`,
        });
        debug("sync completed", {
          requestId: details.requestId,
          filmTitle: filmTitle || imdbId,
          imdbId,
          rating,
        });
      });
    } catch (err) {
      warn("sync failed", {
        requestId: details.requestId,
        filmTitle,
        imdbId,
        rating,
        pending,
        error: errorInfo(err),
      });
      await logSync(filmTitle || imdbId || "unknown", imdbId, rating, false, err.message, getRetryPayload(pending));
      // Keep the reason (it's what tells the user *why*) but always end with the
      // next step, and cap the reason so the hint can never be the part that
      // gets cut off by the toast's length limit.
      const hint = rating
        ? " Retry from the extension menu."
        : " Reload the page and rate again.";
      const reason = rating
        ? `${filmTitle || imdbId || "Rating"} — ${err.message}`
        : err.message;
      showSyncToast(details.tabId, {
        stage: "error",
        title: "IMDb sync failed",
        detail: `${shortToastText(reason, 78)}${hint}`,
      });
    }
  },
  { urls: ["https://letterboxd.com/s/*", "https://letterboxd.com/api/v0/*", "https://api.letterboxd.com/*"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  cleanupPending,
  { urls: ["https://letterboxd.com/s/*", "https://letterboxd.com/api/v0/*", "https://api.letterboxd.com/*"] }
);

// ── In-page sync toasts ───────────────────────────────────────────────────────
// A click on Letterboxd only proves the rating landed on Letterboxd — it says nothing
// about whether RateSync intercepted it. These toasts surface the two invisible stages:
// capture ("IMDb sync initiated") and the result ("IMDb rating synced" / "…failed").
// They are injected into the Letterboxd tab, so __ratesyncShowToast must be fully
// self-contained: chrome.scripting serialises the function source only, no closures.
function __ratesyncShowToast(payload) {
  const TOAST_ID = "ratesync-toast";
  const state = payload || {};
  const stage = state.stage === "done" || state.stage === "error" ? state.stage : "start";

  let root = document.getElementById(TOAST_ID);
  if (!root) {
    const style = document.createElement("style");
    style.id = "ratesync-toast-style";
    style.textContent = [
      "#ratesync-toast{",
      "position:fixed;top:10px;right:10px;z-index:2147483647;",
      "display:flex;align-items:flex-start;gap:10px;max-width:320px;box-sizing:border-box;",
      "padding:12px 15px;border-radius:16px;",
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;",
      "font-size:13px;line-height:1.45;color:#eef2f9;",
      "background:rgba(23,27,36,0.62);",
      "-webkit-backdrop-filter:blur(16px) saturate(180%);backdrop-filter:blur(16px) saturate(180%);",
      "border:1px solid rgba(255,255,255,0.16);box-shadow:0 14px 34px rgba(0,0,0,0.34);",
      "opacity:0;transform:translateY(-10px) scale(0.98);",
      "transition:opacity .22s ease,transform .22s ease;pointer-events:none;}",
      "#ratesync-toast.rs-visible{opacity:1;transform:translateY(0) scale(1);}",
      "#ratesync-toast.rs-start{border-color:rgba(245,166,35,0.45);}",
      "#ratesync-toast.rs-done{background:rgba(20,34,32,0.62);border-color:rgba(52,211,153,0.45);}",
      "#ratesync-toast.rs-error{background:rgba(38,22,25,0.66);border-color:rgba(248,113,113,0.5);}",
      "#ratesync-toast .rs-dot{width:8px;height:8px;border-radius:50%;flex:none;margin-top:5px;",
      "background:#f5a623;box-shadow:0 0 0 4px rgba(245,166,35,0.18);}",
      "#ratesync-toast.rs-done .rs-dot{background:#34d399;box-shadow:0 0 0 4px rgba(52,211,153,0.18);}",
      "#ratesync-toast.rs-error .rs-dot{background:#f87171;box-shadow:0 0 0 4px rgba(248,113,113,0.18);}",
      "#ratesync-toast .rs-body{min-width:0;flex:1;}",
      "#ratesync-toast .rs-title,#ratesync-toast .rs-detail{",
      "display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      "#ratesync-toast .rs-title{font-weight:600;letter-spacing:.01em;}",
      "#ratesync-toast .rs-detail{margin-top:2px;font-size:12px;color:rgba(234,239,247,0.72);}",
      "@media (prefers-reduced-motion:reduce){#ratesync-toast{transition:none;transform:none;}}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);

    root = document.createElement("div");
    root.id = TOAST_ID;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");

    const dot = document.createElement("span");
    dot.className = "rs-dot";

    const body = document.createElement("div");
    body.className = "rs-body";
    const title = document.createElement("span");
    title.className = "rs-title";
    const detail = document.createElement("span");
    detail.className = "rs-detail";
    body.appendChild(title);
    body.appendChild(detail);
    root.appendChild(dot);
    root.appendChild(body);
    root._rsTitle = title;
    root._rsDetail = detail;

    (document.body || document.documentElement).appendChild(root);
  }

  // Swap the state class only — never drop rs-visible, so an in-flight toast flips
  // to its new state in place instead of blinking out and back.
  root.classList.remove("rs-start", "rs-done", "rs-error");
  root.classList.add("rs-" + stage);
  root._rsTitle.textContent = state.title || "";
  root._rsDetail.textContent = state.detail || "";
  root._rsDetail.hidden = !state.detail;
  root.classList.add("rs-visible");

  clearTimeout(root._rsTimer);
  // The "initiated" card has to outlive the 5s auto-retry window, otherwise the
  // result arrives after it already vanished and the flow looks disconnected.
  root._rsTimer = setTimeout(
    () => root.classList.remove("rs-visible"),
    stage === "done" ? 4000 : stage === "start" ? 12000 : 8000
  );
}

async function showSyncToast(tabId, payload) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  try {
    const { showToasts = true } = await chrome.storage.local.get("showToasts");
    if (!showToasts) return;
    await chrome.scripting.executeScript({
      target: { tabId },
      func: __ratesyncShowToast,
      args: [payload],
    });
  } catch (err) {
    debug("sync toast not shown", { tabId, stage: payload?.stage, error: errorInfo(err) });
  }
}

async function findLetterboxdTabId() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://letterboxd.com/*" });
    return tabs.length > 0 ? tabs[0].id : null;
  } catch (err) {
    debug("no letterboxd tab available for toast", { error: errorInfo(err) });
    return null;
  }
}

function shortToastText(text, limit = 110) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// syncLog stores "Title (YYYY)" (see logSync()); the toast is tight on space, so the
// year is dropped there — it adds nothing the user needs to recognize the film.
function stripYearSuffix(title) {
  return String(title || "").replace(/\s*\(\d{4}\)\s*$/, "").trim();
}

// Named entities Letterboxd actually uses in film titles (Latin-1 accents plus a few
// symbols); numeric entities are handled separately below.
const TITLE_ENTITY_MAP = {
  nbsp: " ", apos: "'", quot: '"', amp: "&", lt: "<", gt: ">",
  laquo: "«", raquo: "»", deg: "°", middot: "·", bull: "•", hellip: "…",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  trade: "™", reg: "®", copy: "©", times: "×", euro: "€", pound: "£",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", aring: "å", aelig: "æ",
  ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ",
  ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", oslash: "ø", oelig: "œ",
  ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü",
  yacute: "ý", yuml: "ÿ", szlig: "ß", thorn: "þ", eth: "ð",
};

Object.assign(TITLE_ENTITY_MAP, {
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å", AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï",
  Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü",
  Yacute: "Ý", THORN: "Þ", ETH: "Ð",
});

// String.fromCodePoint (not fromCharCode) is required for anything past U+FFFF — most
// emoji included — or the numeric entity decodes to the wrong character. A code point
// outside the valid range throws; that entity is dropped rather than breaking the title.
function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeTitleEntities(text) {
  return String(text)
    .replace(/&lrm;/gi, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => safeCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (whole, name) => {
      const mapped = TITLE_ENTITY_MAP[name] ?? TITLE_ENTITY_MAP[name[0].toUpperCase() + name.slice(1)];
      return mapped ?? "";
    })
    .trim();
}

function getMetaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = html.match(
    new RegExp(`<meta\\s[^>]*?(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, "i")
  );
  if (!tag) return null;
  const content = tag[0].match(/\scontent\s*=\s*["']([^"']*)["']/i);
  return content ? content[1] : null;
}

// Letterboxd's <title> is prefixed with &lrm; and suffixed with "directed by … • Letterboxd",
// and a title that itself starts with "(" (e.g. "(500) Days of Summer) breaks naive parsing.
// Prefer the clean meta tags Letterboxd publishes on every film page.
function extractFilmTitle(html) {
  const candidates = [
    getMetaContent(html, "og:title"),
    getMetaContent(html, "production:name-and-year"),
    getMetaContent(html, "twitter:title"),
  ];
  for (const candidate of candidates) {
    const title = candidate ? decodeTitleEntities(candidate) : "";
    if (title) return title;
  }

  const titleTag = html.match(/<title>([^<]+)<\/title>/i);
  if (!titleTag) return null;
  const raw = decodeTitleEntities(titleTag[1]);
  const title = raw
    .split(/\s+directed by\s+/i)[0]
    .split(/\s+[•·]\s+/)[0]
    .trim();
  return title || null;
}

async function resolveImdbId(url, label) {
  debug("fetching letterboxd details page", { label, url });
  const resp = await fetch(url, { credentials: "include" });
  debug("letterboxd details response", {
    label,
    url,
    status: resp.status,
    ok: resp.ok,
  });
  if (!resp.ok) throw new Error(`Could not find IMDb ID for ${label} (HTTP ${resp.status}).`);
  const html = await resp.text();
  const filmTitle = extractFilmTitle(html);
  const imdbMatch = html.match(/href=["']https?:\/\/(?:www\.)?imdb\.com\/title\/(tt\d+)/i);
  if (imdbMatch) {
    debug("found imdb link on letterboxd details page", {
      label,
      filmTitle,
      imdbId: imdbMatch[1],
    });
    return { imdbId: imdbMatch[1], filmTitle };
  }
  const tmdbMatch = html.match(/href=["']https?:\/\/(?:www\.)?themoviedb\.org\/(movie|tv)\/(\d+)/i);
  if (tmdbMatch) {
    const mediaType = tmdbMatch[1].toLowerCase();
    debug("found tmdb fallback link on letterboxd details page", {
      label,
      filmTitle,
      mediaType,
      tmdbId: tmdbMatch[2],
    });
    return { imdbId: await getImdbIdFromTmdb(tmdbMatch[2], mediaType), filmTitle };
  }
  warn("letterboxd details page had no imdb or tmdb link", {
    label,
    filmTitle,
    url,
    htmlLength: html.length,
    htmlSnippet: html.slice(0, 500),
  });
  throw new Error(`Could not find IMDb ID for ${label}.`);
}

function getImdbIdFromLetterboxdFilmId(letterboxdFilmId) {
  return resolveImdbId(`https://letterboxd.com/film/film:${letterboxdFilmId}/details/`, `film ${letterboxdFilmId}`);
}

function getImdbIdFromProductionSlug(productionId) {
  if (!/^[\w-]+$/.test(productionId)) throw new Error(`Invalid productionId: ${productionId}`);
  return resolveImdbId(`https://letterboxd.com/film/${productionId}/details/`, `production ${productionId}`);
}

async function getImdbIdFromProductionId(productionId) {
  if (!/^[\w-]+$/.test(productionId)) throw new Error(`Invalid productionId: ${productionId}`);

  // Try the film slug page first. Short slugs (dune, jaws, up, heat…) also match the
  // LID pattern, and resolving those through boxd.it costs three doomed requests and
  // can redirect to a *different* film if the slug collides with a real short code.
  const mayBeLid = looksLikeLetterboxdLid(productionId);
  let slugError = null;
  try {
    return await getImdbIdFromProductionSlug(productionId);
  } catch (err) {
    slugError = err;
    if (mayBeLid) {
      debug("slug details lookup failed; retrying as a possible Letterboxd LID", {
        productionId,
        error: errorInfo(err),
      });
    } else {
      warn("slug details lookup failed", { productionId, error: errorInfo(err) });
    }
  }

  if (!mayBeLid) throw slugError;

  try {
    return await getImdbIdFromBoxdItLid(productionId);
  } catch (err) {
    warn("boxd.it lid lookup failed; trying letterboxd film api", {
      productionId,
      error: errorInfo(err),
    });
  }

  try {
    return await getImdbIdFromLetterboxdFilmLid(productionId);
  } catch (err) {
    warn("letterboxd film api lookup failed; no further fallback", {
      productionId,
      error: errorInfo(err),
    });
  }

  throw slugError;
}

async function getImdbIdFromBoxdItLid(filmLid) {
  debug("resolving boxd.it film lid", { filmLid });
  const resp = await fetch(`https://boxd.it/${filmLid}`, {
    credentials: "omit",
    redirect: "follow",
  });
  debug("boxd.it response", {
    filmLid,
    status: resp.status,
    ok: resp.ok,
    url: resp.url,
  });
  if (!resp.ok) throw new Error(`Could not resolve boxd.it/${filmLid} (HTTP ${resp.status}).`);

  const match = getUrlPath(resp.url).match(/^\/film\/([^/]+)/);
  if (!match) throw new Error(`boxd.it/${filmLid} did not resolve to a Letterboxd film URL: ${resp.url}`);

  const slug = decodeURIComponent(match[1]);
  debug("boxd.it resolved to letterboxd slug", {
    filmLid,
    slug,
    url: resp.url,
  });
  return getImdbIdFromProductionSlug(slug);
}

async function getImdbIdFromLetterboxdFilmLid(filmLid) {
  debug("fetching letterboxd film api", { filmLid });
  let resp = await fetch(`https://letterboxd.com/api/v0/film/${filmLid}`, {
    credentials: "include",
  });
  if (resp.status === 404) {
    debug("letterboxd same-origin film api returned 404; trying public api host", { filmLid });
    resp = await fetch(`https://api.letterboxd.com/api/v0/film/${filmLid}`, {
      credentials: "include",
    });
  }

  debug("letterboxd film api response", {
    filmLid,
    status: resp.status,
    ok: resp.ok,
    url: resp.url,
  });
  if (!resp.ok) throw new Error(`Could not load Letterboxd film ${filmLid} (HTTP ${resp.status}).`);

  const data = await resp.json();
  const filmTitle = getFilmTitleFromApiFilm(data);
  const imdbId = findFirstUrlMatching(data, /(?:^|[/:])(?:imdb:)?(tt\d{5,})\b|imdb\.com\/title\/(tt\d+)/i);
  if (imdbId) {
    debug("found imdb id in letterboxd film api response", {
      filmLid,
      filmTitle,
      imdbId,
      topLevelKeys: Object.keys(data || {}),
    });
    return { imdbId, filmTitle };
  }

  const tmdbRef = findFirstTmdbRef(data);
  if (tmdbRef) {
    debug("found tmdb id in letterboxd film api response", {
      filmLid,
      filmTitle,
      mediaType: tmdbRef.mediaType,
      tmdbId: tmdbRef.tmdbId,
      topLevelKeys: Object.keys(data || {}),
    });
    return { imdbId: await getImdbIdFromTmdb(tmdbRef.tmdbId, tmdbRef.mediaType), filmTitle };
  }

  warn("letterboxd film api response had no imdb or tmdb id", {
    filmLid,
    filmTitle,
    topLevelKeys: Object.keys(data || {}),
    links: data?.links,
  });
  throw new Error(`Could not find IMDb ID for Letterboxd film ${filmLid}.`);
}

async function getFilmFromLogEntry(logEntryId) {
  if (!/^[\w-]+$/.test(logEntryId)) throw new Error(`Invalid logEntryId: ${logEntryId}`);

  debug("fetching letterboxd production log entry", { logEntryId });
  let resp = await fetch(`https://letterboxd.com/api/v0/production-log-entries/${logEntryId}`, {
    credentials: "include",
  });
  if (resp.status === 404) {
    debug("production log entry endpoint returned 404; trying log-entry endpoint", { logEntryId });
    resp = await fetch(`https://letterboxd.com/api/v0/log-entry/${logEntryId}`, {
      credentials: "include",
    });
  }
  debug("letterboxd log entry response", {
    logEntryId,
    status: resp.status,
    ok: resp.ok,
    url: resp.url,
  });
  if (!resp.ok) throw new Error(`Could not load Letterboxd log entry ${logEntryId} (HTTP ${resp.status}).`);

  const data = await resp.json();
  const candidate = firstValue(
    data.productionId,
    data.filmId,
    data.viewingableUID,
    data.production?.id,
    data.production?.slug,
    data.film?.id,
    data.film?.slug
  );

  const letterboxdFilmId = normalizeLetterboxdFilmId(candidate);
  const productionId = normalizeSlug(candidate);
  debug("parsed identifiers from letterboxd log entry", {
    logEntryId,
    candidate,
    letterboxdFilmId,
    productionId,
    topLevelKeys: Object.keys(data || {}),
    productionKeys: data?.production ? Object.keys(data.production) : [],
    filmKeys: data?.film ? Object.keys(data.film) : [],
  });
  if (!letterboxdFilmId && !productionId) {
    throw new Error(`Could not identify film from Letterboxd log entry ${logEntryId}.`);
  }

  return { letterboxdFilmId, productionId };
}

async function getImdbIdFromTmdb(tmdbId, mediaType = "movie") {
  const type = mediaType === "tv" ? "tv" : "movie";
  const apiKey = await getTmdbApiKey();
  const { url, init } = buildTmdbRequest(
    `https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids`,
    apiKey
  );
  debug("fetching tmdb external ids", { tmdbId, mediaType: type });
  const resp = await fetch(url, init);
  debug("tmdb external ids response", {
    tmdbId,
    mediaType: type,
    status: resp.status,
    ok: resp.ok,
  });
  if (!resp.ok) throw new Error(`TMDb API error: ${resp.status}`);
  const data = await resp.json();
  debug("tmdb external ids parsed", {
    tmdbId,
    mediaType: type,
    imdbId: data.imdb_id || null,
  });
  if (!data.imdb_id) throw new Error(`No IMDb ID on TMDb for ${type} ${tmdbId}`);
  return data.imdb_id;
}

async function getImdbLoginCookies() {
  const [c1, c2] = await Promise.all([
    chrome.cookies.getAll({ domain: ".imdb.com" }),
    chrome.cookies.getAll({ domain: "www.imdb.com" }),
  ]);
  const all = [...c1, ...c2];
  // Only the login cookie's presence matters; its value is never kept.
  if (!all.some((c) => c.name === "at-main")) throw permanentError("Not logged in to IMDb.");
  const sessionId = all.find((c) => c.name === "session-id")?.value || null;
  return { sessionId };
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete") return resolve();
        if (Date.now() - start > timeoutMs) {
          return reject(new Error("Timed out waiting for IMDb page to load."));
        }
        setTimeout(check, 300);
      }).catch(reject);
    })();
  });
}

// Runs inside https://www.imdb.com page context so Origin/Referer/cookies
// match a real IMDb web session. Must stay self-contained (serialized).
// Submissions are queued one at a time, so a request that never answers would block
// every later sync — hence the time limit.
async function __ratesyncRateInPage(imdbId, rating, sessionId, timeoutMs = 20000) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/graphql+json, application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Imdb-Client-Name": "imdb-web-next-localized",
    "X-Imdb-User-Country": "US",
    "X-Imdb-User-Language": "en-US",
  };
  if (sessionId) headers["X-Amzn-Sessionid"] = sessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  let raw;
  try {
    resp = await fetch("https://api.graphql.imdb.com/", {
      method: "POST",
      headers,
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({
        operationName: "UpdateTitleRating",
        query: `mutation UpdateTitleRating($rating: Int!, $titleId: ID!) {
        rateTitle(input: {rating: $rating, titleId: $titleId}) {
          rating { value }
        }
      }`,
        variables: { rating, titleId: imdbId },
      }),
    });
    raw = await resp.text();
  } catch (err) {
    if (err && err.name === "AbortError") return { timedOut: true };
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // keep raw for diagnostics
  }
  return { status: resp.status, ok: resp.ok, data, raw: (raw || "").slice(0, 2000) };
}

// ── IMDb submission queue & shared background tab ─────────────────────────────
// Submissions run one at a time and share a single IMDb tab, so a burst of ratings
// loads one IMDb page instead of opening several heavy tabs at once. The tab is parked
// after the last submission and closed by an alarm (alarms survive service-worker
// restarts, so a terminated worker can never leak an open tab).
let imdbSubmitChain = Promise.resolve();
let imdbSubmissionsInFlight = 0;
let sharedImdbTabId = null;

function submitImdbRating(imdbId, rating) {
  imdbSubmissionsInFlight += 1;
  const run = imdbSubmitChain.then(() => submitImdbRatingNow(imdbId, rating));
  imdbSubmitChain = run.catch(() => {});
  return run.finally(async () => {
    imdbSubmissionsInFlight -= 1;
    if (imdbSubmissionsInFlight > 0) return;
    // The rating is in. With auto-open off nobody is ever going to look at this tab, so
    // it is closed immediately rather than left sitting in the tab strip for a minute.
    // A tab the user has already been shown (auto-open + success) is left alone by
    // releaseSharedImdbTab(), which decides on ownership, not on this preference.
    try {
      await releaseSharedImdbTab();
    } catch (err) {
      warn("could not release shared imdb tab after submission", { error: errorInfo(err) });
    }
    // Backstop only: if this worker dies before the close lands, the alarm still cleans up.
    await scheduleSharedImdbTabRelease();
  });
}

async function scheduleSharedImdbTabRelease() {
  if (sharedImdbTabId == null) return;
  try {
    await chrome.alarms.create(IMDB_TAB_RELEASE_ALARM, { delayInMinutes: 1 });
  } catch (err) {
    warn("could not schedule shared imdb tab release", { error: errorInfo(err) });
  }
}

async function releaseSharedImdbTab() {
  if (imdbSubmissionsInFlight > 0) return;

  // A tab is only ever closed while it is still *ours*. The moment it has been shown to
  // the user it is theirs, whatever the setting says — so this is decided by ownership,
  // not by the auto-open preference (which a user may have toggled since).
  const { [IMDB_TAB_OWNED_KEY]: userOwned } = await chrome.storage.session.get(IMDB_TAB_OWNED_KEY);
  if (userOwned) return;
  if (imdbSubmissionsInFlight > 0) return;

  const { [IMDB_TAB_STORAGE_KEY]: parkedTabId } = await chrome.storage.session.get(IMDB_TAB_STORAGE_KEY);
  if (parkedTabId == null || imdbSubmissionsInFlight > 0) return;

  await chrome.storage.session.remove(IMDB_TAB_STORAGE_KEY);
  // Last check: from here to tabs.remove() there is no await, so a submission that starts
  // now either finds the tab (and we close it before it is used) or opens a fresh one.
  if (imdbSubmissionsInFlight > 0) return;
  if (sharedImdbTabId === parkedTabId) sharedImdbTabId = null;
  try {
    await chrome.tabs.remove(parkedTabId);
    debug("closed parked imdb tab", { tabId: parkedTabId });
  } catch {
    // already closed
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== IMDB_TAB_RELEASE_ALARM) return;
  releaseSharedImdbTab().catch((err) => warn("failed to release shared imdb tab", { error: errorInfo(err) }));
});

async function acquireImdbTab(imdbId, navigate) {
  const target = `https://www.imdb.com/title/${imdbId}/`;

  if (sharedImdbTabId == null) {
    // A previous service worker instance may have parked a tab before it was terminated.
    const { [IMDB_TAB_STORAGE_KEY]: parkedTabId } = await chrome.storage.session.get(IMDB_TAB_STORAGE_KEY);
    if (parkedTabId != null) {
      try {
        await chrome.tabs.get(parkedTabId);
        sharedImdbTabId = parkedTabId;
      } catch {
        await chrome.storage.session.remove(IMDB_TAB_STORAGE_KEY);
      }
    }
  }

  if (sharedImdbTabId != null) {
    try {
      const existing = await chrome.tabs.get(sharedImdbTabId);
      // The in-page script posts the title id itself, so any IMDb page gives us the
      // origin, cookies and session id we need — no reload required between ratings.
      const reusable = /^https:\/\/(?:www\.)?imdb\.com\//.test(existing.url || "")
        && (!navigate || existing.url === target);
      if (reusable) {
        if (existing.status !== "complete") await waitForTabComplete(existing.id);
        await chrome.storage.session.set({ [IMDB_TAB_STORAGE_KEY]: sharedImdbTabId });
        debug("reusing background imdb tab", { tabId: existing.id });
        return existing;
      }
      const updated = await chrome.tabs.update(sharedImdbTabId, { url: target });
      await waitForTabComplete(sharedImdbTabId);
      await chrome.storage.session.set({ [IMDB_TAB_STORAGE_KEY]: sharedImdbTabId });
      debug("reusing background imdb tab after navigation", {
        tabId: sharedImdbTabId,
        url: target,
      });
      return updated;
    } catch (err) {
      debug("shared imdb tab is unavailable; opening a new one", {
        tabId: sharedImdbTabId,
        error: errorInfo(err),
      });
      sharedImdbTabId = null;
      await chrome.storage.session.remove(IMDB_TAB_STORAGE_KEY);
    }
  }

  const created = await chrome.tabs.create({ url: target, active: false });
  sharedImdbTabId = created.id;
  await chrome.storage.session.set({ [IMDB_TAB_STORAGE_KEY]: created.id });
  // A brand-new background tab has not been shown to anyone yet.
  await chrome.storage.session.remove(IMDB_TAB_OWNED_KEY);
  await waitForTabComplete(created.id);
  return created;
}

// Verified live against api.graphql.imdb.com (2026-09-27): its CDN/WAF only checks for
// the presence of X-Imdb-Client-Name — it does not require a real page context — and
// credentials:"include" attaches the user's real IMDb session cookies here exactly as
// it would from any other context, since host_permissions' "https://*.imdb.com/*" already
// covers this subdomain. So this is tried first: no tab, no injection, just a plain fetch.
//
// Mirrors __ratesyncRateInPage's mutation/operation name/headers exactly. The two cannot
// share code — __ratesyncRateInPage must stay fully self-contained for chrome.scripting's
// serialization — so keep them in sync by hand; never change one without the other.
async function submitImdbRatingDirect(imdbId, rating, sessionId, timeoutMs = 20000) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/graphql+json, application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Imdb-Client-Name": "imdb-web-next-localized",
    "X-Imdb-User-Country": "US",
    "X-Imdb-User-Language": "en-US",
  };
  if (sessionId) headers["X-Amzn-Sessionid"] = sessionId;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp;
  let raw;
  try {
    resp = await fetch("https://api.graphql.imdb.com/", {
      method: "POST",
      headers,
      credentials: "include",
      signal: controller.signal,
      body: JSON.stringify({
        operationName: "UpdateTitleRating",
        query: `mutation UpdateTitleRating($rating: Int!, $titleId: ID!) {
        rateTitle(input: {rating: $rating, titleId: $titleId}) {
          rating { value }
        }
      }`,
        variables: { rating, titleId: imdbId },
      }),
    });
    raw = await resp.text();
  } catch (err) {
    clearTimeout(timer);
    if (err?.name === "AbortError") throw new Error("IMDb did not respond in time.");
    throw err;
  }
  clearTimeout(timer);

  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    // keep raw for diagnostics
  }
  // Same validation either way — a rejection here (bad status, a GraphQL errors array) is
  // just as loud and just as caught by the caller as a failure from the tab-based path.
  return interpretRateResult(imdbId, rating, { status: resp.status, ok: resp.ok, data, raw: (raw || "").slice(0, 2000) });
}

// After a successful *direct* submission there is no tab to reload — this opens a fresh
// one already showing the new rating, and marks it owned immediately (never becomes the
// "shared" tab at all), so the release alarm never touches it.
async function openImdbTabForUser(imdbId) {
  try {
    const created = await chrome.tabs.create({ url: `https://www.imdb.com/title/${imdbId}/`, active: true });
    await chrome.storage.session.set({ [IMDB_TAB_OWNED_KEY]: true });
    debug("opened imdb tab to show the newly synced rating", { tabId: created.id });
  } catch (err) {
    debug("could not open imdb tab after direct sync", { error: errorInfo(err) });
  }
}

async function submitImdbRatingNow(imdbId, rating) {
  const { sessionId } = await getImdbLoginCookies();
  const { autoOpenImdb, imdbFallbackEnabled = true } = await chrome.storage.local.get([
    "autoOpenImdb",
    "imdbFallbackEnabled",
  ]);

  debug("posting imdb graphql rating (direct)", { imdbId, rating });
  try {
    const data = await submitImdbRatingDirect(imdbId, rating, sessionId);
    debug("imdb graphql rating accepted (direct, no tab opened for submission)", { imdbId, rating });
    if (autoOpenImdb) await openImdbTabForUser(imdbId);
    return data;
  } catch (err) {
    if (imdbFallbackEnabled === false) throw err;
    warn("direct imdb submission failed; falling back to the browser-tab method", {
      imdbId,
      rating,
      error: errorInfo(err),
    });
  }

  // ── Fallback: the browser-tab method (the only method before this direct path existed) ──
  debug("posting imdb graphql rating via imdb page context", {
    imdbId,
    rating,
    autoOpen: Boolean(autoOpenImdb),
  });
  let tab = await acquireImdbTab(imdbId, Boolean(autoOpenImdb));

  let result;
  try {
    result = await injectRateInPage(tab.id, imdbId, rating, sessionId);
  } catch (err) {
    // The tab we just acquired can still become unusable (closed, discarded by Chrome
    // to save memory, navigated away) in the brief window before injection actually
    // runs — chrome.scripting.executeScript then rejects with a generic "An unknown
    // error occurred when fetching the script." One fresh tab and one more try turns
    // that narrow, one-off race into a success instead of failing outright (or waiting
    // out the separate 5s auto-retry, which would otherwise be the only recovery).
    warn("imdb tab became unusable before the rating could be sent; opening a fresh one", {
      imdbId,
      tabId: tab.id,
      error: errorInfo(err),
    });
    if (sharedImdbTabId === tab.id) sharedImdbTabId = null;
    await chrome.storage.session.remove(IMDB_TAB_STORAGE_KEY).catch(() => {});
    tab = await acquireImdbTab(imdbId, Boolean(autoOpenImdb));
    result = await injectRateInPage(tab.id, imdbId, rating, sessionId);
  }
  // Throws on failure. On that path the tab is deliberately left parked and unfocused:
  // it still shows the previous rating (or none), and the release alarm will close it.
  const data = interpretRateResult(imdbId, rating, result);

  // Only now — with IMDb confirming the new value — does the tab become the user's.
  if (autoOpenImdb) await handImdbTabToUser(tab.id);
  return data;
}

// Only the injection itself — kept separate from interpretRateResult() so a failure
// here (the tab was gone before the script could even run) is distinguishable from
// IMDb having answered but rejected the rating.
async function injectRateInPage(tabId, imdbId, rating, sessionId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: __ratesyncRateInPage,
    args: [imdbId, rating, sessionId],
  });
  return result;
}

function interpretRateResult(imdbId, rating, result) {
  debug("imdb graphql response", {
    imdbId,
    rating,
    status: result?.status,
    ok: result?.ok,
    raw: result?.raw,
  });
  if (!result) throw new Error("IMDb rating did not return a response.");
  if (result.timedOut) throw new Error("IMDb did not respond in time.");
  if (!result.ok) {
    const detail = result.raw ? ` — ${result.raw.slice(0, 300)}` : "";
    if (result.status === 403) {
      const looksLikeHtml = /^\s*<(!doctype|html)/i.test(result.raw || "");
      // The raw response stays in the console for debugging; users get the next step.
      warn("imdb rejected the rating request (403)", { imdbId, looksLikeHtml, raw: result.raw });
      throw new Error("IMDb blocked the request. Make sure you're logged in to IMDb, then try again.");
    }
    throw new Error(`IMDb GraphQL failed: ${result.status}${detail}`);
  }
  if (result.data?.errors) {
    warn("imdb graphql returned errors", {
      imdbId,
      rating,
      errors: result.data.errors,
    });
    throw new Error(`IMDb GraphQL error: ${result.data.errors[0].message}`);
  }
  debug("imdb graphql rating accepted", {
    imdbId,
    rating,
    returnedRating: result.data?.data?.rateTitle?.rating?.value,
  });
  return result.data;
}

// Shows the tab to the user. The reload matters: the page was loaded *before* the
// mutation ran, so without it the tab would display the rating it had before, or none.
async function handImdbTabToUser(tabId) {
  // Forget the tab first: from here on the user may browse anywhere in it, and a later
  // rating must open a fresh background tab rather than navigate this one away.
  if (sharedImdbTabId === tabId) sharedImdbTabId = null;
  await chrome.storage.session.remove(IMDB_TAB_STORAGE_KEY).catch(() => {});
  try {
    await chrome.tabs.reload(tabId);
    await chrome.tabs.update(tabId, { active: true });
    // The tab now belongs to the user — the release alarm must never close it.
    await chrome.storage.session.set({ [IMDB_TAB_OWNED_KEY]: true });
    debug("handed imdb tab to the user", { tabId });
  } catch {
    // tab may already be gone; ignore
  }
}

function getRetryPayload(entry) {
  return {
    letterboxdFilmId: entry.letterboxdFilmId || null,
    productionId: entry.productionId || null,
    logEntryId: entry.logEntryId || null,
  };
}

function canRetryEntry(entry) {
  return Number.isInteger(entry.rating)
    && entry.rating >= 1
    && entry.rating <= 10
    && (
      /^tt\d+$/.test(entry.imdbId || "")
      || entry.letterboxdFilmId
      || entry.productionId
      || entry.logEntryId
    );
}

// Two log entries are "the same film" if they agree on any one identifier that's
// present on both sides — a resolved IMDb id first, then the Letterboxd ids a retry
// would resolve from.
function sameFilm(a, b) {
  if (a.imdbId && b.imdbId && /^tt\d+$/.test(a.imdbId) && a.imdbId === b.imdbId) return true;
  if (a.letterboxdFilmId && b.letterboxdFilmId && a.letterboxdFilmId === b.letterboxdFilmId) return true;
  if (a.productionId && b.productionId && a.productionId === b.productionId) return true;
  return false;
}

// A retry replays a rating value captured at some point in the past. If the user has
// rated the film again since — through the normal flow, which always carries the
// current value — replaying the old one would silently overwrite the newer rating.
async function hasNewerSuccessfulSync(entry) {
  const { syncLog = [] } = await chrome.storage.local.get("syncLog");
  return syncLog.some(
    (other) => other.success && other.timestamp > entry.timestamp && sameFilm(other, entry)
  );
}

async function resolveRetryImdbId(entry) {
  if (/^tt\d+$/.test(entry.imdbId || "")) {
    return { imdbId: entry.imdbId, filmTitle: entry.filmTitle || entry.imdbId };
  }

  const retryEntry = { ...entry };
  if (!retryEntry.letterboxdFilmId && !retryEntry.productionId && retryEntry.logEntryId) {
    Object.assign(retryEntry, await getFilmFromLogEntry(retryEntry.logEntryId));
  }

  if (retryEntry.letterboxdFilmId) {
    return getImdbIdFromLetterboxdFilmId(retryEntry.letterboxdFilmId);
  }
  if (retryEntry.productionId) {
    return getImdbIdFromProductionId(retryEntry.productionId);
  }
  throw new Error("Could not identify Letterboxd film from failed sync.");
}

// All syncLog mutations are funnelled through one queue: chrome.storage has no
// transactions, so a get() followed by set() from two concurrent ratings would let the
// second read overwrite whatever the first had just written.
let syncLogWriteChain = Promise.resolve();

const SYNC_LOG_LIMIT = 100;

function queueSyncLogWrite(mutate) {
  syncLogWriteChain = syncLogWriteChain
    .then(async () => {
      const { syncLog = [] } = await chrome.storage.local.get("syncLog");
      mutate(syncLog);
      await chrome.storage.local.set({ syncLog: syncLog.slice(0, SYNC_LOG_LIMIT) });
    })
    .catch((err) => warn("sync log write failed", { error: errorInfo(err) }));
  return syncLogWriteChain;
}

async function updateRetriedLogEntry(originalTimestamp, patch) {
  return queueSyncLogWrite((syncLog) => {
    const index = syncLog.findIndex((entry) => entry.timestamp === originalTimestamp);
    if (index < 0) return;

    const [entry] = syncLog.splice(index, 1);
    syncLog.unshift({ ...entry, ...patch, timestamp: Date.now() });
  });
}

async function retrySync(entry) {
  debug("retry requested", {
    filmTitle: entry?.filmTitle,
    imdbId: entry?.imdbId,
    rating: entry?.rating,
    letterboxdFilmId: entry?.letterboxdFilmId,
    productionId: entry?.productionId,
    logEntryId: entry?.logEntryId,
    timestamp: entry?.timestamp,
  });
  if (!entry || !canRetryEntry(entry)) {
    throw new Error("This failed sync does not have enough data to retry.");
  }

  if (await hasNewerSuccessfulSync(entry)) {
    debug("retry skipped; a newer successful sync already exists for this film", {
      filmTitle: entry.filmTitle,
      imdbId: entry.imdbId,
      timestamp: entry.timestamp,
    });
    throw new Error("This film has a newer successful sync already — retry skipped.");
  }

  const toastTabId = await findLetterboxdTabId();
  showSyncToast(toastTabId, {
    stage: "start",
    title: entry.filmTitle
      ? shortToastText(`IMDb sync initiated: ${stripYearSuffix(entry.filmTitle)}`, 60)
      : "IMDb sync initiated",
    detail: `IMDb rating (converted): ${entry.rating}/10`,
  });

  let resolved = null;
  try {
    resolved = await resolveRetryImdbId(entry);
    if (!/^tt\d+$/.test(resolved.imdbId)) throw new Error(`Unexpected IMDb ID format: ${resolved.imdbId}`);
    debug("retry resolved imdb id", {
      originalFilmTitle: entry.filmTitle,
      resolvedFilmTitle: resolved.filmTitle,
      imdbId: resolved.imdbId,
      rating: entry.rating,
    });
    await submitImdbRating(resolved.imdbId, entry.rating);
    await updateRetriedLogEntry(entry.timestamp, {
      filmTitle: resolved.filmTitle || entry.filmTitle || resolved.imdbId,
      imdbId: resolved.imdbId,
      success: true,
      error: null,
    });
    showSyncToast(toastTabId, {
      stage: "done",
      title: shortToastText(
        `IMDb rating synced: ${stripYearSuffix(resolved.filmTitle || entry.filmTitle) || resolved.imdbId}`,
        60
      ),
      detail: `IMDb rating (converted): ${entry.rating}/10`,
    });
    debug("retry completed", {
      imdbId: resolved.imdbId,
      rating: entry.rating,
      timestamp: entry.timestamp,
    });
    return { ok: true };
  } catch (err) {
    warn("retry failed", {
      filmTitle: entry.filmTitle,
      imdbId: entry.imdbId,
      rating: entry.rating,
      letterboxdFilmId: entry.letterboxdFilmId,
      productionId: entry.productionId,
      logEntryId: entry.logEntryId,
      resolved,
      error: errorInfo(err),
    });
    await updateRetriedLogEntry(entry.timestamp, {
      filmTitle: resolved?.filmTitle || entry.filmTitle || entry.imdbId || "unknown",
      imdbId: resolved?.imdbId || entry.imdbId || null,
      success: false,
      error: err.message,
    });
    showSyncToast(toastTabId, {
      stage: "error",
      title: "IMDb sync failed",
      detail: shortToastText(
        `${resolved?.filmTitle || entry.filmTitle || entry.imdbId || "Rating"} — ${err.message}`
      ),
    });
    throw err;
  }
}

async function logSync(filmTitle, imdbId, rating, success, error = null, retryPayload = {}) {
  return queueSyncLogWrite((syncLog) => {
    syncLog.unshift({
      filmTitle,
      imdbId,
      rating,
      success,
      error,
      timestamp: Date.now(),
      ...retryPayload,
    });
  });
}

async function updateBadge() {
  const cookies = await chrome.cookies.getAll({ domain: ".imdb.com" });
  const loggedIn = cookies.some((c) => c.name === "at-main");
  chrome.action.setBadgeText({ text: loggedIn ? "" : "•" });
  chrome.action.setBadgeBackgroundColor({ color: "#FFC107" });
}

chrome.runtime.onInstalled.addListener(() => updateBadge().catch(() => {}));
chrome.runtime.onStartup.addListener(() => updateBadge().catch(() => {}));
updateBadge().catch(() => {});

chrome.cookies.onChanged.addListener((changeInfo) => {
  if (changeInfo.cookie.domain.includes("imdb.com") && changeInfo.cookie.name === "at-main") {
    updateBadge().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "page-rating") {
    // The film-page rating read by page-hook.js. Remember it for the completion of the
    // PATCH we cannot read, and fill in any capture still waiting for it.
    const tabId = sender.tab?.id;
    debug("page reported rating", {
      tabId,
      url: message.url,
      rating: message.rating,
    });
    rememberPageRating(tabId, message.rating, message.url);
    fillAwaitingRating(tabId, message.rating, message.url)
      .catch((err) => warn("failed to apply page rating", { error: errorInfo(err) }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type !== "retry-sync") return false;

  debug("received runtime message", {
    type: message.type,
    entry: {
      filmTitle: message.entry?.filmTitle,
      imdbId: message.entry?.imdbId,
      rating: message.entry?.rating,
      letterboxdFilmId: message.entry?.letterboxdFilmId,
      productionId: message.entry?.productionId,
      logEntryId: message.entry?.logEntryId,
      timestamp: message.entry?.timestamp,
    },
  });
  retrySync(message.entry)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
