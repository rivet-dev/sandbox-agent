export const TASK_QUEUE_NAMES = [
  "task.command.initialize",
  "task.command.provision",
  "task.command.attach",
  "task.command.switch",
  "task.command.push",
  "task.command.sync",
  "task.command.merge",
  "task.command.archive",
  "task.command.kill",
  "task.command.get",
  "task.command.workbench.mark_unread",
  "task.command.workbench.rename_task",
  "task.command.workbench.rename_branch",
  "task.command.workbench.create_session",
  "task.command.workbench.rename_session",
  "task.command.workbench.set_session_unread",
  "task.command.workbench.update_draft",
  "task.command.workbench.change_model",
  "task.command.workbench.send_message",
  "task.command.workbench.stop_session",
  "task.command.workbench.sync_session_status",
  "task.command.workbench.close_session",
  "task.command.workbench.publish_pr",
  "task.command.workbench.revert_file",
  "task.status_sync.result",
] as const;

export function taskWorkflowQueueName(name: string): string {
  return name;
}
