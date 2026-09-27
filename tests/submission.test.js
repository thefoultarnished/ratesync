// Submitting to IMDb: auto-retry, error messages, the shared background tab, the sync
// log, and retries from the popup.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, letterboxdRoute, imdbGraphqlRoute, htmlResponse, letterboxdDetailsHtml, jsonResponse } = require("./harness");

const FILMS = {
  "2aWW": { title: "Heat (1995)", imdbId: "tt0113277" },
  "3bXX": { title: "Jaws (1975)", imdbId: "tt0073195" },
};
const meRate = (lid) => `https://letterboxd.com/api/v0/me/rate/${lid}`;
const GRAPHQL_ERROR = { status: 200, ok: true, data: { errors: [{ message: "Rating rejected" }] }, raw: "{}" };
const FORBIDDEN = { status: 403, ok: false, data: null, raw: "<html>403 Forbidden</html>" };

function setup(options) {
  return loadBackground({ routes: [letterboxdRoute(FILMS)], ...options });
}

async function rateOnFilmPage(bg, lid, stars, tabId = 1) {
  await bg.pageRating(tabId, lid, stars);
  const req = await bg.beforeRequest({ tabId, method: "PATCH", url: meRate(lid) });
  await bg.completed(req);
}

// ── Automatic second attempt ────────────────────────────────────────────────

test("a failed first attempt is retried silently and only the success is shown", async () => {
  const bg = setup();
  let calls = 0;
  bg.addRoute(/letterboxd\.com\/film\/2aWW\/details\//, () =>
    ++calls === 1 ? htmlResponse("busy", 503) : htmlResponse(letterboxdDetailsHtml(FILMS["2aWW"]))
  );
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(calls, 2);
  assert.equal(bg.syncLog().length, 1, "no log row for the failed first attempt");
  assert.equal(bg.syncLog()[0].success, true);
  assert.deepEqual(bg.calls.toasts.map((t) => t.stage), ["start", "done"]);
});

test("toasts: 'start' and 'done' both show the converted rating, and 'done' drops the year", async () => {
  const bg = setup();
  await rateOnFilmPage(bg, "2aWW", 4);

  const [start, done] = bg.calls.toasts;
  assert.equal(start.title, "IMDb sync initiated");
  assert.equal(start.detail, "IMDb rating (converted): 8/10");
  // FILMS["2aWW"].title is "Heat (1995)" — the year must not appear in the toast.
  assert.equal(done.title, "IMDb rating synced: Heat");
  assert.equal(done.detail, "IMDb rating (converted): 8/10");
});

test("toasts: a long film title is truncated so the toast stays one line", async () => {
  const bg = setup({
    routes: [
      letterboxdRoute({
        "2aWW": {
          title: "An Extremely Long Made-Up Film Title That Goes On And On Forever (1995)",
          imdbId: "tt0113277",
        },
      }),
    ],
  });
  await rateOnFilmPage(bg, "2aWW", 4);

  const done = bg.calls.toasts.at(-1);
  assert.ok(done.title.length <= 60, `expected <=60 chars, got ${done.title.length}: "${done.title}"`);
  assert.ok(done.title.endsWith("…"), "must be truncated with an ellipsis, not cut off silently");
});

test("two failed attempts log one failure with a retry hint", async () => {
  const bg = setup();
  bg.queueImdbResult(GRAPHQL_ERROR);
  bg.queueImdbResult(GRAPHQL_ERROR);
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.imdbSubmissions.length, 2);
  assert.equal(bg.syncLog().length, 1);
  assert.match(bg.syncLog()[0].error, /Rating rejected/);
  assert.match(bg.calls.toasts.at(-1).detail, /Retry from the extension menu/);
});

test("logged out of IMDb: the sync fails with a clear message", async () => {
  const bg = setup({ cookies: [] });
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.syncLog()[0].error, "Not logged in to IMDb.");
});

test("an IMDb 403 shows a plain message, not developer instructions", async () => {
  const bg = setup();
  bg.queueImdbResult(FORBIDDEN);
  bg.queueImdbResult(FORBIDDEN);
  await rateOnFilmPage(bg, "2aWW", 4);

  const { error } = bg.syncLog()[0];
  assert.match(error, /IMDb blocked the request/);
  assert.doesNotMatch(error, /chrome:\/\/extensions|1\.5\.0|\.zip/);
});

test("with in-page notifications off, no toast is shown but the sync still runs", async () => {
  const bg = setup({ local: { showToasts: false } });
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.toasts.length, 0);
  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => s.rating), [8]);
  assert.equal(bg.syncLog()[0].success, true);
});

test("with in-page notifications off, failures are still logged for the popup", async () => {
  const bg = setup({ local: { showToasts: false } });
  bg.queueImdbResult(GRAPHQL_ERROR);
  bg.queueImdbResult(GRAPHQL_ERROR);
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.toasts.length, 0);
  assert.equal(bg.syncLog()[0].success, false);
});

// ── IMDb request time limit ─────────────────────────────────────────────────

test("an IMDb request that never answers is abandoned, not left hanging", async () => {
  const bg = setup();
  bg.context.fetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
      });
    });
  const result = await bg.context.__ratesyncRateInPage("tt0113277", 8, "123-4567890", 20000);
  assert.equal(result.timedOut, true);
});

test("the in-page IMDb request keeps its operation, headers and variables", async () => {
  const bg = setup();
  let sent = null;
  bg.context.fetch = async (url, init) => {
    sent = { url, init };
    return { status: 200, ok: true, text: async () => '{"data":{}}' };
  };
  const result = await bg.context.__ratesyncRateInPage("tt0113277", 8, "123-4567890");
  const body = JSON.parse(sent.init.body);

  assert.equal(result.ok, true);
  assert.equal(sent.url, "https://api.graphql.imdb.com/");
  assert.equal(body.operationName, "UpdateTitleRating");
  assert.match(body.query, /rateTitle\(input: \{rating: \$rating, titleId: \$titleId\}\)/);
  assert.deepEqual({ ...body.variables }, { rating: 8, titleId: "tt0113277" });
  assert.equal(sent.init.headers["X-Imdb-Client-Name"], "imdb-web-next-localized");
  assert.equal(sent.init.headers["X-Amzn-Sessionid"], "123-4567890");
  assert.equal(sent.init.credentials, "include");
});

test("a timed-out submission fails clearly and does not block the next rating", async () => {
  const bg = setup();
  bg.queueImdbResult({ timedOut: true });
  bg.queueImdbResult({ timedOut: true });
  await rateOnFilmPage(bg, "2aWW", 4);
  assert.equal(bg.syncLog()[0].error, "IMDb did not respond in time.");

  await rateOnFilmPage(bg, "3bXX", 2);
  assert.equal(bg.syncLog()[0].success, true);
  assert.equal(bg.openTabs().length, 0);
});

// ── Permanent errors skip the wasted auto-retry ─────────────────────────────

test("logged out of IMDb: fails once, no wasted 5s retry", async () => {
  const bg = setup({ cookies: [] });
  await rateOnFilmPage(bg, "2aWW", 4);

  const detailsFetches = bg.calls.fetches.filter((u) => u.includes("/film/2aWW/details/"));
  assert.equal(detailsFetches.length, 1, "a permanent error must not trigger the auto-retry");
  assert.equal(bg.syncLog()[0].error, "Not logged in to IMDb.");
});

test("missing TMDb key: fails once, no wasted 5s retry", async () => {
  const bg = setup();
  bg.addRoute(/letterboxd\.com\/film\/obscure-film\/details\//, () =>
    htmlResponse(letterboxdDetailsHtml({ imdbId: null, tmdb: { type: "movie", id: 5 } }))
  );
  const req = await bg.beforeRequest({
    method: "POST",
    url: "https://letterboxd.com/api/v0/production-log-entries",
    requestBody: { raw: [{ bytes: new TextEncoder().encode(JSON.stringify({ productionId: "obscure-film", rating: 4 })).buffer }] },
  });
  await bg.completed(req);

  const detailsFetches = bg.calls.fetches.filter((u) => u.includes("/film/obscure-film/details/"));
  assert.equal(detailsFetches.length, 1, "a permanent error must not trigger the auto-retry");
  assert.match(bg.syncLog()[0].error, /TMDb API key not set/);
});

test("a transient error (not a permanent one) still gets the normal 5s retry", async () => {
  // Already covered by "two failed attempts log one failure with a retry hint" above,
  // which asserts exactly 2 imdbSubmissions for a plain (non-permanent) GraphQL error —
  // included here as a named cross-check that permanent-error handling didn't also
  // swallow the retry for ordinary failures.
  const bg = setup();
  bg.queueImdbResult(GRAPHQL_ERROR);
  bg.queueImdbResult(GRAPHQL_ERROR);
  await rateOnFilmPage(bg, "2aWW", 4);
  assert.equal(bg.calls.imdbSubmissions.length, 2);
});

// ── Direct background submission (tried first), and the fallback toggle ────

const DIRECT_OK = () => jsonResponse({ data: { rateTitle: { rating: { value: 8 } } } });
const DIRECT_AUTH_ERROR = () =>
  jsonResponse({ errors: [{ message: "Authentication required for mutation." }], data: null });

test("direct submission succeeds: no IMDb tab is ever opened", async () => {
  const bg = setup();
  bg.addRoute(...imdbGraphqlRoute(DIRECT_OK));
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.tabsCreated.length, 0);
  assert.equal(bg.calls.imdbSubmissions.length, 0, "chrome.scripting.executeScript never used");
  assert.equal(bg.syncLog()[0].success, true);
});

test("direct submission succeeds with auto-open on: a fresh tab opens to show it", async () => {
  const bg = setup({ local: { autoOpenImdb: true } });
  bg.addRoute(...imdbGraphqlRoute(DIRECT_OK));
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.tabsCreated.length, 1);
  assert.equal(bg.calls.tabsCreated[0].active, true);
  assert.equal(bg.session.data.imdbTabUserOwned, true);
  assert.equal(bg.syncLog()[0].success, true);
});

test("toggle ON (default): a failed direct attempt falls back to the browser-tab method", async () => {
  const bg = setup();
  bg.addRoute(...imdbGraphqlRoute(DIRECT_AUTH_ERROR));
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.imdbSubmissions.length, 1, "fell back to the tab method");
  assert.equal(bg.syncLog()[0].success, true);
});

test("toggle OFF: a failed direct attempt fails immediately, no tab fallback", async () => {
  const bg = setup({ local: { imdbFallbackEnabled: false } });
  bg.addRoute(...imdbGraphqlRoute(DIRECT_AUTH_ERROR));
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.tabsCreated.length, 0);
  assert.equal(bg.calls.imdbSubmissions.length, 0, "the tab method was never tried");
  assert.equal(bg.syncLog()[0].success, false);
  assert.match(bg.syncLog()[0].error, /Authentication required/);
});

test("toggle OFF: a working direct attempt is unaffected by the toggle", async () => {
  const bg = setup({ local: { imdbFallbackEnabled: false } });
  bg.addRoute(...imdbGraphqlRoute(DIRECT_OK));
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.syncLog()[0].success, true);
  assert.equal(bg.calls.tabsCreated.length, 0);
});

// ── A tab that becomes unusable right before injection ──────────────────────

test("a tab closed/discarded right before injection gets one fresh-tab retry", async () => {
  const bg = setup();
  bg.queueInjectionFailure("An unknown error occurred when fetching the script.");
  await rateOnFilmPage(bg, "2aWW", 4);

  // Two injection attempts (one on the tab that vanished, one on a fresh tab), but
  // exactly one rating logged — the retry is invisible to the end result.
  assert.equal(bg.calls.imdbSubmissions.length, 2);
  assert.equal(bg.calls.tabsCreated.length, 2, "a fresh tab is opened after the first one failed");
  assert.equal(bg.syncLog().length, 1);
  assert.equal(bg.syncLog()[0].success, true);
  // The distinguishing signal: recovery happens *inside* submitImdbRatingNow, without
  // falling all the way back to the separate 5s auto-retry — which would re-resolve the
  // film from scratch and fetch the Letterboxd details page a second time. One fetch
  // means the fresh-tab retry did the work, not the unrelated outer retry.
  const detailsFetches = bg.calls.fetches.filter((u) => u.includes("/film/2aWW/details/"));
  assert.equal(detailsFetches.length, 1, "resolved once — recovered without the outer auto-retry");
});

test("if the fresh tab also fails to inject, the sync still fails clearly", async () => {
  const bg = setup();
  // Exhaust both the inner fresh-tab retry and the outer 5s auto-retry (2 tries each).
  for (let i = 0; i < 4; i++) bg.queueInjectionFailure(`tab gone (${i})`);
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.syncLog().length, 1);
  assert.equal(bg.syncLog()[0].success, false);
  assert.match(bg.syncLog()[0].error, /tab gone/);
});

// ── Shared background IMDb tab ──────────────────────────────────────────────

test("auto-open off: a background tab is used, never focused, and closed afterwards", async () => {
  const bg = setup();
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.tabsCreated.length, 1);
  assert.equal(bg.calls.tabsCreated[0].active, false);
  assert.deepEqual(bg.calls.tabsActivated, []);
  assert.deepEqual(bg.calls.tabsRemoved, [bg.calls.tabsCreated[0].id]);
  assert.equal(bg.session.data.imdbOpenTabId, undefined);
});

test("two ratings at once share one IMDb tab and both are logged", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", 4);
  const a = await bg.beforeRequest({ tabId: 1, method: "PATCH", url: meRate("2aWW") });
  await bg.pageRating(2, "3bXX", 2);
  const b = await bg.beforeRequest({ tabId: 2, method: "PATCH", url: meRate("3bXX") });
  await Promise.all([bg.completed(a), bg.completed(b)]);

  assert.equal(bg.calls.tabsCreated.length, 1);
  assert.deepEqual(
    bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]).sort(),
    [["tt0073195", 4], ["tt0113277", 8]]
  );
  assert.equal(bg.syncLog().length, 2, "concurrent log writes must not overwrite each other");
  assert.equal(bg.openTabs().length, 0);
});

test("auto-open on: the tab is reloaded and focused only after IMDb accepts", async () => {
  const bg = setup({ local: { autoOpenImdb: true } });
  await rateOnFilmPage(bg, "2aWW", 4);

  const tabId = bg.calls.tabsCreated[0].id;
  assert.deepEqual(bg.calls.tabsReloaded, [tabId]);
  assert.deepEqual(bg.calls.tabsActivated, [tabId]);
  assert.equal(bg.session.data.imdbTabUserOwned, true);
  assert.deepEqual(bg.calls.tabsRemoved, []);
});

test("auto-open on: the cleanup alarm never closes a tab the user was shown", async () => {
  const bg = setup({ local: { autoOpenImdb: true } });
  await rateOnFilmPage(bg, "2aWW", 4);
  await bg.fireAlarm("ratesync-release-imdb-tab");

  assert.deepEqual(bg.calls.tabsRemoved, []);
});

test("a tab handed to the user is never reused or navigated by a later rating", async () => {
  const bg = setup({ local: { autoOpenImdb: true } });
  await rateOnFilmPage(bg, "2aWW", 4);
  const shown = bg.calls.tabsCreated[0].id;
  await bg.chrome.tabs.update(shown, { url: "https://mail.google.com/inbox" }); // user browses on

  for (const autoOpenImdb of [true, false]) {
    await bg.local.set({ autoOpenImdb });
    await rateOnFilmPage(bg, "3bXX", 2);
    const tab = bg.openTabs().find((t) => t.id === shown);
    assert.equal(tab?.url, "https://mail.google.com/inbox", `autoOpen=${autoOpenImdb}: user's tab untouched`);
    assert.ok(bg.calls.imdbSubmissions.at(-1).tabId !== shown, "submitted in a fresh tab");
  }
});

test("auto-open on but IMDb rejects: the tab is never focused and gets closed", async () => {
  const bg = setup({ local: { autoOpenImdb: true } });
  bg.queueImdbResult(GRAPHQL_ERROR);
  bg.queueImdbResult(GRAPHQL_ERROR);
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.deepEqual(bg.calls.tabsActivated, []);
  assert.deepEqual(bg.calls.tabsReloaded, []);
  assert.equal(bg.openTabs().length, 0, "no stray IMDb tab left behind");
});

test("a tab parked by a previous (terminated) worker is adopted, not duplicated", async () => {
  const bg = setup();
  const parked = bg.openTab("https://www.imdb.com/title/tt0000001/");
  await bg.session.set({ imdbOpenTabId: parked });
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.calls.tabsCreated.length, 0);
  assert.equal(bg.calls.imdbSubmissions[0].tabId, parked);
});

// ── Retry must not overwrite a newer rating ─────────────────────────────────

test("retry is skipped when a newer successful sync exists for the same film (by imdbId)", async () => {
  const failed = { filmTitle: "Heat", imdbId: "tt0113277", rating: 8, success: false, error: "x", timestamp: 1 };
  const newer = { filmTitle: "Heat", imdbId: "tt0113277", rating: 4, success: true, error: null, timestamp: 2 };
  const bg = setup({ local: { syncLog: [newer, failed] } });

  const response = await bg.sendMessage({ type: "retry-sync", entry: failed });

  assert.equal(response.ok, false);
  assert.match(response.error, /newer successful sync/);
  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.calls.toasts.length, 0, "no toast at all, not even 'initiated'");
  assert.deepEqual(bg.syncLog(), [newer, failed], "the failed entry is left exactly as it was");
});

test("retry is skipped when a newer successful sync exists for the same film (by letterboxdFilmId, no imdbId yet)", async () => {
  const failed = { filmTitle: "?", letterboxdFilmId: "51875", rating: 8, success: false, error: "x", timestamp: 1 };
  const newer = { filmTitle: "Heat", imdbId: "tt0113277", letterboxdFilmId: "51875", rating: 4, success: true, timestamp: 2 };
  const bg = setup({ local: { syncLog: [newer, failed] } });

  const response = await bg.sendMessage({ type: "retry-sync", entry: failed });

  assert.equal(response.ok, false);
  assert.equal(bg.calls.imdbSubmissions.length, 0);
});

test("retry proceeds normally when no newer successful sync exists", async () => {
  const older = { filmTitle: "Heat", imdbId: "tt0113277", rating: 8, success: true, timestamp: 1 };
  const failed = { filmTitle: "Heat", imdbId: "tt0113277", rating: 8, success: false, error: "x", timestamp: 2 };
  const bg = setup({ local: { syncLog: [failed, older] } });

  const response = await bg.sendMessage({ type: "retry-sync", entry: failed });

  assert.equal(response.ok, true);
  assert.equal(bg.calls.imdbSubmissions.length, 1);
});

test("retry proceeds when the only later syncs for the same film also failed", async () => {
  const failed1 = { filmTitle: "Heat", imdbId: "tt0113277", rating: 8, success: false, error: "x", timestamp: 1 };
  const failed2 = { filmTitle: "Heat", imdbId: "tt0113277", rating: 8, success: false, error: "y", timestamp: 2 };
  const bg = setup({ local: { syncLog: [failed2, failed1] } });

  const response = await bg.sendMessage({ type: "retry-sync", entry: failed1 });

  assert.equal(response.ok, true);
  assert.equal(bg.calls.imdbSubmissions.length, 1);
});

test("retry proceeds when a newer success exists but is for a different film", async () => {
  const failed = { filmTitle: "Heat", imdbId: "tt0113277", rating: 8, success: false, error: "x", timestamp: 1 };
  const otherFilm = { filmTitle: "Jaws", imdbId: "tt0073195", rating: 4, success: true, timestamp: 2 };
  const bg = setup({ local: { syncLog: [otherFilm, failed] } });

  const response = await bg.sendMessage({ type: "retry-sync", entry: failed });

  assert.equal(response.ok, true);
  assert.equal(bg.calls.imdbSubmissions.length, 1);
});

// ── Sync log & popup retry ──────────────────────────────────────────────────

test("the sync log is capped at 100 entries, newest first", async () => {
  const old = Array.from({ length: 100 }, (_, i) => ({ filmTitle: `old ${i}`, success: true, timestamp: i }));
  const bg = setup({ local: { syncLog: old } });
  await rateOnFilmPage(bg, "2aWW", 4);

  assert.equal(bg.syncLog().length, 100);
  assert.equal(bg.syncLog()[0].filmTitle, "Heat (1995)");
});

test("retry from the popup replaces the failed row instead of adding one", async () => {
  const failed = { filmTitle: "Heat (1995)", imdbId: "tt0113277", rating: 8, success: false, error: "x", timestamp: 1 };
  const bg = setup({ local: { syncLog: [failed] } });
  const response = await bg.sendMessage({ type: "retry-sync", entry: failed });

  assert.equal(response.ok, true);
  assert.equal(bg.syncLog().length, 1);
  assert.equal(bg.syncLog()[0].success, true);
  assert.equal(bg.syncLog()[0].error, null);
});

test("retry refuses an entry without a usable rating", async () => {
  const bg = setup();
  const response = await bg.sendMessage({
    type: "retry-sync",
    entry: { filmTitle: "?", imdbId: "tt0113277", rating: null, success: false, timestamp: 1 },
  });

  assert.equal(response.ok, false);
  assert.equal(bg.calls.imdbSubmissions.length, 0);
});
