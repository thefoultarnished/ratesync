# RateSync — Privacy Policy

**Last updated:** September 27, 2026 (version 2.0.0)

---

## Overview

RateSync is a Chrome extension that copies the rating you give a film on Letterboxd to your IMDb account. This policy explains what data the extension touches, where it goes, and what is never collected.

RateSync is an independent project and is not affiliated with, endorsed by, or sponsored by Letterboxd or IMDb. Letterboxd and IMDb are trademarks of their respective owners.

**In short:** RateSync has no server, no analytics, and no tracking. Everything it stores stays in your browser. The only data that leaves your device is what's needed to do the sync — your rating goes to IMDb, and film lookups go to Letterboxd and (optionally) TMDb.

---

## What Is Never Collected

The developer never receives any of your data. RateSync does not collect, sell, or share:

- Your name, email address, or other personal details
- Your Letterboxd or IMDb password or login credentials
- Your browsing history
- Your ratings or sync history
- Any analytics, usage statistics, or crash reports

---

## What RateSync Accesses, and Why

### Your Letterboxd ratings
- **What:** When you rate or log a film on letterboxd.com, RateSync reads the rating value and the film's Letterboxd ID from that request.
- **How:** It watches Letterboxd's network requests (`webRequest`), and a small script on letterboxd.com pages reads the rating from the film page's star widget, because Chrome hides that request's content from extensions.
- **Sign-in forms are ignored:** requests to Letterboxd's sign-in and account pages, and any form containing a password or token field, are skipped without being read or logged.

### Letterboxd film pages
- **What:** To find the matching IMDb title, RateSync loads the film's public details page from `letterboxd.com` (and, as a fallback, `boxd.it` short links or `api.letterboxd.com`). It reads the film's title and its IMDb or TMDb link.
- **Note:** These requests are made from your browser, so Letterboxd sees them as coming from you, like any page you open.

### Your IMDb login
- **What:** RateSync checks whether IMDb's login cookie (`at-main`) exists, to show whether you're logged in. It never stores, logs, or transmits that cookie's value.
- **Session ID:** It also reads IMDb's `session-id` value and includes it in the rating request to IMDb, the same way IMDb's own website does.
- **How the rating is sent:** RateSync opens an IMDb tab and sends the rating from inside that page, so your browser attaches your IMDb session itself. The tab closes automatically, or stays open for you if you turned on *Auto-open IMDb*.

### Your TMDb key (optional)
- **What:** A TMDb API key or Read Access Token, only if you choose to add one.
- **Why:** To look up the IMDb ID of films that Letterboxd doesn't link to IMDb.
- **Where it goes:** Stored in your browser (`chrome.storage.local`) and sent only to `api.themoviedb.org`, together with the film's TMDb ID.

---

## What Is Stored, and Where

All storage is inside your own browser profile. Nothing is synced to any server.

| Data | Where | How long |
|---|---|---|
| Sync history: film title, IMDb ID, rating, success or error message, time, and Letterboxd film IDs (used for the Retry button) | `chrome.storage.local` | Last 100 syncs; you can clear it in the popup |
| Settings: TMDb key, popup filters, *Auto-open IMDb* and in-page notification preferences | `chrome.storage.local` | Until you change or remove them |
| Ratings being synced right now, and the ID of the background IMDb tab | `chrome.storage.session` | Deleted automatically when the browser closes |
| The rating read from the star widget | Extension memory | Up to 30 seconds, deleted once used |

Uninstalling RateSync deletes all of it.

---

## Where Data Is Sent

RateSync only contacts these services, only to perform a sync you started by rating a film:

| Service | What is sent | Their privacy policy |
|---|---|---|
| IMDb (`www.imdb.com`, `api.graphql.imdb.com`) | The film's IMDb ID and your rating, from your logged-in IMDb session | [imdb.com/privacy](https://www.imdb.com/privacy) |
| Letterboxd (`letterboxd.com`, `boxd.it`, `api.letterboxd.com`) | Requests for the film's public details page | [letterboxd.com/privacy-policy](https://letterboxd.com/privacy-policy) |
| TMDb (`api.themoviedb.org`), optional | The film's TMDb ID and your TMDb key | [themoviedb.org/privacy-policy](https://www.themoviedb.org/privacy-policy) |

Links in the popup (TMDb sign-up, Ko-fi) open only when you click them.

---

## Permissions and Why They're Needed

| Permission | Why |
|---|---|
| `webRequest` | Notice when you submit a rating on Letterboxd, and whether Letterboxd saved it |
| `scripting` | Show the small sync status message on Letterboxd, and send the rating from inside the IMDb tab |
| `cookies` | Check whether you're logged in to IMDb, and read IMDb's session ID |
| `storage` | Keep your sync history and settings in your browser |
| `alarms` | Close the background IMDb tab if the extension is interrupted mid-sync |
| `https://letterboxd.com/*` | Detect ratings, run the star-widget script, and load film details pages |
| `https://boxd.it/*`, `https://api.letterboxd.com/*` | Fallback film lookups for Letterboxd short links |
| `https://*.imdb.com/*` | Open the IMDb tab, send the rating, and check the IMDb login cookie |
| `https://api.themoviedb.org/*` | Optional IMDb ID lookup through TMDb |

---

## Changes to This Policy

If this policy changes, the updated version will be published at the same location with a new date.

---

## Contact

Questions or concerns: neo35royal@gmail.com
