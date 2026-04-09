import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@dashboard/lib/utils";
import {
  ListTodo,
  History,
  GitPullRequest,
  FolderGit2,
  Activity,
} from "lucide-react";

const NAV_ITEMS = [
  { to: "/", icon: ListTodo, label: "Active" },
  { to: "/history", icon: History, label: "History" },
  { to: "/prs", icon: GitPullRequest, label: "Pull Requests" },
  { to: "/repos", icon: FolderGit2, label: "Repos" },
];

export function Layout() {
  return (
    <div className="flex h-screen bg-zinc-950">
      {/* Sidebar */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800/60">
        {/* Logo */}
        <div className="flex h-14 items-center gap-2.5 px-4">
          <div className="relative h-8 w-8 rounded-lg bg-gradient-to-br from-violet-500 to-violet-700 flex items-center justify-center text-sm font-bold text-white shadow-lg shadow-violet-500/20">
            G
            <div className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 border-2 border-zinc-950" />
          </div>
          <div>
            <span className="text-sm font-semibold tracking-tight text-zinc-100">
              Goodboy
            </span>
            <div className="flex items-center gap-1">
              <Activity size={9} className="text-emerald-400" />
              <span className="text-[10px] text-zinc-500">Online</span>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 pt-2 space-y-0.5">
          <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-600">
            Navigation
          </div>
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition-all duration-150",
                  isActive
                    ? "bg-zinc-800/80 text-zinc-100 font-medium shadow-sm"
                    : "text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-300"
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    size={15}
                    className={cn(
                      "transition-colors",
                      isActive ? "text-violet-400" : "text-zinc-600 group-hover:text-zinc-400"
                    )}
                  />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-zinc-800/40 px-4 py-3">
          <p className="text-[10px] text-zinc-700">
            Background coding agent
          </p>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
