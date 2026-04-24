import { useRef, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownContentProps {
  content: string;
  /**
   * Enable GFM task-list checkbox interaction. When set, clicking an
   * unchecked/checked `- [ ]` / `- [x]` item calls the handler with its
   * 0-based index (in document order across the whole markdown). When
   * omitted, checkboxes render as disabled — the remark-gfm default.
   */
  onToggleCheckbox?: (index: number, checked: boolean) => void;
}

const headingStyle = (level: 1 | 2 | 3 | 4 | 5 | 6): CSSProperties => {
  const sizes: Record<number, string> = { 1: "18px", 2: "16px", 3: "14px", 4: "13px", 5: "12px", 6: "12px" };
  return {
    fontSize: sizes[level],
    fontWeight: 600,
    color: "var(--text-primary)",
    marginTop: level === 1 ? "0" : "14px",
    marginBottom: "6px",
    lineHeight: 1.4,
  };
};

const codeBlockStyle: CSSProperties = {
  display: "block",
  fontFamily: "ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace",
  fontSize: "12px",
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "6px",
  padding: "10px 12px",
  overflowX: "auto",
  whiteSpace: "pre",
  margin: "6px 0",
};

const inlineCodeStyle: CSSProperties = {
  fontFamily: "ui-monospace, 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', monospace",
  fontSize: "12px",
  background: "var(--bg-tertiary)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "4px",
  padding: "1px 6px",
};

const paragraphStyle: CSSProperties = {
  margin: "6px 0",
  lineHeight: 1.6,
  color: "var(--text-primary)",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

// Tailwind's preflight strips list-style from ul/ol so bullet/number
// markers disappear. Restore them explicitly here so refinement plans
// and other markdown content keep their list affordances.
const unorderedListStyle: CSSProperties = {
  margin: "6px 0",
  paddingLeft: "20px",
  color: "var(--text-primary)",
  lineHeight: 1.6,
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  listStyleType: "disc",
  listStylePosition: "outside",
};

const orderedListStyle: CSSProperties = {
  ...unorderedListStyle,
  listStyleType: "decimal",
};

const blockquoteStyle: CSSProperties = {
  borderLeft: "3px solid var(--border-default)",
  paddingLeft: "12px",
  margin: "6px 0",
  color: "var(--text-secondary)",
  fontStyle: "italic",
  overflowWrap: "anywhere",
  wordBreak: "break-word",
};

const tableStyle: CSSProperties = {
  borderCollapse: "collapse",
  margin: "6px 0",
  fontSize: "12px",
};

const thStyle: CSSProperties = {
  border: "1px solid var(--border-subtle)",
  padding: "6px 10px",
  background: "var(--bg-tertiary)",
  fontWeight: 600,
  textAlign: "left",
};

const tdStyle: CSSProperties = {
  border: "1px solid var(--border-subtle)",
  padding: "6px 10px",
};

const linkStyle: CSSProperties = {
  color: "var(--accent, #3b82f6)",
  textDecoration: "underline",
};

const hrStyle: CSSProperties = {
  border: "none",
  borderTop: "1px solid var(--border-subtle)",
  margin: "12px 0",
};

export function MarkdownContent({ content, onToggleCheckbox }: MarkdownContentProps): ReactNode {
  // Compute a checkbox's index *at click time* by walking the rendered DOM,
  // rather than tracking it during render. React StrictMode double-invokes
  // component function bodies in development so any render-time counter
  // gets incremented twice per checkbox, producing off-by-one indices.
  // DOM-based lookup sidesteps that entirely.
  const rootRef = useRef<HTMLDivElement>(null);

  const handleCheckboxChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (!onToggleCheckbox || !rootRef.current) return;
    const boxes = Array.from(
      rootRef.current.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    const index = boxes.indexOf(e.target);
    if (index >= 0) onToggleCheckbox(index, e.target.checked);
  };

  return (
    <div
      ref={rootRef}
      data-testid="markdown-content"
      style={{
        fontSize: "13px",
        color: "var(--text-primary)",
        // Ensure long URLs and other unbreakable tokens wrap at the parent
        // edge instead of pushing the panel wider. `minWidth: 0` prevents the
        // default flex `min-width: auto` from expanding the content box.
        minWidth: 0,
        overflowWrap: "anywhere",
        wordBreak: "break-word",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 style={headingStyle(1)}>{children}</h1>,
          h2: ({ children }) => <h2 style={headingStyle(2)}>{children}</h2>,
          h3: ({ children }) => <h3 style={headingStyle(3)}>{children}</h3>,
          h4: ({ children }) => <h4 style={headingStyle(4)}>{children}</h4>,
          h5: ({ children }) => <h5 style={headingStyle(5)}>{children}</h5>,
          h6: ({ children }) => <h6 style={headingStyle(6)}>{children}</h6>,
          p: ({ children }) => <p style={paragraphStyle}>{children}</p>,
          ul: ({ children }) => <ul style={unorderedListStyle}>{children}</ul>,
          ol: ({ children }) => <ol style={orderedListStyle}>{children}</ol>,
          // Task-list items (`- [ ]` / `- [x]`) already carry a checkbox as
          // their marker; rendering a disc bullet alongside makes the row
          // feel double-marked. `react-markdown` + `remark-gfm` surface
          // these as `className="task-list-item"` and provide a `checked`
          // prop. Suppress the list marker only for those rows so the
          // Acceptance Criteria section shows clean `[ ] / [x]` lines
          // while ordinary bullets elsewhere keep their disc.
          li: ({ children, className, ...rest }) => {
            const checked = (rest as { checked?: boolean }).checked;
            const isTaskItem =
              (typeof className === "string" && className.includes("task-list-item")) ||
              typeof checked === "boolean";
            return (
              <li
                className={className}
                style={{
                  margin: "2px 0",
                  display: "list-item",
                  ...(isTaskItem
                    ? { listStyleType: "none", marginLeft: "-20px" }
                    : null),
                }}
              >
                {children}
              </li>
            );
          },
          blockquote: ({ children }) => <blockquote style={blockquoteStyle}>{children}</blockquote>,
          code: ({ className, children, ...rest }) => {
            const isBlock = className?.startsWith("language-");
            if (isBlock) {
              return (
                <code className={className} style={codeBlockStyle} {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code style={inlineCodeStyle} {...rest}>
                {children}
              </code>
            );
          },
          pre: ({ children }) => <pre style={{ margin: "6px 0" }}>{children}</pre>,
          table: ({ children }) => <table style={tableStyle}>{children}</table>,
          th: ({ children }) => <th style={thStyle}>{children}</th>,
          td: ({ children }) => <td style={tdStyle}>{children}</td>,
          a: ({ children, href }) => (
            <a href={href} style={linkStyle} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          hr: () => <hr style={hrStyle} />,
          strong: ({ children }) => <strong style={{ fontWeight: 600 }}>{children}</strong>,
          em: ({ children }) => <em style={{ fontStyle: "italic" }}>{children}</em>,
          input: ({ type, checked, ...rest }) => {
            if (type !== "checkbox") {
              return <input type={type} {...rest} />;
            }
            // Task-list checkbox from `- [ ]` / `- [x]`. react-markdown
            // renders these as disabled inputs by default; we override so
            // the reviewer can flip them during pr_review. Index is
            // resolved lazily in `handleCheckboxChange` via DOM order.
            const interactive = typeof onToggleCheckbox === "function";
            return (
              <input
                type="checkbox"
                checked={!!checked}
                disabled={!interactive}
                onChange={handleCheckboxChange}
                style={{
                  marginRight: "6px",
                  cursor: interactive ? "pointer" : "default",
                  // Light compensation so the native checkbox aligns
                  // visually with the 13px body text.
                  verticalAlign: "middle",
                }}
              />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
