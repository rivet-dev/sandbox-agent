import type { ContentPart } from "../../types/legacyApi";
import { formatJson } from "../../utils/format";

const renderContentPart = (part: ContentPart, index: number) => {
  const partType = (part as { type?: string }).type ?? "unknown";
  const key = `${partType}-${index}`;
  switch (partType) {
    case "text":
      return (
        <div key={key} className="part">
          <div className="part-body">{(part as { text: string }).text}</div>
        </div>
      );
    case "json":
      return (
        <div key={key} className="part">
          <div className="part-title">json</div>
          <pre className="code-block">{formatJson((part as { json: unknown }).json)}</pre>
        </div>
      );
    case "tool_call": {
      const { name, arguments: args, call_id } = part as {
        name: string;
        arguments: string;
        call_id: string;
      };
      return (
        <div key={key} className="part">
          <div className="part-title">
            tool call - {name}
            {call_id ? ` - ${call_id}` : ""}
          </div>
          {args ? <pre className="code-block">{args}</pre> : <div className="muted">No arguments</div>}
        </div>
      );
    }
    case "tool_result": {
      const { call_id, output } = part as { call_id: string; output: string };
      return (
        <div key={key} className="part">
          <div className="part-title">tool result - {call_id}</div>
          {output ? <pre className="code-block">{output}</pre> : <div className="muted">No output</div>}
        </div>
      );
    }
    case "file_ref": {
      const { path, action, diff } = part as { path: string; action: string; diff?: string | null };
      return (
        <div key={key} className="part">
          <div className="part-title">file - {action}</div>
          <div className="part-body mono">{path}</div>
          {diff && <pre className="code-block">{diff}</pre>}
        </div>
      );
    }
    case "reasoning": {
      const { text, visibility } = part as { text: string; visibility: string };
      return (
        <div key={key} className="part">
          <div className="part-title">reasoning - {visibility}</div>
          <div className="part-body muted">{text}</div>
        </div>
      );
    }
    case "image": {
      const { path, mime } = part as { path: string; mime?: string | null };
      return (
        <div key={key} className="part">
          <div className="part-title">image {mime ? `- ${mime}` : ""}</div>
          <div className="part-body mono">{path}</div>
        </div>
      );
    }
    case "status": {
      const { label, detail } = part as { label: string; detail?: string | null };
      return (
        <div key={key} className="part">
          <div className="part-title">status - {label}</div>
          {detail && <div className="part-body">{detail}</div>}
        </div>
      );
    }
    default:
      return (
        <div key={key} className="part">
          <div className="part-title">unknown</div>
          <pre className="code-block">{formatJson(part)}</pre>
        </div>
      );
  }
};

export default renderContentPart;
