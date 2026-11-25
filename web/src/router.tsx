import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createBrowserHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouterHistory,
} from "@tanstack/react-router";

import { createQueryClient } from "./api/queryClient";
import { validatePhoneSearch } from "./phone/phoneSearch";

// Every screen is loaded lazily, so each route's code is its own chunk: a
// Phone downloads only the Phone code. Keep this file free of static imports
// from `stage/`, `admin/` or `bridge/` (the code-split test checks it).

/** What every route's loaders get: the query client, to prefetch with. */
export interface RouterContext {
  queryClient: QueryClient;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

/** `/`: the Phone screens. `/?join=<code>` is the join QR code's link. */
const phoneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: validatePhoneSearch,
  component: lazyRouteComponent(
    () => import("./phone/PhoneScreen"),
    "PhoneScreen",
  ),
});

/** `/stage`: the Stage. */
const stageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stage",
  component: lazyRouteComponent(
    () => import("./stage/StageScreen"),
    "StageScreen",
  ),
});

/**
 * `/stage/playback?song=<id>`: the playback check page that plays a Library
 * Song with no Party and shows its Song time (#155); a debug page beside the
 * sing scene (#164).
 */
const playbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/stage/playback",
  validateSearch: (search: Record<string, unknown>) => {
    const song = Number(search["song"]);
    return { song: Number.isInteger(song) ? song : undefined };
  },
  component: lazyRouteComponent(
    () => import("./stage/playback/PlaybackCheck"),
    "PlaybackCheck",
  ),
});

/** `/bridge`: the Mic bridge install page. The server's own files under `/bridge/` are not the app's. */
const bridgeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/bridge",
  component: lazyRouteComponent(
    () => import("./bridge/BridgeScreen"),
    "BridgeScreen",
  ),
});

/** `/admin`: the Admin area, with its four sections as child routes. */
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: lazyRouteComponent(() => import("./admin/AdminArea"), "AdminArea"),
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./admin/AdminHome"), "AdminHome"),
});

const downloadsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/downloads",
  component: lazyRouteComponent(() => import("./admin/Downloads"), "Downloads"),
});

const songsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/songs",
  component: lazyRouteComponent(() => import("./admin/Songs"), "Songs"),
});

const libraryProblemsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/library-problems",
  component: lazyRouteComponent(
    () => import("./admin/LibraryProblems"),
    "LibraryProblems",
  ),
});

const profilesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/profiles",
  component: lazyRouteComponent(() => import("./admin/Profiles"), "Profiles"),
});

const routeTree = rootRoute.addChildren([
  phoneRoute,
  stageRoute,
  playbackRoute,
  bridgeRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    downloadsRoute,
    songsRoute,
    libraryProblemsRoute,
    profilesRoute,
  ]),
]);

/**
 * The app's router; tests pass a memory history. Every route renders inside
 * `queryClient`'s provider, so any screen can `useQuery`.
 */
export function createAppRouter(
  history: RouterHistory = createBrowserHistory(),
  queryClient: QueryClient = createQueryClient(),
) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    Wrap: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
