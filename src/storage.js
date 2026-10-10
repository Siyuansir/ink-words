// 本地存储层：单词与短文（含按词检索）
const WORDS_KEY = "ink_words";
const ARTICLES_KEY = "ink_articles";

export const WORDS_PER_ARTICLE = 10;

export function loadWords() {
  try {
    const list = JSON.parse(localStorage.getItem(WORDS_KEY)) || [];
    // 兼容旧数据：补上 used 标记
    list.forEach((w) => {
      if (typeof w.used !== "boolean") w.used = false;
    });
    return list;
  } catch {
    return [];
  }
}

export function saveWords(words) {
  localStorage.setItem(WORDS_KEY, JSON.stringify(words));
}

// 返回 { added: boolean, words: [...] }
export function addWord(wordObj) {
  const words = loadWords();
  const exists = words.find(
    (w) => w.word.toLowerCase() === wordObj.word.toLowerCase()
  );
  if (exists) return { added: false, words };
  words.unshift({ ...wordObj, used: false, time: Date.now() });
  saveWords(words);
  return { added: true, words };
}

export function findWord(word) {
  const key = word.toLowerCase();
  return loadWords().find((w) => w.word.toLowerCase() === key) || null;
}

// 尚未用于生成短文的单词（按录入先后排序，最早在前）
export function getPendingWords() {
  return loadWords()
    .filter((w) => !w.used)
    .sort((a, b) => a.time - b.time);
}

export function markWordsUsed(wordList) {
  const keys = new Set(wordList.map((w) => String(w).toLowerCase()));
  const words = loadWords();
  words.forEach((w) => {
    if (keys.has(w.word.toLowerCase())) w.used = true;
  });
  saveWords(words);
  return words;
}

export function loadArticles() {
  try {
    return JSON.parse(localStorage.getItem(ARTICLES_KEY)) || [];
  } catch {
    return [];
  }
}

export function saveArticles(articles) {
  localStorage.setItem(ARTICLES_KEY, JSON.stringify(articles));
}

export function addArticle(articleObj) {
  const articles = loadArticles();
  articles.unshift({ ...articleObj, time: articleObj.time || Date.now() });
  saveArticles(articles);
  return articles;
}

// 包含指定单词的所有短文（数组顺序：新 → 旧）
export function findArticlesByWord(word) {
  const articles = loadArticles();
  const key = word.toLowerCase();
  return articles.filter((a) =>
    (a.words || []).some((w) => String(w).toLowerCase() === key)
  );
}

export function clearAll() {
  localStorage.removeItem(WORDS_KEY);
  localStorage.removeItem(ARTICLES_KEY);
}
