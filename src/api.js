// 与大模型后端（Cloudflare Worker）交互的接口层
// API Key 只存在 Worker 的 Secrets 里，前端永不接触密钥。

const API_BASE_KEY = "ink_api_base";
const MODEL_KEY = "ink_model";
const DEFAULT_BASE = "http://localhost:8787";

export function getApiBase() {
  return (localStorage.getItem(API_BASE_KEY) || DEFAULT_BASE).replace(/\/+$/, "");
}

export function setApiBase(base) {
  if (base) localStorage.setItem(API_BASE_KEY, base.trim());
  else localStorage.removeItem(API_BASE_KEY);
}

export function getModel() {
  return localStorage.getItem(MODEL_KEY) || "";
}

export function setModel(model) {
  if (model) localStorage.setItem(MODEL_KEY, model.trim());
  else localStorage.removeItem(MODEL_KEY);
}

async function post(path, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(getApiBase() + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, model: getModel() || undefined }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const data = await res.json();
        if (data && data.error) msg = data.error;
      } catch {}
      throw new Error(msg);
    }
    return await res.json();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("请求超时，请检查网络或后端地址");
    if (err instanceof TypeError) throw new Error("无法连接后端，请在设置页检查接口地址");
    throw err;
  }
}

// 查单词：返回 { word, meaning, pos, examples, usage }
export function explainWord(word) {
  return post("/api/explain-word", { word });
}

// 生成短文：words 为 10 个生词，返回 { article, word_count }
// article 中的目标词已被后端用 <mark> 包裹
export async function generateArticle(words) {
  const data = await post("/api/generate-article", { words }, 120000);
  return { ...data, article: sanitizeMarks(data.article || "") };
}

// 只放行 <mark> 标签，其余一律转义，防止 XSS
function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function sanitizeMarks(text) {
  return escapeHtml(text)
    .replaceAll("&lt;mark&gt;", "<mark>")
    .replaceAll("&lt;/mark&gt;", "</mark>");
}
