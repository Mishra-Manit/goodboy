/** Shell: floating nav pill + centered single-column content. */

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useHideOnScrollDown } from "@dashboard/hooks/use-hide-on-scroll";
import { NavStateContext, useNavState } from "@dashboard/hooks/use-nav-state";
import { cn } from "@dashboard/lib/utils";

const NAV_ITEMS = [
  { to: "/", label: "Tasks" },
  { to: "/prs", label: "PRs" },
  { to: "/repos", label: "Repos" },
  { to: "/memory", label: "Memory" },
] as const;

export function Layout() {
  const { hidden, setHidden } = useHideOnScrollDown();
  return (
    <NavStateContext.Provider value={{ hidden, setHidden }}>
    <div className="grain min-h-screen">
      <nav
        className={cn(
          "fixed top-5 left-1/2 z-50 -translate-x-1/2 transition-all duration-300 ease-out",
          hidden ? "pointer-events-none -translate-y-[calc(100%+24px)] opacity-0" : "opacity-100",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1 rounded-full px-1.5 py-1.5",
            "bg-glass border border-glass-border backdrop-blur-xl nav-shadow",
          )}
        >
          <Brand />
          <div className="h-4 w-px bg-glass-border" />
          <div className="flex items-center gap-0.5 px-1">
            {NAV_ITEMS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={({ isActive }) =>
                  cn(
                    "rounded-full px-3.5 py-1 font-body text-[12px] transition-all duration-200",
                    isActive
                      ? "bg-nav-active text-text font-medium"
                      : "text-text-dim hover:text-text-secondary",
                  )
                }
              >
                {label}
              </NavLink>
            ))}
          </div>
        </div>
      </nav>

      <Main />
    </div>
    </NavStateContext.Provider>
  );
}

// --- Helpers ---

/** Wide canvas on the PR review page; editorial column elsewhere. */
function Main() {
  const { pathname } = useLocation();
  const { hidden } = useNavState();
  const wide = /^\/prs\/[^/]+\/review$/.test(pathname) || /^\/tasks\/[^/]+\/review$/.test(pathname);

  if (wide) {
    return (
      <main
        className={cn(
          "mx-auto flex h-dvh flex-col px-5 transition-[padding] duration-300 ease-out",
          "max-w-[1600px] pb-0",
          hidden ? "pt-2" : "pt-14",
        )}
      >
        <Outlet />
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-[680px] px-5 pt-24 pb-24">
      <Outlet />
    </main>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 pl-3 pr-4">
      <div className="relative flex h-5 w-5 items-center justify-center">
        <span className="font-display text-[11px] font-bold text-accent">G</span>
        <div className="absolute -top-px -right-px h-1.5 w-1.5 rounded-full bg-ok" />
      </div>
    </div>
  );
}
