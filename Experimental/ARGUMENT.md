# The Loader Problem — What We're Trying to Solve

## The constraint

YouTube Tuner must run at `document-start` — before YouTube's SPA boots — or it misses
the initialization window entirely. The MutationObserver, the `yt-navigate-finish` listener,
the HUD injection: all of it depends on being in place before YouTube's own scripts execute.

Violentmonkey guarantees this timing for directly installed scripts. The problem is that
direct installation means manual updates. Every time the script changes, the user reinstalls.

## What we want

One installation. Updates flow from the dev branch to the browser automatically, without
the user touching Violentmonkey.

## Why this is hard

Any mechanism that fetches code from a remote URL is inherently async. Async means the fetch
resolves after `document-start`. By then, YouTube has already booted. The fetched code arrives
too late to matter.

Previous attempts (GM_xmlhttpRequest + eval) confirmed this: the fetch succeeds, the eval
runs, but the SPA has already initialized and the script has nothing to hook into.

## The approach in this folder

A single script with `@grant none` and `@run-at document-start`.

On every load it evals synchronously from localStorage — no network, no async, correct timing.
If localStorage is empty (cold start), it evals a baked-in snapshot of the current stable
script instead. The HUD fires on the very first load, no exceptions.

After the synchronous eval, a `fetch()` fires asynchronously to pull the latest version from
the dev branch and write it to localStorage. If the fetch succeeds, the next load runs
fresh code. If YouTube's CSP blocks it, the baked-in snapshot remains the fallback forever
until it is manually updated.

## What this test proves or disproves

Whether `fetch()` to `raw.githubusercontent.com` survives YouTube's `connect-src` CSP
directive from page context. If it does, we have automatic updates. If it doesn't, the
approach still works but requires the baked-in snapshot to be refreshed on each push —
which is a build step, not a user action.

## The open question

If `fetch()` is blocked, the next candidate is a two-script approach where a sandboxed
Violentmonkey script (with `GM_xmlhttpRequest` and `@connect`) handles the fetch and writes
to localStorage, while a `@grant none` runner reads and evals. The ordering problem between
two scripts on the same URL is the unresolved risk in that path.
