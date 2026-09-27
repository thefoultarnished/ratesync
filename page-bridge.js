// Isolated-world counterpart of page-hook.js: takes the rating the page world posted
// and forwards it to the service worker. Kept separate because isolated scripts are the
// only ones allowed to call chrome.runtime.*.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "ratesync" || data.kind !== "rating") return;

  // After the extension is reloaded or updated, this old copy of the script is cut off
  // from it: sendMessage then throws, or returns a rejected promise. Both are ignored so
  // the page's console stays clean; the sync itself reports "reload the page".
  try {
    const sent = chrome.runtime.sendMessage({
      type: "page-rating",
      url: String(data.url || ""),
      rating: data.rating,
    });
    if (sent && typeof sent.catch === "function") sent.catch(() => {});
  } catch {
    /* extension context invalidated */
  }
});
