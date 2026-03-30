import { useParams, useNavigate, Navigate } from "react-router-dom";
import { TaskDetail } from "../TaskDetail";
import { colors, fonts } from "../theme";

export function TaskDetailPage() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();

  if (!taskId) return <Navigate to="/tasks" replace />;

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, fontFamily: fonts.body, color: colors.text }}>
      <TaskDetail
        taskId={taskId}
        onBack={() => navigate("/tasks")}
      />
    </div>
  );
}
