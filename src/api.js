// 与大模型后端的接口层（阿里云函数计算 FC，默认千问模型）
// API Key 只存在后端环境变量里，前端不接触密钥，用户无需填写任何地址。

const CLOUD_BASE = "https://ink-words-api-psjczrhpuf.cn-chengdu.fcapp.run";
const LOCAL_BASE = "http://localhost:9000";

// 本机开发（localhost/127.0.0.1 打开前端）自动连本地后端（node fc/index.js），其余一律连 FC
export const API_BASE =
  ["localhost", "127.0.0.1"].includes(location.hostname) ? LOCAL_BASE : CLOUD_BASE;

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

// 查单词：返回 { word, phonetic, meaning, pos, examples, usage }
export function explainWord(word) {
  return post("/api/explain-word", { word });
}

// 文中查词：返回该词在具体语境（句子）中的中文语境义 { word, meaning }
export function explainInContext(word, context) {
  return post("/api/explain-context", { word, context }, 60000);
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
