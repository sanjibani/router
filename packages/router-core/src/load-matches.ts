import { isServer } from '@tanstack/router-core/isServer'
import { invariant } from './invariant'
import { createControlledPromise, isPromise } from './utils'
import { isNotFound } from './not-found'
import { rootRouteId } from './root'
import { isRedirect } from './redirect'
import type { NotFoundError } from './not-found'
import type { AnyRedirect } from './redirect'
import type { ParsedLocation } from './location'
import type {
  AnyRoute,
  BeforeLoadContextOptions,
  LoaderFnContext,
  SsrContextOptions,
} from './route'
import type { AnyRouteMatch, MakeRouteMatch } from './Matches'
import type { AnyRouter, SSROption, UpdateMatchFn } from './router'

/**
 * An object of this shape is created when calling `loadMatches`.
 * It contains everything we need for all other functions in this file
 * to work. (It's basically the function's argument, plus a few mutable states)
 */
type InnerLoadContext = {
  /** the calling router instance */
  router: AnyRouter
  location: ParsedLocation
  /** mutable state, scoped to a `loadMatches` call */
  firstBadMatchIndex?: number
  /** mutable state, scoped to a `loadMatches` call */
  rendered?: boolean
  serialError?: unknown
  updateMatch: UpdateMatchFn
  matches: Array<AnyRouteMatch>
  preload?: boolean
  preloadMatchIds?: Set<string>
  forceStaleReload?: boolean
  onReady?: () => Promise<void>
  sync?: boolean
}

const triggerOnReady = (inner: InnerLoadContext): void | Promise<void> => {
  if (!inner.rendered) {
    inner.rendered = true
    return inner.onReady?.()
  }
}

const resolvePreload = (inner: InnerLoadContext, matchId: string): boolean => {
  return !!inner.preload && !inner.router.stores.matchStores.has(matchId)
}

/**
 * Builds the accumulated context from router options and all matches up to the given index.
 * Merges __routeContext and __beforeLoadContext from each match.
 */
const buildMatchContext = (
  inner: InnerLoadContext,
  index: number,
): Record<string, unknown> => {
  const context: Record<string, unknown> = {
    ...(inner.router.options.context ?? {}),
  }
  for (let i = 0; i <= index; i++) {
    const match = inner.matches[i]!
    Object.assign(context, match.__routeContext, match.__beforeLoadContext)
  }
  return context
}

// Commits the merged context exactly when a match's beforeLoad phase settles.
// Loader-phase updates intentionally leave context alone; loaders cannot change
// the inputs used by buildMatchContext.
const commitMatch = (
  inner: InnerLoadContext,
  matchId: string,
  index: number,
  patch: Partial<AnyRouteMatch>,
): void => {
  inner.updateMatch(matchId, (prev) => ({
    ...prev,
    ...patch,
    context: buildMatchContext(inner, index),
  }))
}

const patchMatch = (
  inner: InnerLoadContext,
  matchId: string,
  patch: Partial<AnyRouteMatch>,
): void => {
  inner.updateMatch(matchId, (prev) => ({
    ...prev,
    ...patch,
  }))
}

const getNavigate = (inner: InnerLoadContext) => (opts: any) =>
  inner.router.navigate({
    ...opts,
    _fromLocation: inner.location,
  })

const settleBeforeLoadPromise = (match: AnyRouteMatch): void => {
  match._nonReactive.beforeLoadPromise?.resolve()
  match._nonReactive.beforeLoadPromise = undefined
}

const settleLoaderPromise = (match: AnyRouteMatch): void => {
  match._nonReactive.loaderPromise?.resolve()
  match._nonReactive.loaderPromise = undefined
}

const settleLoadPromises = (match: AnyRouteMatch): void => {
  settleLoaderPromise(match)
  match._nonReactive.loadPromise?.resolve()
  match._nonReactive.loadPromise = undefined
}

const clearPending = (match: AnyRouteMatch): void => {
  clearTimeout(match._nonReactive.pendingTimeout)
  match._nonReactive.pendingTimeout = undefined
  match._nonReactive.minPendingPromise?.resolve()
  match._nonReactive.minPendingPromise = undefined
}

export const clearMatchPromises = (match: AnyRouteMatch): void => {
  clearPending(match)
  settleBeforeLoadPromise(match)
  settleLoadPromises(match)
}

const getNotFoundBoundaryIndex = (
  inner: InnerLoadContext,
  err: NotFoundError,
): number | undefined => {
  if (!inner.matches.length) {
    return undefined
  }

  const requestedRouteId = err.routeId

  let startIndex = requestedRouteId
    ? inner.matches.findIndex((match) => match.routeId === requestedRouteId)
    : (inner.firstBadMatchIndex ?? inner.matches.length - 1)

  if (startIndex < 0) {
    startIndex = 0
  }

  for (let i = startIndex; i >= 0; i--) {
    const match = inner.matches[i]!
    const route = inner.router.looseRoutesById[match.routeId]!
    if (route.options.notFoundComponent) {
      return i
    }
  }

  // If no boundary component is found, preserve explicit routeId targeting behavior,
  // otherwise default to root for untargeted notFounds.
  return requestedRouteId ? startIndex : 0
}

const handleRedirect = (
  inner: InnerLoadContext,
  match: AnyRouteMatch | undefined,
  redirect: AnyRedirect,
): void => {
  if (redirect.redirectHandled && !redirect.options.reloadDocument) {
    throw redirect
  }

  // in case of a redirecting match during preload, the match does not exist
  if (match) {
    match._nonReactive.error = redirect
    clearPending(match)
    settleBeforeLoadPromise(match)

    if (inner.preload || inner.router.stores.cachedMatchStores.has(match.id)) {
      inner.router.clearCache({ filter: (d) => d.id === match.id })
      settleLoadPromises(match)
    } else {
      // A redirect is not renderable navigation state. Keep the current
      // renderable status (pending or success) until the redirect target
      // commits, but clear fetching state.
      settleLoaderPromise(match)
      patchMatch(inner, match.id, {
        isFetching: false as const,
      })
    }
  }

  inner.rendered = true
  redirect.options._fromLocation = inner.location
  redirect.redirectHandled = true
  throw inner.router.resolveRedirect(redirect)
}

const handleNotFound = (
  inner: InnerLoadContext,
  match: AnyRouteMatch | undefined,
  notFound: NotFoundError,
): void => {
  if (match) {
    match._nonReactive.error = notFound
    clearPending(match)
    settleBeforeLoadPromise(match)
    settleLoadPromises(match)

    if (!notFound.routeId) {
      // Stamp the throwing match's routeId so that the finalization step in
      // loadMatches knows where the notFound originated. The actual boundary
      // resolution is deferred until firstBadMatchIndex is stable.
      notFound.routeId = match.routeId
    }

    patchMatch(inner, match.id, {
      status: 'notFound',
      error: notFound,
      isFetching: false,
      _forcePending: undefined,
    })

    if (inner.preload || inner.router.stores.cachedMatchStores.has(match.id)) {
      inner.router.clearCache({ filter: (d) => d.id === match.id })
    }
  }

  throw notFound
}

const handleRedirectOrNotFound = (
  inner: InnerLoadContext,
  match: AnyRouteMatch | undefined,
  err: unknown,
): void => {
  if (isRedirect(err)) {
    handleRedirect(inner, match, err)
  }

  if (isNotFound(err)) {
    handleNotFound(inner, match, err)
  }
}

const getLoaderMatch = (
  inner: InnerLoadContext,
  matchId: string,
): AnyRouteMatch | false | undefined => {
  const match = inner.router.getMatch(matchId)
  if (!match || inner.preloadMatchIds?.has(matchId)) {
    return
  }

  // upon hydration, we skip the loader if the match has been dehydrated on the server
  if (!(isServer ?? inner.router.isServer) && match._nonReactive.dehydrated) {
    return false
  }

  if ((isServer ?? inner.router.isServer) && match.ssr === false) {
    return false
  }

  return match
}

const handleSerialError = (
  inner: InnerLoadContext,
  index: number,
  err: any,
): void => {
  const match = inner.matches[index]!
  const { id: matchId, routeId } = match
  const route = inner.router.looseRoutesById[routeId]!

  // Much like suspense, we use a promise here to know if
  // we've been outdated by a new loadMatches call and
  // should abort the current async operation
  if (err instanceof Promise) {
    throw err
  }

  inner.firstBadMatchIndex ??= index
  match.__beforeLoadContext = undefined

  const currentMatch = inner.router.getMatch(matchId)
  if (currentMatch) {
    currentMatch.__beforeLoadContext = undefined
  }

  handleRedirectOrNotFound(inner, currentMatch, err)

  try {
    route.options.onError?.(err)
  } catch (errorHandlerErr) {
    err = errorHandlerErr
    // The current match's pending beforeLoad context was already cleared above.
    handleRedirectOrNotFound(inner, currentMatch, err)
  }

  // A match that errors during the beforeLoad phase never reaches the loader
  // phase. Settle its promises after committing the error state.
  commitMatch(inner, matchId, index, {
    __beforeLoadContext: undefined,
    error: err,
    status: 'error',
    isFetching: false,
    _forcePending: undefined,
    updatedAt: Date.now(),
    abortController: new AbortController(),
  })

  const updatedMatch = inner.router.getMatch(matchId)
  if (updatedMatch) {
    clearMatchPromises(updatedMatch)
  }

  if (!inner.preload) {
    inner.serialError ??= err
  }
}

const isBeforeLoadSsr = (
  inner: InnerLoadContext,
  matchId: string,
  index: number,
  route: AnyRoute,
): void | Promise<void> => {
  const existingMatch = inner.router.getMatch(matchId)!
  const parentMatchId = inner.matches[index - 1]?.id
  const parentMatch = parentMatchId
    ? inner.router.getMatch(parentMatchId)!
    : undefined

  // in SPA mode, only SSR the root route
  if (inner.router.isShell()) {
    existingMatch.ssr = route.id === rootRouteId
    return
  }

  if (parentMatch?.ssr === false) {
    existingMatch.ssr = false
    return
  }

  const parentOverride = (tempSsr: SSROption) => {
    if (tempSsr === true && parentMatch?.ssr === 'data-only') {
      return 'data-only'
    }
    return tempSsr
  }

  const defaultSsr = inner.router.options.defaultSsr ?? true

  if (route.options.ssr === undefined) {
    existingMatch.ssr = parentOverride(defaultSsr)
    return
  }

  if (typeof route.options.ssr !== 'function') {
    existingMatch.ssr = parentOverride(route.options.ssr)
    return
  }
  const { search, params } = existingMatch

  const ssrFnContext: SsrContextOptions<any, any, any> = {
    search: makeMaybe(search, existingMatch.searchError),
    params: makeMaybe(params, existingMatch.paramsError),
    location: inner.location,
    matches: inner.matches.map((match) => ({
      index: match.index,
      pathname: match.pathname,
      fullPath: match.fullPath,
      staticData: match.staticData,
      id: match.id,
      routeId: match.routeId,
      search: makeMaybe(match.search, match.searchError),
      params: makeMaybe(match.params, match.paramsError),
      ssr: match.ssr,
    })),
  }

  const tempSsr = route.options.ssr(ssrFnContext)
  if (isPromise(tempSsr)) {
    return tempSsr.then((ssr) => {
      existingMatch.ssr = parentOverride(ssr ?? defaultSsr)
    })
  }

  existingMatch.ssr = parentOverride(tempSsr ?? defaultSsr)
  return
}

const setupPendingTimeout = (
  inner: InnerLoadContext,
  matchId: string,
  route: AnyRoute,
  match: AnyRouteMatch,
): void => {
  if (match._nonReactive.pendingTimeout !== undefined) return

  const pendingMs =
    route.options.pendingMs ?? inner.router.options.defaultPendingMs
  const shouldPending = !!(
    inner.onReady &&
    !(isServer ?? inner.router.isServer) &&
    !resolvePreload(inner, matchId) &&
    (route.options.loader ||
      route.options.beforeLoad ||
      routeNeedsPreload(route)) &&
    typeof pendingMs === 'number' &&
    pendingMs !== Infinity &&
    (route.options.pendingComponent ??
      (inner.router.options as any).defaultPendingComponent)
  )

  if (shouldPending) {
    const pendingTimeout = setTimeout(() => {
      // the timeout has served its purpose, clear it so that a later load
      // pass of this match can arm a new one
      match._nonReactive.pendingTimeout = undefined
      // Update the match and prematurely resolve the loadMatches promise so that
      // the pending component can start rendering
      triggerOnReady(inner)
    }, pendingMs)
    match._nonReactive.pendingTimeout = pendingTimeout
  }
}

const executeBeforeLoad = (
  inner: InnerLoadContext,
  matchId: string,
  index: number,
  route: AnyRoute,
): void | Promise<void> => {
  const match = inner.router.getMatch(matchId)!

  // explicitly capture the previous loadPromise
  let prevLoadPromise = match._nonReactive.loadPromise
  match._nonReactive.loadPromise = createControlledPromise<void>(() => {
    prevLoadPromise?.resolve()
    prevLoadPromise = undefined
  })

  const { paramsError, searchError } = match

  if (paramsError) {
    handleSerialError(inner, index, paramsError)
    return
  }

  if (searchError) {
    handleSerialError(inner, index, searchError)
    return
  }

  setupPendingTimeout(inner, matchId, route, match)
  const beforeLoad = route.options.beforeLoad

  const abortController = new AbortController()
  let isPending = false
  const pending = () => {
    if (isPending) {
      return
    }
    isPending = true
    inner.updateMatch(matchId, (prev) => ({
      ...prev,
      isFetching: 'beforeLoad',
      fetchCount: prev.fetchCount + 1,
      abortController,
      // Note: We intentionally don't update context here.
      // Context should only be updated after beforeLoad resolves to avoid
      // components seeing incomplete context during async beforeLoad execution.
    }))
  }

  // if there is no `beforeLoad` option, just mark as pending and resolve.
  // The undefined beforeLoad context is still committed here to clear any
  // stale context from a previous load generation of the same match.
  if (!beforeLoad) {
    inner.matches[index]!.__beforeLoadContext = undefined
    inner.router.batch(() => {
      pending()
      commitMatch(inner, matchId, index, {
        isFetching: false as const,
        __beforeLoadContext: undefined,
      })
    })
    settleBeforeLoadPromise(match)
    return
  }

  const beforeLoadPromise = createControlledPromise<void>()
  const isCurrentBeforeLoad = () =>
    inner.router.getMatch(matchId)?._nonReactive.beforeLoadPromise ===
    beforeLoadPromise

  // commits the result of the beforeLoad phase and settles its promise
  const updateContext = (beforeLoadContext: any) => {
    if (!isCurrentBeforeLoad()) {
      return
    }

    if (isRedirect(beforeLoadContext) || isNotFound(beforeLoadContext)) {
      pending()
      handleSerialError(inner, index, beforeLoadContext)
      return
    }

    inner.matches[index]!.__beforeLoadContext = beforeLoadContext

    inner.router.batch(() => {
      pending()
      commitMatch(inner, matchId, index, {
        isFetching: false as const,
        __beforeLoadContext: beforeLoadContext,
      })
    })
    settleBeforeLoadPromise(match)
  }

  match._nonReactive.beforeLoadPromise = beforeLoadPromise

  // Build context from all parent matches, excluding current match's __beforeLoadContext
  // (since we're about to execute beforeLoad for this match)
  const context = {
    ...buildMatchContext(inner, index - 1),
    ...match.__routeContext,
  }
  const { search, params, cause } = match
  const preload = resolvePreload(inner, matchId)
  const beforeLoadFnContext: BeforeLoadContextOptions<
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any,
    any
  > = {
    search,
    abortController,
    params,
    preload,
    context,
    location: inner.location,
    navigate: getNavigate(inner),
    buildLocation: inner.router.buildLocation,
    cause: preload ? 'preload' : cause,
    matches: inner.matches,
    routeId: route.id,
    ...inner.router.options.additionalContext,
  }

  let beforeLoadContext
  try {
    beforeLoadContext = beforeLoad(beforeLoadFnContext)
    if (isPromise(beforeLoadContext)) {
      pending()
      return beforeLoadContext.then(updateContext, (err) => {
        if (!isCurrentBeforeLoad()) {
          return
        }
        handleSerialError(inner, index, err)
      })
    }
  } catch (err) {
    pending()
    handleSerialError(inner, index, err)
    return
  }

  updateContext(beforeLoadContext)
  return
}

const handleBeforeLoad = (
  inner: InnerLoadContext,
  index: number,
): void | Promise<void> => {
  const { id: matchId, routeId } = inner.matches[index]!
  const route = inner.router.looseRoutesById[routeId]!

  const queueExecution = () => {
    const existingMatch = getLoaderMatch(inner, matchId)
    if (!existingMatch) {
      return
    }

    // If we are in the middle of a load, either of these will be present
    // (not to be confused with `loadPromise`, which is always defined)
    const pendingBeforeLoad = existingMatch._nonReactive.beforeLoadPromise
    if (pendingBeforeLoad || existingMatch._nonReactive.loaderPromise) {
      setupPendingTimeout(inner, matchId, route, existingMatch)

      if (pendingBeforeLoad) {
        return pendingBeforeLoad.then(() => {
          const match = inner.router.getMatch(matchId)!
          if (match.preload && match.status === 'notFound') {
            handleRedirectOrNotFound(inner, match, match.error)
          }

          if (!getLoaderMatch(inner, matchId)) {
            return
          }
          return executeBeforeLoad(inner, matchId, index, route)
        })
      }

      const match = inner.router.getMatch(matchId)!
      if (match.preload && match.status === 'notFound') {
        handleRedirectOrNotFound(inner, match, match.error)
      }
    }

    if (!getLoaderMatch(inner, matchId)) {
      return
    }
    return executeBeforeLoad(inner, matchId, index, route)
  }

  // on the server, determine whether to SSR the current match or not
  if (isServer ?? inner.router.isServer) {
    const maybePromise = isBeforeLoadSsr(inner, matchId, index, route)
    if (isPromise(maybePromise)) return maybePromise.then(queueExecution)
  }
  return queueExecution()
}

const getLoaderContext = (
  inner: InnerLoadContext,
  matchPromises: Array<Promise<AnyRouteMatch>>,
  matchId: string,
  index: number,
  route: AnyRoute,
): LoaderFnContext => {
  const parentMatchPromise = matchPromises[index - 1] as any
  const { params, loaderDeps, abortController, cause } =
    inner.router.getMatch(matchId)!

  const context = buildMatchContext(inner, index)

  const preload = resolvePreload(inner, matchId)

  return {
    params,
    deps: loaderDeps,
    preload,
    parentMatchPromise,
    abortController,
    context,
    location: inner.location,
    navigate: getNavigate(inner),
    cause: preload ? 'preload' : cause,
    route,
    ...inner.router.options.additionalContext,
  }
}

const runLoader = async (
  inner: InnerLoadContext,
  matchPromises: Array<Promise<AnyRouteMatch>>,
  matchId: string,
  index: number,
  route: AnyRoute,
): Promise<void> => {
  let getCurrentMatch: (() => AnyRouteMatch | undefined) | undefined

  try {
    // If the Matches component rendered
    // the pending component and needs to show it for
    // a minimum duration, we''ll wait for it to resolve
    // before committing to the match and resolving
    // the loadPromise

    const match = inner.router.getMatch(matchId)!
    const loaderBucket = match._nonReactive
    const loaderPromise = loaderBucket.loaderPromise
    const isCurrentLoader = () => loaderBucket.loaderPromise === loaderPromise
    getCurrentMatch = () => {
      return isCurrentLoader() ? inner.router.getMatch(matchId) : undefined
    }

    // Actually run the loader and handle the result
    try {
      if (!(isServer ?? inner.router.isServer) || match.ssr === true) {
        loadRouteChunk(route)
      }

      // Kick off the loader!
      const routeLoader = route.options.loader
      const loader =
        typeof routeLoader === 'function' ? routeLoader : routeLoader?.handler
      const loaderResult = loader?.(
        getLoaderContext(inner, matchPromises, matchId, index, route),
      )
      const loaderResultIsPromise = isPromise(loaderResult)

      const willLoadSomething = !!(
        loaderResultIsPromise ||
        route._lazyPromise ||
        route._componentsPromise ||
        route.options.head ||
        route.options.scripts ||
        route.options.headers ||
        loaderBucket.minPendingPromise
      )

      if (willLoadSomething) {
        patchMatch(inner, matchId, {
          isFetching: 'loader',
        })
      }

      if (loader) {
        const loaderData = loaderResultIsPromise
          ? await loaderResult
          : loaderResult

        if (!getCurrentMatch()) {
          return
        }

        if (isRedirect(loaderData) || isNotFound(loaderData)) {
          throw loaderData
        }

        if (loaderData !== undefined) {
          patchMatch(inner, matchId, {
            loaderData,
          })
        }
      }

      // Lazy option can modify the route options,
      // so we need to wait for it to resolve before
      // we can use the options
      if (route._lazyPromise) await route._lazyPromise
      const pendingPromise = loaderBucket.minPendingPromise
      if (pendingPromise) await pendingPromise

      // Last but not least, wait for the components
      // to be preloaded before we resolve the match
      if (route._componentsPromise) await route._componentsPromise
      if (!isCurrentLoader()) {
        return
      }
      patchMatch(inner, matchId, {
        error: undefined,
        status: 'success',
        isFetching: false as const,
        updatedAt: Date.now(),
      })
    } catch (e) {
      let error = e

      if (isRedirect(e) && e.redirectHandled) {
        throw e
      }

      if ((error as any)?.name === 'AbortError') {
        if (match.abortController.signal.aborted) {
          return
        }
        if (!getCurrentMatch()) {
          return
        }
        // a softly aborted pending match keeps its previous data and is
        // committed as success
        inner.updateMatch(matchId, (prev) => ({
          ...prev,
          status: prev.status === 'pending' ? 'success' : prev.status,
          isFetching: false,
        }))
        return
      }

      const pendingPromise = loaderBucket.minPendingPromise
      if (pendingPromise) await pendingPromise
      let currentMatch = getCurrentMatch()
      if (!currentMatch) {
        return
      }

      if (isNotFound(e)) {
        await (route.options.notFoundComponent as any)?.preload?.()
        currentMatch = getCurrentMatch()
        if (!currentMatch) {
          return
        }
      }

      handleRedirectOrNotFound(inner, currentMatch, e)

      try {
        route.options.onError?.(e)
      } catch (onErrorError) {
        error = onErrorError
        handleRedirectOrNotFound(inner, currentMatch, onErrorError)
      }
      await loadRouteChunk(route, ['errorComponent'])
      if (!isCurrentLoader()) {
        return
      }

      patchMatch(inner, matchId, {
        error,
        status: 'error',
        isFetching: false,
      })
    }
  } catch (err) {
    if ((isRedirect(err) && err.redirectHandled) || isNotFound(err)) {
      throw err
    }
    const match = getCurrentMatch?.()
    if (!match) {
      return
    }
    handleRedirectOrNotFound(inner, match, err)
  }
}

const loadRouteMatch = async (
  inner: InnerLoadContext,
  matchPromises: Array<Promise<AnyRouteMatch>>,
  index: number,
): Promise<AnyRouteMatch> => {
  const { id: matchId, routeId } = inner.matches[index]!
  const route = inner.router.looseRoutesById[routeId]!
  const routeLoader = route.options.loader
  const shouldReloadInBackground =
    ((typeof routeLoader === 'function'
      ? undefined
      : routeLoader?.staleReloadMode) ??
      inner.router.options.defaultStaleReloadMode) !== 'blocking'
  // becomes true when this pass leaves the loader running detached in the
  // background, in which case finalization is deferred to that detached run
  let loaderIsRunningAsync = false
  let loaderGeneration: AnyRouteMatch['_nonReactive']['loaderPromise']
  let loaderBucket: AnyRouteMatch['_nonReactive'] | undefined

  /**
   * Decides how the loader runs for this pass and executes it.
   */
  const runLoaderPhase = (
    preload: boolean,
    prevMatch: AnyRouteMatch,
    previousRouteMatchId: string | undefined,
    match: AnyRouteMatch,
  ): void | Promise<void> => {
    const age = Date.now() - prevMatch.updatedAt

    const staleAge = preload
      ? (route.options.preloadStaleTime ??
        inner.router.options.defaultPreloadStaleTime ??
        30_000) // 30 seconds for preloads by default
      : (route.options.staleTime ?? inner.router.options.defaultStaleTime ?? 0)

    const shouldReloadOption = route.options.shouldReload

    // Default to reloading the route all the time
    // Allow shouldReload to get the last say,
    // if provided.
    const shouldReload =
      typeof shouldReloadOption === 'function'
        ? shouldReloadOption(
            getLoaderContext(inner, matchPromises, matchId, index, route),
          )
        : shouldReloadOption

    const { status, invalid } = match
    const staleMatchShouldReload =
      age >= staleAge &&
      (!!inner.forceStaleReload ||
        match.cause === 'enter' ||
        (previousRouteMatchId !== undefined &&
          previousRouteMatchId !== match.id))
    const loaderShouldRunAsync =
      status === 'success' &&
      (invalid || (shouldReload ?? staleMatchShouldReload))

    if (preload && route.options.preload === false) {
      // Do nothing
      return
    }

    if (loaderShouldRunAsync && !inner.sync && shouldReloadInBackground) {
      // stale-while-revalidate: leave the loader running detached
      loaderIsRunningAsync = true
      const backgroundGeneration = match._nonReactive.loaderPromise
      if (match.invalid !== false) {
        patchMatch(inner, matchId, { invalid: false })
      }
      ;(async () => {
        try {
          await runLoader(inner, matchPromises, matchId, index, route)
        } catch (err) {
          if (isRedirect(err)) {
            await inner.router.navigate(err.options)
            return
          }
        }
        const latestMatch = inner.router.getMatch(matchId)
        if (
          latestMatch &&
          latestMatch._nonReactive.loaderPromise === backgroundGeneration
        ) {
          settleLoadPromises(latestMatch)
        }
      })()
      return
    }

    if (status !== 'success' || loaderShouldRunAsync) {
      return runLoader(inner, matchPromises, matchId, index, route)
    }
  }

  const prevMatch = getLoaderMatch(inner, matchId)
  if (!prevMatch) {
    // in case of a redirecting match during preload, the match does not exist
    if (prevMatch === undefined) {
      return inner.matches[index]!
    }

    // the beforeLoad phase (and with it the context commit) does not run for
    // skipped matches, so commit the merged route context here
    commitMatch(inner, matchId, index, { invalid: false })

    if (isServer ?? inner.router.isServer) {
      return inner.router.getMatch(matchId)!
    }
  } else {
    const activeIdAtIndex = inner.router.stores.matchesId.get()[index]
    const activeAtIndex =
      (activeIdAtIndex &&
        inner.router.stores.matchStores.get(activeIdAtIndex)) ||
      null
    const previousRouteMatchId =
      activeAtIndex?.routeId === routeId
        ? activeIdAtIndex
        : inner.router.stores.matches.get().find((d) => d.routeId === routeId)
            ?.id
    const preload = resolvePreload(inner, matchId)

    // there is a loaderPromise, so we are in the middle of a load
    if (prevMatch._nonReactive.loaderPromise) {
      loaderBucket = prevMatch._nonReactive
      loaderGeneration = loaderBucket.loaderPromise
      // do not block if we already have stale data we can show
      // but only if the ongoing load is not a preload since error handling is different for preloads
      // and we don't want to swallow errors
      if (
        prevMatch.status === 'success' &&
        !inner.sync &&
        !prevMatch.preload &&
        shouldReloadInBackground
      ) {
        // this load pass hands the match over to the still in-flight reload;
        // finalization is skipped, so clear invalid here without touching
        // promises or loader state.
        if (prevMatch.invalid !== false) {
          patchMatch(inner, matchId, {
            invalid: false,
          })
        }
        return inner.router.getMatch(matchId)!
      }
      await loaderGeneration
      const match = inner.router.getMatch(matchId)
      if (match) {
        const error = match._nonReactive.error || match.error
        if (error) {
          handleRedirectOrNotFound(inner, match, error)
        }

        if (match.status === 'pending') {
          await runLoaderPhase(preload, prevMatch, previousRouteMatchId, match)
        }
      }
    } else {
      const match = inner.router.getMatch(matchId)!
      // a new load generation starts: any settle error stored by a previous
      // generation no longer applies to this one
      match._nonReactive.error = undefined
      match._nonReactive.loaderPromise = createControlledPromise<void>()
      loaderBucket = match._nonReactive
      loaderGeneration = loaderBucket.loaderPromise
      if (preload !== match.preload) {
        patchMatch(inner, matchId, {
          preload,
        })
      }

      await runLoaderPhase(preload, prevMatch, previousRouteMatchId, match)
    }
  }

  let match = inner.router.getMatch(matchId)
  if (!match) {
    return inner.matches[index]!
  }
  if (loaderGeneration && loaderBucket?.loaderPromise !== loaderGeneration) {
    return inner.matches[index]!
  }

  clearTimeout(match._nonReactive.pendingTimeout)
  match._nonReactive.pendingTimeout = undefined
  match._nonReactive.dehydrated = undefined

  const nextIsFetching = loaderIsRunningAsync ? match.isFetching : false
  if (nextIsFetching !== match.isFetching || match.invalid !== false) {
    patchMatch(inner, matchId, {
      isFetching: nextIsFetching,
      invalid: false,
    })
    match = inner.router.getMatch(matchId)!
  }

  if (!loaderIsRunningAsync) {
    settleLoadPromises(match)
  }

  return match
}

export async function loadMatches(arg: {
  router: AnyRouter
  location: ParsedLocation
  matches: Array<AnyRouteMatch>
  preload?: boolean
  preloadMatchIds?: Set<string>
  forceStaleReload?: boolean
  onReady?: () => Promise<void>
  updateMatch: UpdateMatchFn
  sync?: boolean
}): Promise<Array<MakeRouteMatch>> {
  const inner: InnerLoadContext = arg
  const matchPromises: Array<Promise<AnyRouteMatch>> = []

  // make sure the pending component is immediately rendered when hydrating a match that is not SSRed
  // the pending component was already rendered on the server and we want to keep it shown on the client until minPendingMs is reached
  if (
    !(isServer ?? inner.router.isServer) &&
    inner.router.stores.matchesId
      .get()
      .some(
        (matchId) =>
          inner.router.stores.matchStores.get(matchId)?.get()._forcePending,
      )
  ) {
    triggerOnReady(inner)
  }

  let beforeLoadNotFound: NotFoundError | undefined

  // Execute all beforeLoads one by one
  for (let i = 0; i < inner.matches.length; i++) {
    try {
      const beforeLoad = handleBeforeLoad(inner, i)
      if (isPromise(beforeLoad)) await beforeLoad
    } catch (err) {
      if (isRedirect(err)) {
        throw err
      }
      if (isNotFound(err)) {
        beforeLoadNotFound = err
      } else {
        if (!inner.preload) throw err
      }
      break
    }

    if (inner.serialError || inner.firstBadMatchIndex != null) {
      break
    }
  }

  // Execute loaders once, with max index adapted for beforeLoad notFound handling.
  const baseMaxIndexExclusive = inner.firstBadMatchIndex ?? inner.matches.length

  const boundaryIndex =
    beforeLoadNotFound && !inner.preload
      ? getNotFoundBoundaryIndex(inner, beforeLoadNotFound)
      : undefined

  const maxIndexExclusive =
    beforeLoadNotFound && inner.preload
      ? 0
      : boundaryIndex !== undefined
        ? Math.min(boundaryIndex + 1, baseMaxIndexExclusive)
        : baseMaxIndexExclusive

  let firstNotFound: NotFoundError | undefined
  let firstUnhandledRejection: unknown

  for (let i = 0; i < maxIndexExclusive; i++) {
    matchPromises.push(loadRouteMatch(inner, matchPromises, i))
  }

  try {
    await Promise.all(matchPromises)
  } catch {
    const settled = await Promise.allSettled(matchPromises)

    for (const result of settled) {
      if (result.status !== 'rejected') continue

      const reason = result.reason
      if (isRedirect(reason)) {
        throw reason
      }
      if (isNotFound(reason)) {
        firstNotFound ??= reason
      } else {
        firstUnhandledRejection ??= reason
      }
    }

    if (firstUnhandledRejection !== undefined) {
      throw firstUnhandledRejection
    }
  }

  if (beforeLoadNotFound && inner.preload) {
    return inner.matches
  }

  const notFoundToThrow = firstNotFound ?? beforeLoadNotFound

  let headMaxIndex = inner.firstBadMatchIndex ?? inner.matches.length - 1

  if (notFoundToThrow) {
    // Determine once which matched route will actually render the
    // notFoundComponent, then pass this precomputed index through the remaining
    // finalization steps.
    // This can differ from the throwing route when routeId targets an ancestor
    // boundary (or when bubbling resolves to a parent/root boundary).
    const renderedBoundaryIndex = getNotFoundBoundaryIndex(
      inner,
      notFoundToThrow,
    )

    if (renderedBoundaryIndex === undefined) {
      if (process.env.NODE_ENV !== 'production') {
        throw new Error(
          'Invariant failed: Could not find match for notFound boundary',
        )
      }

      invariant()
    }
    const boundaryMatch = inner.matches[renderedBoundaryIndex]!

    const boundaryRoute = inner.router.looseRoutesById[boundaryMatch.routeId]!
    const defaultNotFoundComponent = (inner.router.options as any)
      .defaultNotFoundComponent

    // Ensure a notFoundComponent exists on the boundary route
    if (!boundaryRoute.options.notFoundComponent && defaultNotFoundComponent) {
      boundaryRoute.options.notFoundComponent = defaultNotFoundComponent
    }

    notFoundToThrow.routeId = boundaryMatch.routeId

    commitMatch(
      inner,
      boundaryMatch.id,
      renderedBoundaryIndex,
      boundaryMatch.routeId === rootRouteId
        ? // For root boundary, use globalNotFound so the root component's
          // shell still renders and <Outlet> handles the not-found display,
          // instead of replacing the entire root shell via status='notFound'.
          {
            status: 'success' as const,
            globalNotFound: true,
            error: undefined,
            isFetching: false,
            _forcePending: undefined,
          }
        : // For non-root boundaries, set status:'notFound' so MatchInner
          // renders the notFoundComponent directly.
          {
            status: 'notFound' as const,
            error: notFoundToThrow,
            isFetching: false,
            _forcePending: undefined,
          },
    )

    headMaxIndex = renderedBoundaryIndex

    // Ensure the rendering boundary route chunk (and its lazy components, including
    // lazy notFoundComponent) is loaded before we continue to head execution/render.
    await loadRouteChunk(boundaryRoute, ['notFoundComponent'])
  }

  // When a serial error occurred (e.g. beforeLoad threw a regular Error),
  // the erroring route's lazy chunk wasn't loaded because loaders were skipped.
  // We need to load it so the code-split errorComponent is available for rendering.
  if (inner.serialError && inner.firstBadMatchIndex !== undefined) {
    const errorRoute =
      inner.router.looseRoutesById[
        inner.matches[inner.firstBadMatchIndex]!.routeId
      ]!
    await loadRouteChunk(errorRoute, ['errorComponent'])
  }

  // serially execute heads once after loaders/notFound handling, ensuring
  // all head functions get a chance even if one throws.
  for (let i = 0; i <= headMaxIndex; i++) {
    const match = inner.matches[i]!
    const { id: matchId, routeId } = match
    const route = inner.router.looseRoutesById[routeId]!
    const routeOptions = route.options
    try {
      const headMatch =
        inner.router.getMatch(matchId) ?? (inner.preload && match)
      if (
        headMatch &&
        (routeOptions.head || routeOptions.scripts || routeOptions.headers)
      ) {
        const assetContext = {
          ssr: inner.router.options.ssr,
          matches: inner.matches,
          match: headMatch,
          params: headMatch.params,
          loaderData: headMatch.loaderData,
        }

        const [headFnContent, scripts, headers] = await Promise.all([
          routeOptions.head?.(assetContext),
          routeOptions.scripts?.(assetContext),
          routeOptions.headers?.(assetContext),
        ])
        patchMatch(inner, matchId, {
          meta: headFnContent?.meta,
          links: headFnContent?.links,
          headScripts: headFnContent?.scripts,
          headers,
          scripts,
          styles: headFnContent?.styles,
        })
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error(`Error executing head for route ${routeId}:`, err)
      }
    }
  }

  const readyPromise = triggerOnReady(inner)
  if (isPromise(readyPromise)) {
    await readyPromise
  }

  if (notFoundToThrow) {
    throw notFoundToThrow
  }

  if (inner.serialError && !inner.onReady) {
    throw inner.serialError
  }

  return inner.matches
}

export type RouteComponentType =
  | 'component'
  | 'errorComponent'
  | 'pendingComponent'
  | 'notFoundComponent'

function preloadRouteComponents(
  route: AnyRoute,
  componentTypesToLoad: Array<RouteComponentType>,
): Promise<void> | undefined {
  let preloads: Array<Promise<void>> | undefined
  for (const type of componentTypesToLoad) {
    const preload = (route.options[type] as any)?.preload?.()
    if (preload) {
      preloads ||= []
      preloads.push(preload)
    }
  }

  if (!preloads) return undefined

  return Promise.all(preloads) as any as Promise<void>
}

export function loadRouteChunk(
  route: AnyRoute,
  componentTypesToLoad: Array<RouteComponentType> = componentTypes,
) {
  if (!route._lazyLoaded && route._lazyPromise === undefined) {
    if (route.lazyFn) {
      route._lazyPromise = route.lazyFn().then((lazyRoute) => {
        // explicitly don't copy over the lazy route's id
        const { id: _id, ...options } = lazyRoute.options
        Object.assign(route.options, options)
        route._lazyLoaded = true
        route._lazyPromise = undefined // gc promise, we won't need it anymore
      })
    } else {
      route._lazyLoaded = true
    }
  }

  const runAfterLazy = () => {
    if (route._componentsLoaded) {
      return
    }
    if (componentTypesToLoad !== componentTypes) {
      return preloadRouteComponents(route, componentTypesToLoad)
    }
    if (route._componentsPromise === undefined) {
      const componentsPromise = preloadRouteComponents(route, componentTypes)

      if (componentsPromise) {
        route._componentsPromise = componentsPromise.then(() => {
          route._componentsLoaded = true
          route._componentsPromise = undefined // gc promise, we won't need it anymore
        })
      } else {
        route._componentsLoaded = true
      }
    }
    return route._componentsPromise
  }

  return route._lazyPromise
    ? route._lazyPromise.then(runAfterLazy)
    : runAfterLazy()
}

function makeMaybe<TValue, TError>(
  value: TValue,
  error: TError,
): { status: 'success'; value: TValue } | { status: 'error'; error: TError } {
  if (error) {
    return { status: 'error' as const, error }
  }
  return { status: 'success' as const, value }
}

export function routeNeedsPreload(route: AnyRoute) {
  for (const componentType of componentTypes) {
    if ((route.options[componentType] as any)?.preload) {
      return true
    }
  }
  return false
}

export const componentTypes: Array<RouteComponentType> = [
  'component',
  'errorComponent',
  'pendingComponent',
  'notFoundComponent',
] as const
