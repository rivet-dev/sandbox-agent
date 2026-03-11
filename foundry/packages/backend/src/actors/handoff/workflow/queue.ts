export const HANDOFF_QUEUE_NAMES = [
  "handoff.command.initialize",
  "handoff.command.provision",
  "handoff.command.attach",
  "handoff.command.switch",
  "handoff.command.push",
  "handoff.command.sync",
  "handoff.command.merge",
  "handoff.command.archive",
  "handoff.command.kill",
  "handoff.command.get",
  "handoff.command.workbench.mark_unread",
  "handoff.command.workbench.rename_handoff",
  "handoff.command.workbench.rename_branch",
  "handoff.command.workbench.create_session",
  "handoff.command.workbench.rename_session",
  "handoff.command.workbench.set_session_unread",
  "handoff.command.workbench.update_draft",
  "handoff.command.workbench.change_model",
  "handoff.command.workbench.send_message",
  "handoff.command.workbench.stop_session",
  "handoff.command.workbench.sync_session_status",
  "handoff.command.workbench.close_session",
  "handoff.command.workbench.publish_pr",
  "handoff.command.workbench.revert_file",
  "handoff.status_sync.result",
] as const;

export function handoffWorkflowQueueName(name: string): string {
  return name;
}
