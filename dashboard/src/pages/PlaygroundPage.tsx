import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Code,
  Copy,
  FileText,
  History,
  MessageSquare,
  Paperclip,
  Play,
  RefreshCw,
  Send,
  Sliders,
  Sparkles,
  Square,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Markdown } from "../components/Markdown.js";
import {
  ACCEPT_ATTRIBUTE,
  attachmentImages,
  classifyFile,
  composePromptWithAttachments,
  formatBytes,
  readImageAttachment,
  readTextAttachment,
  MAX_ATTACHMENTS,
  type Attachment,
} from "../attachments.js";

interface ModelItem {
  readonly id: string;
  readonly description?: string | undefined;
  readonly context_window?: number | undefined;
  readonly supports_vision?: boolean | undefined;
}

interface Message {
  readonly id: string;
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
  readonly images?: readonly string[] | undefined;
  readonly meta?: {
    readonly servedBy?: string | undefined;
    readonly ttftMs?: number | undefined;
    readonly totalDurationMs?: number | undefined;
  } | undefined;
}

interface PromptHistoryItem {
  readonly id: string;
  readonly timestamp: string;
  readonly model: string;
  readonly prompt: string;
  readonly ttftMs?: number | undefined;
  readonly totalDurationMs?: number | undefined;
  readonly servedBy?: string | undefined;
}

const COMMON_POOLS = ["auto", "pool/xhigh", "pool/high", "pool/medium", "pool/low"] as const;

export function PlaygroundPage({
  initialModel,
}: Readonly<{
  initialModel?: string | undefined;
}> = {}): ReactElement {
  const [models, setModels] = useState<readonly string[]>([]);
  const [modelsMeta, setModelsMeta] = useState<Record<string, ModelItem>>({});
  const [selectedModel, setSelectedModel] = useState<string>(() => initialModel ?? "auto");
  const [messages, setMessages] = useState<readonly Message[]>([
    {
      id: "welcome",
      role: "assistant",
      content: "Hello! This is the llm-relay live sandbox. Select a pool or model above, attach text or images, and send a message to test routing, failover, and streaming responsiveness.",
    },
  ]);
  const [inputPrompt, setInputPrompt] = useState("");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  // System Prompt & Parameters Drawer
  const [systemPrompt, setSystemPrompt] = useState<string>(() => {
    try { return sessionStorage.getItem("llm-relay.playground.sysprompt") ?? ""; } catch { return ""; }
  });
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const [showParameters, setShowParameters] = useState(false);
  const [temperature, setTemperature] = useState<number>(0.7);
  const [maxTokens, setMaxTokens] = useState<number>(2048);
  const [streamEnabled, setStreamEnabled] = useState<boolean>(true);

  // Modals & Notices
  const [codeModalOpen, setCodeModalOpen] = useState(false);
  const [codeLang, setCodeLang] = useState<"curl" | "python" | "node">("curl");
  const [copiedCode, setCopiedCode] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<readonly PromptHistoryItem[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (initialModel) setSelectedModel(initialModel);
  }, [initialModel]);

  const updateSystemPrompt = (val: string) => {
    setSystemPrompt(val);
    try { sessionStorage.setItem("llm-relay.playground.sysprompt", val); } catch { /* ignore */ }
  };

  useEffect(() => {
    fetch("/v1/models")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { data?: readonly ModelItem[] } | null) => {
        if (data?.data && Array.isArray(data.data)) {
          const list = data.data.map((m) => m.id);
          const combined = Array.from(new Set([...COMMON_POOLS, ...list]));
          setModels(combined);
          const metaMap: Record<string, ModelItem> = {};
          for (const item of data.data) {
            metaMap[item.id] = item;
          }
          setModelsMeta(metaMap);
          if (!initialModel) {
            if (combined.includes("auto")) setSelectedModel("auto");
            else if (combined.includes("pool/medium")) setSelectedModel("pool/medium");
            else if (combined.length > 0) setSelectedModel(combined[0]!);
          }
        }
      })
      .catch(() => {
        setModels([...COMMON_POOLS]);
      });
  }, [initialModel]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // Handle attaching files
  const handleAddFiles = async (files: FileList | File[]) => {
    setAttachmentError(null);
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    if (attachments.length + fileArray.length > MAX_ATTACHMENTS) {
      setAttachmentError(`Maximum ${MAX_ATTACHMENTS} attachments allowed per turn.`);
      return;
    }

    const newAttachments: Attachment[] = [];
    for (const file of fileArray) {
      const kind = classifyFile(file);
      if (!kind) {
        setAttachmentError(`Unsupported file format: ${file.name}`);
        continue;
      }
      try {
        if (kind === "image") {
          const dataUrl = await readImageAttachment(file);
          newAttachments.push({
            id: `${Date.now()}-${file.name}`,
            kind: "image",
            name: file.name,
            dataUrl,
          });
        } else {
          const text = await readTextAttachment(file);
          newAttachments.push({
            id: `${Date.now()}-${file.name}`,
            kind: "text",
            name: file.name,
            text,
          });
        }
      } catch (err) {
        setAttachmentError(err instanceof Error ? err.message : `Failed to read ${file.name}`);
      }
    }

    if (newAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...newAttachments]);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  // Vision capability check
  const stagedImages = attachmentImages(attachments);
  const selectedMeta = modelsMeta[selectedModel];
  const modelSupportsVision =
    selectedModel === "auto" ||
    selectedModel.startsWith("pool/") ||
    selectedModel.toLowerCase().includes("vision") ||
    selectedModel.toLowerCase().includes("gemini") ||
    selectedModel.toLowerCase().includes("claude") ||
    selectedModel.toLowerCase().includes("4o") ||
    Boolean(selectedMeta?.supports_vision);

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const prompt = inputPrompt.trim();
    if ((!prompt && attachments.length === 0) || streaming) return;

    const composedText = composePromptWithAttachments(prompt, attachments);
    const userMsg: Message = {
      id: "user-" + Date.now(),
      role: "user",
      content: composedText,
      images: stagedImages.length > 0 ? stagedImages : undefined,
    };

    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInputPrompt("");
    setAttachments([]);
    setStreaming(true);

    const controller = new AbortController();
    setAbortController(controller);

    const assistantId = "assistant-" + Date.now();
    const assistantMsgPlaceholder: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
    };
    setMessages([...newMessages, assistantMsgPlaceholder]);

    const startTime = performance.now();
    let firstTokenTime: number | null = null;
    let accumulatedText = "";
    let servedByHeader: string | undefined;

    try {
      // Build request messages
      const requestMessages: Array<{ role: string; content: unknown }> = [];
      if (systemPrompt.trim()) {
        requestMessages.push({ role: "system", content: systemPrompt.trim() });
      }

      for (const msg of newMessages) {
        if (msg.id === "welcome") continue;
        if (msg.images && msg.images.length > 0) {
          // Multimodal message format
          const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
            { type: "text", text: msg.content },
          ];
          for (const imgUrl of msg.images) {
            parts.push({ type: "image_url", image_url: { url: imgUrl } });
          }
          requestMessages.push({ role: msg.role, content: parts });
        } else {
          requestMessages.push({ role: msg.role, content: msg.content });
        }
      }

      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages: requestMessages,
          temperature,
          max_tokens: maxTokens,
          stream: streamEnabled,
        }),
        signal: controller.signal,
      });

      servedByHeader = response.headers.get("x-llm-relay-served-by") ?? undefined;

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      if (!streamEnabled) {
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        accumulatedText = json.choices?.[0]?.message?.content ?? "";
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: accumulatedText,
                  meta: {
                    servedBy: servedByHeader,
                    totalDurationMs: Math.round(performance.now() - startTime),
                  },
                }
              : msg
          )
        );
      } else {
        if (!response.body) {
          throw new Error("No response body received from relay.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.replace(/^data:\s*/, "");
            if (dataStr === "[DONE]") break;

            try {
              const parsed = JSON.parse(dataStr) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                if (firstTokenTime === null) {
                  firstTokenTime = performance.now();
                }
                accumulatedText += delta;
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === assistantId
                      ? {
                          ...msg,
                          content: accumulatedText,
                          meta: {
                            servedBy: servedByHeader,
                            ttftMs: firstTokenTime ? Math.round(firstTokenTime - startTime) : undefined,
                            totalDurationMs: Math.round(performance.now() - startTime),
                          },
                        }
                      : msg
                  )
                );
              }
            } catch {
              // Ignore incomplete chunk parse errors
            }
          }
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        accumulatedText += "\n\n[Request cancelled by operator]";
      } else {
        accumulatedText += `\n\n[Error: ${err instanceof Error ? err.message : String(err)}]`;
      }
      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === assistantId
            ? {
                ...msg,
                content: accumulatedText,
                meta: {
                  servedBy: servedByHeader,
                  ttftMs: firstTokenTime ? Math.round(firstTokenTime - startTime) : undefined,
                  totalDurationMs: Math.round(performance.now() - startTime),
                },
              }
            : msg
        )
      );
    } finally {
      const durationMs = Math.round(performance.now() - startTime);
      const ttft = firstTokenTime ? Math.round(firstTokenTime - startTime) : undefined;
      setHistory((prev) => [
        {
          id: "h-" + Date.now(),
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          model: selectedModel,
          prompt,
          ttftMs: ttft,
          totalDurationMs: durationMs,
          servedBy: servedByHeader,
        },
        ...prev.slice(0, 9),
      ]);
      setStreaming(false);
      setAbortController(null);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleStop = () => {
    abortController?.abort();
  };

  const handleClear = () => {
    setMessages([]);
    setAttachments([]);
    textareaRef.current?.focus();
  };

  const copyToClipboard = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopyNotice(id);
    setTimeout(() => setCopyNotice(null), 2000);
  };

  const getCodeSnippet = (lang: "curl" | "python" | "node") => {
    const reqMsgs = [
      ...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []),
      ...messages.filter((m) => m.id !== "welcome").map((m) => ({ role: m.role, content: m.content })),
    ];
    if (reqMsgs.length === 0) {
      reqMsgs.push({ role: "user", content: inputPrompt.trim() || "Hello world" });
    }

    if (lang === "curl") {
      return `curl http://127.0.0.1:8791/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(
    {
      model: selectedModel,
      messages: reqMsgs,
      temperature,
      max_tokens: maxTokens,
      stream: streamEnabled,
    },
    null,
    2
  )}'`;
    }

    if (lang === "python") {
      return `from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8791/v1",
    api_key="anything", # llm-relay loopback requires no remote key
)

response = client.chat.completions.create(
    model="${selectedModel}",
    messages=${JSON.stringify(reqMsgs, null, 4)},
    temperature=${temperature},
    max_tokens=${maxTokens},
    stream=${streamEnabled ? "True" : "False"},
)

${
  streamEnabled
    ? `for chunk in response:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
print()`
    : `print(response.choices[0].message.content)`
}`;
    }

    return `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8791/v1",
  apiKey: "anything",
});

async function main() {
  const stream = await client.chat.completions.create({
    model: "${selectedModel}",
    messages: ${JSON.stringify(reqMsgs, null, 4)},
    temperature: ${temperature},
    max_tokens: ${maxTokens},
    stream: ${streamEnabled},
  });

  ${
    streamEnabled
      ? `for await (const chunk of stream) {
    process.stdout.write(chunk.choices[0]?.delta?.content || "");
  }
  console.log();`
      : `console.log(stream.choices[0].message.content);`
  }
}

main();`;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 8rem)", gap: "1rem" }}>
      {/* Top Header with Model Picker, System Prompt Toggle, Parameters, and Clear */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "0.75rem",
          padding: "0.85rem 1.25rem",
          borderRadius: "0.5rem",
          backgroundColor: "var(--card)",
          border: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--muted-foreground)" }}>Target:</span>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              aria-label="Select target model or pool"
              style={{
                fontFamily: "monospace",
                fontSize: "0.85rem",
                padding: "0.35rem 0.65rem",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                backgroundColor: "var(--surface)",
                color: "var(--foreground)",
                fontWeight: 600,
                minWidth: "160px",
              }}
            >
              <optgroup label="Dynamic Effort Pools">
                {COMMON_POOLS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Discovered Models & Rungs">
                {models
                  .filter((m) => !COMMON_POOLS.includes(m as (typeof COMMON_POOLS)[number]))
                  .map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
              </optgroup>
            </select>
          </div>

          <button
            type="button"
            onClick={() => setShowSystemPrompt((prev) => !prev)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.8rem",
              padding: "0.35rem 0.65rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--border)",
              background: showSystemPrompt || systemPrompt ? "var(--row-hover)" : "transparent",
              color: systemPrompt ? "var(--accent)" : "var(--foreground)",
              cursor: "pointer",
            }}
          >
            <span>System Prompt</span>
            {systemPrompt.trim() && <span style={{ width: "6px", height: "6px", borderRadius: "9999px", backgroundColor: "var(--accent)" }} />}
          </button>

          <button
            type="button"
            onClick={() => setShowParameters((prev) => !prev)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.8rem",
              padding: "0.35rem 0.65rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--border)",
              background: showParameters ? "var(--row-hover)" : "transparent",
              color: "var(--foreground)",
              cursor: "pointer",
            }}
          >
            <Sliders size={13} />
            <span>Parameters</span>
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => setCodeModalOpen(true)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              fontSize: "0.8rem",
              padding: "0.35rem 0.65rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--foreground)",
              cursor: "pointer",
            }}
          >
            <Code size={14} /> View Code
          </button>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                fontSize: "0.8rem",
                padding: "0.35rem 0.65rem",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                background: "transparent",
                color: "var(--muted-foreground)",
                cursor: "pointer",
              }}
            >
              <Trash2 size={13} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Expandable System Prompt Drawer */}
      {showSystemPrompt && (
        <div
          style={{
            padding: "0.85rem 1.25rem",
            borderRadius: "0.5rem",
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: "var(--foreground)" }}>
              System Prompt (Prepended to conversation)
            </span>
            {systemPrompt.trim() && (
              <button
                type="button"
                onClick={() => updateSystemPrompt("")}
                style={{ fontSize: "0.75rem", color: "var(--muted-foreground)", background: "none", border: "none", cursor: "pointer" }}
              >
                Clear
              </button>
            )}
          </div>
          <textarea
            value={systemPrompt}
            onChange={(e) => updateSystemPrompt(e.target.value)}
            placeholder="E.g., You are an expert TypeScript coding assistant. Answer concisely with code snippets."
            rows={2}
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--border)",
              backgroundColor: "var(--surface)",
              color: "var(--foreground)",
              fontSize: "0.85rem",
              lineHeight: 1.4,
              resize: "vertical",
            }}
          />
        </div>
      )}

      {/* Expandable Parameters Drawer */}
      {showParameters && (
        <div
          style={{
            padding: "0.85rem 1.25rem",
            borderRadius: "0.5rem",
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "1.5rem",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem" }}>
            <span style={{ color: "var(--muted-foreground)" }}>Temperature:</span>
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={temperature}
              onChange={(e) => setTemperature(parseFloat(e.target.value))}
              style={{ width: "80px" }}
            />
            <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{temperature.toFixed(1)}</span>
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem" }}>
            <span style={{ color: "var(--muted-foreground)" }}>Max Tokens:</span>
            <input
              type="number"
              min="64"
              max="16384"
              step="128"
              value={maxTokens}
              onChange={(e) => setMaxTokens(parseInt(e.target.value, 10) || 2048)}
              style={{
                width: "90px",
                padding: "0.2rem 0.4rem",
                borderRadius: "0.25rem",
                border: "1px solid var(--border)",
                backgroundColor: "var(--surface)",
                color: "var(--foreground)",
                fontFamily: "monospace",
              }}
            />
          </label>

          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8125rem", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={streamEnabled}
              onChange={(e) => setStreamEnabled(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            <span>Stream SSE Responses</span>
          </label>
        </div>
      )}

      {/* Main Chat Conversation Window */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          borderRadius: "0.5rem",
          border: "1px solid var(--border)",
          backgroundColor: "var(--card)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "1.25rem",
            display: "flex",
            flexDirection: "column",
            gap: "1.25rem",
          }}
        >
          {messages.map((msg) => {
            const isUser = msg.role === "user";
            return (
              <div
                key={msg.id}
                style={{
                  display: "flex",
                  justifyContent: isUser ? "flex-end" : "flex-start",
                }}
              >
                <div
                  style={{
                    maxWidth: "85%",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: isUser ? "flex-end" : "flex-start",
                    gap: "0.35rem",
                  }}
                >
                  <div
                    style={{
                      padding: "0.75rem 1rem",
                      borderRadius: isUser ? "0.75rem 0.75rem 0.15rem 0.75rem" : "0.75rem 0.75rem 0.75rem 0.15rem",
                      backgroundColor: isUser ? "var(--accent)" : "var(--row-hover)",
                      color: isUser ? "#ffffff" : "var(--foreground)",
                      border: isUser ? "none" : "1px solid var(--border)",
                      fontSize: "0.875rem",
                      lineHeight: 1.55,
                      wordBreak: "break-word",
                      boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                    }}
                  >
                    {msg.images && msg.images.length > 0 && (
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.5rem" }}>
                        {msg.images.map((src, idx) => (
                          <img
                            key={idx}
                            src={src}
                            alt=""
                            style={{
                              width: "70px",
                              height: "70px",
                              objectFit: "cover",
                              borderRadius: "0.375rem",
                              border: "1px solid rgba(255,255,255,0.2)",
                            }}
                          />
                        ))}
                      </div>
                    )}
                    {isUser ? (
                      <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
                    ) : (
                      <Markdown content={msg.content} />
                    )}
                  </div>

                  {/* Metadata & Copy Action for Assistant Messages */}
                  {!isUser && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                        fontSize: "0.72rem",
                        color: "var(--muted-foreground)",
                        padding: "0 0.25rem",
                        flexWrap: "wrap",
                      }}
                    >
                      {msg.meta?.servedBy && (
                        <span>
                          Served by: <strong style={{ color: "var(--foreground)", fontFamily: "monospace" }}>{msg.meta.servedBy}</strong>
                        </span>
                      )}
                      {msg.meta?.ttftMs !== undefined && (
                        <span>TTFT: <strong style={{ color: "var(--foreground)" }}>{msg.meta.ttftMs}ms</strong></span>
                      )}
                      {msg.meta?.totalDurationMs !== undefined && (
                        <span>Total: <strong style={{ color: "var(--foreground)" }}>{msg.meta.totalDurationMs}ms</strong></span>
                      )}
                      {msg.content && (
                        <button
                          type="button"
                          onClick={() => copyToClipboard(msg.content, msg.id)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.25rem",
                            background: "transparent",
                            border: "none",
                            color: copyNotice === msg.id ? "var(--accent)" : "var(--muted-foreground)",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          {copyNotice === msg.id ? <Check size={11} /> : <Copy size={11} />}
                          <span>{copyNotice === msg.id ? "Copied" : "Copy"}</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Streaming Indicator */}
          {streaming && !messages[messages.length - 1]?.content && (
            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <div
                style={{
                  padding: "0.6rem 0.9rem",
                  borderRadius: "0.75rem",
                  backgroundColor: "var(--row-hover)",
                  border: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                }}
              >
                <span className="animate-spin"><RefreshCw size={14} style={{ color: "var(--accent)" }} /></span>
                <span style={{ fontSize: "0.8125rem", color: "var(--muted-foreground)" }}>Waiting for first token…</span>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input & Attachment Box */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files) void handleAddFiles(e.dataTransfer.files);
          }}
          style={{
            padding: "0.75rem 1rem",
            borderTop: "1px solid var(--border)",
            backgroundColor: dragging ? "rgba(59, 130, 246, 0.08)" : "var(--surface)",
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
          }}
        >
          {/* Staged Attachments Chips */}
          {attachments.length > 0 && (
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {attachments.map((att) => (
                <div
                  key={att.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    padding: "0.2rem 0.5rem",
                    borderRadius: "0.375rem",
                    border: "1px solid var(--border)",
                    backgroundColor: "var(--card)",
                    fontSize: "0.75rem",
                  }}
                >
                  {att.kind === "image" && att.dataUrl ? (
                    <img src={att.dataUrl} alt="" style={{ width: "20px", height: "20px", objectFit: "cover", borderRadius: "0.2rem" }} />
                  ) : (
                    <FileText size={14} style={{ color: "var(--muted-foreground)" }} />
                  )}
                  <span style={{ maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {att.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(att.id)}
                    style={{ background: "transparent", border: "none", cursor: "pointer", padding: "0 0.15rem", color: "var(--muted-foreground)" }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Attachment Error or Vision Warning */}
          {attachmentError && (
            <div style={{ fontSize: "0.75rem", color: "var(--danger)", display: "flex", alignItems: "center", gap: "0.35rem" }}>
              <AlertTriangle size={12} /> {attachmentError}
            </div>
          )}
          {stagedImages.length > 0 && !modelSupportsVision && (
            <div style={{ fontSize: "0.75rem", color: "#eab308", display: "flex", alignItems: "center", gap: "0.35rem" }}>
              <AlertTriangle size={12} /> Note: Model "{selectedModel}" may not support vision or image analysis.
            </div>
          )}

          <form onSubmit={handleSend} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTRIBUTE}
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) void handleAddFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              title="Attach text files (.txt, .md, .json, .csv) or images"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "0.6rem",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                background: "var(--card)",
                color: "var(--muted-foreground)",
                cursor: streaming ? "not-allowed" : "pointer",
              }}
            >
              <Paperclip size={16} />
            </button>

            <textarea
              ref={textareaRef}
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              onPaste={(e) => {
                const files = e.clipboardData?.files;
                if (files && files.length > 0) {
                  e.preventDefault();
                  void handleAddFiles(files);
                }
              }}
              placeholder="Send a message or drop files/images… (Enter to send, Shift+Enter for newline)"
              rows={2}
              style={{
                flex: 1,
                padding: "0.5rem 0.75rem",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                backgroundColor: "var(--card)",
                color: "var(--foreground)",
                fontSize: "0.875rem",
                lineHeight: 1.4,
                resize: "none",
              }}
            />

            {streaming ? (
              <button
                type="button"
                onClick={handleStop}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.35rem",
                  padding: "0.6rem 1rem",
                  borderRadius: "0.375rem",
                  border: "1px solid var(--danger)",
                  background: "rgba(239, 68, 68, 0.1)",
                  color: "var(--danger)",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                }}
              >
                <Square size={14} /> Stop
              </button>
            ) : (
              <button
                type="submit"
                disabled={!inputPrompt.trim() && attachments.length === 0}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "0.35rem",
                  padding: "0.6rem 1.15rem",
                  borderRadius: "0.375rem",
                  border: "none",
                  backgroundColor: !inputPrompt.trim() && attachments.length === 0 ? "var(--row-hover)" : "var(--accent)",
                  color: !inputPrompt.trim() && attachments.length === 0 ? "var(--muted-foreground)" : "#ffffff",
                  cursor: !inputPrompt.trim() && attachments.length === 0 ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                }}
              >
                <Send size={14} /> Send
              </button>
            )}
          </form>
        </div>
      </div>

      {/* Code Snippet Modal */}
      {codeModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="code-modal-title"
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setCodeModalOpen(false);
          }}
        >
          <div
            style={{
              backgroundColor: "var(--card)",
              borderRadius: "0.75rem",
              border: "1px solid var(--border)",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.3)",
              width: "100%",
              maxWidth: "640px",
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div
              style={{
                padding: "1rem 1.25rem",
                borderBottom: "1px solid var(--border)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <h3 id="code-modal-title" style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>
                API Request Code Snippet
              </h3>
              <button
                type="button"
                onClick={() => setCodeModalOpen(false)}
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)" }}
              >
                <X size={18} />
              </button>
            </div>

            <div style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                {(["curl", "python", "node"] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => setCodeLang(lang)}
                    style={{
                      padding: "0.35rem 0.75rem",
                      borderRadius: "0.375rem",
                      border: "1px solid var(--border)",
                      background: codeLang === lang ? "var(--accent)" : "var(--surface)",
                      color: codeLang === lang ? "#ffffff" : "var(--foreground)",
                      fontWeight: codeLang === lang ? 600 : 400,
                      fontSize: "0.8125rem",
                      cursor: "pointer",
                      textTransform: "uppercase",
                    }}
                  >
                    {lang}
                  </button>
                ))}
              </div>

              <div style={{ position: "relative" }}>
                <pre
                  style={{
                    margin: 0,
                    padding: "1rem",
                    borderRadius: "0.5rem",
                    backgroundColor: "var(--surface)",
                    border: "1px solid var(--border)",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    lineHeight: 1.4,
                    overflowX: "auto",
                    maxHeight: "340px",
                  }}
                >
                  {getCodeSnippet(codeLang)}
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(getCodeSnippet(codeLang));
                    setCopiedCode(true);
                    setTimeout(() => setCopiedCode(false), 2000);
                  }}
                  style={{
                    position: "absolute",
                    top: "0.5rem",
                    right: "0.5rem",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.25rem",
                    padding: "0.25rem 0.5rem",
                    borderRadius: "0.25rem",
                    border: "1px solid var(--border)",
                    backgroundColor: "var(--card)",
                    color: copiedCode ? "var(--accent)" : "var(--foreground)",
                    fontSize: "0.75rem",
                    cursor: "pointer",
                  }}
                >
                  {copiedCode ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copiedCode ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>

            <div
              style={{
                padding: "0.75rem 1.25rem",
                borderTop: "1px solid var(--border)",
                backgroundColor: "var(--row-hover)",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                onClick={() => setCodeModalOpen(false)}
                className="button-secondary"
                style={{ padding: "0.4rem 0.8rem", fontSize: "0.8125rem" }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
