# 无名杀 PWA 踩坑记录(TROUBLESHOOTING)

本 fork 把无名杀改造成纯静态 PWA(部署 Cloudflare)过程中踩的坑,按「现象 → 根因 → 修法」记录。
**改 SW / 离线 / 部署相关代码前,先读这份**,避免重蹈覆辙(以下每条都真实发生过、反复横跳过)。

架构见 [README-PWA.md](./README-PWA.md)。部署实际用的是仓库根 `dist/`(不是 `apps/core/dist/`)。

---

## 一、CF 部署构建

| 现象 | 根因 | 修法 |
|---|---|---|
| CF 内置 `pnpm install --frozen-lockfile` 失败 | 各子包独立 lockfile,根 lockfile 不含 mobile 依赖 | 构建变量 `SKIP_DEPENDENCY_INSTALL=1` + build command 自写 `pnpm install --no-frozen-lockfile && pnpm build`。`.npmrc` 设 frozen-lockfile=false **对 CF 内置步骤无效** |
| core 不构建、合并步报 `apps/core/dist 不存在` | core 的 `scripts/build.ts` 用了 `import.meta.main`(**Node 24+ 才有**),Node 22 下为 undefined → main() 不执行 | **`NODE_VERSION=24`**(必须24)。另 `PNPM_VERSION=11.20.0` |

**CF 最终配置**:`SKIP_DEPENDENCY_INSTALL=1`、`PNPM_VERSION=11.20.0`、`NODE_VERSION=24`;Build `pnpm install --no-frozen-lockfile && pnpm build`;Deploy `npx wrangler deploy`。`wrangler.jsonc` 指 dist,**不设 not_found_handling**(否则 404 fallback 成 200 破坏 browser.js 的 checkFile 探测)。

---

## 二、iOS PWA 白屏(最难,反复踩)

### 底层机制(先理解这几条,是所有白屏的根)

1. **iOS 主屏 standalone PWA 是独立 origin**,和 Safari 浏览器的 SW/缓存**完全隔离**。在 Safari 里缓存的东西,主屏 PWA 用不到,要在主屏 PWA 里单独联网跑一次建缓存。
2. **iOS Safari/WebKit 断网时 `fetch()` 不 reject,而是长时间 pending 甚至永不返回**(Chromium 是秒失败)。这是最坑的行为差异——任何 `await fetch()` 断网都可能永久挂起。
3. **能否离线启动,唯一取决于「启动文件在不在缓存」**。超时只决定「卡30秒白屏」还是「快速失败」,不决定能不能启动。
4. **启动是 242 个 `<script type=module>` 静态标签**(dist/index.html),几乎在 t≈0 全部并行发起。boot 里有个 30 秒看门狗(init/index.ts),超时没加载完就弹「游戏似乎未正常载入,是否重置」。

| 现象 | 根因 | 修法 |
|---|---|---|
| `Response served by service worker has redirections` 白屏 | CF 把 `/index.html` 307 重定向到 `/`,SW 缓存了 redirected 响应;iOS 禁止 SW 返回 redirected 响应 | `sanitizeResponse()`:redirected 响应用响应体重建干净副本再缓存/返回。`start_url` 改 `/` 避免重定向 |
| `localStorage null is not an object` 崩溃 | iOS PWA/隐私模式下 localStorage 可能为 null | index.html 最早期做内存兜底(usable 探测→内存实现) |
| 冷启动"加载内容失败(undefined)" | 冷启动并发拉大量文件、SW 未接管,偶发失败 | 超时 30s + boot 失败自动 reload 重试一次(sessionStorage 防死循环) |
| **断网启动白屏几十秒 / 弹"未正常载入"** | **SW 对未命中缓存的资源用无超时 fetch(pwa-sw.js);iOS 断网 fetch 永久 pending → 启动 script 永不 load → 30秒看门狗弹框** | **见下「断网白屏根治方案」** |
| jit-test.ts / service-worker.js 断网加载失败 | 这些 dist 根级散文件漏在预缓存清单外(清单只扫子目录) | build.ts 补扫 dist 根一层的 .js/.ts 进核心清单 |

### 断网白屏根治方案(超时两难的正解)

**历史横跳教训(别重蹈)**:
- ❌ 导航请求用 Network-First → Safari 断网 fetch 挂死。**导航必须 Cache-First(SWR),绝不改回**。
- ❌ 给所有 fetch 加统一 2s 超时 → 断网启动不卡了,但「下载离线资源」批量拉未命中文件也被 2s 误杀 → 进度倒退。
- ❌ 用 `postMessage`/模块级变量标记"正在下载" → iOS 事件间隙会杀空闲 SW,重启后 flag 丢失,又开始误杀。**只用请求级无状态信号**。

**正解(pwa-sw.js `missTimeoutMs`,两个正交无状态信号分档)**:
- **下载器 + 清单**(唯一带 `req.cache === "no-cache"` 进 handler)→ **绝不超时**(避开误杀下载)
- **启动关键资源**(`req.destination` = script/style/document/font)→ `navigator.onLine===false` 确定离线时 **4s 快失败**(不再永久 pending 卡到 30s),在线 15s 容慢网
- **图片/音频/视频**(运行期大素材)→ 不超时

**为什么用这俩信号**:下载器 destination 是空串(不是 image/audio),但它带 `cache:"no-cache"`;启动 script 是 default cache 模式。两个信号完全正交,能无歧义区分「该快失败的启动脚本」和「绝不能超时的下载」,且无状态(扛得住 iOS 杀 SW 重启)。

**第2层根治(预缓存完整性)**:install 的 allSettled 会「首访网抖漏文件却标记成功」→ 离线白屏。修法:失败退避重试 3 轮 + `cache.match` 对账 709 项 + 存完成标记(`/__precache_status__`);页面 `QUERY_PRECACHE` 查询,没下齐则 console 警告"联网重开补齐"。

**残留风险(物理边界,绕不过)**:首访没下完就断网/关 PWA,预缓存不完整 → 下次离线仍白屏。只能靠完成标记提示,无法归零。

### 明确不要动
- 导航分支保持 Cache-First(SWR)+ 多 key 兜底
- 不给所有 fetch 加统一超时;超时只在 miss 分支且 no-cache 豁免
- 不用消息/模块变量标记状态
- 不做"SW 提前注册 + clients.claim"(对离线白屏无用,离线那次页面天然已被 active SW 接管)
- hit 分支 SWR、BYPASS、pwa-version.json 的 Network-First 都别动
- **缓存桶名恒为 `noname-pwa-v2`,activate 只删非当前桶**;改文件名/桶名会让"换版部署离线可用"风险剧增

### 其它 iOS 认知(实测纠正过的)
- **独立主屏 PWA 缓存稳定,不会被 iOS 乱清**(早先"7天清理/内存驱逐"说法对主屏 PWA 不成立)
- **iOS 新版 Edge/Chrome 也能装 PWA、能用**(不是只有 Safari;但底层都是 WebKit)
- **无痕模式不支持 SW**,断网必失败——测离线要用普通 Safari/主屏 PWA,不能无痕
- `audio.volume` 被 iOS 忽略(音量滑块无效,要绕得改 Web Audio GainNode,未做);无法代码强制横屏
- **主屏 PWA UA 常不含"Safari"** → `get.is.safari()=false` → 启用沙盒(走 sandbox.js iframe 加载);Safari 浏览器 UA 含"Safari"→跳过沙盒。这曾是"浏览器能进、主屏 PWA 白屏"的分叉点,现由 miss 分支的 destination=script 快失败统一覆盖(sandbox.js 命中缓存即秒开,未命中快失败,不再卡)

---

## 三、离线缓存 / 下载

| 现象 | 根因 | 修法 |
|---|---|---|
| 下载完再点"下载离线资源"→白屏 | 再点时逐个 `cache.match`(1.4万次)密集查询压垮 iOS 主线程 | 改用 `cache.keys()` 一次取全 + Set 批量比对 |
| 下载完锁定后无法补下新增文件("下载完的缓存没法再加") | 完成后打 localStorage 锁定,清单更新(新增 jit-test.ts)也不让重下 | 去掉永久锁定,每次点击都批量核对→只补缺失(增量续传);合并 core+all 清单核对 |
| 缓存桶名不一致 | 下载函数写 `noname-pwa-v1`,SW 读 `noname-pwa-v2` | 统一 `noname-pwa-v2` |

---

## 四、联机(PeerJS 房间号 P2P)

| 现象 | 根因 | 修法 |
|---|---|---|
| 点"创建房间"选模式点启 → 直接开单机 | 诊断日志确认 connectMenu=true(联机分支对);真正 bug 是 createServer 里 `lib.node.clients=[]` 在纯浏览器崩(lib.node 是 Electron 专有) | createServer 开头 `if(!lib.node) lib.node={}` 兜底 |
| 跨设备连不上/卡"连接中"/连上又断刷新 | WorkSpace(云主机)当 host + VPN 网络 = 重 NAT,WebRTC 打洞难、免费 TURN 兜不住;断开触发 onclose→game.reload("刷新") | 网络问题非代码问题。真机测用两台普通设备同 WiFi(局域网免打洞)。日常若免费 TURN 不稳需付费 TURN |
| 分享文本显示 `undefined房间` + 过时"启用邀请链接" | game.roomId 在 P2P 下不存在 | 纯浏览器分享文本改"房间号:XXX + 输房间号加入" |

**机制**:connect 模式服务器纯转发、逻辑权威在房主客户端,故 P2P 化不动引擎——只在传输层加 PeerJS 后端(peerAdapter.js 把 DataConnection 适配成 WebSocket)。同机 Edge+Chrome 验证连接/进房/开始全通=代码 OK。够 2 真人点开始,空位游戏开始时自动 AI 填充。

---

## 调试手段
- 本地纯静态验证:`cd dist && python -m http.server`(无 /checkFile 接口,等效 CF)。跑完停掉服务器,否则锁 dist 导致 build.ts 的 `fs.rm("dist")` 报 EBUSY
- iOS 主屏 PWA 调试:iPhone 设置→Safari→高级→网页检查器;Mac Safari 开发菜单→选 iPhone→主屏 PWA **单独列出**(独立 origin)。断网后看 Network 标签哪个请求一直 pending = 白屏元凶
- macOS Safari 和 iOS Safari 同 WebKit,行为基本一致,可直接 Mac Safari 测离线(断 WiFi 刷新)
