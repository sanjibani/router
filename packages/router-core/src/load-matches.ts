import { isServer } from '@tanstack/router-core/isServer'
import { createControlledPromise, isPromise } from './utils'
import { isNotFound } from './not-found'
import { rootRouteId } from './root'
import { isRedirect } from './redirect'
import type { ControlledPromise } from './utils'
import type { NotFoundError } from './not-found'
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
  updateMatch: UpdateMatchFn
  matches: Array<AnyRouteMatch>
  /** Set only for preload passes. Contains active ids this preload must join, not mutate. */
  preload?: Set<string>
  cancel?: ControlledPromise<InnerLoadContext>
  forceStaleReload?: boolean
  onReady?: (matches: Array<AnyRouteMatch>) => Promise<void>
  sync?: boolean
}

const triggerOnReady = (inner: InnerLoadContext): void | Promise<void> => {
  if (!inner.rendered) {
    inner.rendered = true
    return inner.onReady?.(inner.matches)
  }
}

const isPreloadMatch = (inner: InnerLoadContext, matchId: string): boolean => {
  return !!inner.preload && !isJoinedPreload(inner, matchId)
}

const isJoinedPreload = (inner: InnerLoadContext, matchId: string): boolean => {
  return !!inner.preload?.has(matchId)
}

const joinPreloadedActiveMatch = async (
  inner: InnerLoadContext,
  index: number,
  waitForLoader: boolean,
): Promise<AnyRouteMatch> => {
  const matchId = inner.matches[index]!.id
  const cancelJoinedPreload = (): void => {
    inner.router.clearCache({
      filter: (match) => inner.matches.includes(match),
    })
    inner.cancel?.resolve(inner)
  }
  const throwCancelledPreload = (): never => {
    cancelJoinedPreload()
    throw inner
  }
  const cancelIfOwnerMissing = () => {
    if (!inner.router.getMatch(matchId, 'live')) {
      cancelJoinedPreload()
    }
  }

  let match = inner.router.getMatch(matchId, 'live') ?? throwCancelledPreload()
  const route = inner.router.looseRoutesById[match.routeId]!

  const beforeLoadPromise =
    match._nonReactive.beforeLoadPromise ||
    (route.options.beforeLoad &&
    match.status === 'pending' &&
    match.fetchCount === 0
      ? match._nonReactive.loadPromise
      : undefined)
  if (beforeLoadPromise?.status === 'pending') {
    await beforeLoadPromise
    match = inner.router.getMatch(matchId, 'live') ?? throwCancelledPreload()
  }

  inner.matches[index] = match
  let error = match._nonReactive.error || match.error

  if (!error && waitForLoader && match.status === 'pending') {
    const loaderPromise =
      match._nonReactive.loaderPromise || match._nonReactive.loadPromise
    if (loaderPromise?.status === 'pending') {
      await loaderPromise
      match = inner.router.getMatch(matchId, 'live') ?? throwCancelledPreload()
    }
    inner.matches[index] = match
    error = match._nonReactive.error || match.error
  } else if (!waitForLoader && match.status === 'pending') {
    const loaderPromise =
      match._nonReactive.loaderPromise || match._nonReactive.loadPromise
    if (loaderPromise?.status === 'pending') {
      inner.cancel ??= createControlledPromise<InnerLoadContext>()
      loaderPromise.then(cancelIfOwnerMissing, cancelIfOwnerMissing)
    }
  }

  handleRedirectOrNotFound(inner, match, error)
  if (match.status === 'error' || match.status === 'notFound') {
    inner.firstBadMatchIndex ??= index
    throw error
  }

  return match
}

/**
 * Builds the accumulated context from router options and all matches up to the given index.
 * Merges __routeContext and __beforeLoadContext from each match.
 */
const buildMatchContext = (
  inner: InnerLoadContext,
  index: number,
): Record<string, unknown> => {
  const context: Record<string, unknown> = Object.assign(
    {},
    inner.router.options.context,
  )
  for (let i = 0; i <= index; i++) {
    const match = inner.matches[i]!
    Object.assign(context, match.__routeContext, match.__beforeLoadContext)
  }
  return context
}

const commitMatch = (
  inner: InnerLoadContext,
  matchId: string,
  patch: Partial<AnyRouteMatch>,
): void => {
  if (isJoinedPreload(inner, matchId)) {
    return
  }

  inner.updateMatch(matchId, (prev) => ({
    ...prev,
    ...patch,
  }))
  const match = inner.router.getMatch(matchId)
  if (match) {
    inner.matches[match.index] = match
  }
}

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
): number => {
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

const handleRedirectOrNotFound = (
  inner: InnerLoadContext,
  match: AnyRouteMatch,
  err: unknown,
): void => {
  if (isRedirect(err)) {
    if (err.redirectHandled && !err.options.reloadDocument) {
      throw err
    }
    if (isJoinedPreload(inner, match.id)) {
      throw err
    }

    match._nonReactive.error = err

    if (
      inner.preload ||
      inner.router.stores.cachedMatchStores.get(match.id)?.get() === match
    ) {
      clearMatchPromises(match)
      inner.router.clearCache({ filter: (d) => d.id === match.id })
    } else {
      // A redirect is not renderable navigation state. Keep the current
      // renderable status (pending or success) until the redirect target
      // commits, but clear fetching state.
      clearPending(match)
      settleBeforeLoadPromise(match)
      settleLoaderPromise(match)
      commitMatch(inner, match.id, {
        isFetching: false as const,
      })
    }

    inner.rendered = true
    err.options._fromLocation = inner.location
    err.redirectHandled = true
    throw inner.router.resolveRedirect(err)
  }

  if (isNotFound(err)) {
    if (isJoinedPreload(inner, match.id)) {
      throw err
    }

    match._nonReactive.error = err
    clearMatchPromises(match)

    if (!err.routeId) {
      // Stamp the throwing match's routeId so that the finalization step in
      // loadMatches knows where the notFound originated. The actual boundary
      // resolution is deferred until firstBadMatchIndex is stable.
      err.routeId = match.routeId
    }

    commitMatch(inner, match.id, {
      status: 'notFound',
      error: err,
      isFetching: false,
      _forcePending: undefined,
    })

    throw err
  }
}

const shouldSkipMatchLoad = (
  inner: InnerLoadContext,
  match: AnyRouteMatch,
): boolean => {
  if (isServer ?? inner.router.isServer) {
    return match.ssr === false
  }

  // upon hydration, we skip the loader if the match has been dehydrated on the server
  return !!match._nonReactive.dehydrated
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

  const currentMatch = inner.router.getMatch(matchId)!
  currentMatch.__beforeLoadContext = undefined

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
  commitMatch(inner, matchId, {
    __beforeLoadContext: undefined,
    error: err,
    status: 'error',
    isFetching: false,
    _forcePending: undefined,
    context: buildMatchContext(inner, index),
    updatedAt: Date.now(),
    abortController: new AbortController(),
  })

  const updatedMatch = inner.router.getMatch(matchId)
  if (updatedMatch) {
    clearMatchPromises(updatedMatch)
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
    !isPreloadMatch(inner, matchId) &&
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

  const serialError = match.paramsError || match.searchError
  if (serialError) {
    handleSerialError(inner, index, serialError)
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
    const currentMatch = inner.router.getMatch(matchId)!
    commitMatch(inner, matchId, {
      isFetching: 'beforeLoad',
      fetchCount: currentMatch.fetchCount + 1,
      abortController,
      // Note: We intentionally don't update context here.
      // Context should only be updated after beforeLoad resolves to avoid
      // components seeing incomplete context during async beforeLoad execution.
    })
  }

  const commitBeforeLoad = (beforeLoadContext: any) => {
    inner.router.batch(() => {
      pending()
      inner.matches[index]!.__beforeLoadContext = beforeLoadContext
      commitMatch(inner, matchId, {
        isFetching: false as const,
        __beforeLoadContext: beforeLoadContext,
        context: buildMatchContext(inner, index),
      })
    })
    settleBeforeLoadPromise(match)
  }

  // if there is no `beforeLoad` option, just mark as pending and resolve.
  // The undefined beforeLoad context is still committed here to clear any
  // stale context from a previous load generation of the same match.
  if (!beforeLoad) {
    commitBeforeLoad(undefined)
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

    commitBeforeLoad(beforeLoadContext)
  }

  match._nonReactive.beforeLoadPromise = beforeLoadPromise

  // Build context from all parent matches, excluding current match's __beforeLoadContext
  // (since we're about to execute beforeLoad for this match)
  const context = Object.assign(
    buildMatchContext(inner, index - 1),
    match.__routeContext,
  )
  const { search, params, cause } = match
  const preload = isPreloadMatch(inner, matchId)
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
    navigate: (opts: any) =>
      inner.router.navigate({
        ...opts,
        _fromLocation: inner.location,
      }),
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
): void | Promise<unknown> => {
  const { id: matchId, routeId } = inner.matches[index]!
  const route = inner.router.looseRoutesById[routeId]!

  if (isJoinedPreload(inner, matchId)) {
    return joinPreloadedActiveMatch(inner, index, false)
  }

  const queueExecution = () => {
    const existingMatch = inner.router.getMatch(matchId)
    if (!existingMatch || shouldSkipMatchLoad(inner, existingMatch)) {
      return
    }

    // If we are in the middle of a load, either of these will be present
    // (not to be confused with `loadPromise`, which is always defined)
    const pendingBeforeLoad = existingMatch._nonReactive.beforeLoadPromise
    if (pendingBeforeLoad) {
      setupPendingTimeout(inner, matchId, route, existingMatch)
      return pendingBeforeLoad.then(() => {
        const match = inner.router.getMatch(matchId)
        if (!match || shouldSkipMatchLoad(inner, match)) {
          return
        }

        return executeBeforeLoad(inner, matchId, index, route)
      })
    }

    if (existingMatch._nonReactive.loaderPromise) {
      setupPendingTimeout(inner, matchId, route, existingMatch)
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

  const preload = isPreloadMatch(inner, matchId)

  return {
    params,
    deps: loaderDeps,
    preload,
    parentMatchPromise,
    abortController,
    context,
    location: inner.location,
    navigate: (opts: any) =>
      inner.router.navigate({
        ...opts,
        _fromLocation: inner.location,
      }),
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
  // If the Matches component rendered the pending component and needs to show
  // it for a minimum duration, we'll wait for it to resolve before committing
  // to the match and resolving the loadPromise.
  const match = inner.router.getMatch(matchId)!
  const loaderBucket = match._nonReactive
  const loaderPromise = loaderBucket.loaderPromise
  const isCurrentLoader = () => loaderBucket.loaderPromise === loaderPromise
  const getCurrentMatch = () =>
    isCurrentLoader() ? inner.router.getMatch(matchId) : undefined

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

    if (
      loaderResultIsPromise ||
      route._lazyPromise ||
      route._componentsPromise ||
      route.options.head ||
      route.options.scripts ||
      route.options.headers ||
      loaderBucket.minPendingPromise
    ) {
      commitMatch(inner, matchId, {
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
        commitMatch(inner, matchId, {
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
    commitMatch(inner, matchId, {
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
      const currentMatch = getCurrentMatch()
      if (!currentMatch) {
        return
      }
      // a softly aborted pending match keeps its previous data and is
      // committed as success
      commitMatch(inner, matchId, {
        status:
          currentMatch.status === 'pending' ? 'success' : currentMatch.status,
        isFetching: false,
      })
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
    inner.firstBadMatchIndex ??= index

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

    commitMatch(inner, matchId, {
      error,
      status: 'error',
      isFetching: false,
    })
  }
}

const loadRouteMatch = async (
  inner: InnerLoadContext,
  matchPromises: Array<Promise<AnyRouteMatch>>,
  index: number,
): Promise<AnyRouteMatch> => {
  const { id: matchId, routeId } = inner.matches[index]!
  const route = inner.router.looseRoutesById[routeId]!
  // becomes true when this pass leaves the loader running detached in the
  // background, in which case finalization is deferred to that detached run
  let loaderIsRunningAsync = false
  let loaderGeneration: AnyRouteMatch['_nonReactive']['loaderPromise']
  let matchToLoad: AnyRouteMatch | undefined

  if (isJoinedPreload(inner, matchId)) {
    return await joinPreloadedActiveMatch(inner, index, true)
  }

  const prevMatch = inner.router.getMatch(matchId)
  if (!prevMatch) {
    // in case of a redirecting match during preload, the match does not exist
    return inner.matches[index]!
  }

  if (shouldSkipMatchLoad(inner, prevMatch)) {
    // the beforeLoad phase (and with it the context commit) does not run for
    // skipped matches, so commit the merged route context here
    commitMatch(inner, matchId, {
      invalid: false,
      context: buildMatchContext(inner, index),
    })

    if (isServer ?? inner.router.isServer) {
      return inner.router.getMatch(matchId)!
    }
  } else {
    const routeLoader = route.options.loader
    const shouldReloadInBackground =
      ((typeof routeLoader === 'function'
        ? undefined
        : routeLoader?.staleReloadMode) ??
        inner.router.options.defaultStaleReloadMode) !== 'blocking'
    const preload = isPreloadMatch(inner, matchId)

    // there is a loaderPromise, so we are in the middle of a load
    if (prevMatch._nonReactive.loaderPromise) {
      loaderGeneration = prevMatch._nonReactive.loaderPromise
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
          commitMatch(inner, matchId, {
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

        matchToLoad = match.status === 'pending' ? match : undefined
      }
    } else {
      const match = prevMatch
      // a new load generation starts: any settle error stored by a previous
      // generation no longer applies to this one
      match._nonReactive.error = undefined
      match._nonReactive.loaderPromise = createControlledPromise<void>()
      loaderGeneration = match._nonReactive.loaderPromise
      if (preload !== match.preload) {
        commitMatch(inner, matchId, {
          preload,
        })
      }

      matchToLoad = match
    }

    if (matchToLoad && !(preload && route.options.preload === false)) {
      const { status, invalid } = matchToLoad
      let loaderShouldRun = status !== 'success'

      if (!loaderShouldRun) {
        const activeIdAtIndex = inner.router.stores.matchesId.get()[index]
        const activeAtIndex =
          (activeIdAtIndex &&
            inner.router.stores.matchStores.get(activeIdAtIndex)) ||
          null
        const previousRouteMatchId =
          activeAtIndex?.routeId === routeId
            ? activeIdAtIndex
            : inner.router.stores.matches
                .get()
                .find((d) => d.routeId === routeId)?.id
        const age = Date.now() - prevMatch.updatedAt
        const staleAge = preload
          ? (route.options.preloadStaleTime ??
            inner.router.options.defaultPreloadStaleTime ??
            30_000) // 30 seconds for preloads by default
          : (route.options.staleTime ??
            inner.router.options.defaultStaleTime ??
            0)
        const shouldReloadOption = route.options.shouldReload
        const shouldReload =
          typeof shouldReloadOption === 'function'
            ? shouldReloadOption(
                getLoaderContext(inner, matchPromises, matchId, index, route),
              )
            : shouldReloadOption
        const staleMatchShouldReload =
          age >= staleAge &&
          (!!inner.forceStaleReload ||
            matchToLoad.cause === 'enter' ||
            (previousRouteMatchId !== undefined &&
              previousRouteMatchId !== matchToLoad.id))

        loaderShouldRun = invalid || (shouldReload ?? staleMatchShouldReload)
      }

      if (
        loaderShouldRun &&
        status === 'success' &&
        !inner.sync &&
        shouldReloadInBackground
      ) {
        // stale-while-revalidate: leave the loader running detached
        loaderIsRunningAsync = true
        const backgroundGeneration = matchToLoad._nonReactive.loaderPromise
        if (matchToLoad.invalid !== false) {
          commitMatch(inner, matchId, { invalid: false })
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
      } else if (loaderShouldRun) {
        const run = runLoader(inner, matchPromises, matchId, index, route)
        await (preload && loaderGeneration
          ? Promise.race([run, loaderGeneration])
          : run)
      }
    }
  }

  let match = inner.router.getMatch(matchId)
  if (!match) {
    return inner.matches[index]!
  }
  if (
    loaderGeneration &&
    match._nonReactive.loaderPromise &&
    match._nonReactive.loaderPromise !== loaderGeneration
  ) {
    return inner.matches[index]!
  }

  clearTimeout(match._nonReactive.pendingTimeout)
  match._nonReactive.pendingTimeout = undefined
  match._nonReactive.dehydrated = undefined

  const nextIsFetching = loaderIsRunningAsync ? match.isFetching : false
  if (nextIsFetching !== match.isFetching || match.invalid !== false) {
    commitMatch(inner, matchId, {
      isFetching: nextIsFetching,
      invalid: false,
    })
    match = inner.router.getMatch(matchId)!
  }

  if (!loaderIsRunningAsync) {
    settleLoadPromises(match)
  }

  return (inner.matches[index] = match)
}

export async function loadMatches(arg: {
  router: AnyRouter
  location: ParsedLocation
  matches: Array<AnyRouteMatch>
  preload?: Set<string>
  forceStaleReload?: boolean
  onReady?: (matches: Array<AnyRouteMatch>) => Promise<void>
  updateMatch: UpdateMatchFn
  sync?: boolean
}): Promise<Array<MakeRouteMatch>> {
  const inner: InnerLoadContext = arg
  const matchPromises: Array<Promise<AnyRouteMatch>> = []

  // make sure the pending component is immediately rendered when hydrating a match that is not SSRed
  // the pending component was already rendered on the server and we want to keep it shown on the client until minPendingMs is reached
  if (
    !(isServer ?? inner.router.isServer) &&
    inner.router.stores.matches.get().some((match) => match._forcePending)
  ) {
    triggerOnReady(inner)
  }

  let beforeLoadNotFound: NotFoundError | undefined

  // Execute all beforeLoads one by one
  for (let i = 0; i < inner.matches.length; i++) {
    try {
      const beforeLoad = handleBeforeLoad(inner, i)
      if (isPromise(beforeLoad)) {
        const result = await (inner.cancel
          ? Promise.race([beforeLoad, inner.cancel])
          : beforeLoad)
        if (result === inner) {
          return inner.matches
        }
      }
    } catch (err) {
      if (err === inner) {
        return inner.matches
      }
      if (isNotFound(err)) {
        beforeLoadNotFound = err
      } else if (isRedirect(err) || !inner.preload) {
        throw err
      }
      break
    }

    if (inner.firstBadMatchIndex != null) {
      break
    }
  }

  // Execute loaders once, with max index adapted for beforeLoad notFound handling.
  const baseMaxIndexExclusive = inner.firstBadMatchIndex ?? inner.matches.length
  const maxIndexExclusive = beforeLoadNotFound
    ? Math.min(
        getNotFoundBoundaryIndex(inner, beforeLoadNotFound) + 1,
        baseMaxIndexExclusive,
      )
    : baseMaxIndexExclusive

  let firstNotFound: NotFoundError | undefined

  for (let i = 0; i < maxIndexExclusive; i++) {
    matchPromises.push(loadRouteMatch(inner, matchPromises, i))
  }

  let settled: Array<PromiseSettledResult<AnyRouteMatch>> | undefined
  if (inner.preload) {
    settled = await Promise.allSettled(matchPromises)
  } else {
    try {
      await Promise.all(matchPromises)
    } catch {
      settled = await Promise.allSettled(matchPromises)
    }
  }

  if (settled) {
    if (
      inner.preload &&
      settled.some(
        (result) => result.status === 'rejected' && result.reason === inner,
      )
    ) {
      return inner.matches
    }

    let firstUnhandledRejection: unknown

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

  const notFoundToThrow = firstNotFound ?? beforeLoadNotFound
  let headMatches = inner.matches

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

    const boundaryMatch = inner.matches[renderedBoundaryIndex]!

    const boundaryRoute = inner.router.looseRoutesById[boundaryMatch.routeId]!
    const defaultNotFoundComponent = (inner.router.options as any)
      .defaultNotFoundComponent

    // Ensure a notFoundComponent exists on the boundary route
    if (!boundaryRoute.options.notFoundComponent && defaultNotFoundComponent) {
      boundaryRoute.options.notFoundComponent = defaultNotFoundComponent
    }

    notFoundToThrow.routeId = boundaryMatch.routeId
    const context = buildMatchContext(inner, renderedBoundaryIndex)

    commitMatch(
      inner,
      boundaryMatch.id,
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
            context,
          }
        : // For non-root boundaries, set status:'notFound' so MatchInner
          // renders the notFoundComponent directly.
          {
            status: 'notFound' as const,
            error: notFoundToThrow,
            isFetching: false,
            _forcePending: undefined,
            context,
          },
    )

    headMatches = inner.matches.slice(0, renderedBoundaryIndex + 1)

    // Ensure the rendering boundary route chunk (and its lazy components, including
    // lazy notFoundComponent) is loaded before we continue to head execution/render.
    await loadRouteChunk(boundaryRoute, ['notFoundComponent'])
  } else if (inner.firstBadMatchIndex !== undefined) {
    // When a serial error occurred (e.g. beforeLoad threw a regular Error),
    // the erroring route's lazy chunk wasn't loaded because loaders were skipped.
    // We need to load it so the code-split errorComponent is available for rendering.
    if (!inner.preload) {
      const errorRoute =
        inner.router.looseRoutesById[
          inner.matches[inner.firstBadMatchIndex]!.routeId
        ]!
      await loadRouteChunk(errorRoute, ['errorComponent'])
    }

    for (const match of inner.matches.splice(inner.firstBadMatchIndex + 1)) {
      clearMatchPromises(match)
    }
  }

  // serially execute heads once after loaders/notFound handling, ensuring
  // all head functions get a chance even if one throws.
  for (const match of headMatches) {
    const { id: matchId, routeId } = match
    const routeOptions = inner.router.looseRoutesById[routeId]!.options
    if (isJoinedPreload(inner, matchId)) {
      continue
    }
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
        commitMatch(inner, matchId, {
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

  if (
    !inner.preload &&
    !inner.onReady &&
    inner.firstBadMatchIndex !== undefined
  ) {
    const errorMatch =
      inner.router.getMatch(inner.matches[inner.firstBadMatchIndex]!.id) ??
      inner.matches[inner.firstBadMatchIndex]!
    if (errorMatch.status === 'error') {
      throw errorMatch.error
    }
  }

  return inner.matches
}

type RouteComponentType =
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
  return componentTypes.some(
    (componentType) => (route.options[componentType] as any)?.preload,
  )
}

const componentTypes: Array<RouteComponentType> = [
  'component',
  'errorComponent',
  'pendingComponent',
  'notFoundComponent',
] as const
