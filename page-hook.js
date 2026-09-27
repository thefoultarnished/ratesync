// Runs in Letterboxd's own JS world (manifest: world "MAIN"), because Chrome does not
// hand PATCH request bodies to chrome.webRequest — and the film page's star widget
// saves with `PATCH /api/v0/me/rate/{id}`. The rating only exists inside the page's
// own fetch/XHR call, so we mirror that call and post the value out to page-bridge.js.
//
// Everything here must never break the page: each hook falls through to the original
// network function even if reading the body throws.
(() => {
  if (window.__ratesyncPageHook) return;
  window.__ratesyncPageHook = true;

  const TARGET = /\/api\/v0\/me\/rate\//;

  // `found` distinguishes "the payload carried a rating field" from "there was no
  // rating field at all": `{"rating": null}` means the user *cleared* a rating, which
  // must not be mistaken for a rating we failed to read.
  function readRating(body) {
    const missing = { found: false, value: null };
    if (body === null || body === undefined) return missing;

    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "rating" in parsed) {
          return { found: true, value: parsed.rating };
        }
        return missing;
      } catch {
        const params = new URLSearchParams(body);
        return params.has("rating") ? { found: true, value: params.get("rating") } : missing;
      }
    }

    if (body instanceof URLSearchParams) {
      return body.has("rating") ? { found: true, value: body.get("rating") } : missing;
    }

    // FormData behaves like URLSearchParams for our purposes. Blob/ArrayBuffer bodies
    // are not handled — reading them is inherently async, and the star widget's actual
    // client sends JSON, so there is nothing real to read there today.
    if (typeof FormData !== "undefined" && body instanceof FormData) {
      return body.has("rating") ? { found: true, value: body.get("rating") } : missing;
    }

    if (body && typeof body === "object" && "rating" in body) {
      return { found: true, value: body.rating };
    }

    return missing;
  }

  function report(url, body) {
    try {
      const target =
        typeof url === "string" || url instanceof URL ? String(url) : "";
      if (!TARGET.test(target)) return;
      const { found, value } = readRating(body);
      if (!found) return;
      window.postMessage(
        { source: "ratesync", kind: "rating", url: target, rating: value },
        "*"
      );
    } catch {
      /* never break the page */
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" || input instanceof URL) {
          report(String(input), init ? init.body : undefined);
        } else if (input && typeof input.url === "string") {
          report(input.url, init ? init.body : undefined);
        }
      } catch {
        /* never break the page */
      }
      return originalFetch.apply(this, arguments);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__ratesyncUrl = url;
    } catch {
      /* ignore */
    }
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      report(this.__ratesyncUrl, body);
    } catch {
      /* never break the page */
    }
    return originalSend.apply(this, arguments);
  };
})();
