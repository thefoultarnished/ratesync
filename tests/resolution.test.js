// Turning a Letterboxd film into an IMDb id: title parsing, the slug → LID fallback,
// and the TMDb lookup with both key formats.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, htmlResponse, jsonResponse, letterboxdDetailsHtml } = require("./harness");

// ── Film titles ─────────────────────────────────────────────────────────────

test("a title starting with a parenthesis is kept whole", () => {
  const { context } = loadBackground();
  const html = `<meta property="og:title" content="(500) Days of Summer (2009)" />`;
  assert.equal(context.extractFilmTitle(html), "(500) Days of Summer (2009)");
});

test("HTML entities in titles are decoded", () => {
  const { context } = loadBackground();
  const html = `<meta property="og:title" content="Am&eacute;lie (2001)" />`;
  assert.equal(context.extractFilmTitle(html), "Amélie (2001)");
});

test("without meta tags, the <title> is stripped of its Letterboxd suffix", () => {
  const { context } = loadBackground();
  const html = "<title>&lrm;Heat (1995) directed by Michael Mann • Letterboxd</title>";
  assert.equal(context.extractFilmTitle(html), "Heat (1995)");
});

test("a numeric entity above the Basic Multilingual Plane decodes to the real emoji", () => {
  const { context } = loadBackground();
  const html = `<meta property="og:title" content="Movie &#128512;" />`; // U+1F600, grinning face
  assert.equal(context.extractFilmTitle(html), "Movie 😀");
});

test("a hex entity above the Basic Multilingual Plane decodes correctly too", () => {
  const { context } = loadBackground();
  const html = `<meta property="og:title" content="Movie &#x1F600;" />`;
  assert.equal(context.extractFilmTitle(html), "Movie 😀");
});

test("an out-of-range numeric entity is dropped instead of throwing", () => {
  const { context } = loadBackground();
  const html = `<meta property="og:title" content="Movie &#99999999;" />`;
  assert.equal(context.extractFilmTitle(html), "Movie");
});

// ── Slug first, LID fallback ────────────────────────────────────────────────

test("a short slug that also looks like a LID resolves via the details page first", async () => {
  const bg = loadBackground({
    routes: [[/letterboxd\.com\/film\/jaws\/details\//, () => htmlResponse(letterboxdDetailsHtml({ imdbId: "tt0073195" }))]],
  });
  const { imdbId } = await bg.context.getImdbIdFromProductionId("jaws");

  assert.equal(imdbId, "tt0073195");
  assert.ok(!bg.calls.fetches.some((u) => u.includes("boxd.it")), "no boxd.it request");
});

test("a LID with no details page falls back to the boxd.it redirect", async () => {
  const bg = loadBackground({
    routes: [
      [/letterboxd\.com\/film\/2aWW\/details\//, () => htmlResponse("not found", 404)],
      [/^https:\/\/boxd\.it\/2aWW$/, () => ({ ...htmlResponse(""), url: "https://letterboxd.com/film/heat-1995/" })],
      [/letterboxd\.com\/film\/heat-1995\/details\//, () => htmlResponse(letterboxdDetailsHtml({ imdbId: "tt0113277" }))],
    ],
  });
  const { imdbId } = await bg.context.getImdbIdFromProductionId("2aWW");
  assert.equal(imdbId, "tt0113277");
});

test("a long slug that is not a LID fails without trying boxd.it", async () => {
  const bg = loadBackground({
    routes: [[/letterboxd\.com\/film\/.*\/details\//, () => htmlResponse("not found", 404)]],
  });
  await assert.rejects(bg.context.getImdbIdFromProductionId("the-long-goodbye"), /HTTP 404/);
  assert.ok(!bg.calls.fetches.some((u) => u.includes("boxd.it")));
});

test("slugs with unsafe characters are rejected before any request", async () => {
  const bg = loadBackground();
  await assert.rejects(bg.context.getImdbIdFromProductionId("../../evil"), /Invalid productionId/);
  assert.equal(bg.calls.fetches.length, 0);
});

// ── TMDb fallback ───────────────────────────────────────────────────────────

test("a 32-char v3 key goes in the query string, not a Bearer header", () => {
  const { context } = loadBackground();
  const key = "0123456789abcdef0123456789abcdef";
  const { url, init } = context.buildTmdbRequest("https://api.themoviedb.org/3/movie/1/external_ids", key);
  assert.equal(url, `https://api.themoviedb.org/3/movie/1/external_ids?api_key=${key}`);
  assert.equal(init.headers, undefined);
});

test("a v4 token goes in a Bearer header", () => {
  const { context } = loadBackground();
  const { url, init } = context.buildTmdbRequest("https://api.themoviedb.org/3/movie/1/external_ids", " eyJv4.token ");
  assert.equal(url, "https://api.themoviedb.org/3/movie/1/external_ids");
  assert.equal(init.headers.Authorization, "Bearer eyJv4.token");
});

test("a TV series without an IMDb link resolves through TMDb's /tv/ endpoint", async () => {
  let tmdbInit = null;
  const bg = loadBackground({
    local: { tmdbApiKey: "eyJv4.token" },
    routes: [
      [/letterboxd\.com\/film\/chernobyl\/details\//, () =>
        htmlResponse(letterboxdDetailsHtml({ imdbId: null, tmdb: { type: "tv", id: 87108 } }))],
      [/api\.themoviedb\.org\/3\/tv\/87108\/external_ids/, (url, init) => {
        tmdbInit = init;
        return jsonResponse({ imdb_id: "tt7366338" });
      }],
    ],
  });
  const { imdbId } = await bg.context.getImdbIdFromProductionId("chernobyl");

  assert.equal(imdbId, "tt7366338");
  assert.equal(tmdbInit.headers.Authorization, "Bearer eyJv4.token");
});

test("a film needing TMDb without a key fails with a pointer to Settings", async () => {
  const bg = loadBackground({
    routes: [[/letterboxd\.com\/film\/obscure-film\/details\//, () =>
      htmlResponse(letterboxdDetailsHtml({ imdbId: null, tmdb: { type: "movie", id: 5 } }))]],
  });
  await assert.rejects(bg.context.getImdbIdFromProductionId("obscure-film"), /TMDb API key not set/);
});

test("TMDb lookup turned off: a saved key is not used", async () => {
  let tmdbCalled = false;
  const bg = loadBackground({
    local: { tmdbApiKey: "eyJv4.token", tmdbEnabled: false },
    routes: [
      [/letterboxd\.com\/film\/obscure-film\/details\//, () =>
        htmlResponse(letterboxdDetailsHtml({ imdbId: null, tmdb: { type: "movie", id: 5 } }))],
      [/api\.themoviedb\.org/, () => { tmdbCalled = true; return jsonResponse({ imdb_id: "tt0000005" }); }],
    ],
  });
  await assert.rejects(bg.context.getImdbIdFromProductionId("obscure-film"), /TMDb lookup is off/);
  assert.equal(tmdbCalled, false);
});

test("TMDb lookup never toggled: a saved key is used (existing setups keep working)", async () => {
  const bg = loadBackground({
    local: { tmdbApiKey: "eyJv4.token" }, // no tmdbEnabled at all
    routes: [
      [/letterboxd\.com\/film\/obscure-film\/details\//, () =>
        htmlResponse(letterboxdDetailsHtml({ imdbId: null, tmdb: { type: "movie", id: 5 } }))],
      [/api\.themoviedb\.org\/3\/movie\/5\/external_ids/, () => jsonResponse({ imdb_id: "tt0000005" })],
    ],
  });
  const { imdbId } = await bg.context.getImdbIdFromProductionId("obscure-film");
  assert.equal(imdbId, "tt0000005");
});

test("a film with neither an IMDb nor a TMDb link fails clearly", async () => {
  const bg = loadBackground({
    routes: [[/letterboxd\.com\/film\/nothing-linked\/details\//, () =>
      htmlResponse(letterboxdDetailsHtml({ imdbId: null }))]],
  });
  await assert.rejects(bg.context.getImdbIdFromProductionId("nothing-linked"), /Could not find IMDb ID/);
});
