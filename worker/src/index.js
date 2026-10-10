/**
 * 墨词 Cloudflare Worker —— 大模型轻量后端
 *
 * 接口：
 *   GET  /api/health          健康检查（前端“测试接口连通”按钮使用）
 *   POST /api/explain-word    { "word": "abandon" }
 *        → { word, meaning, pos, examples: [..], usage }
 *   POST /api/generate-article{ "words": ["a","b",...] }
 *        → { article, word_count }（生词已用 <mark> 包裹，约 230-350 词）
 *
 * 配置（wrangler.toml [vars] 或 Cloudflare Secrets）：
 *   LLM_API_KEY   必填，密钥（用 wrangler secret put LLM_API_KEY 设置）
 *   LLM_BASE_URL  OpenAI 兼容接口地址，默认 DeepSeek
 *   LLM_MODEL     默认模型名
 *   ALLOWED_MODELS 允许前端切换的模型白名单（逗号分隔），留空则忽略前端 model
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, service: "ink-words-api", model: env.LLM_MODEL || "deepseek-chat" });
      }

      if (request.method !== "POST") return err("仅支持 POST 请求", 405);

      if (url.pathname === "/api/explain-word") return await handleExplainWord(request, env);
      if (url.pathname === "/api/generate-article") return await handleGenerateArticle(request, env);

      return err("接口不存在", 404);
    } catch (e) {
      return err(`服务器内部错误：${e && e.message ? e.message : "未知错误"}`, 500);
    }
  },
};

/* ---------------- 大模型调用（OpenAI 兼容 Chat Completions） ---------------- */

async function chatLLM(env, messages, { model, temperature = 0.5, maxTokens = 2000, timeoutMs = 100000 } = {}) {
  // 兼容两种密钥变量名：LLM_API_KEY（通用）或 DASHSCOPE_API_KEY（千问习惯叫法）
  const apiKey = env.LLM_API_KEY || env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("后端未配置 LLM_API_KEY，请在 .dev.vars 或 wrangler secret 中设置");

  const baseUrl = (env.LLM_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const useModel = resolveModel(env, model);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`模型接口返回 ${res.status}：${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content || ""
      : "";
    if (!content.trim()) throw new Error("模型返回内容为空");
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function resolveModel(env, requested) {
  if (requested && env.ALLOWED_MODELS) {
    const allowlist = env.ALLOWED_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
    if (allowlist.includes(requested)) return requested;
    return env.LLM_MODEL || "deepseek-chat";
  }
  if (requested && !env.ALLOWED_MODELS) return requested;
  return env.LLM_MODEL || "deepseek-chat";
}

// 从模型输出中提取 JSON（容忍 ```json 代码块和前后废话）
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("模型未返回有效 JSON");
  return JSON.parse(body.slice(start, end + 1));
}

/* ---------------- /api/explain-word ---------------- */

async function handleExplainWord(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("请求体必须是 JSON");
  }

  const word = String(body.word || "").trim();
  if (!/^[A-Za-z][A-Za-z' -]{0,30}$/.test(word)) {
    return err("word 必须是 1-31 个字符的英语单词");
  }

  const messages = [
    {
      role: "system",
      content:
        "你是一个英语学习助手。请解释用户提供的英语单词。" +
        "只返回一个 JSON 对象，不要多余解释，不要代码块标记。字段：" +
        'word（单词本身，原样返回）、meaning（中文含义，简洁列出主要义项）、' +
        "pos（词性，如“动词/名词”）、examples（2 个英文例句的数组）、" +
        "usage（常见搭配与语法用法，中文说明，例如“常用于 abandon sth / abandon doing sth”）。",
    },
    { role: "user", content: `请解释单词：${word}` },
  ];

  let parsed;
  try {
    parsed = extractJson(await chatLLM(env, messages, { model: body.model, temperature: 0.3, maxTokens: 800 }));
  } catch (e) {
    return err(`解释生成失败：${e.message}`, 502);
  }

  const examples = Array.isArray(parsed.examples)
    ? parsed.examples.map(String).slice(0, 3)
    : parsed.examples ? [String(parsed.examples)] : [];

  return json({
    word: parsed.word ? String(parsed.word).trim() : word,
    meaning: String(parsed.meaning || ""),
    pos: String(parsed.pos || ""),
    examples,
    usage: String(parsed.usage || ""),
  });
}

/* ---------------- /api/generate-article ---------------- */

const MIN_WORDS = 230;
const MAX_WORDS = 350;

async function handleGenerateArticle(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return err("请求体必须是 JSON");
  }

  if (!Array.isArray(body.words) || body.words.length === 0 || body.words.length > 20) {
    return err("words 必须是 1-20 个英语单词的数组");
  }
  const words = body.words.map((w) => String(w).trim()).filter((w) => /^[A-Za-z][A-Za-z' -]{0,30}$/.test(w));
  if (!words.length) return err("words 中没有有效的英语单词");

  const prompt = buildArticlePrompt(words);
  const messages = [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }];

  let article = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await chatLLM(env, messages, { model: body.model, temperature: 0.8, maxTokens: 1600 });
    } catch (e) {
      if (attempt === 0) continue;
      return err(`短文生成失败：${e.message}`, 502);
    }

    article = sanitizeArticle(raw);
    const wc = countWords(article);
    const missing = missingWords(article, words);

    if (wc >= MIN_WORDS - 30 && wc <= MAX_WORDS + 50 && missing.length === 0) break;
    // 第二次重试：把不合格原因反馈给模型
    messages.push({ role: "assistant", content: raw });
    messages.push({
      role: "user",
      content:
        `这篇短文不合格，请重写。问题：` +
        (wc < MIN_WORDS || wc > MAX_WORDS ? `当前约 ${wc} 词，必须 230-350 词；` : "") +
        (missing.length ? `以下单词未出现，必须原词出现且用 <mark> 包裹：${missing.join(", ")}；` : "") +
        `仍然只返回正文。`,
    });
  }

  if (!article) return err("短文生成失败，请重试", 502);

  return json({ article, word_count: countWords(article) });
}

function buildArticlePrompt(words) {
  const list = words.map((w) => `"${w}"`).join(", ");
  return {
    system:
      "你是一个英语学习助手。请根据用户提供的单词生成一篇英语短文。要求：\n" +
      `1. 短文必须自然包含以下所有单词，且以原词形出现：${list}；\n` +
      "2. 每个目标单词在文中第一次出现时用 <mark> 标签包裹，例如 <mark>curious</mark>，之后再次出现不必包裹；\n" +
      `3. 文章长度严格控制在 ${MIN_WORDS}-${MAX_WORDS} 词之间；\n` +
      "4. 语言难度适合英语学习者，情节连贯自然，不要生硬堆砌；\n" +
      "5. 分 3-5 个自然段，段与段之间空一行；\n" +
      "6. 除了目标单词的 <mark> 标签外，正文不得包含任何其他 HTML/Markdown 标记、标题或解释；\n" +
      "7. 只返回短文正文，不要任何额外说明。",
    user: `请用上这些单词写一篇英语短文：${list}`,
  };
}

// 只保留成对闭合的 <mark> 标签，去掉模型可能输出的其它任何标签
function sanitizeArticle(raw) {
  let text = String(raw)
    .replace(/^```(?:\w+)?\s*|\s*```$/g, "")
    .replace(/<(?!\/?mark>)[^>]*>/gi, "")
    .replace(/<MARK>/gi, "<mark>")
    .replace(/<\/MARK>/gi, "</mark>")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // 逐 token 扫描：丢弃多余/未配对的 mark 标签，结尾自动补闭合
  const tokens = text.split(/(<\/?mark>)/i).filter(Boolean);
  const out = [];
  let inside = false;
  for (const t of tokens) {
    if (/^<mark>$/i.test(t)) {
      if (inside) continue; // 已在一个 mark 内，丢弃重复的开标签
      inside = true;
      out.push(t);
    } else if (/^<\/mark>$/i.test(t)) {
      if (!inside) continue; // 没有对应开标签，丢弃多余闭标签
      inside = false;
      out.push(t);
    } else {
      out.push(t);
    }
  }
  if (inside) out.push("</mark>");
  return out.join("");
}

function countWords(text) {
  return text
    .replace(/<\/?mark>/g, " ")
    .split(/\s+/)
    .filter((t) => /[A-Za-z]/.test(t)).length;
}

// 检查原词（不区分大小写）是否都出现在正文中
function missingWords(article, words) {
  const lower = article.toLowerCase();
  return words.filter((w) => {
    const key = w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "\\-");
    try {
      return !new RegExp(`\\b${key}\\b`).test(lower);
    } catch {
      return !lower.includes(w.toLowerCase());
    }
  });
}

// 供本地冒烟测试使用（Cloudflare Workers 会忽略多余的导出）
export { sanitizeArticle, countWords, missingWords };
