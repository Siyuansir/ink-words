// 与大模型后端（Cloudflare Worker）交互的接口层
// API Key 只存在 Worker 的 Secrets 里，前端不接触密钥。
// 后端地址已固定为正式部署的 Worker（默认千问模型），用户无需再填写。

const API_BASE = "https://ink-words-api.englishink.workers.dev";

// 清理旧版本遗留的用户自定义配置（接口地址、模型选择已不再开放）
localStorage.removeItem("ink_api_base");
localStorage.removeItem("ink_model");

export function getApiBase() {
  return API_BASE;
}

async function post(path, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    if (err.name === "AbortError") throw new Error("请求超时，请检查网络");
    if (err instanceof TypeError) throw new Error("无法连接后端，请检查网络");
    throw err;
  }
}

// 查单词：返回 { word, meaning, pos, examples, usage }
export function explainWord(word) {
  return post("/api/explain-word", { word });
}

// 生成短文：words 为一组生词，返回 { article, word_count }
// article 中的目标词已被后端用 <mark> 包裹
export async function generateArticle(words) {
  const data = await post("/api/generate-article", { words }, 120000);
  return { ...data, article: sanitizeMarks(data.article || "") };
}

// 健康检查（设置页“测试接口连通”）
export async function pingHealth() {
  const res = await fetch(API_BASE + "/api/health");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
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
