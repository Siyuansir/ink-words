# 墨词（ink-words）

手机端优先的英语生词学习网站：

- 输入英语生词 → 大模型返回中文含义、词性、例句、语法用法（默认千问，后端地址已内置，用户无需填写）
- 每攒满 **10 个生词**自动生成一篇英语短文，生词用 `<mark>` 高亮；篇幅按词数分档：**2–3 词 → 50–70 词、4–6 词 → 80–120 词、7–10 词 → 180–230 词**（自动改写取最接近目标的一版）；**每 10 词自动分为一组，可展开/隐藏**，剩余生词手动生成时也单独成组（至少 2 词）
- 单词页 ↔ 文章页双向点击跳转定位，跳转后目标词在短文中**特别标黄**
- "搜索"入口仅在单词页显示，可检索已查过的单词并跳转
- 设置页支持**批量导入单词**（空格分隔，一次至多 100 个，逐个查询释义并自动分组）与**导出全部单词**（按查询先后空格排列，一键复制）
- 数据保存在浏览器本地（localStorage），零服务器成本

架构：GitHub Pages 静态前端（Vite）→ Cloudflare Worker → 大模型 API（DeepSeek / GLM / Moonshot / OpenAI 等 OpenAI 兼容接口）。API Key 只存在 Worker Secrets 中，前端不接触密钥。

## 目录结构

```
ink-words/
├── index.html / 404.html     # 前端页面（404.html 兼容 GitHub Pages 刷新）
├── vite.config.js            # base './'，任意子路径可用
├── src/
│   ├── style.css             # 水墨风样式
│   ├── storage.js            # 本地存储 + 按词检索文章
│   ├── api.js                # 调用 Worker（含 XSS 净化）
│   └── main.js               # 页面切换、查词、自动攒文、双向跳转、搜索
├── worker/
│   ├── wrangler.toml         # Worker 配置（服务商在 [vars] 中切换）
│   ├── .dev.vars.example     # 本地密钥模板（复制为 .dev.vars）
│   └── src/index.js          # /api/explain-word、/api/generate-article
└── .github/workflows/deploy.yml  # 一键发布 GitHub Pages
```

## 一、本地开发

### 1. 启动 Worker（先配置密钥）

```bash
cd worker
copy .dev.vars.example .dev.vars     # Windows；macOS/Linux 用 cp，并填入你的 LLM_API_KEY
npx wrangler dev                     # 默认 http://localhost:8787
```

> 没有 Cloudflare 账号也能本地跑：`wrangler dev` 本地模式不需要登录即可调试；
> 首次使用 `npx wrangler login` 授权一次即可。

### 2. 启动前端

```bash
npm install
npm run dev        # http://localhost:5173
```

手机在同一 Wi-Fi 下访问 `http://电脑IP:5173` 时，请把前端**设置页**的“后端接口地址”
改为 `http://电脑IP:8787`（默认 localhost 只在电脑浏览器上有效）。
本地 HTTP 明文在手机上完全可用；日后 Worker 上线自带 https，就不受限制。

## 二、部署 Worker

```bash
cd worker
npx wrangler secret put LLM_API_KEY   # 按提示粘贴密钥
npx wrangler deploy
```

部署成功后得到 `https://ink-words-api.<你的用户名>.workers.dev`。

### 更换大模型服务商

编辑 `worker/wrangler.toml` 的 `[vars]`（或用 `wrangler secret put` / `--var`）：

| 服务商 | LLM_BASE_URL | LLM_MODEL |
| --- | --- | --- |
| **千问（当前默认）** | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus`（可选 `qwen-turbo` / `qwen-max` / `qwen-flash`） |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| Moonshot Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |

千问的 API Key 在[阿里云百炼控制台](https://bailian.console.aliyun.com/)（右上角头像 → API-KEY → 创建）获取，形如 `sk-xxxx`。

想接本地 **Ollama**：Ollama 提供 OpenAI 兼容接口（`http://localhost:11434/v1`），
但 Cloudflare 服务器访问不到你本机，需先用 `cloudflared tunnel` 暴露后再把
`LLM_BASE_URL` 指向隧道地址。前端与接口不用改。

## 三、部署前端到 GitHub Pages

1. 新建 GitHub 仓库，把本目录全部文件推送到 `main` 分支；
2. 仓库 **Settings → Pages → Source** 选择 **GitHub Actions**；
3. 推送后 Actions 会自动构建并发布到 `https://<用户名>.github.io/<仓库名>/`；
4. 打开网站 → **设置页** → 填入 Worker 地址 → 保存 → 点“测试接口连通”。

> 手动部署也可以：`npm run build` 后把 `dist/` 内容推到 `gh-pages` 分支。
> `vite.config.js` 已用相对路径 `base: './'`，无需按仓库名改配置；
> `404.html` 与 `.nojekyll` 均已就位（`.nojekyll` 在 `public/` 中会一起打包）。

## 四、使用流程

1. 单词页输入生词 → 点“查词”（或回车）→ 卡片显示释义；
2. 攒满 10 个新词自动生成短文（顶部有进度提示，可在原页面等待，也可继续查词）；
3. 点击**单词卡片** → 跳到最新一篇包含该词的短文并滚动到 `<mark>` 高亮处；
4. 点击**短文中的高亮词**（或文首的生词标签）→ 跳回单词页并定位该词卡片；
5. 顶部“搜索”按钮 → 按英文或中文含义检索已查过的单词，点击直达。

## 五、自检（可选）

```bash
node worker/test-smoke.mjs        # Worker 路由/参数校验/mark 净化等逻辑
node worker/test-integration.mjs  # 本地模拟大模型，端到端跑通两个接口（含自动重试）
```

## 常见问题

- **手机上白屏**：请通过 `https://` 的 GitHub Pages 地址访问；若访问的是局域网 `http://IP:5173`，部分浏览器会拦截非安全上下文的 fetch，属正常现象。
- **提示“无法连接后端”**：设置页里接口地址要填 Worker 完整域名（`https://...workers.dev`），手机端不能填 `localhost`。
- **国内手机访问 `*.workers.dev` 失败**：该默认域名在大陆常被阻断，属网络问题而非配置错误。解决办法：Cloudflare 控制台 → Workers → 设置 → 域和路由 → **自定义域**，绑定一个自有域名（需托管在同一 Cloudflare 账号），之后接口地址填 `https://api.你的域名.com`。
- **文章词数不足/超**：后端按分档长度要求模型并在越界/漏词时自动重写一次，返回两版中最接近目标的一版；非目标词的误高亮会直接还原为纯文本。极端情况下仍可能有 ±5% 偏差，属模型能力限制。
- **换手机数据不互通**：数据存在浏览器本地，后续可按方案接 Supabase / Cloudflare D1 同步。
