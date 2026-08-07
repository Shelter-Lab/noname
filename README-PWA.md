# 无名杀 PWA 版（Shelter-Lab fork）

本仓库是 [libnoname/noname](https://github.com/libnoname/noname)（开源三国杀引擎「无名杀」）的一个 fork，
在**不改动游戏引擎**的前提下，把它改造成**纯静态可部署、可安装到主屏、离线可玩的 PWA**，
并新增**房间号 P2P 联机**（浏览器/PWA 也能当房主，无需 Node 服务器）。

在线体验：<https://noname.xuehaote.workers.dev/>（用 Safari/Edge/Chrome 打开 → 添加到主屏）

---

## 相比官方版做了什么

### 1. 纯静态可部署（脱离文件服务器）
官方浏览器端依赖 `@noname/fs` 文件服务器（`/checkFile` `/readFile` 等 HTTP 接口）读写磁盘，
纯静态托管（如 Cloudflare）没有这个后端。改动：
- `apps/core/noname/init/browser.js`：启动探测文件服务器，**没有则走纯静态模式**——
  读操作退回 `fetch` 真实 URL（文件本就在那个地址，比 base64 塞 JSON 更快、可缓存），
  写 / 列目录转 **IndexedDB 虚拟文件系统**。探测加 2 秒超时，避免断网时干等。

### 2. PWA 外壳
- `apps/core/manifest.webmanifest`：可安装、独立窗口、图标
- `apps/core/pwa-sw.js`：Service Worker 离线缓存（stale-while-revalidate + install 预缓存核心 ~32MB）
- 处理了 iOS 特有坑：重定向响应洗白（`response has redirections` 白屏）、localStorage 为 null 兜底、
  冷启动超时与失败自动重试

### 3. 离线资源下载
- 选项菜单加「下载离线资源」按钮：批量缓存全部立绘/语音（约 1GB），
  跳过已缓存（续传）、显示进度、完成后锁定、处理 iOS 配额上限
- 构建时生成 `pwa-core-assets.json`（核心预缓存清单）和 `pwa-all-assets.json`（全量可下载清单）

### 4. 房间号 P2P 联机（PWA 也能当房主）
官方开服用 `require("ws")`，纯浏览器开不了服。新增 **PeerJS（WebRTC P2P）传输后端**：
- `apps/core/noname/library/element/peerAdapter.js`：把 PeerJS DataConnection 适配成 WebSocket 对象，
  上层联机逻辑（房主权威 + 消息协议）**零改动**
- `game.createServer` 纯浏览器走 PeerJS 开房（peerId = 房间号）；`game.connect` 输房间号走 P2P，输 IP 走原 WebSocket——两种并存
- 联机界面「创建房间」按钮（纯浏览器显示）
- ICE 用免费公共 STUN + TURN

**用法**：创建房间 → 选模式 → 点「启」→ 等待界面显示房间号 → 对方在地址栏输房间号加入。
（单机全模式：身份/国战/乱斗/斗地主/BOSS/塔防等离线可玩。）

### 5. 手动检查更新
「其它 → 更新」界面加「检查更新」按钮（纯手动），PWA 下拉取最新版并刷新，缓存保留。

### 6. 补齐缺失的武将立绘（消除剪影）
上游有一批武将**没有自己的立绘文件**，游戏会回落成性别剪影
（[polyfill.ts](apps/core/noname/init/polyfill.ts) 给 `backgroundImage` 塞两个 url，
第二个是 `default_silhouette_{sex}.jpg`，CSS 多背景自动兜底）。本 fork 全部补齐，详见
**[立绘补齐说明](./docs/CHARACTER-IMAGES.md)** —— 含完整映射表、复查脚本、以及给新武将补图的规格要求。

一句话结论：2494 个武将条目现在**零剪影**。手段分三类：从上游下载真图（4 个）、
`img:` 字段复用同一人物的其它版本立绘（35 个）、外部找图转码补入（6 个）。

配套两个脚本（同步上游后跑一次审计即可知道有没有新的缺图）：

```bash
node scripts/audit-character-images.cjs        # 审计缺图，并给出可复用的同人物候选
python scripts/fit-character-image.py <图> <id>  # 外部找的图转成 350×464 规格并落位
```

---

## 部署（Cloudflare）

Git 连接自动构建（Workers Static Assets），控制台配置：

| 项 | 值 |
|---|---|
| Build command | `pnpm install --no-frozen-lockfile && pnpm build` |
| Deploy command | `npx wrangler deploy` |
| 环境变量 | `SKIP_DEPENDENCY_INSTALL=1`、`PNPM_VERSION=11.20.0`、`NODE_VERSION=24` |

`wrangler.jsonc` 指向 `dist`，**不设 not_found_handling**（保持 404 真实返回，
否则会破坏 browser.js 的 checkFile 文件探测）。

> 踩坑记录：Node 必须 24（core 的 `scripts/build.ts` 用了 Node 24+ 的 `import.meta.main`，
> Node 22 下 core 不构建）；pnpm 用 11.x；各子包独立 lockfile 需 `--no-frozen-lockfile`。

## 本地开发

```bash
pnpm install
pnpm dev      # 开发服务器（带文件服务器）
pnpm build    # 构建到 dist/
```

纯静态验证：`cd dist && python -m http.server`（无文件服务器接口，等效 CF 环境）。

---

*基于 GPL-3.0，与官方无名杀/三国杀无隶属关系。游戏内容版权归原作者。*
