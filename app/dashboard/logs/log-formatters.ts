const USER_AGENT_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /OpenAI\/JS\s*([^\s)]+)/i, name: "OpenAI/JS" },
  { pattern: /Claude-Code\/([^\s)]+)/i, name: "Claude Code" },
  { pattern: /claude-cli\/([^\s)]+)/i, name: "Claude Code" },
  { pattern: /Apifox\/([^\s)]+)/i, name: "Apifox" },
  { pattern: /PostmanRuntime\/([^\s)]+)/i, name: "Postman" },
  { pattern: /curl\/([^\s)]+)/i, name: "curl" },
  { pattern: /python-requests\/([^\s)]+)/i, name: "python-requests" },
  { pattern: /node\/([^\s)]+)/i, name: "Node.js" },
  { pattern: /Edg\/([^\s)]+)/i, name: "Edge" },
  { pattern: /Chrome\/([^\s)]+)/i, name: "Chrome" },
  { pattern: /Firefox\/([^\s)]+)/i, name: "Firefox" },
  { pattern: /Version\/([^\s)]+).*Safari\//i, name: "Safari" },
  { pattern: /Safari\/([^\s)]+)/i, name: "Safari" },
];

export function formatDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;

  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} s`;

  const min = sec / 60;
  if (min < 60) return `${min.toFixed(2)} m`;

  const hour = min / 60;
  return `${hour.toFixed(2)} h`;
}

export function formatUserAgent(value: string | null | undefined) {
  if (!value) return "-";
  const text = value.trim();
  for (const rule of USER_AGENT_PATTERNS) {
    const match = text.match(rule.pattern);
    if (match?.[1]) return `${rule.name} ${match[1]}`;
  }
  return text
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ") || text;
}
