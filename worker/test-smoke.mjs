// 本地冒烟测试：node worker/test-smoke.mjs
import worker, { sanitizeArticle, countWords, missingWords } from "./src/index.js";
import assert from "node:assert";

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
