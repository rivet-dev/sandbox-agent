import { memo, type Ref } from "react";
import { useStyletron } from "baseui";
import { ArrowUpFromLine, FileCode, Square, X } from "lucide-react";

import { ModelPicker } from "./model-picker";
import { PROMPT_TEXTAREA_MIN_HEIGHT, PROMPT_TEXTAREA_MAX_HEIGHT } from "./ui";
import { fileName, type LineAttachment, type ModelId } from "./view-model";

export const PromptComposer = memo(function PromptComposer({
  draft,
  textareaRef,
  placeholder,
  attachments,
  defaultModel,
  model,
  isRunning,
  onDraftChange,
  onSend,
  onStop,
  onRemoveAttachment,
  onChangeModel,
  onSetDefaultModel,
}: {
  draft: string;
  textareaRef: Ref<HTMLTextAreaElement>;
  placeholder: string;
  attachments: LineAttachment[];
  defaultModel: ModelId;
  model: ModelId;
  isRunning: boolean;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onRemoveAttachment: (id: string) => void;
  onChangeModel: (model: ModelId) => void;
  onSetDefaultModel: (model: ModelId) => void;
}) {
  const [css, theme] = useStyletron();

  return (
    <div
      className={css({
        padding: "12px 16px",
        borderTop: `1px solid ${theme.colors.borderOpaque}`,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      })}
    >
      {attachments.length > 0 ? (
        <div className={css({ display: "flex", flexWrap: "wrap", gap: "4px" })}>
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className={css({
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                padding: "2px 8px",
                borderRadius: "4px",
                backgroundColor: "rgba(255, 255, 255, 0.06)",
                border: "1px solid rgba(255, 255, 255, 0.14)",
                fontSize: "11px",
                fontFamily: '"IBM Plex Mono", monospace',
                color: theme.colors.contentSecondary,
              })}
            >
              <FileCode size={11} />
              <span>
                {fileName(attachment.filePath)}:{attachment.lineNumber}
              </span>
              <X size={10} className={css({ cursor: "pointer", opacity: 0.6, ":hover": { opacity: 1 } })} onClick={() => onRemoveAttachment(attachment.id)} />
            </div>
          ))}
        </div>
      ) : null}
      <div
        className={css({
          position: "relative",
          backgroundColor: "rgba(255, 255, 255, 0.06)",
          border: `1px solid ${theme.colors.borderOpaque}`,
          borderRadius: "16px",
          minHeight: `${PROMPT_TEXTAREA_MIN_HEIGHT}px`,
          transition: "border-color 200ms ease",
          ":focus-within": { borderColor: "rgba(255, 255, 255, 0.3)" },
        })}
      >
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className={css({
            display: "block",
            width: "100%",
            minHeight: `${PROMPT_TEXTAREA_MIN_HEIGHT}px`,
            padding: "12px 58px 12px 14px",
            background: "transparent",
            border: "none",
            borderRadius: "16px",
            color: theme.colors.contentPrimary,
            fontSize: "13px",
            fontFamily: "inherit",
            resize: "none",
            outline: "none",
            lineHeight: "1.4",
            maxHeight: `${PROMPT_TEXTAREA_MAX_HEIGHT}px`,
            boxSizing: "border-box",
            overflowY: "hidden",
            "::placeholder": { color: theme.colors.contentSecondary },
          })}
        />
        {isRunning ? (
          <button
            onClick={onStop}
            className={css({
              all: "unset",
              width: "32px",
              height: "32px",
              borderRadius: "6px",
              cursor: "pointer",
              position: "absolute",
              right: "12px",
              bottom: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(255, 255, 255, 0.06)",
              color: theme.colors.contentPrimary,
              transition: "background 200ms ease",
              ":hover": { backgroundColor: "rgba(255, 255, 255, 0.12)" },
            })}
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            onClick={onSend}
            className={css({
              all: "unset",
              width: "32px",
              height: "32px",
              borderRadius: "6px",
              cursor: "pointer",
              position: "absolute",
              right: "12px",
              bottom: "12px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#ff4f00",
              color: "#ffffff",
              transition: "background 200ms ease",
              ":hover": { backgroundColor: "#ff6a00" },
            })}
          >
            <ArrowUpFromLine size={16} />
          </button>
        )}
      </div>
      <ModelPicker value={model} defaultModel={defaultModel} onChange={onChangeModel} onSetDefault={onSetDefaultModel} />
    </div>
  );
});
