import { HelpCircle, Shield } from "lucide-react";
import type { PermissionEventData, QuestionEventData } from "../../types/legacyApi";
import { formatJson } from "../../utils/format";

const ApprovalsTab = ({
  questionRequests,
  permissionRequests,
  questionSelections,
  onSelectQuestionOption,
  onAnswerQuestion,
  onRejectQuestion,
  onReplyPermission
}: {
  questionRequests: QuestionEventData[];
  permissionRequests: PermissionEventData[];
  questionSelections: Record<string, string[][]>;
  onSelectQuestionOption: (requestId: string, optionLabel: string) => void;
  onAnswerQuestion: (request: QuestionEventData) => void;
  onRejectQuestion: (requestId: string) => void;
  onReplyPermission: (requestId: string, reply: "once" | "always" | "reject") => void;
}) => {
  return (
    <>
      {questionRequests.length === 0 && permissionRequests.length === 0 ? (
        <div className="card-meta">No pending approvals.</div>
      ) : (
        <>
          {questionRequests.map((request) => {
            const selections = questionSelections[request.question_id] ?? [];
            const selected = selections[0] ?? [];
            const answered = selected.length > 0;
            return (
              <div key={request.question_id} className="card">
                <div className="card-header">
                  <span className="card-title">
                    <HelpCircle className="button-icon" style={{ marginRight: 6 }} />
                    Question
                  </span>
                  <span className="pill accent">Pending</span>
                </div>
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, marginBottom: 8 }}>{request.prompt}</div>
                  <div className="option-list">
                    {request.options.map((option) => {
                      const isSelected = selected.includes(option);
                      return (
                        <label key={option} className="option-item">
                          <input
                            type="radio"
                            checked={isSelected}
                            onChange={() => onSelectQuestionOption(request.question_id, option)}
                          />
                          <span>{option}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
                <div className="card-actions">
                  <button className="button success small" disabled={!answered} onClick={() => onAnswerQuestion(request)}>
                    Reply
                  </button>
                  <button className="button danger small" onClick={() => onRejectQuestion(request.question_id)}>
                    Reject
                  </button>
                </div>
              </div>
            );
          })}

          {permissionRequests.map((request) => (
            <div key={request.permission_id} className="card">
              <div className="card-header">
                <span className="card-title">
                  <Shield className="button-icon" style={{ marginRight: 6 }} />
                  Permission
                </span>
                <span className="pill accent">Pending</span>
              </div>
              <div className="card-meta" style={{ marginTop: 8 }}>
                {request.action}
              </div>
              {request.metadata !== null && request.metadata !== undefined && (
                <pre className="code-block">{formatJson(request.metadata)}</pre>
              )}
              <div className="card-actions">
                <button className="button success small" onClick={() => onReplyPermission(request.permission_id, "once")}>
                  Allow Once
                </button>
                <button className="button secondary small" onClick={() => onReplyPermission(request.permission_id, "always")}>
                  Always
                </button>
                <button className="button danger small" onClick={() => onReplyPermission(request.permission_id, "reject")}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </>
      )}
    </>
  );
};

export default ApprovalsTab;
