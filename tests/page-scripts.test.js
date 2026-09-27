// The two content scripts on letterboxd.com: page-hook.js (page world) reads the star
// widget's rating, page-bridge.js (isolated world) forwards it to the service worker.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const HOOK_SRC = read("page-hook.js");
const BRIDGE_SRC = read("page-bridge.js");

function loadHook() {
  const posted = [];
  const networkCalls = [];
  class FakeXHR {
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    send(body) {
      networkCalls.push({ via: "xhr", url: this.url, body });
    }
  }
  const g = {
    fetch: async (input, init) => {
      networkCalls.push({ via: "fetch", input, init });
      return "response";
    },
    XMLHttpRequest: FakeXHR,
    postMessage: (message, target) => posted.push({ message, target }),
    URL,
    URLSearchParams,
    FormData, // Node 18+ global, used to check the hook's FormData branch
  };
  g.window = g;
  vm.createContext(g);
  vm.runInContext(HOOK_SRC, g, { filename: "page-hook.js" });
  return { g, posted, networkCalls };
}

function loadBridge({ sendMessage }) {
  let onMessage = null;
  const sent = [];
  const g = {
    chrome: {
      runtime: {
        sendMessage: (msg) => {
          sent.push(msg);
          return sendMessage(msg);
        },
      },
    },
  };
  g.window = g;
  g.addEventListener = (type, fn) => {
    if (type === "message") onMessage = fn;
  };
  vm.createContext(g);
  vm.runInContext(BRIDGE_SRC, g, { filename: "page-bridge.js" });
  // Inside a vm context `window` is the context's global proxy, not `g` itself, so
  // "a message from this window" has to use that object as its source.
  const self = vm.runInContext("window", g);
  return { self, sent, dispatch: (event) => onMessage(event) };
}

// ── page-hook.js ────────────────────────────────────────────────────────────

test("hook: a star-widget fetch reports its rating and still goes to the network", async () => {
  const { g, posted, networkCalls } = loadHook();
  const response = await g.fetch("/api/v0/me/rate/2aWW", {
    method: "PATCH",
    body: JSON.stringify({ rating: 4.5 }),
  });

  assert.equal(response, "response");
  assert.equal(networkCalls.length, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.source, "ratesync");
  assert.equal(posted[0].message.url, "/api/v0/me/rate/2aWW");
  assert.equal(posted[0].message.rating, 4.5);
});

test("hook: a cleared rating is reported as null, not skipped", async () => {
  const { g, posted } = loadHook();
  await g.fetch("/api/v0/me/rate/2aWW", { method: "PATCH", body: '{"rating":null}' });

  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.rating, null);
});

test("hook: other requests are passed through without a report", async () => {
  const { g, posted, networkCalls } = loadHook();
  await g.fetch("/api/v0/film/2aWW", { method: "GET" });
  await g.fetch("/api/v0/me/rate/2aWW", { method: "PATCH", body: '{"liked":true}' });

  assert.equal(posted.length, 0);
  assert.equal(networkCalls.length, 2);
});

test("hook: XHR requests are reported too", () => {
  const { g, posted, networkCalls } = loadHook();
  const xhr = new g.XMLHttpRequest();
  xhr.open("PATCH", "https://letterboxd.com/api/v0/me/rate/3bXX");
  xhr.send("rating=3");

  assert.equal(networkCalls.length, 1);
  assert.equal(posted[0].message.rating, "3");
});

test("hook: a FormData body is read for its rating field", async () => {
  const { g, posted, networkCalls } = loadHook();
  const form = new FormData();
  form.set("rating", "3");
  await g.fetch("/api/v0/me/rate/2aWW", { method: "PATCH", body: form });

  assert.equal(networkCalls.length, 1);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.rating, "3");
});

test("hook: a FormData body without a rating field is left unreported", async () => {
  const { g, posted } = loadHook();
  const form = new FormData();
  form.set("liked", "true");
  await g.fetch("/api/v0/me/rate/2aWW", { method: "PATCH", body: form });

  assert.equal(posted.length, 0);
});

test("hook: an unreadable body never breaks the page's request", async () => {
  const { g, posted, networkCalls } = loadHook();
  const hostile = { get rating() { throw new Error("boom"); } };
  await g.fetch("/api/v0/me/rate/2aWW", { method: "PATCH", body: hostile });

  assert.equal(networkCalls.length, 1);
  assert.equal(posted.length, 0);
});

test("hook: loading twice does not wrap fetch twice", async () => {
  const { g, posted } = loadHook();
  vm.runInContext(HOOK_SRC, g);
  await g.fetch("/api/v0/me/rate/2aWW", { method: "PATCH", body: '{"rating":4}' });

  assert.equal(posted.length, 1);
});

// ── page-bridge.js ──────────────────────────────────────────────────────────

test("bridge: forwards only RateSync rating messages from the page itself", () => {
  const { self, sent, dispatch } = loadBridge({ sendMessage: async () => ({ ok: true }) });
  const data = { source: "ratesync", kind: "rating", url: "/api/v0/me/rate/2aWW", rating: 4 };

  dispatch({ source: self, data });
  dispatch({ source: {}, data }); // from another frame/window
  dispatch({ source: self, data: { ...data, source: "someone-else" } });
  dispatch({ source: self, data: "not an object" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "page-rating");
  assert.equal(sent[0].rating, 4);
});

test("bridge: a disconnected extension produces no error on the page", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const rejecting = loadBridge({
      sendMessage: () => Promise.reject(new Error("Could not establish connection.")),
    });
    const throwing = loadBridge({
      sendMessage: () => {
        throw new Error("Extension context invalidated.");
      },
    });
    const data = { source: "ratesync", kind: "rating", url: "/api/v0/me/rate/2aWW", rating: 4 };

    assert.doesNotThrow(() => rejecting.dispatch({ source: rejecting.self, data }));
    assert.doesNotThrow(() => throwing.dispatch({ source: throwing.self, data }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
