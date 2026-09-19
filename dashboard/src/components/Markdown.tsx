import { useState, type ReactElement } from "react";
import { Check, Copy } from "lucide-react";

function CodeBlock({ code, language }: Readonly<{ code: string; language?: string | undefined }>): ReactElement {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      style={{
        margin: "0.75rem 0",
        borderRadius: "0.5rem",
        border: "1px solid var(--border)",
        backgroundColor: "var(--card)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.35rem 0.75rem",
          backgroundColor: "var(--row-hover)",
          borderBottom: "1px solid var(--border)",
          fontSize: "0.72rem",
          color: "var(--muted-foreground)",
          fontFamily: "monospace",
        }}
      >
        <span>{language || "code"}</span>
        <button
          type="button"
          onClick={() => void handleCopy()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            background: "transparent",
            border: "none",
            color: copied ? "var(--accent)" : "var(--muted-foreground)",
            fontSize: "0.72rem",
            cursor: "pointer",
            padding: "0.15rem 0.35rem",
            borderRadius: "0.25rem",
          }}
          title="Copy code to clipboard"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          padding: "0.75rem",
          overflowX: "auto",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          fontSize: "0.8125rem",
          lineHeight: 1.5,
          color: "var(--foreground)",
        }}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderInline(text: string): ReactElement[] {
  // Parse inline elements: `code`, **bold**, *italic*, [link](url)
  const parts: ReactElement[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // 1. Inline code: `...`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch && codeMatch[1]) {
      parts.push(
        <code
          key={key++}
          style={{
            fontFamily: "monospace",
            fontSize: "0.85em",
            backgroundColor: "var(--row-hover)",
            padding: "0.15em 0.35em",
            borderRadius: "0.25rem",
            border: "1px solid var(--border)",
            color: "var(--accent)",
          }}
        >
          {codeMatch[1]}
        </code>,
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 2. Bold: **...**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch && boldMatch[1]) {
      parts.push(
        <strong key={key++} style={{ fontWeight: 600 }}>
          {boldMatch[1]}
        </strong>,
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 3. Italic: *...*
    const italicMatch = remaining.match(/^\*([^*]+)\*/);
    if (italicMatch && italicMatch[1]) {
      parts.push(
        <em key={key++} style={{ fontStyle: "italic" }}>
          {italicMatch[1]}
        </em>,
      );
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // 4. Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch && linkMatch[1] && linkMatch[2]) {
      parts.push(
        <a
          key={key++}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            color: "var(--accent)",
            textDecoration: "underline",
            textUnderlineOffset: "2px",
          }}
        >
          {linkMatch[1]}
        </a>,
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Normal text chunk up to next special character
    const nextSpecial = remaining.search(/[`*[]/);
    if (nextSpecial === -1) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    } else if (nextSpecial === 0) {
      // First character didn't match full pattern, take it as plain text
      parts.push(<span key={key++}>{remaining[0]}</span>);
      remaining = remaining.slice(1);
    } else {
      parts.push(<span key={key++}>{remaining.slice(0, nextSpecial)}</span>);
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts;
}

export function Markdown({ content }: Readonly<{ content: string }>): ReactElement {
  if (!content) return <span />;

  // Split into blocks: code fences vs normal lines
  const lines = content.split("\n");
  const blocks: ReactElement[] = [];
  let inCodeBlock = false;
  let codeBlockLang = "";
  let codeBlockLines: string[] = [];
  let blockKey = 0;
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    const text = paragraphLines.join("\n").trim();
    if (text) {
      blocks.push(
        <p key={blockKey++} style={{ margin: "0.5rem 0", lineHeight: 1.55 }}>
          {renderInline(text)}
        </p>,
      );
    }
    paragraphLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Check code fence
    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        blocks.push(
          <CodeBlock
            key={blockKey++}
            code={codeBlockLines.join("\n")}
            language={codeBlockLang}
          />,
        );
        inCodeBlock = false;
        codeBlockLines = [];
        codeBlockLang = "";
      } else {
        // Start code block
        flushParagraph();
        inCodeBlock = true;
        codeBlockLang = trimmed.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Headings
    if (trimmed.startsWith("### ")) {
      flushParagraph();
      blocks.push(
        <h4 key={blockKey++} style={{ margin: "0.75rem 0 0.35rem", fontSize: "0.95rem", fontWeight: 600 }}>
          {renderInline(trimmed.slice(4))}
        </h4>,
      );
      continue;
    }
    if (trimmed.startsWith("## ")) {
      flushParagraph();
      blocks.push(
        <h3 key={blockKey++} style={{ margin: "0.85rem 0 0.4rem", fontSize: "1.05rem", fontWeight: 600 }}>
          {renderInline(trimmed.slice(3))}
        </h3>,
      );
      continue;
    }
    if (trimmed.startsWith("# ")) {
      flushParagraph();
      blocks.push(
        <h2 key={blockKey++} style={{ margin: "1rem 0 0.5rem", fontSize: "1.2rem", fontWeight: 700 }}>
          {renderInline(trimmed.slice(2))}
        </h2>,
      );
      continue;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      flushParagraph();
      blocks.push(
        <blockquote
          key={blockKey++}
          style={{
            margin: "0.5rem 0",
            paddingLeft: "0.75rem",
            borderLeft: "3px solid var(--accent)",
            color: "var(--muted-foreground)",
            fontStyle: "italic",
          }}
        >
          {renderInline(trimmed.slice(2))}
        </blockquote>,
      );
      continue;
    }

    // Unordered list item
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      flushParagraph();
      blocks.push(
        <div key={blockKey++} style={{ display: "flex", gap: "0.5rem", margin: "0.25rem 0 0.25rem 0.5rem" }}>
          <span style={{ color: "var(--accent)" }}>&bull;</span>
          <div>{renderInline(trimmed.slice(2))}</div>
        </div>,
      );
      continue;
    }

    // Numbered list item
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch && numMatch[1] && numMatch[2]) {
      flushParagraph();
      blocks.push(
        <div key={blockKey++} style={{ display: "flex", gap: "0.5rem", margin: "0.25rem 0 0.25rem 0.5rem" }}>
          <span style={{ color: "var(--muted-foreground)", fontFamily: "monospace", minWidth: "1.2rem" }}>
            {numMatch[1]}.
          </span>
          <div>{renderInline(numMatch[2])}</div>
        </div>,
      );
      continue;
    }

    // Empty line separates paragraphs
    if (trimmed === "") {
      flushParagraph();
      continue;
    }

    paragraphLines.push(line);
  }

  if (inCodeBlock) {
    blocks.push(
      <CodeBlock
        key={blockKey++}
        code={codeBlockLines.join("\n")}
        language={codeBlockLang}
      />,
    );
  } else {
    flushParagraph();
  }

  return (
    <div
      style={{
        fontSize: "0.875rem",
        lineHeight: 1.6,
        wordBreak: "break-word",
      }}
    >
      {blocks}
    </div>
  );
}
