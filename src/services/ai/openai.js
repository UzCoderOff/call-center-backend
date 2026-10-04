// The OpenAI Chat Completions API, with tools (function calling). Plain
// fetch — no SDK. Reasoning models (gpt-5…, o-series) take
// `reasoning_effort` and no temperature; the others a low temperature. If a
// model turns either down, the question is asked again without it.

// OPENAI_BASE_URL: only for a stand-in when testing.
const BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const URL = `${BASE}/chat/completions`;
const TIMEOUT_MS = 90 * 1000;

const isReasoningModel = (model) => /^(gpt-5|o\d)/.test(model) && !/chat/.test(model);

function requestBody({ model, messages, tools, maxTokens = 1500 }) {
  const body = { model, messages };
  if (tools?.length) body.tools = tools.map((t) => ({ type: "function", function: t }));
  if (isReasoningModel(model)) {
    body.max_completion_tokens = maxTokens + 2000; // room for its own thinking
    body.reasoning_effort = "low";
  } else {
    body.max_completion_tokens = maxTokens;
    body.temperature = 0.2;
  }
  return body;
}

class OpenAiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// -> { message: { role, content, tool_calls? }, usage }
async function complete(apiKey, args) {
  const body = requestBody(args);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return { message: data.choices?.[0]?.message || { role: "assistant", content: "" }, usage: data.usage || null };
    const param = data?.error?.param;
    if (res.status === 400 && attempt < 2 && ["temperature", "reasoning_effort"].includes(param) && param in body) {
      delete body[param];
      continue;
    }
    throw new OpenAiError(data?.error?.message || `OpenAI HTTP ${res.status}`, res.status, data?.error?.code || data?.error?.type || null);
  }
}

// The models this key may use (Sozlamalar → "Sinab koʻrish").
async function listModels(apiKey) {
  const res = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new OpenAiError(data?.error?.message || `OpenAI HTTP ${res.status}`, res.status, data?.error?.code || null);
  return (data.data || []).map((m) => m.id).sort();
}

module.exports = { complete, listModels, requestBody, isReasoningModel, OpenAiError };
