// 本地冒烟测试：node worker/test-smoke.mjs
import worker, { sanitizeArticle, countWords, missingWords, lengthTier, unwrapExtraMarks } from "./src/index.js";
import assert from "node:assert";

// ---- 误高亮自动还原 ----
assert.equal(unwrapExtraMarks("The <mark>cat</mark> and <mark>abandon</mark>", ["abandon"]), "The cat and <mark>abandon</mark>");
assert.equal(unwrapExtraMarks("a <mark>by-product</mark> here", ["by-product"]), "a <mark>by-product</mark> here");
assert.equal(unwrapExtraMarks("<mark>Abandon</mark> ship", ["abandon"]), "<mark>Abandon</mark> ship");

// ---- 长度阶梯 ----
assert.deepEqual(lengthTier(2), { min: 50, max: 70, paras: "2" });
assert.deepEqual(lengthTier(3), { min: 50, max: 70, paras: "2" });
assert.deepEqual(lengthTier(4), { min: 80, max: 120, paras: "3" });
assert.deepEqual(lengthTier(6), { min: 80, max: 120, paras: "3" });
assert.deepEqual(lengthTier(7), { min: 180, max: 230, paras: "3-4" });
assert.deepEqual(lengthTier(10), { min: 180, max: 230, paras: "3-4" });

// ---- 逻辑函数 ----
assert.equal(
  sanitizeArticle('Hi <mark>abandon</mark> <b>bold</b><script>x</script> end'),
  "Hi <mark>abandon</mark> boldx end"
);
assert.equal(sanitizeArticle("<mark>a <mark>b</mark>"), "<mark>a b</mark>");
assert.equal(sanitizeArticle("a</mark>b"), "ab");
assert.equal(sanitizeArticle("<mark>abc"), "<mark>abc</mark>");
assert.equal(sanitizeArticle("<MARK>keep</MARK>"), "<mark>keep</mark>");

assert.equal(countWords("one two <mark>three</mark> four."), 4);
assert.deepEqual(missingWords("The <mark>abandon</mark> plan", ["abandon", "journey"]), ["journey"]);
assert.deepEqual(missingWords("abandoned, and a journey.", ["abandoned", "journey"]), []);

// ---- HTTP 路由 ----
const env = {}; // 故意不配 LLM_API_KEY，验证错误提示友好

let res = await worker.fetch(new Request("http://x/api/health"), env);
assert.equal(res.status, 200);
assert.equal((await res.json()).ok, true);

res = await worker.fetch(
  new Request("http://x/api/explain-word", {
    method: "POST",
    body: JSON.stringify({ word: "123" }),
  }),
  env
);
assert.equal(res.status, 400); // 非法单词被拦下，不消耗模型调用

// /api/explain-context 参数校验
res = await worker.fetch(
  new Request("http://x/api/explain-context", {
    method: "POST",
    body: JSON.stringify({ word: "run", context: "" }),
  }),
  env
);
assert.equal(res.status, 400); // 空语境被拦下

// /api/generate-article 词数边界：1 个或 11 个都应被 400 拦下（不消耗模型调用）
res = await worker.fetch(
  new Request("http://x/api/generate-article", {
    method: "POST",
    body: JSON.stringify({ words: ["only"] }),
  }),
  env
);
assert.equal(res.status, 400);

res = await worker.fetch(
  new Request("http://x/api/generate-article", {
    method: "POST",
    body: JSON.stringify({ words: Array.from({ length: 11 }, (_, i) => "word" + i) }),
  }),
  env
);
assert.equal(res.status, 400);

res = await worker.fetch(new Request("http://x/api/unknown"), env);
assert.equal(res.status, 405);

res = await worker.fetch(
  new Request("http://x/api/explain-word", { method: "OPTIONS" }),
  env
);
assert.equal(res.status, 204);
assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");

res = await worker.fetch(
  new Request("http://x/api/explain-word", {
    method: "POST",
    body: JSON.stringify({ word: "abandon" }),
  }),
  env // 无密钥 → 502 且提示 wrangler secret put
);
assert.equal(res.status, 502);
assert.match((await res.json()).error, /LLM_API_KEY/);

console.log("worker smoke tests: all passed ✓");
