// 端到端集成测试：本地模拟 OpenAI 兼容大模型，跑通 Worker 两个接口
// node worker/test-integration.mjs
import http from "node:http";
import assert from "node:assert";
import worker from "./src/index.js";

const WORDS = ["abandon", "curious", "journey", "brave", "whisper", "ancient", "modern", "gentle", "courage", "shadow"];

let articleCalls = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const messages = JSON.parse(body).messages;
    const system = messages[0].content;
    let content;

    if (system.includes("解释用户")) {
      // 模拟带 ```json 代码块的返回，测试容错解析
      content =
        "```json\n" +
        JSON.stringify({
          word: "abandon",
          phonetic: "/əˈbændən/",
          meaning: "放弃；抛弃",
          pos: "动词",
          examples: ["Don't abandon your goals.", "They abandon the plan."],
          usage: "常用于 abandon sth / abandon doing sth",
        }) +
        "\n```";
    } else if (system.includes("语境")) {
      // 文中查词：语境义
      content = JSON.stringify({ word: "abandon", meaning: "此处指“放纵（自己）”，作及物动词" });
    } else {
      articleCalls++;
      // 从 system 提示里解析目标单词列表，按需生成合格篇幅（每词约 20 词一句）
      const targets = [...system.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      if (articleCalls === 1) {
        // 第一次故意返回不合格：太短且漏词 → 应触发 Worker 自动重试
        content = "Too short. The <mark>abandon</mark> curious journey end.";
      } else {
        content = targets
          .map(
            (w) =>
              `The <mark>${w}</mark> glowed brightly in the morning sun, and everyone in the small village saw it clearly and smiled together warmly.`
          )
          .join("\n\n");
      }
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const env = {
  LLM_API_KEY: "test-key",
  LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  LLM_MODEL: "mock-model",
};

try {
  // ---- /api/explain-word ----
  const r1 = await worker.fetch(
    new Request("http://x/api/explain-word", {
      method: "POST",
      body: JSON.stringify({ word: "abandon" }),
    }),
    env
  );
  assert.equal(r1.status, 200);
  const d1 = await r1.json();
  assert.equal(d1.meaning, "放弃；抛弃");
  assert.equal(d1.phonetic, "/əˈbændən/");
  assert.equal(d1.examples.length, 2);
  assert.ok(d1.usage.includes("abandon sth"));
  console.log("explain-word ✓", JSON.stringify(d1, null, 0));

  // ---- /api/explain-context（文中查词）----
  const rc = await worker.fetch(
    new Request("http://x/api/explain-context", {
      method: "POST",
      body: JSON.stringify({ word: "abandon", context: "He chose to abandon his post." }),
    }),
    env
  );
  assert.equal(rc.status, 200);
  const dc = await rc.json();
  assert.ok(dc.meaning.includes("此处"), "应返回语境义");
  console.log("explain-context ✓", JSON.stringify(dc, null, 0));

  // ---- /api/generate-article（第一次不合格 → 自动重试）----
  const r2 = await worker.fetch(
    new Request("http://x/api/generate-article", {
      method: "POST",
      body: JSON.stringify({ words: WORDS }),
    }),
    env
  );
  assert.equal(r2.status, 200);
  const d2 = await r2.json();
  assert.equal(articleCalls, 2, "应触发一次重试");
  const marks = (d2.article.match(/<mark>/g) || []).length;
  assert.equal(marks, WORDS.length, "每个生词都应被 <mark> 包裹");
  assert.ok(d2.word_count >= 180 && d2.word_count <= 230, `10 词组应 180-230 词，实际 ${d2.word_count}`);
  assert.ok(!/<(?!\/?mark>)[a-z]/i.test(d2.article), "不应出现其它 HTML 标签");
  console.log(`generate-article ✓ ${d2.word_count} 词，${marks} 个 <mark>，含自动重试`);

  // ---- 长度阶梯：3 词 → 50-70，5 词 → 80-120 ----
  for (const [n, min, max] of [[3, 50, 70], [5, 80, 120]]) {
    const words = WORDS.slice(0, n);
    const rt = await worker.fetch(
      new Request("http://x/api/generate-article", {
        method: "POST",
        body: JSON.stringify({ words }),
      }),
      env
    );
    assert.equal(rt.status, 200);
    const dt = await rt.json();
    assert.ok(
      dt.word_count >= min && dt.word_count <= max,
      `${n} 词组应 ${min}-${max} 词，实际 ${dt.word_count}`
    );
    assert.equal((dt.article.match(/<mark>/g) || []).length, n);
    console.log(`阶梯 ${n} 词 ✓ ${dt.word_count} 词`);
  }

  console.log("integration tests: all passed ✓");
} finally {
  server.close();
}
