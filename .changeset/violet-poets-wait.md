---
'@tanstack/router-core': patch
---

Fix context values from a parent route's `beforeLoad` not being propagated to sub-routes in several code paths: while a sub-route's loader reloads in the background, when re-entering a route whose background reload is still in flight, and in a sub-route's error state when its `beforeLoad` throws (the merged context is now committed together with the error status for the errorComponent to consume).

Redirects no longer use a renderable `RouteMatch.status`; `RouteMatch.status` is now `'pending' | 'success' | 'error' | 'notFound'`. Abandoned pending, redirected, or failed matches are dropped from cache and their pending promises are settled so stale suspense work cannot keep rendering suspended.
