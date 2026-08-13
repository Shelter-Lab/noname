# 无名杀 PWA 版（Shelter-Lab fork）

本仓库是 [libnoname/noname](https://github.com/libnoname/noname)（开源三国杀引擎「无名杀」）的一个 fork，
在**不改动游戏引擎**的前提下，把它改造成**纯静态可部署、可安装到主屏、离线可玩的 PWA**，
并新增**房间号 P2P 联机**（浏览器/PWA 也能当房主，无需 Node 服务器）和**自建武将**（纯 JSON，重启不丢）。

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
- `apps/core/pwa-sw.js`：Service Worker 离线缓存（install 预缓存核心 ~32MB）
- `apps/core/pwa-asset-db.js`：**素材仓库（IndexedDB）**，见下节「存储分工」
- 处理了 iOS 特有坑：重定向响应洗白（`response has redirections` 白屏）、localStorage 为 null 兜底、
  冷启动超时与失败自动重试

### 3. 存储分工：代码在 Cache Storage，素材在 IndexedDB

**这不是设计洁癖，是踩了「iOS 冷启动 15.8 秒」才换的架构**
（完整推导见 [TROUBLESHOOTING 病因七](./TROUBLESHOOTING.md)）：

| | 装什么 | 数量 |
|---|---|---|
| **Cache Storage**（`noname-code-v1`） | 代码 + 启动路径上的 103 个小素材（splash / 主菜单背景 / 卡牌框 / 基础字体） | ~746 条 |
| **IndexedDB**（`noname-assets`） | 立绘、语音、内置扩展、花体字；另有一条 `__asset_baseline__` 记本地内容哈希 | 清单 ~14300 条 |

**为什么必须分开**：WebKit 的 `caches.open()` 会扫**该 origin 下每个桶的每一条 record 文件**
（源码 `CacheStorageManager::allCaches` 里 `for (每个桶) cache->open()`），而磁盘上没有 record 级
索引，所以这笔账每次冷启动都要重付。实测 21307 条（含约 6000 条改名/下架后没人清理的历史残留，故比清单数大）× ≈0.74ms
= **15.8 秒，且全花在交出
index.html 之前**（总 16.4s 里首页占 15.7s）。成本正比于**条目数**、与总字节无关
（扫描跳过大 body 实体）—— 故**拆桶无效**（已实测 + 源码双证）、**压缩体积无效**，
唯一杠杆是把素材挪出 Cache Storage。Chromium 有持久化索引，同条件下只要几十毫秒，
所以桌面上压根看不出这个问题。

代码留在 Cache Storage 是因为它要「整版原子一致」（产物文件名不带 hash，必须整批换，
否则新旧 chunk 混搭直接白屏），而 746 条不构成成本。

**改这块前必读两条红线**：
1. **素材只存 ArrayBuffer，绝不存 Blob** —— WebKit 下 IDB 里的 Blob 会每个落成一个独立
   `.blob` 文件，等于把「万文件」问题原样搬回来；且 iOS 有至今未修的 Blob 损坏 bug。
2. **任何往 Cache Storage 写素材的代码都会把那 15.8 秒悄悄养回来** ——
   而且它连"有用"都算不上：SW 只从 IDB 读素材，写进 Cache Storage 是个没人读的副本。

### 4. 离线资源下载与更新
- 选项菜单加「下载离线资源」按钮：批量缓存全部立绘/语音（约 1GB），
  跳过已有（续传）、显示进度、处理 iOS 配额上限
- 构建时生成三份清单：`pwa-core-assets.json`（核心预缓存）、`pwa-all-assets.json`（全量可下载）、
  `pwa-asset-hashes.json`（**内容哈希**，见下）
- **访问即缓存**：联网玩过一局，那局出现的立绘/语音自动进素材库，之后离线可复玩
- **素材更新（2026-08-13 重做）**：换版后第一次访问某素材时会后台问一次「变了没」，
  但**这条路不可靠，不能指望它**——两个原因：
  - 我们的记录只有 `{ buf, mime, len }`、**没存 ETag**，所以发不出 `If-None-Match`；
    能不能省流量完全取决于**浏览器自己的** HTTP 缓存还留着没有，而本地压着 1GB 素材时基本都被挤掉了
  - 开窗标记 `assetRevalidateWindow` 是**内存变量**，只在 install 里置 true，
    且只对「窗口开着时恰好被请求到」的素材生效。iOS 回收 SW 很凶，翻到那张牌时实例早没了
- **可靠的那条路：内容哈希清单**。构建对每个文件算 SHA-256 取前 16 位写进 `pwa-asset-hashes.json`；
  「检查更新」下这一份（几百 KB，CF 会 gzip）与**本地基线**逐条 diff，得到精确变更集，只重下那几个。
  - **基线本地算，不采信服务端清单** —— 直接存服务端那份等于替本地撒谎：
    库里明明是旧字节、基线却声称与线上一致，之后永远 diff 不出差异
  - 基线存成**一条记录**（`__asset_baseline__`），不是给每条素材加字段 ——
    因为 IDB 取一条会把整条（含 `buf`）反序列化出来，没法只读某个字段，
    "读全部 len"就等于把 1GB 素材全读一遍
  - 为什么不用文件名内嵌 hash：见 `TROUBLESHOOTING.md`「为什么至今没给产物加 content hash」。
    那份决策仍然有效（代码产物**不**加文件名 hash），本方案只补它明确治不了的素材那一块，且**不动任何文件名**
- **写入失败会如实弹窗**（iOS 有个未修的 IDB 写入间歇失败 bug），再点一次可补齐 ——
  默默报「完成」而实际少素材，表现成"玩到那里才发现是剪影"，比当场说出来难查得多

### 5. 房间号 P2P 联机（PWA 也能当房主）
官方开服用 `require("ws")`，纯浏览器开不了服。新增 **PeerJS（WebRTC P2P）传输后端**：
- `apps/core/noname/library/element/peerAdapter.js`：把 PeerJS DataConnection 适配成 WebSocket 对象，
  上层联机逻辑（房主权威 + 消息协议）**零改动**
- `game.createServer` 纯浏览器走 PeerJS 开房（peerId = 房间号）；`game.connect` 输房间号走 P2P，输 IP 走原 WebSocket——两种并存
- 联机界面「创建房间」按钮（纯浏览器显示）
- ICE 用免费公共 STUN + TURN

**用法**：创建房间 → 选模式 → 点「启」→ 等待界面显示房间号 → 对方在地址栏输房间号加入。
（单机全模式：身份/国战/乱斗/斗地主/BOSS/塔防等离线可玩。）

### 6. 手动检查更新
「其它 → 更新」界面加「检查更新」按钮（纯手动），PWA 下拉取最新版并刷新，缓存保留。

一次点击依次做三件事：
1. **代码版本** —— 比对线上构建戳与页面正在跑的戳；有新版问是否刷新
2. **缓存体检** —— 代码缓存里的戳与实际在跑的不符时（多是上次 install 在弱网被掐断），
   提供「强制重装核心代码文件」；只差几个文件则如实告知（启动会自动补齐，能自愈）
3. **素材比对** —— 下内容哈希清单与本地基线 diff。首次会先问是否建基线
   （**纯本地计算、不联网、不耗流量**，带 `n/总数` 进度）；建完立刻再比一次，
   发现不一致就问是否更新，**只下差异那几个，不动其余素材**

清单取不到（老构建或离线）时这一步静默跳过，不影响版本检查。

### 7. 网页扩展（自建武将）
本体「扩展 → 制作扩展」在纯静态部署下**重启即失效**：它生成的扩展代码要靠原生 `import()` 去 fetch
`/extension/<名>/extension.js`，这个路径在 CDN 上不存在。

所以另开一条路——「扩展 → **网页扩展**」，不生成任何源码：
- 武将定义以 **JSON 存 IndexedDB**（`data` 仓，key `pwa_diy_characters`），立绘作为 Blob 存 `image` 仓
  （key 前缀 `pwa_diy:`），读出来转 data URL 挂到 `Character.img`
- 技能**只能挑现成的**（`lib.skill` 里已有的，选一个武将再从它的技能里挑，衍生技也列出来），
  所以完全不需要 eval / sandbox
- 启动时由 [util/diyCharacter.js](apps/core/noname/util/diyCharacter.js) 注入运行期
  （`lib.character` / `lib.characterPack.pwa_diy` / `lib.translate`）。注入点在
  [init/index.ts](apps/core/noname/init/index.ts) 的扩展全部加载完之后、建 arena 之前——
  早了技能可能还没就位，晚了选将界面算不到
- **联机模式跳过注入**，理由同本体扩展默认 `connect:false`（`init/loading.ts:232`）：
  主机多出几个客户端没有的武将会直接不同步
- 立绘从手机自己的相册/文件选，导入导出走一个 JSON 文件（含 base64 立绘），可以在设备间搬

用法：扩展 → 网页扩展 → 选头像、填姓名/显示名/体力/性别/势力 → 挑技能 → 保存，当局即可在选将界面选到。

> 两个坑记一下：`menu.css:98` 有条 `.menu-buttons div { position: absolute }`，面板里所有普通 div
> 都得自己覆盖成 `relative`，否则糊成一坨；`get.infoHp("4")` 对纯数字字符串返回 **0**，
> 存之前必须先 `parseInt`（本体 `exetensionMenu.js:1191` 也是这么干的）。

### 8. 补齐缺失的武将立绘（消除剪影）
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

## 部署（Cloudflare Workers Static Assets）

注意是 **Workers**，不是 Pages——域名 `*.workers.dev`，部署命令是 `wrangler deploy`
（不是 `wrangler pages deploy`），仓库里也没有 `_headers` / `_redirects` / `functions/` 这些 Pages 专属文件。

**`git push origin main` 即触发自动构建部署**（约 5-6 分钟），地址不变，
手机上已装的 PWA 点「其它 → 更新 → 检查更新」就能拿到新版，不用重装、不用重下离线资源。

Git 连接自动构建，控制台配置（这几项在 Cloudflare 控制台侧，不在仓库里）：

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

`package.json` 里**没有 deploy 脚本**（部署由 CF 侧的 Deploy command 执行），可用的就这几条：

```bash
pnpm install
pnpm dev      # 开发服务器（带文件服务器）
pnpm build    # 构建到 dist/
pnpm serve    # 用 @noname/fs 起静态服务器伺服 dist/
pnpm start    # build + serve
```

纯静态验证：`cd dist && python -m http.server`（无文件服务器接口，等效 CF 环境）。

---

*基于 GPL-3.0，与官方无名杀/三国杀无隶属关系。游戏内容版权归原作者。*
