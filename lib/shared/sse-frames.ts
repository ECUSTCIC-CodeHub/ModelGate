export type SseFrame = {
  event: string;
  data: string;
  hasData: boolean;
  raw: string;
};

export type SseFrameReader = {
  push(chunk: string): SseFrame[];
  pending(): string;
};

function stripOneLeadingSpace(value: string): string {
  return value.startsWith(" ") ? value.slice(1) : value;
}

// [DONE] 是非 JSON 哨兵，JSON 载荷对多余空格有容忍度、哨兵没有：
// 部分 OpenAI 兼容上游会写成 `data:  [DONE]`（两个空格），只剥一个空格后会失配，
// 解码器随即把它当 JSON 解析并抛错，导致流异常中断。这里单独对哨兵做 trim 比较。
export function isDoneSentinel(data: string): boolean {
  return data === "[DONE]" || data.trim() === "[DONE]";
}

// 按 SSE 规范只剥离一个前导空格：`data:   x` 的值是 `  x`，
// 原先的 trimStart 会把纯文本多行 data 的缩进一并吃掉。
export function parseSseFrame(raw: string): SseFrame {
  let event = "";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    // 跨 chunk 的 CRLF 已在上层归一化，这里兜住残余的单个 CR
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.startsWith("event:")) {
      event = text.slice(6).trim();
    } else if (text.startsWith("data:")) {
      dataLines.push(stripOneLeadingSpace(text.slice(5)));
    }
  }
  return { event, data: dataLines.join("\n"), hasData: dataLines.length > 0, raw };
}

// 逐帧读取 SSE。归一化必须作用在累积缓冲上：`\r` 与 `\n` 落在相邻两个 chunk 时，
// 逐块 replace 看不到这一对，帧分隔符会失配并静默丢帧。
export function createSseFrameReader(): SseFrameReader {
  let buffer = "";
  return {
    push(chunk: string): SseFrame[] {
      buffer = (buffer + chunk).replace(/\r\n/g, "\n");
      const frames: SseFrame[] = [];
      while (true) {
        const index = buffer.indexOf("\n\n");
        if (index === -1) break;
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        frames.push(parseSseFrame(raw));
      }
      return frames;
    },
    pending(): string {
      return buffer;
    },
  };
}
