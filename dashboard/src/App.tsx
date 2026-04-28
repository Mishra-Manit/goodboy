/** Route table. All pages mount under a shared `<Layout>`. */

import { Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "@dashboard/components/Layout";
import { Tasks } from "@dashboard/pages/Tasks";
import { TaskDetail } from "@dashboard/pages/TaskDetail";
import { PullRequests } from "@dashboard/pages/PullRequests";
import { PrSessionDetail } from "@dashboard/pages/PrSessionDetail";
import { Repos } from "@dashboard/pages/Repos";
import { Memory } from "@dashboard/pages/Memory";
import { MemoryDetail } from "@dashboard/pages/MemoryDetail";

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Tasks />} />
        <Route path="/history" element={<Navigate to="/" replace />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/prs" element={<PullRequests />} />
        <Route path="/prs/:id" element={<PrSessionDetail />} />
        <Route path="/repos" element={<Repos />} />
        <Route path="/memory" element={<Memory />} />
        <Route path="/memory/:id" element={<MemoryDetail />} />
      </Route>
    </Routes>
  );
}
