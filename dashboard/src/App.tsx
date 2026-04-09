import { Routes, Route } from "react-router-dom";
import { Layout } from "@dashboard/components/Layout";
import { ActiveTasks } from "@dashboard/pages/ActiveTasks";
import { TaskHistory } from "@dashboard/pages/TaskHistory";
import { TaskDetail } from "@dashboard/pages/TaskDetail";
import { PullRequests } from "@dashboard/pages/PullRequests";
import { Repos } from "@dashboard/pages/Repos";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<ActiveTasks />} />
        <Route path="/history" element={<TaskHistory />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/prs" element={<PullRequests />} />
        <Route path="/repos" element={<Repos />} />
      </Route>
    </Routes>
  );
}
