import {
  WORDS_PER_ARTICLE,
  loadWords,
  addWord,
  findWord,
  getPendingWords,
  markWordsUsed,
  loadArticles,
  addArticle,
  findArticlesByWord,
  clearAll,
} from "./storage.js";
import { explainWord, generateArticle, getApiBase, setApiBase, getModel, setModel } from "./api.js";

// ---------- DOM 引用 ----------
const pages = {
  wordPage: document.getElementById("wordPage"),
  articlePage: document.getElementById("articlePage"),
  settingPage: document.getElementById("settingPage"),
};

const tabBtns = document.querySelectorAll(".tab-btn");
const searchBtn = document.getElementById("searchBtn");
const searchPanel = document.getElementById("searchPanel");
const closeSearchBtn = document.getElementById("closeSearchBtn");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const wordInput = document.getElementById("wordInput");
const addWordBtn = document.getElementById("addWordBtn");
const wordList = document.getElementById("wordList");
const pendingBar = document.getElementById("pendingBar");
const articleList = document.getElementById("articleList");
const toastEl = document.getElementById("toast");
const apiBaseInput = document.getElementById("apiBaseInput");
const saveApiBaseBtn = document.getElementById("saveApiBaseBtn");
const modelInput = document.getElementById("modelInput");
const saveModelBtn = document.getElementById("saveModelBtn");
const testApiBtn = document.getElementById("testApiBtn");
const genNowBtn = document.getElementById("genNowBtn");
const clearDataBtn = document.getElementById("clearDataBtn");
const statsLine = document.getElementById("statsLine");

const PAGE_TO_HASH = { wordPage: "#/words", articlePage: "#/articles", settingPage: "#/settings" };
const HASH_TO_PAGE = { "#/words": "wordPage", "#/articles": "articlePage", "#/settings": "settingPage" };

let generating = false; // 防止并发生成

// ---------- 通用工具 ----------
let toastTimer = null;
function toast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), ms);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 从 mark 的文本中提取单词（去掉首尾标点）
function cleanWord(text) {
  return String(text).toLowerCase().replace(/^[^a-z]+/, "").replace(/[^a-z]+$/, "");
}

// ---------- 页面切换（Hash 路由，避免刷新 404） ----------
function switchPage(name) {
  if (!pages[name]) name = "wordPage";
  Object.values(pages).forEach((p) => p.classList.remove("active"));
  pages[name].classList.add("active");
  tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  const hash = PAGE_TO_HASH[name];
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});

window.addEventListener("hashchange", () => {
  switchPage(HASH_TO_PAGE[location.hash] || "wordPage");
});

// ---------- 单词页渲染 ----------
function renderWords() {
  const words = loadWords();
  if (!words.length) {
    wordList.innerHTML = `<div class="empty-hint">还没有生词，输入一个英语单词开始吧。</div>`;
    renderPendingBar();
    return;
  }
  wordList.innerHTML = words
    .map((w) => {
      const examples = (w.examples || []).slice(0, 2);
      return `
      <div class="word-card" data-word="${escapeHtml(w.word.toLowerCase())}">
        <h3>
          <span>${escapeHtml(w.word)}</span>
          ${w.pos ? `<span class="pos">${escapeHtml(w.pos)}</span>` : ""}
          ${w.used ? `<span class="used-tag">已入文</span>` : ""}
        </h3>
        <p class="meaning">${escapeHtml(w.meaning || "")}</p>
        ${examples.map((e) => `<p class="example">例：${escapeHtml(e)}</p>`).join("")}
        ${w.usage ? `<p>用法：${escapeHtml(w.usage)}</p>` : ""}
        <div class="tip">点击卡片 → 跳转到包含该词的短文</div>
      </div>`;
    })
    .join("");

  wordList.querySelectorAll(".word-card").forEach((card) => {
    card.addEventListener("click", () => jumpToArticle(card.dataset.word));
  });

  renderPendingBar();
}

function renderPendingBar() {
  const pending = getPendingWords().length;
  if (pending === 0) {
    pendingBar.classList.add("hidden");
    return;
  }
  pendingBar.classList.remove("hidden");
  pendingBar.textContent = generating
    ? `正在生成短文（已攒 ${pending} 词）……`
    : `已有 ${pending} 个新词未入文，攒满 ${WORDS_PER_ARTICLE} 个自动生成一篇短文。`;
}

// ---------- 查词 ----------
async function lookupWord() {
  const raw = wordInput.value.trim();
  if (!raw) return;
  if (!/^[A-Za-z][A-Za-z' -]{0,30}$/.test(raw)) {
    toast("请输入英语单词（字母、连字符或空格）");
    return;
  }

  const exists = findWord(raw);
  if (exists) {
    toast(`“${exists.word}”已经查过了`);
    highlightWordCard(exists.word);
    return;
  }

  addWordBtn.disabled = true;
  wordInput.disabled = true;
  toast(`正在查询 “${raw}” ……`, 60000);
  try {
    const data = await explainWord(raw);
    addWord({
      word: data.word || raw,
      meaning: data.meaning || "",
      pos: data.pos || "",
      examples: Array.isArray(data.examples) ? data.examples : [],
      usage: data.usage || "",
    });
    wordInput.value = "";
    renderWords();
    toast(`“${data.word || raw}” 已加入生词本`);
    checkAutoGenerate();
  } catch (err) {
    toast(`查询失败：${err.message}`, 3500);
  } finally {
    addWordBtn.disabled = false;
    wordInput.disabled = false;
    wordInput.focus();
  }
}

addWordBtn.addEventListener("click", lookupWord);
wordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") lookupWord();
});

// ---------- 攒满 10 词自动生成短文 ----------
async function checkAutoGenerate() {
  if (generating) return;
  const pending = getPendingWords();
  if (pending.length < WORDS_PER_ARTICLE) return;
  await generateFor(pending.slice(0, WORDS_PER_ARTICLE).map((w) => w.word));
}

async function generateFor(words) {
  if (!words.length) {
    toast("还没有未入文的生词");
    return;
  }
  if (generating) return;
  generating = true;
  renderPendingBar();
  toast(`正在用 ${words.length} 个生词生成短文……`, 120000);
  try {
    const data = await generateArticle(words);
    const article = data.article || "";
    if (!article.trim()) throw new Error("后端未返回正文");
    addArticle({
      words: words.slice(),
      article,
      word_count: data.word_count || article.split(/\s+/).filter(Boolean).length,
    });
    markWordsUsed(words);
    renderWords();
    renderArticles();
    toast("短文已生成，可在“文章”页查看");
  } catch (err) {
    toast(`生成失败：${err.message}，可在设置页重试`, 3500);
  } finally {
    generating = false;
    renderPendingBar();
  }
}

// ---------- 文章页渲染 ----------
function renderArticles() {
  const articles = loadArticles();
  if (!articles.length) {
    articleList.innerHTML = `<div class="empty-hint">还没有短文。每攒满 ${WORDS_PER_ARTICLE} 个生词会自动生成一篇。</div>`;
    return;
  }
  articleList.innerHTML = articles
    .map((a, i) => {
      const chips = (a.words || [])
        .map((w) => `<button class="word-chip" data-word="${escapeHtml(String(w).toLowerCase())}">${escapeHtml(w)}</button>`)
        .join(" ");
      return `
      <div class="article-card" data-index="${i}" data-words="${escapeHtml((a.words || []).join("|").toLowerCase())}">
        <div class="article-meta">
          <span>第 ${articles.length - i} 篇 · ${fmtTime(a.time)}</span>
          <span>约 ${a.word_count || "?"} 词</span>
        </div>
        <div class="article-words">${chips}</div>
        <div class="article-body">${a.article}</div>
      </div>`;
    })
    .join("");

  // 点击正文中的 <mark> → 跳回单词页并定位该词
  articleList.querySelectorAll(".article-body").forEach((body) => {
    body.addEventListener("click", (e) => {
      const mark = e.target.closest("mark");
      if (!mark) return;
      const word = cleanWord(mark.textContent);
      if (word) jumpToWord(word);
    });
  });

  // 点击顶部的生词标签 → 同样跳回单词页
  articleList.querySelectorAll(".word-chip").forEach((chip) => {
    chip.addEventListener("click", () => jumpToWord(chip.dataset.word));
  });
}

// ---------- 双向跳转 ----------
function jumpToWord(word) {
  switchPage("wordPage");
  const exists = findWord(word);
  if (!exists) {
    toast(`生词本里没有 “${word}”`);
    return;
  }
  highlightWordCard(exists.word);
}

function jumpToArticle(word) {
  const articles = findArticlesByWord(word);
  if (!articles.length) {
    toast(`还没有包含 “${word}” 的短文（攒满 ${WORDS_PER_ARTICLE} 词后自动生成）`);
    return;
  }
  switchPage("articlePage");
  const target = articles[0]; // 最新一篇
  const index = loadArticles().indexOf(target);
  const card = articleList.querySelector(`.article-card[data-index="${index}"]`);
  if (!card) return;
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1600);
  // 滚动到文中该词的第一处高亮
  const key = word.toLowerCase();
  const mark = [...card.querySelectorAll("mark")].find(
    (m) => cleanWord(m.textContent) === key
  );
  (mark || card).scrollIntoView({ behavior: "smooth", block: "center" });
  if (mark) {
    mark.classList.add("flash");
    setTimeout(() => mark.classList.remove("flash"), 1600);
  }
}

function highlightWordCard(word) {
  const cards = document.querySelectorAll(".word-card");
  cards.forEach((card) => {
    if (card.dataset.word === word.toLowerCase()) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("highlight");
      setTimeout(() => card.classList.remove("highlight"), 1200);
    }
  });
}

// ---------- 搜索面板 ----------
searchBtn.addEventListener("click", () => {
  searchPanel.classList.remove("hidden");
  searchInput.focus();
  renderSearch("");
});

closeSearchBtn.addEventListener("click", () => {
  searchPanel.classList.add("hidden");
  searchInput.value = "";
});

searchInput.addEventListener("input", () => {
  renderSearch(searchInput.value);
});

function renderSearch(keyword) {
  const words = loadWords();
  const key = keyword.trim().toLowerCase();
  const list = key
    ? words.filter(
        (w) =>
          w.word.toLowerCase().includes(key) ||
          String(w.meaning || "").includes(key)
      )
    : words;

  searchResults.innerHTML = list.length
    ? list
        .slice(0, 50)
        .map(
          (w) => `<div class="search-item" data-word="${escapeHtml(w.word.toLowerCase())}">
            <strong>${escapeHtml(w.word)}</strong>${escapeHtml(w.meaning || "")}
          </div>`
        )
        .join("")
    : `<div class="empty-hint">没有找到匹配的单词</div>`;

  searchResults.querySelectorAll(".search-item").forEach((item) => {
    item.addEventListener("click", () => {
      searchPanel.classList.add("hidden");
      searchInput.value = "";
      jumpToWord(item.dataset.word);
    });
  });
}

// ---------- 设置页 ----------
apiBaseInput.value = localStorage.getItem("ink_api_base") || "";
modelInput.value = getModel();

saveApiBaseBtn.addEventListener("click", () => {
  setApiBase(apiBaseInput.value.trim());
  toast("接口地址已保存");
});

saveModelBtn.addEventListener("click", () => {
  setModel(modelInput.value.trim());
  toast("模型已保存");
});

testApiBtn.addEventListener("click", async () => {
  testApiBtn.disabled = true;
  toast("正在测试连接……", 30000);
  try {
    const res = await fetch(getApiBase() + "/api/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast("后端连接正常 ✓");
  } catch {
    toast("连接失败，请检查后端是否已启动、地址是否正确（手机端不能用 localhost）", 3500);
  } finally {
    testApiBtn.disabled = false;
  }
});

genNowBtn.addEventListener("click", () => {
  const pending = getPendingWords().map((w) => w.word);
  generateFor(pending);
});

clearDataBtn.addEventListener("click", () => {
  if (!confirm("确定要清空本地单词和文章吗？")) return;
  clearAll();
  renderWords();
  renderArticles();
  renderSettingsStats();
  toast("已清空");
});

function renderSettingsStats() {
  const w = loadWords().length;
  const a = loadArticles().length;
  const p = getPendingWords().length;
  statsLine.textContent = `生词 ${w} 个（未入文 ${p} 个）· 短文 ${a} 篇`;
}

// ---------- 初始化 ----------
function init() {
  renderWords();
  renderArticles();
  renderSettingsStats();
  switchPage(HASH_TO_PAGE[location.hash] || "wordPage");
  if (getPendingWords().length >= WORDS_PER_ARTICLE && !generating) {
    // 上次生成失败或中断时，恢复自动攒文
    checkAutoGenerate();
  }
}

init();
