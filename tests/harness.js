// Loads background.js into a fresh vm context against a stubbed `chrome`, so the
// service worker's real listeners can be driven the way Chrome would drive them.
// Every test gets its own instance; nothing leaks between tests.
"use strict";

const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const BACKGROUND_SRC = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");

// chrome.webRequest URL filters are simple globs ("https://letterboxd.com/s/*").
function matchesFilter(url, patterns) {
  return patterns.some((p) => {
    const re = new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(url);
  });
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn, filter) {
      listeners.push({ fn, filter });
    },
  };
}

function createStorageArea(gate = () => undefined) {
  const data = {};
  const keysOf = (keys) => (keys == null ? Object.keys(data) : [].concat(keys));
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of keysOf(keys)) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(items) {
      await gate();
      for (const [k, v] of Object.entries(items)) data[k] = clone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

const DEFAULT_COOKIES = [
  { name: "at-main", value: "auth-token", domain: ".imdb.com" },
  { name: "session-id", value: "123-4567890", domain: ".imdb.com" },
];

const IMDB_OK = { status: 200, ok: true, data: { data: { rateTitle: { rating: { value: 0 } } } }, raw: "{}" };

function letterboxdDetailsHtml({ title = "Heat (1995)", imdbId = "tt0113277", tmdb = null } = {}) {
  const links = [
    imdbId ? `<a href="http://www.imdb.com/title/${imdbId}/maindetails">IMDb</a>` : "",
    tmdb ? `<a href="https://www.themoviedb.org/${tmdb.type}/${tmdb.id}/">TMDB</a>` : "",
  ].join("");
  return `<html><head><meta property="og:title" content="${title}" /></head><body>${links}</body></html>`;
}

function htmlResponse(html, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: "",
    text: async () => html,
    json: async () => JSON.parse(html),
  };
}

function jsonResponse(obj, status = 200) {
  return htmlResponse(JSON.stringify(obj), status);
}

function loadBackground(options = {}) {
  // Session writes can be held open to model Chrome's storage being slower than a
  // network reply; everything else resolves immediately.
  let sessionWriteGate = null;
  const local = createStorageArea();
  const session = createStorageArea(() => sessionWriteGate?.promise);
  Object.assign(local.data, options.local || {});
  Object.assign(session.data, options.session || {});

  const calls = {
    tabsCreated: [],
    tabsRemoved: [],
    tabsReloaded: [],
    tabsActivated: [],
    alarms: [],
    toasts: [],
    imdbSubmissions: [],
    fetches: [],
    warnings: [],
  };

  const tabs = new Map();
  let nextTabId = 100;
  let cookies = options.cookies || DEFAULT_COOKIES;

  // Returns the next IMDb GraphQL result; tests can queue failures.
  const imdbResults = [...(options.imdbResults || [])];
  // Errors chrome.scripting.executeScript() itself rejects with — a failed injection,
  // as opposed to imdbResults above (a successful injection whose *response* was bad).
  const injectionFailures = [];

  // fetch routes: an array of [RegExp, handler(url, init)] checked in order.
  const routes = [...(options.routes || [])];

  const events = {
    onBeforeRequest: createEvent(),
    onCompleted: createEvent(),
    onErrorOccurred: createEvent(),
    onMessage: createEvent(),
    onAlarm: createEvent(),
  };

  const chrome = {
    webRequest: {
      onBeforeRequest: events.onBeforeRequest,
      onCompleted: events.onCompleted,
      onErrorOccurred: events.onErrorOccurred,
    },
    storage: { local, session },
    alarms: {
      onAlarm: events.onAlarm,
      async create(name, info) {
        calls.alarms.push({ name, info });
      },
    },
    runtime: {
      onInstalled: createEvent(),
      onStartup: createEvent(),
      onMessage: events.onMessage,
    },
    cookies: {
      onChanged: createEvent(),
      async getAll({ domain }) {
        return domain === ".imdb.com" ? cookies : [];
      },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: {
      async create({ url, active }) {
        const tab = { id: nextTabId++, url, active: Boolean(active), status: "complete" };
        tabs.set(tab.id, tab);
        calls.tabsCreated.push({ ...tab });
        return { ...tab };
      },
      async get(id) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return { ...tab };
      },
      async update(id, props) {
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        Object.assign(tab, props, { status: "complete" });
        if (props.active) calls.tabsActivated.push(id);
        return { ...tab };
      },
      async reload(id) {
        calls.tabsReloaded.push(id);
      },
      async remove(id) {
        tabs.delete(id);
        calls.tabsRemoved.push(id);
      },
      async query({ url }) {
        return [...tabs.values()].filter((t) => matchesFilter(t.url, [].concat(url)));
      },
    },
    scripting: {
      async executeScript({ target, world, func, args }) {
        if (world === "MAIN") {
          const [imdbId, rating] = args;
          calls.imdbSubmissions.push({ tabId: target.tabId, imdbId, rating });
          if (injectionFailures.length) throw injectionFailures.shift();
          return [{ result: imdbResults.length ? imdbResults.shift() : IMDB_OK }];
        }
        calls.toasts.push({ tabId: target.tabId, ...args[0], fn: func.name });
        return [{ result: undefined }];
      },
    },
  };

  async function fakeFetch(url, init) {
    calls.fetches.push(String(url));
    for (const [pattern, handler] of routes) {
      if (pattern.test(String(url))) return handler(String(url), init);
    }
    throw new TypeError(`Unrouted fetch in test: ${url}`);
  }

  const context = {
    chrome,
    fetch: fakeFetch,
    console: {
      debug() {},
      log() {},
      warn: (prefix, step, data) => calls.warnings.push({ step, data }),
      error: (...a) => calls.warnings.push({ step: "error", data: a }),
    },
    // Collapse every delay (auto-retry backoff, tab polling) so tests stay fast;
    // ordering is preserved because timers still run in schedule order.
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    Date,
    TextDecoder,
    TextEncoder,
    URL,
    URLSearchParams,
    structuredClone,
    Promise,
    AbortController,
  };
  vm.createContext(context);
  vm.runInContext(BACKGROUND_SRC, context, { filename: "background.js" });

  let nextRequestId = 1;

  const api = {
    chrome,
    calls,
    local,
    session,
    context,
    /** Evaluate an expression inside the worker (e.g. top-level `const` maps). */
    eval: (expr) => vm.runInContext(expr, context),
    addRoute(pattern, handler) {
      routes.unshift([pattern, handler]);
    },
    holdSessionWrites() {
      let release;
      const promise = new Promise((resolve) => (release = resolve));
      sessionWriteGate = { promise, release };
    },
    releaseSessionWrites() {
      sessionWriteGate?.release();
      sessionWriteGate = null;
    },
    setCookies(next) {
      cookies = next;
    },
    queueImdbResult(result) {
      imdbResults.push(result);
    },
    queueInjectionFailure(message) {
      injectionFailures.push(new Error(message));
    },
    openTab(url) {
      const tab = { id: nextTabId++, url, active: true, status: "complete" };
      tabs.set(tab.id, tab);
      return tab.id;
    },
    openTabs: () => [...tabs.values()],
    newRequestId: () => `req-${nextRequestId++}`,

    /** Fire every onBeforeRequest listener whose filter matches, like Chrome does. */
    async beforeRequest(details) {
      const full = { tabId: 1, requestId: api.newRequestId(), ...details };
      await Promise.all(
        events.onBeforeRequest.listeners
          .filter((l) => matchesFilter(full.url, l.filter.urls))
          .map((l) => l.fn(full))
      );
      return full;
    },
    async completed(details) {
      const full = { statusCode: 200, ...details };
      await Promise.all(
        events.onCompleted.listeners
          .filter((l) => matchesFilter(full.url, l.filter.urls))
          .map((l) => l.fn(full))
      );
    },
    async errorOccurred(details) {
      await Promise.all(
        events.onErrorOccurred.listeners
          .filter((l) => matchesFilter(details.url, l.filter.urls))
          .map((l) => l.fn(details))
      );
    },
    /** Deliver a runtime message and wait for its sendResponse. */
    sendMessage(message, sender = {}) {
      return new Promise((resolve) => {
        let handled = false;
        for (const { fn } of events.onMessage.listeners) {
          const keepOpen = fn(message, sender, (response) => resolve(response));
          if (keepOpen === true) handled = true;
        }
        if (!handled) resolve(undefined);
      });
    },
    /** What page-bridge.js sends when page-hook.js sees the star widget's PATCH. */
    pageRating(tabId, lid, rating) {
      return api.sendMessage(
        { type: "page-rating", url: `https://letterboxd.com/api/v0/me/rate/${lid}`, rating },
        { tab: { id: tabId } }
      );
    },
    async fireAlarm(name) {
      await Promise.all(events.onAlarm.listeners.map(({ fn }) => fn({ name })));
      await flush();
    },
    syncLog: () => local.data.syncLog || [],
  };
  return api;
}

/** Encode a body the way chrome.webRequest delivers `requestBody.raw`. */
function rawBody(obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  return { raw: [{ bytes: new TextEncoder().encode(text).buffer }] };
}

/** Let queued microtasks and zero-delay timers settle. */
function flush(rounds = 5) {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => new Promise((r) => setTimeout(r, 0)));
  return p;
}

/** Routes that make the Letterboxd → IMDb resolution succeed for any film. */
/** A route for the new direct background POST to api.graphql.imdb.com. */
function imdbGraphqlRoute(handler) {
  return [/^https:\/\/api\.graphql\.imdb\.com\/$/, (url, init) => handler(url, init)];
}

function letterboxdRoute(films = {}) {
  return [
    /^https:\/\/letterboxd\.com\/film\/([^/]+)\/details\/$/,
    (url) => {
      const key = url.match(/\/film\/([^/]+)\/details\//)[1];
      const film = films[key];
      if (film === undefined) return htmlResponse("not found", 404);
      return htmlResponse(letterboxdDetailsHtml(film));
    },
  ];
}

module.exports = {
  loadBackground,
  rawBody,
  flush,
  letterboxdRoute,
  imdbGraphqlRoute,
  letterboxdDetailsHtml,
  htmlResponse,
  jsonResponse,
  IMDB_OK,
};
