import { Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "@dashboard/components/Layout";
import { Tasks } from "@dashboard/pages/Tasks";
import { TaskDetail } from "@dashboard/pages/TaskDetail";
import { PullRequests } from "@dashboard/pages/PullRequests";
import { Repos } from "@dashboard/pages/Repos";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Tasks />} />
        <Route path="/history" element={<Navigate to="/" replace />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/prs" element={<PullRequests />} />
        <Route path="/repos" element={<Repos />} />
      </Route>
    </Routes>
  );
}
