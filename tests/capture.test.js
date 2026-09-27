// Capturing ratings from Letterboxd: the three endpoints, the page-hook race, and the
// "never reuse a stale rating / film" rules.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, rawBody, letterboxdRoute } = require("./harness");

const FILMS = {
  "2aWW": { title: "Heat (1995)", imdbId: "tt0113277" },
  "3bXX": { title: "Jaws (1975)", imdbId: "tt0073195" },
  "heat-1995": { title: "Heat (1995)", imdbId: "tt0113277" },
  "film:51875": { title: "Heat (1995)", imdbId: "tt0113277" },
  "film:222": { title: "Alien (1979)", imdbId: "tt0078748" },
};

const meRate = (lid) => `https://letterboxd.com/api/v0/me/rate/${lid}`;
const LOG_ENTRIES = "https://letterboxd.com/api/v0/production-log-entries";
const SELECT_FILM = (id) =>
  `https://letterboxd.com/s/check-viewingable-relation?viewingableUID=film:${id}`;

function setup(options) {
  return loadBackground({ routes: [letterboxdRoute(FILMS)], ...options });
}

// ── Rating scale ────────────────────────────────────────────────────────────

test("letterboxd stars convert to the IMDb 1-10 scale", () => {
  const { context } = setup();
  assert.equal(context.parseRating("0.5", "letterboxd"), 1);
  assert.equal(context.parseRating(4.5, "letterboxd"), 9);
  assert.equal(context.parseRating(5, "letterboxd"), 10);
  assert.equal(context.parseRating(["8"], "imdb"), 8);
  assert.equal(context.parseRating(11, "imdb"), 10);
});

test("empty, zero, and junk ratings are ignored", () => {
  const { context } = setup();
  for (const value of [null, undefined, "", 0, "0", -1, "abc", NaN]) {
    assert.equal(context.parseRating(value, "letterboxd"), null, `value ${String(value)}`);
  }
});

// ── Classic film page form: POST /s/film:ID/rate/ ────────────────────────────

test("classic film-page rating form syncs on the 0-10 scale", async () => {
  const bg = setup();
  const req = await bg.beforeRequest({
    method: "POST",
    url: "https://letterboxd.com/s/film:51875/rate/",
    requestBody: { formData: { rating: ["9"] } },
  });
  await bg.completed(req);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]), [["tt0113277", 9]]);
  assert.equal(bg.syncLog()[0].success, true);
});

// ── Star widget: PATCH /api/v0/me/rate/{lid} with the body only visible to the hook ──

test("star widget: page report arrives before the request", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", 4);
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  await bg.completed(req);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]), [["tt0113277", 8]]);
  assert.deepEqual(bg.calls.toasts.map((t) => t.stage), ["start", "done"]);
});

test("star widget: request arrives before the page report", async () => {
  const bg = setup();
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  assert.equal(bg.calls.toasts.length, 0, "no toast until the rating is known");
  await bg.pageRating(1, "2aWW", 3.5);
  await bg.completed(req);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => s.rating), [7]);
  assert.deepEqual(bg.calls.toasts.map((t) => t.stage), ["start", "done"]);
});

test("star widget: a report that never arrives fails with a reload hint, not a retry", async () => {
  const bg = setup();
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  await bg.completed(req);

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  const [entry] = bg.syncLog();
  assert.equal(entry.success, false);
  assert.match(entry.error, /Could not read the rating/);
  const errorToast = bg.calls.toasts.at(-1);
  assert.equal(errorToast.stage, "error");
  assert.match(errorToast.detail, /Reload the page/);
});

test("star widget: clearing a rating (report first) does nothing", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", null);
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  await bg.completed(req);

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.calls.toasts.length, 0);
  assert.equal(bg.syncLog().length, 0);
});

test("star widget: clearing a rating (request first) does nothing", async () => {
  const bg = setup();
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  await bg.pageRating(1, "2aWW", null);
  await bg.completed(req);

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.syncLog().length, 0, "must not be logged as a failed read");
});

test("a consumed page report is never reused by the next rating of the same film", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", 4);
  await bg.completed(await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") }));
  assert.equal(bg.eval("pageRatings.size"), 0);

  // Second rating of the same film whose report is lost: must fail, not resend 8/10.
  await bg.completed(await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") }));
  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => s.rating), [8]);
  assert.equal(bg.syncLog()[0].success, false);
});

test("a page report for another film is not used for this film's request", async () => {
  const bg = setup();
  await bg.pageRating(1, "3bXX", 1.5);
  await bg.completed(await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") }));

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.syncLog()[0].success, false);
});

test("a late page report for another film does not complete a waiting request", async () => {
  const bg = setup();
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  await bg.pageRating(1, "3bXX", 1.5);
  await bg.completed(req);

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.syncLog()[0].success, false, "fails visibly instead of sending 3/10");
});

test("two films rated quickly in one tab both sync (reports kept per film)", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", 4);
  await bg.pageRating(1, "3bXX", 2); // arrives before either request is seen
  const a = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  const b = await bg.beforeRequest({ method: "PATCH", url: meRate("3bXX") });
  await bg.completed(a);
  await bg.completed(b);

  assert.deepEqual(
    bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]),
    [["tt0113277", 8], ["tt0073195", 4]]
  );
  assert.ok(bg.syncLog().every((e) => e.success));
  assert.equal(bg.eval("pageRatings.size"), 0);
});

test("a report is matched to its film exactly, not by prefix", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", 4);
  await bg.completed(await bg.beforeRequest({ method: "PATCH", url: meRate("2aW") }));

  assert.equal(bg.calls.imdbSubmissions.length, 0, "2aWW's rating must not be used for 2aW");
});

test("a report with an encoded film id still matches its request", async () => {
  const bg = setup();
  await bg.sendMessage(
    { type: "page-rating", url: "/api/v0/me/rate/film%3A51875", rating: 3 },
    { tab: { id: 1 } }
  );
  await bg.completed(await bg.beforeRequest({ method: "PATCH", url: meRate("film%3A51875") }));

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]), [["tt0113277", 6]]);
});

test("reports from different tabs do not mix", async () => {
  const bg = setup();
  await bg.pageRating(2, "2aWW", 5);
  await bg.completed(await bg.beforeRequest({ tabId: 1, method: "PATCH", url: meRate("2aWW") }));

  assert.equal(bg.calls.imdbSubmissions.length, 0);
});

// ── Log / diary dialog ──────────────────────────────────────────────────────

test("log entry with its own film slug syncs that film", async () => {
  const bg = setup();
  const req = await bg.beforeRequest({
    method: "POST",
    url: LOG_ENTRIES,
    requestBody: rawBody({ productionId: "heat-1995", rating: 4.5 }),
  });
  await bg.completed(req);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]), [["tt0113277", 9]]);
});

test("log entry: a Letterboxd reply that beats our storage writes is not lost", async () => {
  const bg = setup();
  await bg.beforeRequest({ method: "GET", url: SELECT_FILM(222) });
  const details = {
    tabId: 1,
    requestId: "fast-1",
    method: "POST",
    url: LOG_ENTRIES,
    requestBody: rawBody({ productionId: "heat-1995", rating: 4 }),
  };
  // Chrome's storage writes are real I/O, so Letterboxd can answer while one is still in
  // flight. Hold writes, let the capture run as far as it can, then deliver the reply.
  bg.holdSessionWrites();
  const capturing = bg.beforeRequest(details);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  const completing = bg.completed(details);
  for (let i = 0; i < 50; i++) await Promise.resolve();
  bg.releaseSessionWrites();
  await Promise.all([capturing, completing]);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]), [["tt0113277", 8]]);
  assert.deepEqual(bg.calls.toasts.map((t) => t.stage), ["start", "done"]);
});

test("selecting a film in the log dialog does not toast (nothing rated yet)", async () => {
  const bg = setup();
  await bg.beforeRequest({ method: "GET", url: SELECT_FILM(222) });
  assert.equal(bg.calls.toasts.length, 0);
});

test("a remembered dialog film never overrides the film the log entry names", async () => {
  const bg = setup();
  await bg.beforeRequest({ method: "GET", url: SELECT_FILM(222) }); // Alien, then abandoned
  const req = await bg.beforeRequest({
    method: "POST",
    url: LOG_ENTRIES,
    requestBody: rawBody({ productionId: "heat-1995", rating: 4 }),
  });
  await bg.completed(req);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => s.imdbId), ["tt0113277"]);
});

test("a remembered dialog film is used when the log entry names no film", async () => {
  const bg = setup();
  await bg.beforeRequest({ method: "GET", url: SELECT_FILM(222) });
  const req = await bg.beforeRequest({
    method: "POST",
    url: LOG_ENTRIES,
    requestBody: rawBody({ rating: 3 }),
  });
  await bg.completed(req);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]), [["tt0078748", 6]]);
});

test("a remembered dialog film expires after 10 minutes", async () => {
  const bg = setup({
    session: { pendingRatings: { "tab-1": { filmId: "222", ts: Date.now() - 11 * 60 * 1000 } } },
  });
  const req = await bg.beforeRequest({
    method: "POST",
    url: LOG_ENTRIES,
    requestBody: rawBody({ rating: 3 }),
  });

  assert.equal(bg.eval(`pendingRatings.get(${JSON.stringify(req.requestId)}).letterboxdFilmId`), null);
});

test("the remembered dialog film is consumed by the log entry that uses it", async () => {
  const bg = setup();
  await bg.beforeRequest({ method: "GET", url: SELECT_FILM(222) });
  await bg.beforeRequest({ method: "POST", url: LOG_ENTRIES, requestBody: rawBody({ rating: 3 }) });

  assert.equal(bg.eval(`pendingRatings.has("tab-1")`), false);
});

// ── Letterboxd's own request failing ────────────────────────────────────────

test("if Letterboxd's request errors, nothing is sent and the toast says cancelled", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", 4);
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  await bg.errorOccurred({ ...req, error: "net::ERR_FAILED" });

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.syncLog().length, 0);
  assert.equal(bg.calls.toasts.at(-1).title, "Sync cancelled");
});

test("if Letterboxd answers with a non-2xx status, nothing is sent to IMDb", async () => {
  const bg = setup();
  await bg.pageRating(1, "2aWW", 4);
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  await bg.completed({ ...req, statusCode: 500 });

  assert.equal(bg.calls.imdbSubmissions.length, 0);
  assert.equal(bg.syncLog().length, 0);
});

test("pending correlations are mirrored to session storage and cleared after use", async () => {
  const bg = setup();
  const req = await bg.beforeRequest({ method: "PATCH", url: meRate("2aWW") });
  assert.ok(bg.session.data.pendingRatings[req.requestId], "persisted while in flight");

  await bg.pageRating(1, "2aWW", 4);
  await bg.completed(req);
  assert.equal(bg.session.data.pendingRatings[req.requestId], undefined);
  assert.equal(bg.local.data.pendingRatings, undefined, "never written to local storage");
});

// ── Safety net for endpoints Letterboxd moves ───────────────────────────────

test("a request body split across more than one raw chunk is not truncated", async () => {
  const bg = setup();
  const fullBody = JSON.stringify({ productionId: "heat-1995", rating: 4 });
  const mid = Math.floor(fullBody.length / 2);
  const enc = new TextEncoder();
  const req = await bg.beforeRequest({
    method: "POST",
    url: LOG_ENTRIES,
    requestBody: {
      raw: [
        { bytes: enc.encode(fullBody.slice(0, mid)).buffer },
        { bytes: enc.encode(fullBody.slice(mid)).buffer },
      ],
    },
  });
  await bg.completed(req);

  assert.deepEqual(bg.calls.imdbSubmissions.map((s) => [s.imdbId, s.rating]), [["tt0113277", 8]]);
});

test("an expired dialog film selection is dropped from session storage, not just skipped in memory", async () => {
  const past = Date.now() - 11 * 60 * 1000;
  const bg = setup({ session: { pendingRatings: { "tab-1": { filmId: "222", ts: past } } } });

  // A cleanup for a request that was never pending only *reads* (getPendingRating, then
  // a delete() that finds nothing and persists nothing of its own) — so if storage
  // changes at all here, it can only be hydration itself dropping the expired entry,
  // not some unrelated write to a different key incidentally overwriting the snapshot.
  await bg.errorOccurred({ requestId: "never-existed", url: "https://letterboxd.com/s/film:999999/rate/", error: "x" });

  assert.equal(bg.session.data.pendingRatings["tab-1"], undefined);
});

test("a rating sent to an unknown Letterboxd path is flagged", async () => {
  const bg = setup();
  await bg.beforeRequest({
    method: "POST",
    url: "https://letterboxd.com/api/v0/brand-new/rating-endpoint",
    requestBody: rawBody({ rating: 4 }),
  });

  assert.ok(bg.calls.warnings.some((w) => w.step === "unhandled rating-bearing request"));
});

test("sign-in and password submissions are never inspected by the safety net", async () => {
  const bg = setup();
  // A rating field is included on purpose: were these bodies read, it would be flagged.
  await bg.beforeRequest({
    method: "POST",
    url: "https://letterboxd.com/user/login.do",
    requestBody: { formData: { username: ["me"], password: ["hunter2"], rating: ["4"] } },
  });
  await bg.beforeRequest({
    method: "POST",
    url: "https://letterboxd.com/api/v0/some/new-endpoint",
    requestBody: rawBody({ currentPassword: "hunter2", rating: 4 }),
  });
  await bg.beforeRequest({
    method: "POST",
    url: "https://letterboxd.com/api/v0/some/other-endpoint",
    requestBody: rawBody("token=abc123&rating=4"),
  });

  assert.ok(!bg.calls.warnings.some((w) => w.step === "unhandled rating-bearing request"));
  assert.doesNotMatch(JSON.stringify(bg.calls.warnings), /hunter2|abc123/);
});

test("known rating paths are not flagged by the safety net", async () => {
  const bg = setup();
  await bg.beforeRequest({
    method: "POST",
    url: LOG_ENTRIES,
    requestBody: rawBody({ productionId: "heat-1995", rating: 4 }),
  });

  assert.ok(!bg.calls.warnings.some((w) => w.step === "unhandled rating-bearing request"));
});
