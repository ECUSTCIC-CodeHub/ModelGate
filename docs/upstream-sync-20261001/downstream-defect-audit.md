# ModelGate 上游（Go 分支）2026-10-01 收敛修复分析报告

> 分析对象：upstream 仓库 `upstream/go` 分支，2026-10-01 最终加固提交组。
> 下游基线：本地 Next.js/TypeScript 版 ModelGate（工作目录 `D:\Documents\ecustcic\ModelGate`，最后同步约 2026-07-09）。
>
> 本报告只提取**产品级语义与缺陷本质**，不复述 Go 语法。每条都给出「缺陷 / 正确行为 / 下游是否可能同样存在」。
> 「下游是否可能同样存在」一栏基于对下游实际代码的阅读（已注明文件与行号），非推测；未能定位到对应实现的地方明确写「未定位」。

---

## 零、结论速览

| 分组 | 必须移植（下游确认有同源缺陷） | 建议移植（实现无关的协议/HTTP 正确性） | 不适用（Go 实现细节） |
|:---|:---|:---|:---|
| 协议转换 | `146b6eb`、`6f18246`、`922→8ec9fd8`、`09068a8`、`251f533`、`ada95de`、`6520c9a`、`0c18ad1`(部分)、`f210e44`(部分)、`a5f90b9`(部分)、`b9ae580` | `6882b79`、`17a3b96`、`ec31db4`、`67c529c` | — |
| 安全鉴权 | `6cf905e`、`77bf9ed`、`f04440b`、`1423bc2`、`ec9e3ec`(2/3 项)、`c77ea0b`、`3be07c1` | `75a836e`(已间接防护)、`3fd4f36`、`6c64e40` | `41c1ead`(部分) |
| 存储并发 | `f7e484d`(同类)、`dfc4ab7`、`1c4f1ac`、`2179adb`、`9e96d2a` | `1332542`、`b449c36` | — |

---

## 一、协议转换修复

### 1. `146b6eb` Anthropic 历史转 Chat 时剥离 thinking 注入

**缺陷**
中间协议 `Request.Messages` 保留 Anthropic 的 `thinking` 内容块。当该请求要转到 Chat Completions 上游时，`chatRequestFromIntermediate` 里有一条判断：

```
preserveThinking := req.SourceProtocol == Anthropic && msg.Role == "assistant"
```

于是 assistant 历史里的 thinking 块被**原样写进 Chat 的 `content` 数组**，同时还把 thinking 文本抽出来写进一个**非标准的 `reasoning` 顶层字段**。这两个结构对严格 Chat 上游（OpenAI 官方端点等）都是未知字段，直接 400。

**正确行为**
- 请求方向 `partsToChatContent(parts, preserveThinking)` 的 `preserveThinking` **必须恒为 `false`**，thinking 块整体丢弃。
- 不再向 Chat messages 注入 `reasoning` 字段。
- **响应方向不受影响**：`chatContentFromIntermediate` 仍然在 `opts.thinkingEnabled` 为真时保留 thinking 块，客户端显式请求推理时依旧可见。

**下游是否可能同样存在：✅ 存在，且是同一处逻辑**
`lib/gateway/protocol-adapters/chat-completions-request.ts:1063`

```ts
const preserveThinking = request.sourceProtocol === "anthropic_messages" && message.role === "assistant";
```

随后 `:1067` / `:1092` 把它传给 `normalizedPartsToChatContent(..., { preserveThinking })`，并且 `:1070` / `:1095` 通过 `chatReasoningFields()` 注入 `reasoning` + `reasoning_content` 两个字段。与上游修复前的 Go 代码逐字对应。

**移植方式**：把 `preserveThinking` 在请求方向固定为 `false`（可直接删除该变量与 `chatReasoningFields` 的调用，但注意 `normalizeResponsesMessagesForChat` 里对 pendingThinking 的合并逻辑另见第 4 条），响应方向 `chat-completions-response.ts:1368` 的 `options?.thinkingEnabled` 分支保持不变。

---

### 2. `6f18246` length 截断语义在三协议间无损透传

**缺陷**
中间协议的 `StopReason` 只承载 `stop` / `tool_calls` 两种语义：

- `anthropicResponseToIntermediate` 直接把 Anthropic 的 `stop_reason` **原样**赋给 `StopReason`（`"max_tokens"` 不做映射）；而 `chatResponseFromIntermediate` 又用 `finishReasonFromAnthropic(resp.StopReason, ...)` 反查，`max_tokens` 落进 else 分支变成 `end_turn`。
- 结果：Anthropic `max_tokens` → Chat 只能得到 `stop`；Chat `length` → Anthropic 只能得到 `end_turn`。
- 依赖 `finish_reason: "length"` 判断「输出被 token 上限截断、需要续写」的客户端（大量 Agent/自动续写框架）**永远感知不到截断**。
- 测试里还专门锁定了这个有损行为（`"max_tokens (no tools) should become end_turn"`）。

**正确行为**
中间协议 `StopReason` 扩为三值：`stop` / `tool_calls` / `length`，并做双向映射：

| 协议 | 表达截断的字段 | 映射 |
|:---|:---|:---|
| Chat Completions | `choices[0].finish_reason = "length"` | ↔ 中间 `length` |
| Anthropic Messages | `stop_reason = "max_tokens"` | ↔ 中间 `length` |
| OpenAI Responses | `status = "incomplete"` + `incomplete_details.reason = "max_output_tokens"` | ↔ 中间 `length` |

关键优先级：**截断原因优先于工具调用**。`finishReasonToAnthropic` / `chatResponseFromIntermediate` 都先判 `length` 再判 `tool_calls`，否则「截断的同时已经产出了 tool_call」会被误报成 `tool_use`/`tool_calls`。

流式同步：
- `stream_anthropic.go` 解码 `message_delta.delta.stop_reason == "max_tokens"` → `finishReason = "length"`；编码 `emitDone` 时 `reason == "length"` → `stopReason = "max_tokens"`。
- `stream_responses.go` encoder 新增 `finishReason` 字段，`finish` 事件时记录；`writeDone` 若为 `length` 则把 `status` 改成 `incomplete`、填 `incomplete_details`，并且**事件名从 `response.completed` 改为 `response.incomplete`**。

**下游是否可能同样存在：✅ 全面存在**
- `lib/gateway/protocol-adapters/intermediate.ts:434-442`：

```ts
export function finishReasonToAnthropic(value, hasTools) {
  if (value === "tool_calls" || hasTools) return "tool_use";
  return "end_turn";            // ← length 丢失
}
export function finishReasonFromAnthropic(value, hasTools) {
  if (value === "tool_use" || hasTools) return "tool_calls";
  return "stop";                // ← max_tokens 丢失
}
```

- `anthropic-response.ts:1652` `stop_reason: typeof body.stop_reason === "string" ? body.stop_reason : null` —— 未归一化。
- `chat-completions-response.ts:1436-1438` 对 Anthropic 源走 `finishReasonFromAnthropic`，对其它源直接透传 `response.stop_reason ?? "stop"`（Chat→Chat 的 `length` 恰好能活，但跨协议全丢）。
- `responses-response.ts:1517` `stop_reason: extracted.toolCalls.length > 0 ? "tool_calls" : "stop"` —— 完全不读 `incomplete_details`；`:1536-1538` 输出永远 `status: "completed"` + `incomplete_details: null`。
- 流式：`anthropic-decode.ts` 的 `delta.stop_reason === "tool_use" ? "tool_calls" : "stop"`；`responses-decode.ts` 只处理 `response.completed`，**完全没有 `response.incomplete` 分支**（上游修复前也一样）。

**移植方式**：中间协议加 `"length"`；三处 `stop_reason` 解码归一化；三处编码加优先级；流式响应侧补 `response.incomplete` 事件处理与 encoder 的 incomplete 输出。

---

### 3. `ada95de` 流式解码透出上游错误事件

**缺陷**
三个流式解码器把上游的**错误事件当噪声静默忽略**：

- Chat：`data: {"error":{...}}` 块里没有 `choices`，被直接跳过。
- Anthropic：`event: error`（`overloaded_error` 等）不匹配任何 case，被跳过。
- Responses：`response.failed` 不匹配任何 case，被跳过。

三种情况都表现为「流在完成信号前结束」，网关统一误报成**流截断**，把上游真实的限流/过载/内容策略拒绝原因彻底吞掉，运维完全无从排查。

**正确行为**
解码器遇到错误事件必须**终止转发并返回携带上游 message 的错误**：

- Chat：帧里存在 `error` 字段即报错。
- Anthropic：`event == "error"` 即报错。
- Responses：`event == "response.failed"` 或 `event == "error"`；错误载荷优先取 `parsed["error"]`，为空则回退 `parsed["response"]["error"]`。

新增统一提取函数 `upstreamErrorText`：依次尝试 `{message}` → `{code}` → 字符串本身 → 兜底 `"未知错误"`。所有错误统一包装为 `上游流式返回错误: <message>`。

**下游是否可能同样存在：✅ 存在**
- `lib/gateway/protocol-adapters/streaming/chat-completions-decode.ts` —— 循环里只做 `parseChatChunkEvent`，**没有任何 `error` 分支**（对比 `lib/gateway/protocol-adapters/streaming/common.ts` 的 `createPassthroughStream` 也一样，只 `try/catch` 忽略解析失败）。
- `anthropic-decode.ts` —— 只处理 `message_start` / `content_block_start` / `content_block_delta` / `message_delta` / `message_stop`，**无 `error` 分支**。
- `responses-decode.ts` —— 只处理 `response.created|in_progress`、`output_text.delta`、`reasoning_text.delta`、`reasoning_summary_text.delta`、`output_text.done`、`reasoning_*_text.done`、`content_part.done`、`output_item.added|done`、`function_call_arguments.delta|done`、`response.completed`，**无 `response.failed` / `error` 分支**。

**移植方式**：三个 decoder 各加一个前置错误分支，把上游 message 透出；需要一个与 `upstreamErrorText` 等价的提取器。

---

### 4. `6520c9a` 多条 system 消息拼接进 Responses 的 instructions

**缺陷**
`responsesRequestFromIntermediate` 遍历消息时只取**第一条** system：

```go
if msg.Role == "system" {
    next["instructions"] = textFromParts(msg.Content, "\n")
    break        // ← 后面的 system/developer 全丢
}
```

Chat 协议允许任意多条 `system` / `developer` 消息，转 Responses 时只有 Responses 唯一的 `instructions` 字段可选，于是第 2 条起的系统提示词**静默丢失**——多段系统提示（角色设定 + 输出格式约束 + 安全要求）场景下模型行为完全跑偏。

**正确行为**
收集**所有** system 消息的文本，过滤空串，用 `"\n\n"`（空行）拼接写入 `instructions`；一条都没有时不设置该字段。

**下游是否可能同样存在：✅ 存在**
`lib/gateway/protocol-adapters/responses-request.ts:1231-1277` 的 `responsesRequestFromIntermediate` 里，`input` 是把**所有**消息平铺成 items，**根本没有 `instructions` 输出**。system 消息被 `normalizeResponsesMessageRole` 原样当成 `{type:"message", role:"system"}` 塞进 `input`。这与上游修复前的语义不同但同样是错的：Responses 上游对 `input` 里的 `system` role 处理与 `instructions` 优先级不同，且与下游 `chatCompletionsRequestFromIntermediate` 的反向处理（把 `instructions` 前置成 system 消息，见 `chat-completions-request.ts:839-849`）不对称。

同时注意下游**反向**方向已有正确雏形：`chat-completions-request.ts:1056` 用 `normalizeResponsesInstructions(request.messages, request.extra.instructions)` 把单条 `instructions` 拼成一条 system 消息。**该方向需要的是「多条 system → 拼接」，下游缺失。**

**移植方式**：`responsesRequestFromIntermediate` 中收集 `role === "system" || role === "developer"` 的文本，`\n\n` 拼接后写入 `next.instructions`，并把这些消息从 `input` 中排除。

---

### 5. `67c529c` 归一化跨 chunk 边界的 SSE CRLF 行结束符

**缺陷**
`readSSEFrames` 逐块做 `strings.ReplaceAll(chunk, "\r\n", "\n")`。当网络分片**恰好落在 `\r` 与 `\n` 之间**——上一块以 `\r` 结尾、本块以 `\n` 开头——两个字节分属不同 chunk，逐块替换谁也替换不掉，缓冲区里残留 `\r\n`。

后果分两种：
1. 若残留在帧分隔位置（`\r\n\r\n` 跨界），`strings.Index(buffer, "\n\n")` 找不到分隔符，**整个帧被静默丢弃**（永远等不到下一次 `\n\n`，或者把后续多帧黏成一帧）。
2. 若残留在 `data:` 值内部，`\r` 混进 JSON 文本，`json.Unmarshal` 失败，该帧被当噪声跳过。

**正确行为**
- 拼接前先处理跨块 CRLF：若 `buffer` 以 `\r` 结尾且新 chunk 首字节是 `\n`，先把 buffer 末尾的 `\r` 剥掉（等价于提前归一化）。
- 在 `parseSSEFrame` 里**逐行 `TrimSuffix(line, "\r")`** 兜底，确保残余 CR 绝不混进 data 值、也不破坏 `event:` 前缀识别。

**下游是否可能同样存在：✅ 存在（同一算法）**
所有下游 SSE 解析器都用同一模式 `buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")`，跨块 CRLF 同样漏掉，且**没有 TrimSuffix("\r") 兜底**：
- `lib/gateway/protocol-adapters/streaming/common.ts`（`createPassthroughStream`）
- `lib/gateway/protocol-adapters/streaming/chat-completions-decode.ts`
- `lib/gateway/protocol-adapters/streaming/anthropic-decode.ts`
- `lib/gateway/protocol-adapters/streaming/responses-decode.ts`

**移植方式**：抽一个共用的 SSE 帧读取器（下游已有 `streaming/common.ts` 可作落点），实现跨块 CRLF 剥离 + 逐行 `replace(/\r$/, "")`。

---

### 6. `17a3b96` tool_choice none 转 Anthropic 时不下发工具列表

**缺陷**
Chat 的 `tool_choice: "none"` 语义是**禁止调用工具**。Anthropic 没有 `none` 枚举值（只有 `auto` / `any` / `tool`），上游的做法是省略 `tool_choice` 字段。但**省略 `tool_choice` 时 Anthropic 的默认值是 `auto`（模型可自行调用工具）**，而 `tools` 列表仍然下发了——语义**完全反转**：客户端明确要求「不许用工具」，上游却拿到了可用工具且被允许调用。

**正确行为**
`tool_choice.Mode == "none"` 时，**同时省略 `tools` 列表**。Anthropic 侧没有工具列表就物理上无法调用工具，从而等效禁用，保持客户端意图。

**下游是否可能同样存在：✅ 存在**
- `lib/gateway/normalized-message/...` 无影响；问题在编码侧。
- 下游 `toolChoiceFromIntermediateForAnthropic`（`lib/gateway/protocol-adapters/tools.ts:707-713`）**确实返回 `{ type: "none" }`** 而不是省略——这是 Anthropic 官方 API 里**不存在**的取值，严格端点会 400（比上游修复前更糟）。
- 同时 `lib/gateway/protocol-adapters/anthropic-request.ts` 里 `if (request.tools !== undefined) next.tools = toolsFromIntermediateForAnthropic(request.tools);` **无条件下发 tools**，没有 `tool_choice === "none"` 的判断。

**移植方式**：`anthropic-request.ts` 中当 `request.tool_choice === "none"` 时跳过 `next.tools`，并让 `toolChoiceFromIntermediateForAnthropic("none")` 返回 `undefined`（不下发字段）。

---

### 7. `8ec9fd8` 保留 Responses 推理 summary 内容

**缺陷**
o 系 / gpt-5 系模型的**可见推理**在 Responses 协议里以 `reasoning` 输出项的 **`summary` 数组**（`type: "summary_text"` 块）暴露，而**不是** `content` 数组（`content` 里是加密的 `reasoning_text`）。上游解码只读 `reasoning.content`，导致：

- 非流式：跨协议转换后 thinking 内容**系统性为空**。
- 流式：`response.reasoning_summary_text.delta` 事件不被识别，推理内容全丢。

**正确行为**
- 非流式：`responsesResponseToIntermediate` 在聚合 reasoning 项时，除 `content` 外**追加遍历 `summary` 数组**里 `type == "summary_text"` 的 `text`。
- 流式：`response.reasoning_summary_text.delta` 与 `response.reasoning_text.delta` **同等对待**，都产出 `reasoning_delta`。

**下游是否可能同样存在：⚠️ 部分存在（非流式已修，流式已修，但需核对语义差异）**
- 非流式**下游已正确**：`lib/gateway/protocol-adapters/responses-response.ts:1483-1492`

```ts
const reasoningSummary = reasoningItems
  .flatMap((item) => normalizeContentParts(item.summary))
  .flatMap((part) => { if (part.type === "thinking") return [part.thinking];
                       if (part.type === "text") return [part.text]; return []; })
  .join("");
...
return { text, toolCalls, reasoning: reasoning || reasoningSummary };
```

  注意差异：下游用 **`reasoning || reasoningSummary`（优先 content，二者不叠加）**，上游修复是 **`reasoningText += summaryText`（叠加）**。若某上游同时返回 `content` 与 `summary`，两者结果不同。建议对齐上游的「叠加」。
- 流式**下游已正确**：`responses-decode.ts` 有独立的 `response.reasoning_summary_text.delta` 分支，`response.reasoning_summary_text.done` 也做了处理。

**结论**：此条下游基本已具备，只需确认 `reasoning || reasoningSummary` 的择一语义是否需要改为叠加。

---

### 8. `6882b79` 保留 Anthropic tool_result 消息内的兄弟内容块

**缺陷**
Anthropic 允许**同一条 `user` 消息**混排 `tool_result` 与文本/图片块：

```json
{"role":"user","content":[
  {"type":"tool_result","tool_use_id":"toolu_1","content":"result data"},
  {"type":"text","text":"additional context"}
]}
```

`NormalizeAnthropicMessages` 把 `tool_result` 收集进 `toolResults`、其余进 `textParts`，然后在 `len(toolResults) > 0` 时把 `textParts` **连同工具消息一起 `continue` 丢弃**。多轮工具对话中模型附带的说明/追加约束**静默消失**。

**正确行为**
展开工具消息之后，若 `textParts` 非空，**按原 role 追加为下一条消息**。

**下游是否可能同样存在：✅ 存在**
`lib/gateway/normalized-message/anthropic.ts`：

```ts
if (toolResults.length > 0) {
  for (const result of toolResults) {
    normalized.push({ role: "tool", tool_call_id: result.tool_call_id, content: ... });
  }
  continue;              // ← textParts 被丢弃
}
```

与上游修复前完全一致。

**移植方式**：在 `continue` 前补

```ts
if (textParts.length > 0) normalized.push({ role, content: textParts });
```

---

### 9. `09068a8` 结构化承载图片修复跨协议双向损坏

这一条包含**三个独立缺陷**，是本批最严重的协议修复。

**缺陷 A：Anthropic base64 图片退化为 unknown 块被丢弃**
`NormalizeAnthropicMessages` 遇到 `source.type == "base64"` 时，因为中间协议的 `ContentPart` **没有能承载 base64 的字段**，只能塞一个 `Type: "unknown"` 占位。该块在所有编码路径的 switch 里都命中不了任何分支，**图片被静默丢弃**。注释本身就承认了这个设计缺陷："中间协议没有安全的 base64 图片字段"。

**缺陷 B：Chat data:URL 转 Anthropic 生成非法 url source**
`partsToAnthropicContent` 对图片块**无条件**输出：

```go
"source": map[string]interface{}{"type": "url", "url": part.ImageURL}
```

而 Anthropic 的 `url` source **只接受 https URL**。Chat 的 `image_url` 大量使用 `data:image/png;base64,...` 内联形态，转过去就是一个**非法 source**，Anthropic 直接 400。

**缺陷 C：Anthropic base64 → Chat/Responses 无法回填**
即使 A 被修好，把 base64 塞进 `ImageURL` 字段也会让 Chat 侧收到一个裸 base64 字符串当 url，语义错误。

**正确行为**
1. 中间协议 `ContentPart` **新增两个字段**：`ImageMediaType string`、`ImageBase64 string`。
2. `NormalizeAnthropicMessages` 的 `source.type` 分支：
   - `"base64"` → `ContentPart{Type: "image", ImageMediaType: source.media_type, ImageBase64: source.data}`，**不再退化为 unknown**；
   - `"url"` → `ContentPart{Type: "image", ImageURL: source.url}`。
3. 新增 `anthropicImageSource(part)` 统一构造 Anthropic source：
   - `ImageBase64` 非空 → `{type:"base64", media_type, data}`；`media_type` 缺失时**兜底 `image/png`**（Anthropic 要求显式声明，否则请求无法解析）；
   - 否则尝试 `parseImageDataURL(ImageURL)` 解析 `data:` URL，成功则**解码为 base64 source**（`media_type` 取自逗号前的 meta，且必须 `image/` 前缀、`;base64` 后缀、data 非空）；
   - 都不是才回退 `{type:"url", url}`。
4. 新增 `dataURLForImage(mediaType, base64)`：Chat / Responses 方向把 base64 反向拼成 `data:<mediaType>;base64,<data>`。
5. `partsToChatContent` / `partsToResponseContent` 的 image 分支：`ImageURL` 为空且 `ImageBase64` 非空时，先合成 data:URL 再输出。

**下游是否可能同样存在：✅ 三个缺陷全部存在**
- **A**：`lib/gateway/normalized-message/anthropic.ts`

```ts
if (type === "image") {
  const source = asRecord(content.source);
  if (typeof source?.data === "string" && source.data.length > 0) {
    textParts.push({ type: "image", image_url: source.data, detail: null });   // ← 裸 base64 当 url
  } else if (typeof source?.url === "string" && source.url.length > 0) {
    textParts.push({ type: "image", image_url: source.url, detail: null });
  }
}
textParts.push(...normalizeContentParts([content]));   // ← 又追加一次
```

  下游比上游修复前更糟：把**裸 base64 数据**当 `image_url`，且随后**再 `push` 一次 `normalizeContentParts([content])`**——`type === "image"` 在 `normalizeContentParts`（`content.ts`）里也不匹配任何分支（只认 `image_url` / `input_image`），最终落到 `parts.push({type:"unknown", value:item})`，**同一张图产生一个错误 image part + 一个 unknown part**。
- **B**：`lib/gateway/normalized-message/content.ts` 的 `normalizedPartsToAnthropicContent`

```ts
if (part.type === "image") {
  return [{ type: "image", source: { type: "url", url: part.image_url } }];   // ← 无条件 url source
}
```

- **C**：`NormalizedContentPart` 类型（`lib/gateway/normalized-message/types.ts`）**只有 `{ type:"image"; image_url:string; detail? }`**，没有 base64 / media_type 字段，与中间协议缺字段同源。

**移植方式**：给 `NormalizedContentPart` 的 image 变体加 `image_base64?` / `image_media_type?`（或引入 `source` 子对象）；`normalizeAnthropicMessages` 正确分支且**去掉重复 push**；`normalizedPartsToAnthropicContent` / `normalizedPartsToChatContent` / `normalizedPartsToResponseContent` 三处按上述规则互转；新增 `parseImageDataURL` / `dataURLForImage` 工具。

---

### 10. `0c18ad1` 跨协议转换按目标协议白名单过滤扩展字段

**缺陷**
中间协议 `Request.Extra` 保存了「未建模的源协议私有字段」，用意是**同协议往返时不丢字段**。但跨协议转换时它被**原样透传给目标上游**：

- Anthropic 的 `top_k` → OpenAI 官方 Chat 端点：未知参数 400。
- Chat 的 `seed` / `presence_penalty` / `frequency_penalty` → Anthropic：未知参数 400。

**正确行为**
`AdaptRequest` 在 `outboundAdapter.RequestFromIntermediate(req)` **之前**调用 `filterCrossProtocolExtra(req, outbound)`，按目标协议白名单过滤：

| 目标协议 | 放行白名单 |
|:---|:---|
| ChatCompletions | `seed`、`presence_penalty`、`frequency_penalty`、`logit_bias`、`logprobs`、`top_logprobs`、`n`、`reasoning_effort`、`service_tier`、`store` |
| Anthropic | `top_k` |
| Responses | `service_tier`、`store` |

**同协议路径（`upstream == inbound`）不受影响**，扩展字段原样保留。

**下游是否可能同样存在：⚠️ 已有等价机制，但口径不同（需对齐）**
下游用的不是「白名单」而是「黑名单剔除」——`lib/gateway/protocol-adapters/protocol-extra.ts` 定义了三组 `*_ONLY_EXTRA_KEYS`，各方在 `requestFromIntermediate` 时按源协议 `omitKeys`：

- `anthropic-request.ts`：源 `responses` → 剔除 `CROSS_PROTOCOL_EXTRA_KEYS + RESPONSES_ONLY_EXTRA_KEYS`；源 `chat_completions` → 剔除 `CROSS_PROTOCOL_EXTRA_KEYS + CHAT_COMPLETIONS_ONLY_EXTRA_KEYS`；源 `anthropic_messages` → 只剔除 `CROSS_PROTOCOL_EXTRA_KEYS`。
- `chat-completions-request.ts`：源 `responses` → 剔除 `crossProtocolKeys + RESPONSES_ONLY_EXTRA_KEYS`；源 `anthropic_messages` → 剔除 `crossProtocolKeys + ANTHROPIC_ONLY_EXTRA_KEYS`。
- `responses-request.ts`：`responseExtraFromIntermediate()` 同构。

风险点：**黑名单是穷举的**，任何未被列入的源协议私有字段都会继续透传（这正是上游改用白名单的原因）。且下游三处黑名单内容**互不相同**（例如 `reasoning` 只在 `RESPONSES_ONLY_EXTRA_KEYS` 与 `CHAT_COMPLETIONS_ONLY_EXTRA_KEYS` 里，`ANTHROPIC_ONLY_EXTRA_KEYS` 不含），容易出现漏网。

**移植方式（推荐）**：改为目标协议白名单，作为 `AdaptRequest` 统一后置过滤，同协议路径短路跳过。

---

### 11. `a5f90b9` Anthropic stop_sequences 映射到 Chat 的 stop

**缺陷**
Anthropic 的停止序列字段叫 `stop_sequences`，Chat 叫 `stop`。中间协议两者都建模（`Stop` / `StopSequences`），但 `chatRequestFromIntermediate` **只输出 `req.Stop`**：

```go
if req.Stop != nil { next["stop"] = req.Stop }
```

`req.StopSequences` 被**静默丢弃**——Anthropic 客户端设了停止序列，转到 Chat 上游后完全不生效，模型继续生成。

**正确行为**
`req.Stop == nil` 时用 `req.StopSequences` 承接，写入 Chat 的 `stop`。
**已知限制（上游明确保留不修）**：Responses API **没有原生停止序列字段**，`req.Stop` / `req.StopSequences` 无法映射，只能丢弃——上游在 `responsesRequestFromIntermediate` 里补了注释说明这是跨协议已知限制。

**下游是否可能同样存在：✅ 部分存在**
- Chat 方向**下游已正确**：`lib/gateway/protocol-adapters/chat-completions-request.ts:1109` `if (request.stop !== undefined) next.stop = request.stop;` —— **但没有 `stop_sequences` 回退**。Anthropic→Chat 时 `anthropicRequestToIntermediate`（`anthropic-request.ts:64`）只填 `stop_sequences: body.stop_sequences`，**不填 `stop`**，因此 `request.stop` 为 `undefined`，`stop_sequences` 被丢弃。**同一缺陷。**
- Anthropic 方向**下游已正确**：`anthropic-request.ts` 有 `if (request.stop !== undefined && request.stop_sequences === undefined)` 的反向承接。
- Responses 方向：下游同样无字段可映射（与上游一致，属已知限制）。

**移植方式**：`chat-completions-request.ts` 中 `next.stop = request.stop ?? request.stop_sequences;`。

---

### 12. `f210e44` 建模 max_completion_tokens 修复 o 系模型跨协议转换

**缺陷**
o1 / o3 / o4 等推理系模型只接受 `max_completion_tokens`，**拒绝 `max_tokens`**。Chat 的请求键列表 `chatRequestKeys` 里**没有 `max_completion_tokens`**，因此该字段：

1. 不会被建模成中间协议的 `MaxTokens`；
2. 反而落进 `Extra`，跨协议转换时被**作为未知参数透传给严格上游**（Anthropic 等），触发 400。

结果是 o 系模型跨协议转换**既丢了输出上限，又带上一个非法参数**，双重失败。

**正确行为**
1. `chatRequestKeys` 加入 `"max_completion_tokens"`，使其从 `Extra` 中剔除。
2. `max_tokens` 缺失时读取 `max_completion_tokens` 填入中间协议 `MaxTokens`。
3. Responses 方向由既有的 `max_output_tokens` 输出路径自动承接。

**下游是否可能同样存在：⚠️ 已部分正确，但仍有一个残留风险**
- `lib/gateway/protocol-adapters/chat-completions-request.ts:818` **已建模**：

```ts
maxTokens: body.max_tokens ?? body.max_completion_tokens,
```

- `REQUEST_KEYS`（`:739-757`）**已包含 `"max_completion_tokens"`**，所以不会被塞进 `extra`。

**结论**：下游此项**已正确**，与上游修复语义等价。但 `CHAT_COMPLETIONS_ONLY_EXTRA_KEYS`（`protocol-extra.ts:469`）里仍列有 `max_completion_tokens`——这是用于**跨协议剔除源协议私有键**的黑名单，作用是防御性的，保留无害。

---

### 13. `ec31db4` Chat 流式解码延迟 finish 让真实 usage 先到达

**缺陷**
Chat 上游的 SSE 顺序是：

```
... finish_reason: "stop"  →  usage 块  →  data: [DONE]
```

解码器在收到 `finish_reason` 时**立即** `sink(finish)`。`finish` 是终止事件，下游编码器收到即收尾并生成最终 usage —— 此时**真实 usage 块还没到**，客户端拿到的是本地**估算值**：

- Anthropic 方向：`message_delta.output_tokens` 是估算而非真实。
- Responses 方向：`usage` 同理。

**正确行为**
- `finish_reason` **只缓存到 `pendingFinish`，不立即发 `finish`**。
- 延迟到 `data: [DONE]` 或读循环正常结束时再发 `finish`。
- 上游在 `finish_reason` 后**没有 `[DONE]` 就直接断流**时，读循环结束仍需按已确认的完成原因补发 `finish`（**不能误报截断**）。
- `[DONE]` 分支：若 `pendingFinish` 为空（兼容只有 `[DONE]` 没有 `finish_reason` 的上游）则归一为 `"stop"`；非空则用缓存的真实原因，并清空缓存。

**下游是否可能同样存在：✅ 存在**
`lib/gateway/protocol-adapters/streaming/chat-completions-decode.ts`：

```ts
if (parsed.finishReason) {
  controller.enqueue({ type: "finish", reason: parsed.finishReason });   // ← 立即发
}
```

且 `[DONE]` 分支是 `if (data === "[DONE]") continue;` —— **直接跳过，不产生任何 finish**。因此「无 `finish_reason` 只有 `[DONE]`」的上游在下游会**完全不产生 finish 事件**（上游修复前的 Go 代码至少会补 `stop`，下游更弱）。同时读循环 `done` 后只 `controller.close()`，**不补发 finish**。Anthropic 方向的 `anthropic-decode.ts` 也用同一模式（`finish_reason` 在内就绪，`message_delta` 立刻 enqueue usage——该文件顺序恰好不同，`usage` 在 `message_delta` 里本来就晚于 `stop_reason`，风险较低）。

**移植方式**：`chat-completions-decode.ts` 改为缓存 `pendingFinish`，在 `[DONE]` 与 `done` 两处补发。

---

### 14. `b9ae580` SSE data 前导空格按规范只剥一个

**缺陷**
解析 `data:` 行时用 `strings.TrimLeft(value, " ")`，**剥掉全部前导空格**。SSE 规范只允许剥**一个**（`data: ` 的单空格分隔符）。对于**纯文本多行 data**（非 JSON 事件），行首缩进被整体吃掉，内容畸变。

**正确行为**
改为 `strings.TrimPrefix(value, " ")`（只剥一个）；无空格的 `data:{"a":1}` 形态兼容不变。

**下游是否可能同样存在：✅ 存在（更严重）**
下游全部用 **`.trimStart()`**（等价于 `TrimLeft`，剥全部空白）：
- `lib/gateway/protocol-adapters/streaming/common.ts`
- `lib/gateway/protocol-adapters/streaming/chat-completions-decode.ts`
- `lib/gateway/protocol-adapters/streaming/anthropic-decode.ts`
- `lib/gateway/protocol-adapters/streaming/responses-decode.ts`

**移植方式**：全部换成「剥一个空格」语义：`line.slice(5).replace(/^ /, "")`。

---

### 15. `251f533` 工具空参数补 object schema 并修正 o 系模型词表

这一条包含两个独立修复。

**缺陷 A：工具 `parameters` 为 null**
`toolsFromIntermediateForChat` / `toolsFromIntermediateForResponses` 直接输出 `"parameters": tool.Parameters`。当源协议工具**没有声明参数 schema**（Anthropic 的 `input_schema` 缺失等）时，`Parameters` 为 `nil`，序列化成 JSON `null`，**部分严格上游拒绝 `parameters: null`**。Anthropic 方向本来就有兜底（`toolsFromIntermediateForAnthropic` 补 `{type:"object", properties:{}}`），Chat / Responses 方向缺失。

**正确行为**
Chat 与 Responses 方向同样在 `Parameters == nil` 时补 `{"type": "object"}`。

**下游是否可能同样存在：✅ 存在**
`lib/gateway/protocol-adapters/tools.ts`：

```ts
export function toolsFromIntermediateForChat(tools) {
  return tools.map((tool) => ({ type: "function", function: {
    name: tool.name, description: tool.description,
    parameters: asRecord(tool.parameters) ?? tool.parameters,   // ← null 时输出 null
    strict: tool.strict, } }));
}
export function toolsFromIntermediateForResponses(tools) {  // 同样问题
```

只有 `toolsFromIntermediateForAnthropic` 有 `?? { type: "object", properties: {} }` 兜底（`:655`）。注意下游还有第二个问题：`strict: tool.strict` 在 `undefined` 时会被 `JSON.stringify` 丢掉（可接受），但 `description: undefined` 同理——这两项无害。

**移植方式**：两个函数改为 `parameters: asRecord(tool.parameters) ?? tool.parameters ?? { type: "object" }`。

**缺陷 B：o1/o3/o4 token 估算系统性低估**
`tiktoken-go v0.7.0` 的模型前缀表**没有 o1/o3/o4**，`tokenizer.ForModel` 全部失配，回退 `cl100k_base`。而 o 系模型实际使用 `o200k_base`。两套词表对同一文本的 token 数差异可达 20-40%，导致 o 系模型的 token 估算**系统性低估**，影响配额扣减、日志计费、TPS 统计。

**正确行为**
新增 `oSeriesModel(model)` 识别 o 系模型名（`o1` / `o1-mini` / `o1-preview` / `o3` / `o3-2025` / `o4-mini`），命中时**显式映射到 `o200k_base`**。识别规则必须精确：前缀是 `o1`/`o3`/`o4` 且后续字符是空、`-`、`.` 或数字，避免误伤 `other-model`、`ollama` 等相似前缀。

**下游是否可能同样存在：需核对，倾向于存在**
下游有 `lib/gateway/tokenizer.ts` 与 `lib/gateway/token-estimate.ts`。请核查其 o 系模型词表选择逻辑。**本次未展开阅读这两个文件，标记为待验证。**

---

## 二、安全与鉴权修复

### 16. `6cf905e` 渠道上游密钥不再明文回传前端

**缺陷**
`GET /api/admin/channels`（列表）、创建响应、更新响应**全部原样返回 `api_key` 明文**。管理页任意一处 XSS（或任何一个被降权的管理员会话被读取）即可**一次性拿到全部供应商凭证**。同时 `/api/admin/channels/probe-models` 要求前端**回传明文 `api_key`**，让密钥在浏览器内存与网络里反复往返。

**正确行为**
- 新增 `maskAPIKey(key)`：空串返回空串（区分「未配置」）；长度 ≤ 8 返回 `"****"`；否则返回 `"****" + key[len-4:]`（末四位）。
- 列表 / 创建 / 更新响应中的 `api_key` 一律替换为脱敏值。
- 更新时若客户端回传的值**恰好等于当前脱敏值**，视为「管理员未修改」，**服务端保留原密钥**，避免掩码覆盖真实凭证。
- `probe-models` 新增可选 `channel_id`；提供时从服务端读取 `base_url` / `api_key` / `user_agent` / `proxy_url` 作为默认值（`api_key` 为空或等于脱敏值时用存储值），前端**不再回传明文密钥**。
- 前端渠道卡片直接展示服务端返回的脱敏值。

**下游是否可能同样存在：✅ 存在，且下游采用了另一套「私有密钥」机制但仍泄漏**
`app/api/admin/channels/route.ts` 的 `GET`：

```ts
api_key: canView ? channel.api_key : null,
```

下游做的是**权限门控**（`api_key_private` 渠道只有创建者可见），但：

1. **只要 `canView` 为真就返回完整明文**，没有任何脱敏。管理员（或渠道创建者）的浏览器里始终持有全部明文密钥。
2. `api_key_private` 默认为 0（`parsed.data.api_key_private === true ? 1 : 0`），意味着**新建渠道默认对所有管理员明文可见**。
3. `app/api/admin/channels/probe-models/route.ts` 的 `bodySchema` **只有 `base_url`（必填）、`api_key`、`user_agent`、`proxy_url`**——**没有 `channel_id`**，前端必须回传明文 `api_key`。与上游修复前完全一致。
4. 创建响应（`POST`）同样返回 `api_key: canViewCreated ? createdRow.api_key : null` 明文。

**移植方式**：引入 `maskApiKey`；列表/创建/更新响应统一脱敏；更新时脱敏值视为未修改；`probe-models` 加 `channel_id`。**注意与下游已有的 `api_key_private` 权限门控并存**——建议脱敏作为无条件底线，`api_key_private` 继续控制可见性（不可见时返回 `null`，可见时返回脱敏值）。同时必须评估 `API.md` 与前端 `channel-models-drawer.tsx` 的联动改动。

---

### 17. `ec9e3ec` 收敛密码验证的三个缺口

**缺陷（三个独立缺口）**

**(i) 改密接口无流控**
`POST /api/auth/change-password` 校验 `current_password` 时**完全没有限流**。攻击者只要持有一个被盗的**访问令牌**（例如从共享终端/日志里捞到），就可以用该令牌**无限次爆破当前密码**——而登录接口有 5 次/分钟限制，这条路径完全绕过了它。

**(ii) 用户名枚举时序侧信道**
`login` 里：

```go
if user == nil || user.Enabled != 1 || !auth.ComparePassword(...) {
```

短路求值：**用户不存在时 `ComparePassword` 根本不执行**，响应在几毫秒内返回；用户存在时则要跑完整次 bcrypt（cost 10，约 50-100ms）。攻击者按响应时延即可**枚举出有效用户名**，为后续定向爆破铺路。

**(iii) 超长密码 500**
密码只校验了下界 `len < 8`，没有上界。bcrypt **硬上限 72 字节**，超出部分 `GenerateFromPassword` 直接返回 `ErrPasswordTooLong`，最终变成 **500 内部错误**而非 400 参数错误。

**正确行为**
- **(i)** 改密接口复用登录限流器，以 `authCtx.User.Username` 为键；超限返回 429。
- **(ii)** 用户不存在时执行一次**等价耗时的哑哈希比较**：预生成 `dummyPasswordHash`（bcrypt cost 10，与真实哈希同强度），走同一条 `ComparePassword` 路径，抹平时序差。
- **(iii)** 统一密码长度 **8-72**，超长返回 400（错误文案同步改为「密码需为 8-72 位」），覆盖注册、管理员创建用户、管理员重置密码、改密四条路径。

**下游是否可能同样存在：⚠️ (i)(ii) 存在，(iii) 存在**
- **(i)** ✅ **存在**：`app/api/auth/change-password/route.ts` 只有 `ensureWebUser(request)` 守卫，**没有 `checkLoginRateLimit` 调用**，直接 `comparePassword(parsed.data.current_password, user.password_hash)`。
- **(ii)** ✅ **存在**：`app/api/auth/login/route.ts`

```ts
const user = await gatewayDb.queryOne<DbUser>("SELECT * FROM users WHERE username = ? AND deleted_at IS NULL", [parsed.data.username]);
if (!user || user.enabled !== 1) return jsonError("用户名或密码错误", 401);   // ← 短路，无哑比较
const ok = await comparePassword(parsed.data.password, user.password_hash);
```

- **(iii)** ✅ **存在**：下游各处的 zod schema 只有 `z.string().min(8)`（改密、注册），无 `.max(72)`；`lib/auth/validation.ts` 的错误文案也只有「密码长度至少 8 位」。bcryptjs 在超长密码下的行为需实测，但**缺少显式上界校验是确定的**。

**移植方式**：三处独立改动，互不依赖，建议一并做。注意下游登录限流是**内存 Map + `setInterval` 定期清扫**（`lib/auth/login-ratelimit.ts`），改密复用同一 `checkLoginRateLimit` 即可，键含 `username` 时口径一致。

---

### 18. `77bf9ed` 改密后撤销用户已签发的全部令牌

**缺陷**
令牌是**纯无状态 JWT**，签发后与数据库无任何绑定。`POST /api/auth/change-password` 只更新 `password_hash`，**不做任何令牌失效**。后果：用户的密码被改（自助改密或管理员重置）后，**所有此前签发的访问令牌与刷新令牌继续有效**直到自然过期（刷新令牌默认 7 天）。攻击者已持有的会话可以**无限续期**——改密这个动作在安全语义上完全失效。

**正确行为**
- `users` 表新增 `token_version` 列（默认 0，通过 `ensureColumn` 幂等加列）。
- 签发访问/刷新令牌时把 `user.TokenVersion` 写入 claims（`json:"tv,omitempty"`）。
- **修改密码**（`UpdateUserPassword`）与**管理员重置密码**（`UpdateAdminUser` 的 `PasswordHash != nil` 分支）**递增** `token_version`（`token_version + 1`）。
- 访问令牌校验（`authFromAccessToken`）与刷新令牌校验（`authFromRefreshToken`）都**比对数据库当前版本**，不一致返回 `ErrUnauthorized`。
- `POST /api/auth/refresh` 对版本落后的令牌返回 401 + 清理认证 Cookie + 文案「登录已过期，请重新登录」。

**下游是否可能同样存在：✅ 存在，且是完全的裸 JWT**
`lib/auth/auth.ts`：

```ts
type TokenPayload = { sub: string; role: "admin"|"user"; username: string; type: TokenType };
// 没有版本字段
export function signAccessToken(user) { return jwt.sign({ sub, role, username, type: "access" }, getAccessSecret(), {...}); }
export async function getAuthContextFromAccessToken(token) {
  ... payload = verifyAccessToken(token); ...
  const user = await findEnabledUserById(Number(payload.sub));   // 只查 enabled=1，不比对任何版本
  if (!user) return null;
  return {...};
}
```

- `app/api/auth/change-password/route.ts`：`UPDATE users SET password_hash = ? WHERE id = ?` —— **无任何令牌失效**。
- `app/api/admin/users/[id]/route.ts` 的管理员重置密码路径同样（需复核，但下游无 `token_version` 列，搜索 `token_version|tokenVersion` 结果为**空**）。
- `requireWebAuthWithRefresh` / `getServerProfileFromCookieStore` 里的刷新令牌校验也**只查 `enabled`**，无版本比对。

**移植方式**：加列 → 签发时写入 → 两处密码变更时递增 → 三处校验处比对（`getAuthContextFromAccessToken`、`requireWebAuthWithRefresh`、`getServerProfileFromCookieStore` 的 refresh 分支）→ `refresh` 路由返回 401 并清 Cookie。**这是本批安全修复中优先级最高的一条。**

---

### 19. `3be07c1` OIDC 回调地址仅从配置的对外域名构造

**缺陷**
`redirectURI` 由 `publicOrigin(c)` 构造，而 `publicOrigin` **完全依赖请求本身**：

```go
scheme := "http"; if c.Request.TLS != nil { scheme = "https" }
if forwarded := c.GetHeader("x-forwarded-proto"); forwarded != "" {
    scheme = strings.Split(forwarded, ",")[0]     // ← 任意 scheme 注入
}
return scheme + "://" + c.Request.Host            // ← Host 完全可伪造
```

两个攻击面：
1. **`Host` 头伪造**：`Host: evil.com` 即可让 `redirect_uri` 指向攻击者域名。OIDC 授权码会被 IdP 回跳到 `https://evil.com/api/auth/oidc/callback?code=...`，攻击者**直接拿到授权码**，换取令牌后完全接管账号。
2. **`x-forwarded-proto` 注入**：未做取值校验，可注入 `javascript` 等任意 scheme。

**正确行为**
1. `redirectURI` **只从设置里的 `public_base_url` 构造**（`strings.TrimRight(public_base_url, "/") + "/api/auth/oidc/callback"`）；**未配置时直接报错**，authorize 返回 400 提示「OIDC 登录需要先在设置中配置对外服务域名 public_base_url」，callback 则重定向到错误页——**绝不基于请求头推导**。
2. `x-forwarded-proto` **只接受 `http` / `https`**（小写化 + 去空格后判等），其余取值忽略并保留原 scheme。

**下游是否可能同样存在：✅ 存在**
`lib/auth/oidc.ts`：

```ts
export async function getPublicOrigin(requestUrl: string): Promise<string> {
  const s = await getGatewaySettings();
  if (s.public_base_url) return s.public_base_url;
  return new URL(requestUrl).origin;        // ← 未配置时回退到请求 origin
}
export async function resolveRedirectUri(requestUrl: string): Promise<string> {
  return `${await getPublicOrigin(requestUrl)}/api/auth/oidc/callback`;
}
```

下游**未配置 `public_base_url` 时回退到 `new URL(requestUrl).origin`**。Next.js 的 `request.url` 在 standalone/反代模式下的 host 同样来自 `Host` / `x-forwarded-host` 头（下游代码注释自己就承认了这一点：「在反代 / standalone 模式下，request.url 的 host 可能是内部地址 0.0.0.0:3000」）。**结论：Host 伪造路径存在**（是否可被外部直接利用取决于部署的反代是否覆写 `Host`）。下游代码里**没有** `x-forwarded-proto` 参与 scheme 推导，所以第 2 个子缺陷不适用。

**移植方式**：`getPublicOrigin` 未配置 `public_base_url` 时抛错（authorize 返回 400），不再回退请求 origin。**这是一个强行为变更，需要同步 `API.md` 并在升级说明里提示管理员先配置 `public_base_url`，否则 OIDC 登录会中断。**

---

### 20. `3da32d2` 登出重定向拦截反斜杠协议相对地址

**缺陷**
`logoutRedirect` 的开放重定向检查是：

```go
if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") { next = "/login" }
```

只拦了 `//`。但浏览器在解析 URL 时会把**反斜杠归一化为正斜杠**：`next=/\evil.com` 通过前缀检查（以 `/` 开头、不以 `//` 开头），实际被浏览器当作 `//evil.com` → **协议相对地址**，跳到攻击者站点。登出接口成为开放重定向入口（钓鱼/凭据收割链的一环）。

**正确行为**
校验 `next` 的**第二个字节不是 `/` 也不是 `\`**：

```go
second := next[1]
return second != '/' && second != '\\'
```

**下游是否可能同样存在：❌ 不存在（下游防护更强）**
`lib/shared/safe-next.ts` 的实现已显著强于上游修复：

```ts
if (!param.startsWith("/") || param.startsWith("//")) return fallback;
// 拒绝控制字符与反斜杠
if (/[\u0000-\u001F\u007F\\]/.test(param)) return fallback;
let url = new URL(param, "https://safe.invalid");
if (url.origin !== "https://safe.invalid") return fallback;
const decodedPath = decodeURIComponent(url.pathname);
if (/[\u0000-\u001F\u007F\\]/.test(decodedPath)) return fallback;
```

它**直接拒绝任何反斜杠与控制字符**（原始与解码后各校验一次），并用 `new URL()` 归一化后校验 origin，覆盖了 `/\evil.com`、`/%09/evil.com` 等变体。`app/api/auth/logout/route.ts` 的 `resolveSafeNext` 正确调用了它。

**结论**：下游该条**无需移植**。

---

### 21. `c77ea0b` 登录限流改用受信代理口径的客户端 IP

**缺陷**
限流键原本用 `ResolveClientIP(c)`，而该函数**无条件信任转发头**：

```go
key := ResolveClientIP(c) + ":" + strings.ToLower(strings.TrimSpace(username))
```

攻击者每次请求伪造一个新的 `X-Forwarded-For: 1.2.3.4`，就得到一个**全新的限流桶**，5 次/分钟的限制被彻底绕过，登录爆破无成本。

**正确行为**
1. 限流键改用 `c.ClientIP()` —— 由 `configureClientIP` 统一控制**受信代理边界**（只在配置了可信代理时才采信转发头），伪造转发头不再能开新桶。
2. 新增**过期条目定期清扫**（每过一个 `rateLimitWindow` 扫一次 `attempts`），防止大量一次性 key 让 `attempts` map **无限增长**（内存耗尽）。

**下游是否可能同样存在：⚠️ 部分存在（IP 口径需按部署核实；清扫已具备）**
`lib/auth/login-ratelimit.ts`：

```ts
function getKey(request: Request, username?: string): string {
  const ip = resolveClientIp(request.headers) ?? "unknown";
  ...
}
setInterval(() => { for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key); }, CLEANUP_INTERVAL_MS).unref();
```

- **清扫已具备**：`setInterval` + `CLEANUP_INTERVAL_MS = 300_000` + `.unref()`，比上游修复前更完善。✅ 此项无需移植。
- **IP 口径**：`lib/core/client-ip.ts` 的 `resolveClientIp` **无条件按优先级取 `eo-client-ip` → `x-forwarded-for` → `x-real-ip` 的第一个值**，没有任何受信代理边界校验：

```ts
export function resolveClientIp(headers: Headers): string | null {
  return firstHeaderValue(headers.get("eo-client-ip"))
    ?? firstHeaderValue(headers.get("x-forwarded-for"))
    ?? firstHeaderValue(headers.get("x-real-ip"));
}
```

  **在客户端可直连 Next.js 的部署下，伪造 `X-Forwarded-For` 即可绕过登录限流。** 但在 EdgeOne Pages 等平台后面部署时，平台会覆写这些头，风险被消解。**下游是否需要移植取决于部署形态**（建议加一个「受信代理」环境变量开关，默认不信任转发头）。

**移植方式**：引入可信代理配置（如 `TRUSTED_PROXY=1` 或 `TRUSTED_IP_HEADERS`），未配置时不采信转发头（回退到 socket 地址或统一 `"unknown"` 桶）。

---

### 22. `6c64e40` OIDC 签名密钥未知 kid 时强制刷新 JWKS

**缺陷**
`oidcSigningKey` 先 `fetchOIDCJWKS`（**带 5 分钟 TTL 缓存**），再在结果里按 `kid` 匹配。当 IdP **轮换签名密钥**（kid 变了）时：

1. 缓存命中（未过期）→ 直接返回旧 keys；
2. 新 kid 在旧 keys 里**匹配不到** → 返回「找不到签名密钥」错误。

于是**密钥轮换后，最长 5 分钟内所有 OIDC 登录全部失败**，管理员只能干等缓存过期或重启服务。

**正确行为**
- 缓存命中但 `kid` 匹配失败时，**绕过缓存强制重新拉取一次 JWKS 再重试**。
- 抽取 `matchOIDCJWK(keys, kid, alg)` 复用匹配逻辑，`fetchOIDCJWKS` / `fetchOIDCJWKSFresh` 分离：前者走缓存，后者总是真实请求并**在成功后才更新缓存**（同时把缓存写入时间从误用的 `now` 改为 `time.Now()`）。
- 细节：`kid` 为空时（无法定向刷新）直接返回原错误，不做无谓刷新。

**下游是否可能同样存在：⚠️ 需按实现差异核实，倾向于存在**
`lib/auth/oidc.ts` 的缓存结构：

```ts
const jwksCache = new Map<string, { keys: OidcJwk[]; expiresAt: number }>();
const DISCOVERY_TTL_MS = 5 * 60 * 1000;   // JWKS 复用同一 TTL
async function fetchJwks(jwksUri: string): Promise<OidcJwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > now) return cached.keys;   // ← 5 分钟 TTL 命中即返回
  ...
}
```

**TTL 与上游修复前一致（5 分钟）**，且**在缓存返回路径上看不到「kid 未命中则强制刷新」的分支**。由于 `fetchJwks` 只是返回 keys 列表，kid 匹配发生在调用方，所以取决于调用方（`verifyOIDCIDToken` 附近，本次未完整读到该段）是否做了「匹配失败 → 强制刷新」重试。**标记为待验证**；若调用方没有该重试，则下游存在与上游修复前同样的「密钥轮换后最长 5 分钟登录故障」。

**移植方式**：拆分 `fetchJwks`（走缓存）/ `fetchJwksFresh`（总是请求），匹配失败且 `kid` 非空时调用后者重试一次。

---

### 23. `327cef2` 访问日志掩码 Ollama 路径鉴权令牌

**缺陷**
Ollama 兼容接口支持**把 API Key 放在路径段**上：`/api/ollama/<token>/api/chat`。访问日志直接打印 `param.Path`，于是**有效 API Key 明文落进日志**。任何能读日志的人（运维、日志聚合系统、日志泄露事故）即可直接使用该密钥。这与上游对 query 令牌的脱敏口径（`requestLogEndpoint`）不一致。

**正确行为**
新增 `redactAccessLogPath(path)`：路径以 `/api/ollama/` 开头时，取剩余部分中**第一个 `/` 之前**的段（即 token）替换为 8 个 `*`，保留后续路径。非 Ollama 路径原样返回。**边界**：`/api/ollama/` 后没有 `/`（即只有 token、无后续路径）时原样返回，不误伤。

**下游是否可能同样存在：⚠️ 取决于部署的访问日志**
下游是 Next.js，**没有内置的 HTTP 访问日志中间件**：
- `proxy.ts`（根目录）只做鉴权重定向与 `x-request-path` 头注入，**不打印日志**。
- 搜索 `console.log.*pathname` / `accessLog` / `requestLog` 均**无命中**（只有 `lib/gateway/jsonl-log-writer.ts` 打印「无法打开日志文件」/「写入失败」两类错误）。

因此**下游应用层不落 access log，此项在应用层不存在**。但：

⚠️ **下游有一个等价风险点**：`proxy.ts` 把 `pathname + search` 写入 **`x-request-path` 请求头**并转发给应用。若下游后续基于该头做日志，或在错误处理/异常上报里输出该头，`/api/ollama/<token>/...` 的令牌同样会泄漏。**建议在写入 `x-request-path` 时即做与上游等价的掩码**（Ollama 路径段 + query 中的令牌参数），作为纵深防御。

---

### 24. `3fd4f36` 上游错误日志去除 URL 内嵌凭据

**缺陷**
`gatewayLogUpstreamError` 直接打印 `err.Error()`。Go 的 `*url.Error` 会在错误信息里携带**完整 URL**。渠道 `base_url` 支持 `user:pass@host` 形式的**内嵌凭据**（上游 `proxy_url` 文档明确支持「可在 URL 中携带代理认证信息」），于是**上游凭据明文落进错误日志**。

**正确行为**
落日志前，若 `errors.As(err, &urlErr)`，解析 `urlErr.URL` 并**清空 `parsed.User`**（userinfo），再把清理后的 URL 写回 `urlErr.URL`，最后才取 `err.Error()`。

**下游是否可能同样存在：✅ 存在同类风险**
下游 `lib/gateway/upstream-error.ts`：

```ts
export function parseUpstreamError(text: string, status: number) { ... }   // 解析上游响应体，不含 URL
```

本身不拼 URL，**但**：
- `app/api/admin/channels/probe-models/route.ts` 有 `return jsonError(\`请求上游失败：${message}\`, 502);`，`message` 来自 `error.message`——**undici/fetch 的错误消息会携带完整请求 URL**，而 `base_url` 可能内嵌凭据。
- `lib/gateway/proxy.ts` 的 `testUpstreamModel` 有 `body_preview: error instanceof Error ? error.message : "Unknown upstream error"` —— **同样把可能含凭据的 URL 写进返回体**（并可能被前端展示/记录）。
- `lib/gateway/passthrough-handler.ts`、`multipart-gateway-handler.ts` 的错误处理路径需一并复核。

**移植方式**：新增 `redactUrlCredentials(text | error)` 工具，在**所有把上游错误信息落日志/回响应体的位置**先剥离 `user:pass@`。注意 `setup` 侧也要处理 URL 编码形态（`user%3Apass@`）。

---

### 25. `b5a6ab1` 按事件 ID 去重拦截时间窗口内的重放投递

**缺陷**
Webhook 只有**时间戳 5 分钟偏差窗口**这一个防重放手段。在 5 分钟窗口内，攻击者（或发送方的重试逻辑异常）可以**用同一份签名 payload 重复投递任意次**，每次都真实执行状态变更（改角色、改标签、禁用/启用用户）。Webhook 本身就有幂等性缺陷。

**正确行为**
- 维护「近期已处理事件 ID」集合，保留 **15 分钟**（覆盖 5 分钟时间戳窗口 + 余量）。
- 时间窗口内同一事件 ID 重复投递：**返回 200** + 「重复的事件已处理，已忽略。」+ 回显 `event_id`，**跳过状态变更**（返回 200 而非 4xx，让发送方停止重试）。
- **处理失败时释放去重标记**（`webhookForgetEvent`），使发送方按原事件 ID 重试仍能生效。
- `id` 为空时无法去重，退回时间戳 + 签名校验。
- 定期清扫过期条目标记，防止无界增长。
- 进程内存实现；跨重启的重放由时间戳窗口兜底（上游明确写了这个取舍）。

**下游是否可能同样存在：✅ 存在，且下游更弱**
`app/api/webhook/route.ts`：

```ts
const MAX_TIMESTAMP_DRIFT = 300;
// ... 时间戳校验 ...
if (!verifySignature(...)) return jsonError("签名验证失败", 403);
// 直接 switch (payload.type) 执行状态变更，无任何 event id 去重
```

**完全没有任何去重**，同一个 `id` 在 5 分钟窗口内可重复投递任意次。

**移植方式**：在签名校验通过后、`switch` 之前加 ID 去重（内存 Map + 15 分钟 TTL + 定期清扫）；`handleRoleChange` / `handleTagsChanged` 抛错时释放标记；重复投递返回 200。

---

### 26. `1423bc2` 校验上游应用标识（app_id 语义纠正）

**缺陷**
`findWebhookUser` 里的校验逻辑是：

```go
issuer := normalizeOIDCIssuerURL(settings.OIDCIssuerURL)
appID = normalizeOIDCIssuerURL(appID)
if appID != "" {
    if issuer != "" && appID != issuer { return nil, nil }
    issuer = appID                              // ← 用 app_id 覆盖 issuer
}
```

两个问题：
1. **语义错误**：文档说 `app_id` 是「来源应用标识」，但实现要求它等于 **OIDC Issuer URL**。而实际发送方（上游的 OIDC/SSO 平台）用的 `app_id` 是 **OIDC Client ID**（形如 `tdp_2675e341d06a0a48bbb0c5ab984f5489`）。因此只要带 `app_id`，事件就**永远被忽略**——Webhook 在带 app_id 时完全失效。
2. **信任放大**：`issuer = appID` 允许**调用方自行指定用哪个 issuer 去定位用户**。攻击者只要知道 webhook secret（或利用签名兼容性缺陷），就能指定任意 issuer 去匹配本不该匹配的用户。

**正确行为**
- `app_id` 非空时必须等于配置的 **`oidc_client_id`**（`strings.TrimSpace` 后判等）；不等于则直接返回 `nil, nil`（忽略事件）。
- **不再用 `app_id` 覆盖 issuer**，用户定位始终用配置的 `oidc_issuer_url` + `data.user_id`。

**下游是否可能同样存在：⚠️ 下游根本没有 app_id 校验**
`app/api/webhook/route.ts` 里：

```ts
type WebhookPayload = { id, type, timestamp, signature, app_id?, data };
async function findUser(oidcSubject: string) {
  return gatewayDb.queryOne("SELECT id, ... FROM users WHERE oidc_subject = ? AND enabled = 1 AND deleted_at IS NULL", [oidcSubject]);
}
```

**`app_id` 只出现在类型定义里，从未被读取**。没有校验 = 没有语义错误（不会像上游那样永远忽略事件），但同时**完全缺失应用标识校验**这一层防护（任何持有 secret 的来源都能投递）。相比上游修复前是「过度校验导致功能失效」，下游是「零校验」。

**移植方式**：加 `app_id` 非空时必须等于设置的 `oidc_client_id` 的校验。**同时提醒**：这会让现有「发着 issuer URL 当 app_id」的发送方开始被忽略——需与上游发送方协调或做一段灰度兼容。

---

### 27. `f04440b` 兼容不含 app_id 的旧版签名

**缺陷**
签名验证逻辑是：

```go
if payload.AppID != "" {
    return verifyWebhookSignaturePayload(secret, payload, true)   // ← 强制含 app_id 的签名串
}
return verifyWebhookSignaturePayload(secret, payload, false)
```

`app_id` 非空时**只接受扩展签名串** `HMAC(secret, id + "." + type + "." + timestamp + "." + app_id + JSON(data))`，而**不接受标准签名串** `HMAC(secret, id + "." + type + "." + timestamp + JSON(data))`。发送方一旦带上 `app_id`，就必须改用扩展签名串，否则全部 403——这是一个隐式的**破坏性协议变更**。

**正确行为（最终形态）**
**优先按不含 `app_id` 的标准签名串校验**，未通过时**再回退**到含 `app_id` 的旧版扩展签名：

```go
if verifyWebhookSignaturePayload(secret, payload, false) { return true }
return payload.AppID != "" && verifyWebhookSignaturePayload(secret, payload, true)
```

文档措辞同步改为「为兼容旧版扩展签名，当请求包含非空 `app_id` 时，**也接受**以下签名串」。

**下游是否可能同样存在：⚠️ 下游只实现了标准签名串**
`app/api/webhook/route.ts`：

```ts
function verifySignature(secret, id, type, timestamp, data, expected) {
  const mac = createHmac("sha256", secret);
  mac.update(id + "." + type + "." + timestamp);
  mac.update(JSON.stringify(data));      // ← 只有标准签名串，无 app_id 变体
  const computed = "sha256=" + mac.digest("hex");
  ...
}
```

下游**只支持标准签名串**。这与上游**修复后**的「优先标准串」一致——**如果发送方用的是标准串，下游没问题**；但如果发送方（如某些上游平台）用的是扩展串，下游会 403。**结论**：下游需要在确认发送方签名形态后，决定是否补上扩展串回退。

另注意下游的**比较实现有一个小瑕疵**：

```ts
if (a.length !== b.length) return timingSafeEqual(a, a) && false;
```

长度不等时用 `timingSafeEqual(a, a)` 做等时消耗——这是刻意的时序防护（避免长度差泄漏），**实现是对的**。

---

### 28. `75a836e` 公告 Markdown 链接协议白名单

**缺陷**
`renderInlineMarkdown` 把 Markdown 链接直接渲染成 `<a href={href}>`，**不校验协议**。公告内容由**管理员**发布、向**全员**展示——一个被攻陷或恶意的管理员账号即可通过 `[点我](javascript:...)` 或 `[点我](data:text/html;base64,...)` 对**所有用户**执行脚本，是跨权限边界的 XSS 向量。

**正确行为**
新增 `isSafeMarkdownHref(href)`：
- 以 `//` 开头（协议相对）→ 拒绝；
- **不含 `:`** → 是相对路径，放行；
- 含 `:` → 只有 `/^https?:\/\//i` 放行，其余（`javascript:`、`data:`、`vbscript:` 等）全部拒绝。

不安全的链接**降级为纯文本渲染**（输出原始 Markdown 源码文本，而不是渲染成 `<a>`）。

**下游是否可能同样存在：❌ 不存在（下游用 DOMPurify 做了更强的防护）**
`components/dashboard/announcement-dialog.tsx`：

```ts
const rendered = await marked.parse(content);
setHtml(DOMPurify.sanitize(rendered, MARKDOWN_PURIFY_CONFIG));
...
<div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
```

`lib/shared/utils.ts:56-59`：

```ts
export const MARKDOWN_PURIFY_CONFIG = {
  ALLOWED_TAGS: ["p","br","strong","em","ul","ol","li","a","code","pre","blockquote","h1"..."h6","hr","table","thead","tbody","tr","th","td","del","s","sub","sup"],
  ALLOWED_ATTR: ["href", "title", "class"],
};
```

DOMPurify 默认就会剥离 `javascript:` 等危险协议的 `href`（其 URI 安全策略是内置的），比上游的字符串前缀白名单更完整（还覆盖 `data:image/svg+xml`、HTML 实体编码绕过等上游方案未处理的变体）。

**结论**：下游该条**无需移植**。可选加固：在 `MARKDOWN_PURIFY_CONFIG` 中显式加 `ALLOWED_URI_REGEXP: /^https?:|^\/|^#/i`，把白名单显式化，避免依赖 DOMPurify 的默认行为。

---

### 29. `1c4f1ac` 业务 4xx 不再计入渠道熔断计数

**缺陷**
渠道熔断逻辑把**所有非 2xx/3xx 上游响应**都当成渠道故障：

```go
defaultChannelRuntime.complete(result.lease, false, ...)
```

后果：**调用方的业务错误**（400 参数错误、422 校验失败、404 模型不存在）也累积 `consecutiveFailures`。多个用户连续发几个 400（比如客户端 SDK 版本不兼容、prompt 格式写错），**健康的共享渠道会被误熔断 15 秒**，影响所有用户。熔断器本应衡量「渠道是否健康」，而非「调用方是否写对了请求」。

**正确行为**
- 新增 `completeNeutral(lease, latency)`：**归还租约 + 记录延迟 EWMA，但不动健康统计**（不改 `consecutiveFailures`，不触发熔断，不恢复健康）。
- 新增 `upstreamStatusCountsAgainstCircuit(status)` 判定：

| 状态码 | 是否计入熔断 |
|:---|:---|
| `>= 500` | ✅ 计入 |
| `429` | ✅ 计入 |
| `401` | ✅ 计入 |
| `403` | ✅ 计入 |
| 其余（400/404/422 等） | ❌ **不计入**，走 `completeNeutral` |

- `writeGatewayResponse` 与 `other` 转发路径（`otherGatewayHandler.writeResponse`）**同步该口径**：成功 → `complete(true)`；失败且 `upstreamStatusCountsAgainstCircuit` → `complete(false)`；失败但不计入 → `completeNeutral`。
- 延迟 EWMA 的计算被抽成 `observeLatencyLocked`，供 `complete` 与 `completeNeutral` 共用——**中立路径仍要记录延迟**（延迟是渠道健康的正交指标）。

**下游是否可能同样存在：✅ 存在**
`lib/gateway/gateway-handler.ts` 的调用点：

| 行号 | 调用 | 场景 |
|:---|:---|:---|
| `:533` | `lease.complete({ ok: false, ... })` | 流式上游 4xx |
| `:570` | `lease.complete({ ok: false, ... })` | 流式无 body 且 4xx |
| `:618` | `lease.complete({ ok: upstream.status < 400, ... })` | 流式无 body 正常路径 |
| `:659` | `lease.complete({ ok: success, ... })` | 流式 finalize |
| `:739` | `lease.complete({ ok: false, ... })` | 非流式上游 4xx |
| `:788` | `lease.complete({ ok: true, ... })` | 非流式成功 |

**全部按 `status < 400` 一刀切，没有任何状态码分类。** `lib/gateway/channel-runtime.ts` 的 `ChannelLease.complete`：

```ts
complete(result: { ok: boolean; latencyMs: number }) {
  if (this.released) return;
  updateLatencyEwma(this.state, result.latencyMs);
  if (result.ok) { this.state.consecutiveFailures = 0; this.state.circuitOpenUntil = 0; }
  else if (isCircuitBreakerEnabled()) {
    this.state.consecutiveFailures += 1;
    if (this.state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.state.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    }
  }
  this.released = true; releaseLease(this.state); drainQueue(this.runtimeKey, this.state);
}
```

`ok: false` **必然累加** `consecutiveFailures`（阈值 3，熔断 15 秒，`CIRCUIT_FAILURE_THRESHOLD = 3` / `CIRCUIT_OPEN_MS = 15_000`）。同时下游**没有 `completeNeutral` 等价方法**。

**移植方式**：
1. `ChannelLease` 新增 `completeNeutral(latencyMs)`：只 `updateLatencyEwma` + `releaseLease` + `drainQueue`，不动健康统计。
2. 新增 `upstreamStatusCountsAgainstCircuit(status)`。
3. 上述 6 个调用点全部改造为三分支。
4. 检查 `passthrough-handler.ts` / `multipart-gateway-handler.ts` / `ollama-handler.ts` 是否也有租约完成点需要同步。

---

### 30. `2179adb` 流式转发不再被渠道超时整程截断

**缺陷**
`sendGatewayUpstream` 对**所有**请求（含流式）都用同一个总超时：

```go
timeout := time.Duration(maxInt64(route.Timeout, 1)) * time.Second
client := outboundHTTPClient(timeout, route.ProxyURL)          // http.Client{Timeout: timeout}
reqCtx, cancel := context.WithTimeout(context.Background(), timeout)
```

`http.Client.Timeout` **覆盖整个响应体读取过程**。渠道 `timeout` 默认 60 秒，用户可设更长——但无论如何，**任何长于该值的流式输出都会被硬截断**：模型正说到一半，连接被掐断。长推理（o 系、thinking 模式）、长文生成、Agent 多轮工具调用全部受影响。文档里「长请求可设置为大于 60 的值」只是让用户被迫把超时调到很大，代价是**真正的挂死也一起等很久**。

**正确行为**
流式与非流式**分离**：

| | 客户端 | 上下文 | 响应头时限 | 整程时限 |
|:---|:---|:---|:---|:---|
| **流式** | `outboundStreamHTTPClient`（**无 `Timeout`**） | `context.WithCancel`（**无 deadline**） | `Transport.ResponseHeaderTimeout = timeout` | **无** |
| **非流式** | `outboundHTTPClient`（`Timeout = timeout`） | `context.WithTimeout(timeout)` | — | `timeout` |

**挂死兜底**：新增 `idleWatchdogReadCloser` 包裹响应体——

- 构造时 `time.AfterFunc(idle, cancel)` 启动计时器；
- 每次 `Read` 返回 `n > 0` 时 `timer.Reset(idle)`；
- `Close()` 时 `timer.Stop()` + `cancel()`。

语义：**渠道 `timeout` 从「整程总超时」改为「响应头时限 + 相邻分块间最大空闲」**。长时间正常输出永远不会被截断；上游真挂死（超过 timeout 无任何字节）仍会被取消。

配套改动：
- `outboundHTTPTransport(proxyURL, responseHeaderTimeout)` —— 缓存 key 从 `proxyURL` 改为 `proxyURL + "\x00" + responseHeaderTimeout`，避免不同超时值共用 transport。
- 探测与连通性测试（`postGatewayUpstream`）显式传 `streaming=false`，保持一次性小响应的总超时语义。
- 调用点从 adapter 的 `streamRequested(body)` 取流式标志。

**下游是否可能同样存在：✅ 存在，且比上游修复前更严重**
- **主网关路径**：`lib/gateway/proxy.ts` 的 `fetchUpstreamRequest`：

```ts
function createTimeoutController(timeoutSeconds: number) {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, timeoutSeconds) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);   // ← 单一总超时
  return { controller, timeout };
}
export async function fetchUpstreamRequest(route, requestBody, protocol, inboundHeaders) {
  const { controller, timeout } = createTimeoutController(route.channel.timeout);
  try { ... fetch(url, { ...fetchInit, signal: controller.signal }) ... }
  finally { clearTimeout(timeout); }
}
```

  **注意 `finally { clearTimeout(timeout) }` 的时序**：`fetch()` 在**响应头到达**时即 resolve，`clearTimeout` 立即执行——所以主网关路径下**总超时实际只约束到响应头为止**，流式 body 的读取反而不受约束。这是一个**与上游相反的偏差**：长流不会被截断，但**上游挂死（发完头就不发数据）会无限期挂住**，没有空闲看门狗兜底。
- **passthrough / multipart 路径**：`lib/gateway/passthrough-handler.ts:300-301`

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), Math.max(1, channel.timeout) * 1000);
```

  同样是「总超时但 finally 立即 clear」模式。

**移植方式**：
1. `createTimeoutController` 拆分为两种语义：非流式保留总超时；流式改为 `AbortSignal.timeout` 只约束响应头（或在 `fetch` resolve 后立刻 clear，等价于现状，但需**显式**表达意图）。
2. **补上缺失的空闲看门狗**：把上游 `idleWatchdog` 等价逻辑实现为一个 `TransformStream` 或读取包装，在 `gateway-handler.ts` 的 `wrapped` ReadableStream 里，每次 `reader.read()` 前后重置一个 `setTimeout(() => controller.abort(), timeoutMs)`——这是下游**当前完全缺失**的能力，也是本组修复里除 `1c4f1ac` 外最需要移植的一条。
3. 统一 `proxy.ts` / `passthrough-handler.ts` / `multipart-gateway-handler.ts` 三处的超时口径。

---

### 31. `9e96d2a` 归还排队超时竞态下已授予的渠道并发租约

**缺陷**
`acquire` 的排队等待者用 `select` 同时等「超时/取消」与「被授予租约」两个分支：

```go
select {
case result := <-waiter: ...            // 被 drainQueueLocked 授予
case <-timer.C:  s.removeWaiter(...); return queue_timeout
case <-ctx.Done(): s.removeWaiter(...); return request_cancelled
}
```

竞态：`removeWaiter` **需要拿锁**，而在它等锁期间，另一个请求归还租约触发 `drainQueueLocked`，**已经把租约写进了 waiter 的缓冲通道**。此时两个分支同时就绪，Go 的 `select` **随机**选一个——如果选中了超时分支，代码直接返回 `queue_timeout`，**通道里那份租约被永久遗弃**：`state.inFlight` 计数没有归还，队列也没有 drain。

后果：**渠道并发容量被逐步侵蚀至耗尽**。每次竞态泄漏一个槽位，长时间运行后 `inFlight` 虚高，渠道明明空闲却不再接受任何请求（表现类似「渠道莫名熔断且不恢复」）。

**正确行为**
超时/取消分支在 `removeWaiter` 之后，**非阻塞地回收已进入通道的租约**：

```go
func (s *channelRuntimeStore) reclaimRacedLease(waiter chan channelAcquireResult) {
    select {
    case result := <-waiter:
        if result.lease != nil { s.abandon(result.lease) }
    default:                 // 通道为空说明确实没被授予
    }
}
```

`removeWaiter` 与 `reclaimRacedLease` 配合：前者从队列摘除避免后续重复授予，后者**兜住「摘除前已被授予」的那一份**。

**下游是否可能同样存在：✅ 存在（同一竞态，JS 事件循环版本）**
`lib/gateway/channel-runtime.ts` 的 `acquireChannel`：

```ts
const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  state.queue = state.queue.filter((item) => item !== waiter);   // ← 仅从队列摘除
  if (waiter.onAbort && signal) signal.removeEventListener("abort", waiter.onAbort);
  resolve({ ok: false, reason: "queue_timeout" });                // ← 已授予的租约被遗弃
}, QUEUE_TIMEOUT_MS);

waiter.onAbort = () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  state.queue = state.queue.filter((item) => item !== waiter);
  reject(new Error("Request aborted while waiting for channel queue."));   // ← 同样遗弃
};
```

下游的 `drainQueue` 是**同步**的：

```ts
function drainQueue(key: string, state: ModelRuntimeState) {
  while (state.queue.length > 0 && state.inFlight < getEffectiveLimit(state)) {
    const waiter = state.queue.shift();
    if (!waiter) break;
    if (waiter.signal?.aborted) continue;
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(grantLease(key, state, true).lease);    // ← 调 resolve 已授予
  }
}
```

`grantLease` 已经 `state.inFlight += 1`，所以**一旦 `resolve` 被调用，槽位就已经占用**。而 timeout 回调里 `settled = true` 后只做 `state.queue.filter(...)`——**`state.queue` 里已经没有该 waiter 了**（`drainQueue` 用 `shift()` 摘走了），所以这次 filter 是空操作，`settled` 也不阻止已发生的 `resolve`（`waiter.resolve` 内部设 `settled = true` 但 Promise 的 resolve 已生效）。

在 JS 里，`setTimeout` 回调与 `drainQueue` 不会真正并发（单线程），但**顺序竞态依然成立**：`releaseLease` → `drainQueue` → 同步 `waiter.resolve(...)` 授予租约，与 `timer` 回调在**同一个宏任务队列**里竞争。若 timer 回调先执行并 `state.queue.filter`，随后 `drainQueue` 里 `state.queue.shift()` 拿到的是**下一个** waiter（正常）；但若 `drainQueue` 先 `shift()` 并 `resolve`，**Promise 的 `resolve` 只是把 continuation 排入微任务队列**，外层等待方虽然拿到了 `{ok:true, lease}`，但如果**同时** timeout 已触发并在同一轮里 `resolve({ok:false, reason:"queue_timeout"})`，Promise 的**首次 settle 生效，后续忽略**——即 lease 已经递增过 `inFlight`，但调用方收到的是 `queue_timeout`，**租约泄漏，槽位永久占用**。

**移植方式**：`Waiter` 增加 `grantedLease?: ChannelLease` 字段；`drainQueue` 的 `waiter.resolve(grantLease(...).lease)` 改为先记录 lease 再 resolve；timeout/abort 回调在 `settled = true` 后检查 `waiter.grantedLease`，非空则 `waiter.grantedLease.abandon()`（对应上游的 `abandon` 语义：`releaseLease` + `drainQueue`，不改健康统计）。

---

### 32. `b449c36` 用量累加失败记录日志不再静默吞掉

**缺陷**
三处 `AddGatewayUsage` 调用点全部写成：

```go
_ = h.app.DB.AddGatewayUsage(...)
```

**返回值被丢弃**。写库失败（数据库连接断开、磁盘满、并发锁冲突、字段溢出）时**没有任何日志**，表现为：用户实际消耗了 token 但配额统计没变。管理员看到配额数据与日志对不上，**完全无从排查**。

**正确行为**
抽取统一封装 `recordGatewayUsage(app, authCtx, alias, tokens, tokenMultiplier, requestMultiplier)`，内部调用 `AddGatewayUsage`，**失败时输出包含 `user_id` / `key_id` / `alias` / `error` 的日志**。三处调用点（流式、非流式、`other` 转发）统一走该封装。

**下游是否可能同样存在：✅ 存在（同类静默失败，且下游涉及多个写库点）**
`lib/gateway/gateway-handler.ts` 中 `addUsage(...)` 被调用 **5 次**（`:611` 流式无 body、`:658` 流式 finalize、`:785` 非流式成功，以及 `other`/passthrough 路径），**没有任何一处 `await` 或 `.catch()`**：

```ts
addUsage(auth.user.id, auth.key.id, Math.max(1, tokenUsage.totalTokens), 1, route.model.token_multiplier, route.model.request_multiplier, route.channel.id, route.model.id, route.model.alias, redeemBalanceId);
```

`addUsage`（`lib/gateway/usage-accounting.ts:65`）是 `async` 函数，返回的 Promise **被丢弃**——一旦 `gatewayDb.transaction(...)` 抛错，会产生 **unhandled rejection**（Next.js 里可能只是打一条警告，甚至被静默吞掉），**没有任何业务级日志**。

同类问题还有：
- `lib/gateway/chat-log.ts:86`

```ts
writer.enqueue(buildJsonlRecord(input)).catch(() => {
  // JSONL write failure is non-critical
});
```

  **显式空 catch**。（JSONL 是次要日志，可接受，但至少应 `console.error`。）

**移植方式**：包一层 `recordGatewayUsage(...)`，内部 `await` 或 `.catch(err => console.error(...))`，日志含 `user_id` / `key_id` / `alias` / `error`。

---

## 三、存储与并发修复

### 33. `f7e484d` 周期配额重置比较用 datetime 归一化时间格式

**缺陷**
周期配额重置的 SQL 条件：

```go
Where("id = ? AND deleted_at IS NULL AND (period_reset_at IS NULL OR period_reset_at <= ?)", userID, now.Format(time.RFC3339Nano))
```

`period_reset_at` 是 **TEXT/DATETIME 列**，这个比较是**字典序（字符串比较）**，而不是时间比较。历史版本写入的是 **`"2006-01-02 15:04:05"`（空格分隔）**，新版本写入的是 **RFC3339（`T` 分隔）**。ASCII 里 `' '（0x20） < 'T'（0x54）`，所以：

```
"2026-10-01 12:00:00"  <  "2026-10-01T00:00:00"    永远成立
```

即使 `period_reset_at` 是**未来**时间（旧格式），字典序也恒小于当前时间的 RFC3339，于是**每个请求都会命中重置条件**——周期配额被**无限重置**，配额形同虚设。触发条件是「库里有旧格式写入的 `period_reset_at`」，正是**从旧版本升级上来的实例**。

**正确行为**
SQL 比较改为用 SQLite 的 `datetime()` 归一化：

```sql
datetime(period_reset_at) <= datetime(?)
```

`datetime()` 同时接受 RFC3339 与 `"YYYY-MM-DD HH:MM:SS"` 两种输入，统一归一化后再比较。条件更新（`WHERE ... ` 的原子性）语义不变——并发请求中**仍只有首个过期请求**真正重置。

**下游是否可能同样存在：✅ 同类缺陷，且下游涉及三张表**
下游**是同一套字典序比较**（同样的 SQL 结构、同样的问题）：

- `lib/gateway/channel-quota.ts:26`

```sql
SET period_used_tokens = 0, period_used_requests = 0, period_reset_at = ?
WHERE id = ? AND (period_reset_at IS NULL OR period_reset_at <= ?)
```

- `lib/gateway/model-quota.ts:26` —— **完全相同的模式**（`models` 表）。
- `lib/gateway/quota.ts`（用户级）—— **需复核**，但 `lib/core/db/init.ts:293` 表明 `users.period_reset_at` 也是同一列类型，极可能同构。

下游写入侧用 `toMysqlDatetime(nextReset)` / `toMysqlDatetime`（`lib/core/db/datetime.ts`），格式需确认是空格分隔还是 `T` 分隔。**注意下游同时支持 MySQL 与 SQLite 两套 driver**（`lib/core/db/mysql-adapter.ts` / `sqlite-adapter.ts`）：

- **MySQL**：列类型是 `DATETIME`（`lib/core/db/mysql-schema.ts:21,52,101`），MySQL 会**隐式转换**为时间比较，**不受影响**。
- **SQLite**：列类型是 `DATETIME`（SQLite 无真实类型，实际按 TEXT/BLOB 亲和性存储），**存在字典序比较问题**。

**移植方式**：SQLite 侧把条件改为 `datetime(period_reset_at) <= datetime(?)`；MySQL 侧可保持不变（或统一用 `STR_TO_DATE`/显式 CAST）。三处（user / channel / model）都要改。**这是升级路径上最容易被忽略但后果最严重的存储缺陷之一（配额完全失效）。**

---

### 34. `dfc4ab7` 软删除用户组时改写名称释放唯一索引

**缺陷（链条式）**
`groups.name` 上有 **UNIQUE 约束**，而**唯一索引覆盖软删除行**（软删除只是 `deleted_at` 非空，行仍在）。`SoftDeleteGroup` 只做：

```go
Updates(map[string]interface{}{"enabled": 0, "deleted_at": gorm.Expr("CURRENT_TIMESTAMP")})
```

**不改 `name`**。后果链条：

1. 管理员删除名为「测试组」的组 → 软删除行仍占用 `name = "测试组"`；
2. 管理员想重建同名组 → **`UNIQUE` 冲突，永远无法重建**（且用户拿到的是令人困惑的 DB 错误）。
3. 更严重的是**启动失败链**：默认组名 `"default"` 若被历史软删除行占用，`ensureDefaultGroup` 的
   ```go
   db.Clauses(clause.OnConflict{DoNothing: true}).Create(&group)
   ```
   **静默吞掉唯一冲突**（`DoNothing` 不报错），随后
   ```go
   db.Where("is_default = 1 AND deleted_at IS NULL").First(&group)
   ```
   读不到任何记录 → 返回 `读取默认用户组失败` → **服务启动失败**，且错误信息完全没有指向真正原因（name 唯一约束数据残留）。

**正确行为**
1. `SoftDeleteGroup` 在软删除时**改写 `name`** 释放名称：

```sql
name = 'del' || id || hex(randomblob(3))
```

（`id` 保证不同组之间不冲突，`hex(randomblob(3))` 防止重复删除同一 id 的历史残留碰撞。）

2. **启动时清理历史残留**：`ensureDefaultGroup` 在创建前，先把仍占用 `default` 名称的软删除行改写为 `'del' || id || hex(randomblob(3))`，释放名称。
3. **给可诊断的错误**：复读默认组失败且是 `ErrRecordNotFound` 时，返回明确信息「默认用户组创建后被立即覆盖或删除，请检查 groups 表的 name 唯一约束数据」，而不是笼统的「读取默认用户组失败」。

**下游是否可能同样存在：✅ 完全存在（三部分全中）**
- **UNIQUE 约束存在**：`lib/core/db/mysql-schema.ts:61`

```sql
name VARCHAR(255) UNIQUE NOT NULL,
```

- **软删除不改名**：`app/api/admin/groups/[id]/route.ts` 的 `DELETE`

```ts
await gatewayDb.execute("UPDATE `groups` SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
```

  **没有改写 `name`**。同名组重建会撞唯一约束。注意下游**在应用层做了存在性检查**（`app/api/admin/groups/route.ts:81` `SELECT id FROM groups WHERE name = ? AND deleted_at IS NULL`），所以**重建同名组时不会被拦下**——应用层认为名称可用，直接 `INSERT`，然后**撞 DB 唯一约束报 500**。这比上游修复前更糟：上游是静默失败，下游是「应用层说可以、DB 说不行」的不一致。
- **默认组 bootstrap 无清理**：`lib/core/db/init.ts:543,560` 附近有 `SELECT id FROM groups WHERE is_default = 1 AND deleted_at IS NULL`；**需要复核**其创建路径是否有 `ON CONFLICT DO NOTHING` 之类的静默吞错。若结构同上游，则**存在启动失败链**。

**移植方式**：`DELETE` 时把 `name` 一并改写为 `"del" + id + 随机后缀`；`init.ts` 的默认组 bootstrap 前先清理占用 `default` 名称的软删除行；失败时给出可诊断错误。

---

### 35. `1332542` 计费乘法改为四舍五入并钳制溢出

**缺陷**
计费乘法写成：

```go
billedTokens := int64(float64(maxInt64Store(tokens, 0)) * maxFloat64Store(tokenMultiplier, 0))
```

`int64(float64)` 是**向零截断**（floor），不是四舍五入。后果：

- **`token_multiplier = 0.5` 时**：3 个 token → `1.5` → 截断成 `1`，**少计 0.5**。所有奇数 token 数都少计，**系统性少计**（不是随机误差，是单向偏差）。用户实际消耗 3 个，账上只记 1 个（应为 2 个）。
- **溢出未定义**：`float64` 乘积超过 `int64` 范围时，`int64(...)` 转换在 Go 里是**未定义行为**（实现相关，可能得到 `MinInt64` 这种负数）。恶意/异常上游返回超大 `usage.total_tokens`，配合高倍率，就可能把用量计成负数 → **冲减累计用量**（绕过配额）。

**正确行为**
抽取 `multiplyUsage(value int64, multiplier float64) int64`：

1. 先钳制负数为 0（`maxInt64Store(value, 0)` / `maxFloat64Store(multiplier, 0)`，保持原有防御）；
2. 乘积 `>= math.MaxInt64` 时**钳制到上界**（`return math.MaxInt64`）；
3. 否则 `int64(math.Round(product))` —— **四舍五入**。

验证用例：`multiplyUsage(3, 0.5) == 2`、`multiplyUsage(2, 0.5) == 1`、`multiplyUsage(-5, 2) == 0`、`multiplyUsage(math.MaxInt64, 1024) == math.MaxInt64`。

**下游是否可能同样存在：⚠️ 部分存在（四舍五入已有，溢出钳制缺失）**
`lib/gateway/usage-accounting.ts:6-10, 66-67`：

```ts
function cleanFloat(value: number): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) < 1e-6) return rounded;
  return Math.round(value * 1e6) / 1e6;
}
...
const billedTokens = cleanFloat(Math.max(0, tokens * tokenMultiplier));
const billedRequests = cleanFloat(Math.max(0, requests * requestMultiplier));
```

- **四舍五入**：✅ 下游用 `Math.round`，**没有截断问题**（`Math.round(1.5) === 2`，与上游修复一致，比上游修复前更好）。
- **负数防御**：✅ `Math.max(0, ...)` 已有（不过顺序与上游不同：上游是「先钳制再乘」，下游是「先乘再钳制」——若 `tokens` 为负且 `multiplier` 也为负，下游会得到正值。上游的「先钳制」更严谨）。
- **溢出钳制**：❌ **下游没有**。JS 的 `number` 是 `float64`，`tokens * tokenMultiplier` 不会像 Go 那样出现未定义转换，但：
  - `token_multiplier` 在 API schema 里**限制为 `.min(0).max(100)`**（`app/api/admin/channels/route.ts` 的 model schema），所以极端倍率被拦在入口；
  - 但 `tokens` 直接来自上游 `usage.total_tokens`，**没有上限校验**——一个返回 `usage.total_tokens: 1e308` 的恶意上游会让 `cleanFloat` 得到 `Infinity` 或 `1e308`，写进 `used_tokens`（`DOUBLE` 列，MySQL 侧可存，SQLite 侧含 `Infinity` 会存成 `NULL` 或异常值），**污染配额统计**。

**移植方式**：在 `addUsage` 中先 `const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;` 再相乘；乘积 `> Number.MAX_SAFE_INTEGER` 时钳制；并**调整顺序为「先钳制再乘」**以对齐上游语义。可选：在 `normalizeUsage` / `usageFrom*` 处对上游 usage 值加上限。

---

### 36. `41c1ead` 非网关接口统一限制请求体大小并设置读超时

**缺陷**
服务器配置：

```go
ReadHeaderTimeout: 10 * time.Second,
ReadTimeout:       0,                    // ← 不限
WriteTimeout:      0,
IdleTimeout:       120 * time.Second,
```

`ReadTimeout = 0` 意味着**请求体读取没有任何时间上限**。同时 `/api` 下**非网关接口没有任何请求体大小限制**。

两个攻击面：
1. **内存耗尽**：`/api/auth/login`、`/api/auth/register` 等**未鉴权**接口可以用一个超大 JSON body（几百 MB）把内存打爆（`c.ShouldBindJSON` 会完整读进内存）。
2. **慢速发送攻击（Slowloris 变体）**：ReadTimeout 为 0，攻击者一个字节一个字节地发请求体，**连接被无限期占用**，用极低成本耗尽连接池。

**正确行为**
1. `/api` 分组统一挂 `apiBodyLimitMiddleware`，对**非网关路径**套 `http.MaxBytesReader(c.Writer, c.Request.Body, 4*1024*1024)`（**4MB**）：
   - `/api/v1/` 与 `/api/ollama/` 前缀**跳过**（网关路径的请求体上限 ≤ 10MB 由协议适配器自行处理，这里不重复包装）；
   - `Body == nil` 或 `ContentLength == 0` 时跳过（无体请求不包装）。
2. `ReadTimeout` 从 `0` 改为 **10 分钟**：缓解慢速发送，同时**10MB 的正常网关 body 在 10 分钟内必然传完**，不误伤。`WriteTimeout` **保持 0**（长流式响应不能被写超时中断）。

**下游是否可能同样存在：⚠️ 部分存在（网关侧已有上限，非网关侧未定位到）**
- **网关侧已有防护**：`lib/gateway/passthrough-handler.ts` 有 `readBodyCapped(request, maxBytes)`，注释明确「按硬上限分块读取请求体原始字节，超过上限返回 null（防止 content-length 被伪造导致内存放大）」，**逐块累计并 cancel**——实现比上游的 `MaxBytesReader` 更严谨。这是一个**下游比上游做得好的地方**。
- **非网关侧**：本次搜索未在 `app/api/auth/*`、`app/api/admin/*` 等路由里发现任何请求体大小限制。Next.js 的 Route Handler 里 `await request.json()` **不限制大小**。**倾向于存在该缺陷**，但因未逐一核对全部路由，标记为**待验证**（尤其是**未鉴权**的 `/api/auth/login`、`/api/auth/register`）。
- **读超时**：Next.js 应用层**无法直接设置** `ReadTimeout`（由 Node HTTP server / 部署平台控制）。下游有部署层配置的途径（如自定义 server 或平台设置），需在**部署文档**中明确。**此项在应用代码层不适用。**

**移植方式**：抽一个 `readJsonBodyCapped(request, maxBytes)` 工具（可复用 `passthrough-handler.ts` 的分块读取逻辑），在 `/api` 非网关路由统一使用，**优先覆盖未鉴权接口**。同时评估 `next.config.ts` 的 `experimental.serverActions.bodySizeLimit` 是否覆盖 Route Handler（一般**不覆盖**）。

---

## 四、优先级建议

### P0 — 立即移植（安全影响明确、下游已确认存在）

| # | 提交 | 理由 |
|:---|:---|:---|
| 1 | `77bf9ed` | 改密后旧令牌仍可续期 7 天。**纯安全漏洞**，攻击者持有会话即可无限续命，改密这个安全动作完全失效。下游是裸 JWT，无任何版本绑定。 |
| 2 | `6cf905e` | 管理页一次性明文回传**全部**供应商密钥。下游 `probe-models` 强制前端传明文、列表默认明文可见。凭据泄露面最大。 |
| 3 | `3be07c1` | OIDC `redirect_uri` 可被 `Host` 头劫持 → **授权码被引导到攻击者域名 → 账号接管**。强行为变更，需配套 `API.md` 与升级提示。 |
| 4 | `ec31db4` + `f210e44` + `6f18246` | 这一组直接影响**协议正确性**：o 系模型的真实 usage 丢失 + `length` 截断语义全链路丢失（下游三协议全丢）。依赖 `finish_reason` 续写的客户端会陷入无限续写或静默截断。 |
| 5 | `09068a8` | 图片跨协议**双向损坏**（Anthropic base64 退化为 unknown/裸 base64、Chat data:URL 生成非法 url source）。下游 `normalizeAnthropicMessages` 还会**重复 push** 同一块。视觉模型场景完全不可用。 |

### P1 — 高优先级（协议/网关正确性，影响面大）

| # | 提交 | 理由 |
|:---|:---|:---|
| 6 | `1c4f1ac` | 业务 4xx 误熔断健康渠道，多用户并发 400 会**打断所有用户**。下游 6 个租约完成点全需改造。 |
| 7 | `2179adb` | 流式转发超时语义。下游当前「finally 立即 clearTimeout」导致长流不截断但**挂死流无限期占用连接与并发槽位**——需要补**空闲看门狗**（下游完全缺失）。 |
| 8 | `f7e484d` | 周期配额在 SQLite 部署下**每个请求都重置**，配额形同虚设。升级路径上极易触发（历史 `period_reset_at` 是旧格式）。下游涉及 user / channel / model 三处。 |
| 9 | `9e96d2a` | 并发租约泄漏，长期运行后**渠道容量被侵蚀至耗尽**且不可自愈（表现类似「渠道莫名不再被调度」）。 |
| 10 | `146b6eb` | Anthropic thinking 历史转 Chat 触发**严格上游 400**。下游同一处逻辑，影响所有「Claude 客户端 + 非 Anthropic 渠道」组合。 |
| 11 | `ada95de` | 三个流式解码器吞掉上游错误事件，统一误报为「流经截断」。**运维不可观测**，线上排障成本极高。 |
| 12 | `dfc4ab7` | `groups.name` UNIQUE 覆盖软删除行 → 同名组无法重建（下游会 500），且可能触发**启动失败链**。 |
| 13 | `b5a6ab1` | Webhook 重放：5 分钟窗口内同一 payload 可重复执行状态变更。下游**零去重**。 |
| 14 | `1423bc2` | 下游**完全没有 `app_id` 校验**，任何持有 secret 的来源都可投递。 |
| 15 | `c77ea0b` | 登录限流绕过（取决于部署形态；直连部署必然可绕过）。**清扫机制下游已有，无需移植。** |

### P2 — 中优先级（协议细节 / 防御纵深）

| # | 提交 | 理由 |
|:---|:---|:---|
| 16 | `0c18ad1` | 下游黑名单机制虽能覆盖常见字段，但**穷举不可靠**，三处黑名单还不一致。建议改白名单。 |
| 17 | `251f533` | 工具空参数补 object schema（下游 Chat/Responses 方向输出 `null`），+ o 系模型词表（**待验证**）。 |
| 18 | `ec9e3ec` | 三个缺口：改密无限流、登录时序侧信道、密码无上界。均为**独立的低成本改动**，建议一并做。 |
| 19 | `6882b79` | tool_result 兄弟内容块丢失。改动极小（一行），多轮工具对话质量受影响。 |
| 20 | `17a3b96` | `tool_choice: none` 语义反转 + 下游输出**不存在的 `{type:"none"}`**（严格 Anthropic 会 400）。 |
| 21 | `a5f90b9` | Anthropic `stop_sequences` → Chat `stop` 缺失（下游一站补齐）。Responses 侧是已知限制。 |
| 22 | `67c529c` + `b9ae580` | SSE 解析健壮性。下游四个 decoder 全部有同一问题，且 `trimStart()` 比上游 `TrimLeft` 只会更糟。建议抽**共用 SSE 帧读取器**一次性修好。 |
| 23 | `6520c9a` | 多条 system 消息进 Responses 的 `instructions`。下游缺该映射且与反向处理不对称。 |
| 24 | `b449c36` | 下游 5 处 `addUsage(...)` **未 await 未 catch** → unhandled rejection。加日志封装。 |
| 25 | `3fd4f36` | 上游错误信息里的 URL 凭据。下游 `probe-models` / `testUpstreamModel` 会把 `error.message` 写进响应体。 |
| 26 | `1332542` | 四舍五入下游已有；补**溢出钳制**与「先钳制再乘」的顺序。 |
| 27 | `41c1ead` | 非网关路由请求体上限（**待验证**）。网关侧下游已做得更好。 |

### P3 — 低优先级 / 无需移植

| # | 提交 | 结论 |
|:---|:---|:---|
| 28 | `3da32d2` | **无需移植**。下游 `lib/shared/safe-next.ts` 已拒绝所有反斜杠与控制字符，并用 `new URL()` 归一化后校验 origin，防护强于上游修复。 |
| 29 | `75a836e` | **无需移植**。下游用 DOMPurify + 显式 `ALLOWED_TAGS`/`ALLOWED_ATTR`，强于上游的字符串前缀白名单。可选：显式加 `ALLOWED_URI_REGEXP` 加固。 |
| 30 | `6c64e40` | **待验证**。需读 `lib/auth/oidc.ts` 的 `verifyOIDCIDToken` 调用方，确认是否已有「kid 未命中 → 强制刷新」重试。TTL 与上游修复前一致（5 分钟），风险窗口存在。 |
| 31 | `327cef2` | 下游无 HTTP 访问日志（Next.js 无内置中间件），应用层不存在。但 `proxy.ts` 会把 `pathname + search` 写进 `x-request-path` 头——**建议在该处即做掩码**作为纵深防御。 |
| 32 | `f04440b` | 取决于上游发送方用的签名串形态。下游只支持标准串，与上游**修复后**的优先项一致。需确认发送方是否用扩展串。 |
| 33 | `2179adb`(部署部分) | 读超时属部署层配置，应用代码层不适用。 |

---

## 五、待验证清单（本报告未能完整确认的项）

以下项在本次分析中**未能读到完整实现**，结论标记为待验证，建议独立复核：

1. **`251f533` 的 o 系模型词表**：未读 `lib/gateway/tokenizer.ts` 与 `lib/gateway/token-estimate.ts`，无法确认下游对 `o1`/`o3`/`o4` 的编码选择。
2. **`6c64e40` 的 JWKS kid 重试**：未读到 `lib/auth/oidc.ts` 中 `verifyOIDCIDToken` 的完整实现（文件约 400+ 行，本次只读了前 160 行），无法确认是否有强制刷新重试。
3. **`f7e484d` 的用户级周期配额**：未读 `lib/gateway/quota.ts`，只确认了 `channel-quota.ts` 与 `model-quota.ts` 存在字典序比较。
4. **`41c1ead` 的非网关路由体大小上限**：未逐一核对 `app/api/auth/*`、`app/api/admin/*` 全部路由。
5. **`dfc4ab7` 的默认组 bootstrap**：未读到 `lib/core/db/init.ts:530-570` 的完整创建路径，无法确认是否有 `ON CONFLICT DO NOTHING` 式的静默吞错。
6. **`3fd4f36` 的完整错误日志面**：只核对了 `probe-models` 与 `testUpstreamModel` 两处，`passthrough-handler.ts` / `multipart-gateway-handler.ts` / `ollama-handler.ts` 的错误处理路径未完整复核。
7. **`1423bc2` 的发送方 `app_id` 形态**：需向 webhook 发送方确认实际发送的是 OIDC Client ID 还是 Issuer URL，决定移植后的兼容策略。
8. **`1332542` 的 SQLite `Infinity` 落库行为**：需实测确认 `used_tokens` 收到 `Infinity` 时的存储表现。

---

## 六、给下游的移植策略建议

1. **一次性抽公共基础设施，避免逐条打补丁**：
   - 共用 **SSE 帧读取器**（覆盖 `67c529c` + `b9ae580` + `ec31db4`，四个 decoder 同时受益）；
   - 共用 **图片互转工具**（`parseImageDataURL` / `dataURLForImage` / `anthropicImageSource`，覆盖 `09068a8`）；
   - 共用 **敏感信息脱敏工具**（`maskApiKey` / `redactUrlCredentials` / Ollama 路径掩码，覆盖 `6cf905e` + `3fd4f36` + `327cef2`）；
   - 共用 **请求体限读工具**（覆盖 `41c1ead`，可复用 `passthrough-handler.ts` 现成的 `readBodyCapped`）。

2. **中间协议字段扩展要一次性规划**：`length` 完成语义、图片 base64/media_type、`StopSequences` 双向承接——这三项都触及 `IntermediateRequest` / `IntermediateResponse` / `NormalizedContentPart` 的类型定义，建议合并为一次协议层重构，避免反复改动类型。

3. **两个「强行为变更」需要发布沟通**：
   - `3be07c1`：OIDC 未配置 `public_base_url` 时**直接报错**，会让未配置该设置且正在用 OIDC 的部署**立即登录中断**。必须在升级说明里前置提示，或提供一个过渡期（如先只记日志告警）。
   - `1423bc2`：`app_id` 语义从「等于 Issuer URL」改为「等于 Client ID」，会让现有发送方**开始被忽略**。需要发送方配合或做双值兼容期。

4. **回归测试优先覆盖**：
   - 截断语义：`length` / `max_tokens` / `incomplete+max_output_tokens` 三协议的 6 个方向（下游已有 `adapters_test.go` 的 Go 版可作移植蓝本）；
   - 图片：Anthropic base64 ↔ Chat data:URL ↔ Responses input_image 的双向；
   - SSE 边界：**单帧内 CRLF** + **跨 chunk CRLF** + **data 值多前导空格** + **纯文本多行 data**；
   - 熔断：连续 5 个 400 不应打开熔断，连续 3 个 500 应打开；
   - 流式超时：**长流（总时长 > 渠道超时）不被截断** + **挂死流（块间空闲 > 渠道超时）被取消** —— 这两个用例在下游当前实现下都会失败，是验证移植是否到位的关键。
