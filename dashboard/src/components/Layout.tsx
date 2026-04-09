import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@dashboard/lib/utils";
import {
  ListTodo,
  History,
  GitPullRequest,
  FolderGit2,
} from "lucide-react";

const NAV_ITEMS = [
  { to: "/", icon: ListTodo, label: "Active Tasks" },
  { to: "/history", icon: History, label: "Task History" },
  { to: "/prs", icon: GitPullRequest, label: "Pull Requests" },
  { to: "/repos", icon: FolderGit2, label: "Repos" },
];

export function Layout() {
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-surface">
        <div className="flex h-14 items-center gap-2 border-b border-border px-4">
          <div className="h-7 w-7 rounded-md bg-brand flex items-center justify-center text-sm font-bold text-zinc-950">
            G
          </div>
          <span className="text-sm font-semibold tracking-tight">Goodboy</span>
        </div>

        <nav className="flex-1 space-y-0.5 p-2">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-surface-raised text-text font-medium"
                    : "text-text-dim hover:bg-surface-raised hover:text-text"
                )
              }
            >
              <Icon size={16} />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}
