import {
  WORDS_PER_ARTICLE,
  loadWords,
  addWord,
  findWord,
  getPendingWords,
  markWordsUsed,
  loadArticles,
  addArticle,
  clearAll,
} from "./storage.js";
import { explainWord, generateArticle, getApiBase, pingHealth } from "./api.js";

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
const testApiBtn = document.getElementById("testApiBtn");
const apiBaseLine = document.getElementById("apiBaseLine");
const genNowBtn = document.getElementById("genNowBtn");
const clearDataBtn = document.getElementById("clearDataBtn");
const statsLine = document.getElementById("statsLine");
const importBtn = document.getElementById("importBtn");
const importPanel = document.getElementById("importPanel");
const importInput = document.getElementById("importInput");
const importConfirmBtn = document.getElementById("importConfirmBtn");
const closeImportBtn = document.getElementById("closeImportBtn");
const importProgress = document.getElementById("importProgress");

const PAGE_TO_HASH = { wordPage: "#/words", articlePage: "#/articles", settingPage: "#/settings" };
const HASH_TO_PAGE = { "#/words": "wordPage", "#/articles": "articlePage", "#/settings": "settingPage" };

let generating = false; // 防止并发生成
let importing = false; // 防止并发导入

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
  // 搜索按钮在顶栏，仅单词页显示
  searchBtn.classList.toggle("hide", name !== "wordPage");
  const hash = PAGE_TO_HASH[name];
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});

window.addEventListener("hashchange", () => {
  switchPage(HASH_TO_PAGE[location.hash] || "wordPage");
});

// ---------- 分组展开/收起状态 ----------
const COLLAPSE_KEY = "ink_group_collapse";
function loadCollapse() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {};
  } catch {
    return {};
  }
}
function saveCollapse(map) {
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map));
}

// 某单词所属的分组 id（pending = 未分组，g<时间戳> = 已生成短文的组）
function groupOfWord(word) {
  const key = String(word).toLowerCase();
  const articles = loadArticles();
  for (const a of articles) {
    if ((a.words || []).some((t) => String(t).toLowerCase() === key)) {
      return "g" + a.time;
    }
  }
  return "pending";
}

// ---------- 单词页渲染（按组分块，可展开/隐藏） ----------
function cardHtml(w) {
  const examples = (w.examples || []).slice(0, 2);
  return `
  <div class="word-card" data-word="${escapeHtml(w.word.toLowerCase())}">
    <h3>
      <span>${escapeHtml(w.word)}</span>
      ${w.pos ? `<span class="pos">${escapeHtml(w.pos)}</span>` : ""}
    </h3>
    <p class="meaning">${escapeHtml(w.meaning || "")}</p>
    ${examples.map((e) => `<p class="example">例：${escapeHtml(e)}</p>`).join("")}
    ${w.usage ? `<p>用法：${escapeHtml(w.usage)}</p>` : ""}
    <div class="tip">点击卡片 → 跳转到包含该词的短文</div>
  </div>`;
}

function renderWords() {
  const words = loadWords();
  if (!words.length) {
    wordList.innerHTML = `<div class="empty-hint">还没有生词，输入一个英语单词开始吧。</div>`;
    renderPendingBar();
    return;
  }

  const wordMap = new Map(words.map((w) => [w.word.toLowerCase(), w]));
  const articles = loadArticles();
  const collapse = loadCollapse();
  const usedKeys = new Set();
  let html = "";

  // 已生成短文的分组（每组对应一篇文章），最新在前
  articles.forEach((a, i) => {
    const gid = "g" + a.time;
    const cards = (a.words || [])
      .map((t) => String(t).toLowerCase())
      .filter((k) => {
        if (usedKeys.has(k) || !wordMap.has(k)) return false;
        usedKeys.add(k);
        return true;
      })
      .map((k) => wordMap.get(k));
    const collapsed = collapse[gid] ? " collapsed" : "";
    html += `
    <div class="word-group${collapsed}" data-group="${gid}">
      <button class="group-header" data-group="${gid}">
        <span class="caret">▾</span>
        <span>第 ${articles.length - i} 组 · 已生成短文</span>
        <span class="count">${cards.length} 词 · ${fmtTime(a.time)}</span>
      </button>
      <div class="word-list group-body">${cards.map(cardHtml).join("")}</div>
    </div>`;
  });

  // 未分组的新词（攒文中）：显示在最上方，且最新的排最前，方便刚查完就能看到
  const pending = getPendingWords().filter((w) => !usedKeys.has(w.word.toLowerCase())).reverse();
  if (pending.length) {
    const collapsed = collapse.pending ? " collapsed" : "";
    html = `
    <div class="word-group${collapsed}" data-group="pending">
      <button class="group-header pending-header" data-group="pending">
        <span class="caret">▾</span>
        <span>未分组 · 攒文中</span>
        <span class="count">${pending.length}/${WORDS_PER_ARTICLE}</span>
      </button>
      <div class="word-list group-body">${pending.map(cardHtml).join("")}</div>
    </div>` + html;
  }

  wordList.innerHTML = html;

  // 组头：点击展开/隐藏
  wordList.querySelectorAll(".group-header").forEach((header) => {
    header.addEventListener("click", () => {
      const gid = header.dataset.group;
      const map = loadCollapse();
      const section = header.closest(".word-group");
      const nowCollapsed = !map[gid];
      if (nowCollapsed) map[gid] = true;
      else delete map[gid];
      saveCollapse(map);
      section.classList.toggle("collapsed", nowCollapsed);
    });
  });

  // 卡片：点击跳转到对应短文
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
    renderSettingsStats();
    highlightWordCard(data.word || raw); // 新词已在分组顶部，闪一下高亮便于注意到
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

// ---------- 攒满 10 词自动分组生成短文 ----------
async function checkAutoGenerate() {
  if (generating || importing) return;
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
    renderSettingsStats();
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
  // 若该词所在分组被收起，先展开
  const gid = groupOfWord(exists.word);
  const map = loadCollapse();
  if (map[gid]) {
    delete map[gid];
    saveCollapse(map);
    renderWords();
  }
  highlightWordCard(exists.word);
}

function jumpToArticle(word) {
  const key = word.toLowerCase();
  // 注意：loadArticles() 每次都是新解析的对象，不能用 indexOf 跨次数组找引用，
  // 必须在同一次解析结果里用 findIndex 定位
  const all = loadArticles();
  const index = all.findIndex((a) =>
    (a.words || []).some((w) => String(w).toLowerCase() === key)
  );
  if (index === -1) {
    toast(`还没有包含 “${word}” 的短文（攒满 ${WORDS_PER_ARTICLE} 词后自动生成）`);
    return;
  }
  switchPage("articlePage");
  const card = articleList.querySelector(`.article-card[data-index="${index}"]`);
  if (!card) return;

  // 清掉上一次跳转留下的黄色特别高亮
  articleList.querySelectorAll("mark.target").forEach((m) => m.classList.remove("target"));

  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1600);

  // 该词在文中特别标黄（所有匹配处），并滚动到第一处
  const marks = [...card.querySelectorAll("mark")].filter(
    (m) => cleanWord(m.textContent) === key
  );
  if (marks.length) {
    marks.forEach((m) => m.classList.add("target"));
    marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    marks[0].classList.add("flash");
    setTimeout(() => marks.forEach((m) => m.classList.remove("flash")), 1600);
  } else {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
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

// ---------- 搜索面板（入口在单词页） ----------
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

// ---------- 导入单词（设置页） ----------
importBtn.addEventListener("click", () => {
  importPanel.classList.remove("hidden");
  importInput.value = "";
  importProgress.textContent = "";
  importInput.focus();
});

closeImportBtn.addEventListener("click", () => {
  if (importing) {
    toast("导入进行中，关闭后仍会继续完成", 2500);
  }
  importPanel.classList.add("hidden");
});

importConfirmBtn.addEventListener("click", runImport);

async function runImport() {
  if (importing) return;
  if (generating) {
    toast("有短文正在生成，请稍候再试", 2500);
    return;
  }

  const tokens = importInput.value
    .trim()
    .split(/[\s,，、;；]+/)
    .filter(Boolean);

  if (!tokens.length) {
    toast("请先粘贴要导入的单词");
    return;
  }

  const invalid = [];
  const seen = new Set();
  const candidates = [];
  for (const t of tokens) {
    if (!/^[A-Za-z][A-Za-z' -]{0,30}$/.test(t)) {
      invalid.push(t);
      continue;
    }
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(t);
  }

  const fresh = candidates.filter((t) => !findWord(t));
  const skippedDup = candidates.length - fresh.length;

  if (fresh.length > 100) {
    toast(`一次至多导入 100 个生词，当前 ${fresh.length} 个，请减少后重试`, 3500);
    return;
  }
  if (!fresh.length) {
    toast(`没有需要导入的新单词${skippedDup ? `（${skippedDup} 个已存在，跳过）` : ""}`, 3000);
    return;
  }

  importing = true;
  importConfirmBtn.disabled = true;
  let ok = 0;
  const failed = [];
  try {
    for (let i = 0; i < fresh.length; i++) {
      importProgress.textContent = `正在查询 ${i + 1}/${fresh.length}：${fresh[i]} …`;
      try {
        const d = await explainWord(fresh[i]);
        addWord({
          word: d.word || fresh[i],
          meaning: d.meaning || "",
          pos: d.pos || "",
          examples: Array.isArray(d.examples) ? d.examples : [],
          usage: d.usage || "",
        });
        ok++;
      } catch {
        failed.push(fresh[i]);
      }
    }
    renderWords();
    renderSettingsStats();

    // 导入完成后，按每 10 词一组自动生成分组短文
    let groupNo = 0;
    while (getPendingWords().length >= WORDS_PER_ARTICLE) {
      groupNo++;
      importProgress.textContent = `查询完成，正在生成第 ${groupNo} 组短文……`;
      await generateFor(getPendingWords().slice(0, WORDS_PER_ARTICLE).map((w) => w.word));
      if (generating) break; // 生成失败时不再死循环
    }
  } finally {
    importing = false;
    importConfirmBtn.disabled = false;
  }

  const parts = [`成功 ${ok} 个`];
  if (failed.length) parts.push(`失败 ${failed.length} 个（${failed.join(" ")}）`);
  if (invalid.length) parts.push(`忽略无效输入 ${invalid.length} 个`);
  if (skippedDup) parts.push(`跳过已存在 ${skippedDup} 个`);
  importProgress.textContent = `导入完成：${parts.join("，")}`;
  toast("导入完成", 2500);
}

// ---------- 设置页 ----------
apiBaseLine.textContent = `当前后端：${getApiBase()}（已内置，无需设置）`;

testApiBtn.addEventListener("click", async () => {
  testApiBtn.disabled = true;
  toast("正在测试连接……", 30000);
  try {
    await pingHealth();
    toast("后端连接正常 ✓");
  } catch {
    toast("连接失败，请检查手机网络是否能访问该后端地址", 3500);
  } finally {
    testApiBtn.disabled = false;
  }
});

genNowBtn.addEventListener("click", () => {
  const pending = getPendingWords().map((w) => w.word);
  generateFor(pending); // 剩余生词不足 10 个也可成组，作为独立一组显示
});

clearDataBtn.addEventListener("click", () => {
  if (!confirm("确定要清空本地单词和文章吗？")) return;
  clearAll();
  localStorage.removeItem(COLLAPSE_KEY);
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
