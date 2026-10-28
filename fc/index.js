/**
 * 墨词后端 —— 阿里云函数计算（FC）Web 函数版
 *
 * 与 Cloudflare Worker 版逻辑完全一致，只是入口改为 Node HTTP 服务。
 * 本地运行：  node index.js            （默认端口 9000，与 FC 一致）
 * FC 部署：   启动命令 node index.js，监听端口 9000
 *
 * 环境变量（FC 控制台"环境变量"里配置）：
 *   LLM_API_KEY   必填，千问（百炼）API Key
 *   LLM_BASE_URL  默认 https://dashscope.aliyuncs.com/compatible-mode/v1
 *   LLM_MODEL     默认 qwen-plus
 *   ALLOWED_MODELS 允许的模型白名单（逗号分隔），可留空
 *
 * 接口：
 *   GET  /api/health
 *   POST /api/explain-word     { word } → { word, phonetic, meaning, pos, examples, usage }
 *   POST /api/explain-context  { word, context } → { word, meaning }
 *   POST /api/generate-article { words[] } → { article, word_count }
 */

import http from "node:http";

const PORT = Number(process.env.PORT || 9000);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...CORS,
  });
  res.end(body);
}

function err(res, message, status = 400) {
  sendJson(res, { error: message }, status);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("请求体必须是 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/* ---------------- 大模型调用（OpenAI 兼容 Chat Completions） ---------------- */

async function chatLLM(messages, { temperature = 0.5, maxTokens = 2000, timeoutMs = 100000 } = {}) {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("后端未配置 LLM_API_KEY 环境变量");

  const baseUrl = (process.env.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/+$/, "");
  const useModel = process.env.LLM_MODEL || "qwen-plus";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: useModel, messages, temperature, max_tokens: maxTokens, stream: false }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`模型接口返回 ${res.status}：${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    if (!content.trim()) throw new Error("模型返回内容为空");
    return content;
  } finally {
    clearTimeout(timer);
  }
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

/* ---------------- 业务处理 ---------------- */

const WORD_RE = /^[A-Za-z][A-Za-z' -]{0,30}$/;

async function handleExplainWord(res, body) {
  const word = String(body.word || "").trim();
  if (!WORD_RE.test(word)) return err(res, "word 必须是 1-31 个字符的英语单词");

  const messages = [
    {
      role: "system",
      content:
        "你是一个英语学习助手。请解释用户提供的英语单词。" +
        "只返回一个 JSON 对象，不要多余解释，不要代码块标记。字段：" +
        "word（单词本身，原样返回）、phonetic（国际音标，两侧加斜杠，如 /əˈbændən/）、" +
        "meaning（中文含义，简洁列出主要义项）、" +
        "pos（词性，如“动词/名词”）、examples（2 个英文例句的数组）、" +
        "usage（常见搭配与语法用法，中文说明，例如“常用于 abandon sth / abandon doing sth”）。",
    },
    { role: "user", content: `请解释单词：${word}` },
  ];

  let parsed;
  try {
    parsed = extractJson(await chatLLM(messages, { temperature: 0.3, maxTokens: 800 }));
  } catch (e) {
    return err(res, `解释生成失败：${e.message}`, 502);
  }

  const examples = Array.isArray(parsed.examples)
    ? parsed.examples.map(String).slice(0, 3)
    : parsed.examples ? [String(parsed.examples)] : [];

  sendJson(res, {
    word: parsed.word ? String(parsed.word).trim() : word,
    phonetic: String(parsed.phonetic || parsed.ipa || ""),
    meaning: String(parsed.meaning || ""),
    pos: String(parsed.pos || ""),
    examples,
    usage: String(parsed.usage || ""),
  });
}

async function handleExplainContext(res, body) {
  const word = String(body.word || "").trim();
  const context = String(body.context || "").trim();
  if (!WORD_RE.test(word)) return err(res, "word 必须是 1-31 个字符的英语单词");
  if (!context || context.length > 1200) return err(res, "context 必须是 1-1200 字符的句子");

  const messages = [
    {
      role: "system",
      content:
        "你是一个英语学习助手。用户会给出一个英语句子（或片段）以及其中的一个单词，" +
        "请解释该单词在这个具体语境中的含义（语境义），用简洁的中文，" +
        "如与常见义不同请点明此处用法。只返回一个 JSON 对象，不要多余解释，不要代码块标记。字段：" +
        "word（单词原样返回）、meaning（该词在此句中的中文语境义，尽量一句话）。",
    },
    { role: "user", content: `单词：${word}\n语境：${context}` },
  ];

  let parsed;
  try {
    parsed = extractJson(await chatLLM(messages, { temperature: 0.3, maxTokens: 400 }));
  } catch (e) {
    return err(res, `语境释义生成失败：${e.message}`, 502);
  }

  sendJson(res, {
    word: parsed.word ? String(parsed.word).trim() : word,
    meaning: String(parsed.meaning || ""),
  });
}

// 文章长度阶梯：按目标词数决定篇幅
function lengthTier(n) {
  if (n <= 3) return { min: 50, max: 70, paras: "2" };
  if (n <= 6) return { min: 80, max: 120, paras: "3" };
  return { min: 180, max: 230, paras: "3-4" };
}

// 非目标词的误高亮：直接去掉 <mark> 还原纯文本（确定性修复，零 token 成本）
function unwrapExtraMarks(article, words) {
  const keys = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z]/g, "")));
  return article.replace(/<mark>([^<]*)<\/mark>/gi, (whole, inner) => {
    const k = String(inner).toLowerCase().replace(/[^a-z]/g, "");
    return k && !keys.has(k) ? inner : whole;
  });
}

async function handleGenerateArticle(res, body) {
  if (!Array.isArray(body.words) || body.words.length < 2 || body.words.length > 10) {
    return err(res, "words 必须是 2-10 个英语单词的数组");
  }
  const words = body.words.map((w) => String(w).trim()).filter((w) => WORD_RE.test(w));
  if (words.length < 2) return err(res, "至少需要 2 个有效的英语单词");

  const tier = lengthTier(words.length);
  const prompt = buildArticlePrompt(words, tier);
  const messages = [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }];

  let best = null;
  const deviation = (wc, missing) =>
    (wc < tier.min ? tier.min - wc : wc > tier.max ? wc - tier.max : 0) + missing.length * 1000;

  let article = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await chatLLM(messages, { temperature: 0.8, maxTokens: 1600 });
    } catch (e) {
      if (attempt === 0) continue;
      return err(res, `短文生成失败：${e.message}`, 502);
    }

    article = unwrapExtraMarks(sanitizeArticle(raw), words); // 误高亮就地还原，不浪费改写机会
    const wc = countWords(article);
    const missing = missingWords(article, words);
    const dev = deviation(wc, missing);
    if (!best || dev < best.dev) best = { article, wc, dev };

    if (dev === 0) break; // 词数达标且目标词齐全
    // 不合格且有剩余尝试：把具体问题反馈给模型重写
    if (attempt === 0) {
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content:
          `这篇短文不合格，请重写。问题：` +
          (wc < tier.min || wc > tier.max ? `当前约 ${wc} 词，必须 ${tier.min}-${tier.max} 词，绝不超过 ${tier.max} 词；` : "") +
          (missing.length ? `以下单词未出现，必须原词出现且用 <mark> 包裹：${missing.join(", ")}；` : "") +
          `仍然只返回正文。`,
      });
    }
  }

  const chosen = best || { article, wc: countWords(article) };
  if (!chosen.article) return err(res, "短文生成失败，请重试", 502);
  sendJson(res, { article: chosen.article, word_count: chosen.wc });
}

function buildArticlePrompt(words, tier) {
  const list = words.map((w) => `"${w}"`).join(", ");
  return {
    system:
      "你是一个英语学习助手。请根据用户提供的单词生成一篇英语短文。要求：\n" +
      `1. 短文必须自然包含以下所有单词，且以原词形出现：${list}；\n` +
      "2. 每个目标单词在文中第一次出现时用 <mark> 标签包裹，例如 <mark>curious</mark>，之后再次出现不必包裹；只允许包裹上述目标单词，其他词一律不得加 <mark>；\n" +
      `3. 文章长度必须落在 ${tier.min}-${tier.max} 词之间，绝不能超过 ${tier.max} 词，宁可稍短也不要超字数；\n` +
      "4. 除目标词外，语言要简单地道：使用高中英语水平就能轻松读懂的日常词汇和简短句式，避免生僻词、学术词和复杂从句；情节连贯自然，不要生硬堆砌；\n" +
      `5. 分 ${tier.paras} 个自然段，段与段之间空一行；\n` +
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

  const tokens = text.split(/(<\/?mark>)/i).filter(Boolean);
  const out = [];
  let inside = false;
  for (const t of tokens) {
    if (/^<mark>$/i.test(t)) {
      if (inside) continue;
      inside = true;
      out.push(t);
    } else if (/^<\/mark>$/i.test(t)) {
      if (!inside) continue;
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

/* ---------------- HTTP 入口 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(res, { ok: true, service: "ink-words-fc", model: process.env.LLM_MODEL || "qwen-plus" });
      return;
    }
    if (req.method !== "POST") return err(res, "仅支持 POST 请求", 405);

    const body = await readJsonBody(req);
    if (url.pathname === "/api/explain-word") return await handleExplainWord(res, body);
    if (url.pathname === "/api/explain-context") return await handleExplainContext(res, body);
    if (url.pathname === "/api/generate-article") return await handleGenerateArticle(res, body);

    return err(res, "接口不存在", 404);
  } catch (e) {
    if (!res.headersSent) err(res, `服务器内部错误：${e?.message || "未知错误"}`, 500);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ink-words-fc listening on http://127.0.0.1:${PORT}`);
});
