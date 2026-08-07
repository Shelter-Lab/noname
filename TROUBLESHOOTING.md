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
| **断网启动白屏几十秒 / 弹"未正常载入"(真凶)** | **iOS 主屏 PWA 的 UA 缺"Safari"→ `get.is.safari()=false` → 启用沙盒 → `initializeSandboxRealms` 建 about:blank iframe 加载 sandbox.js;该 iframe 子请求在 iOS WebKit 上【不走父页 SW】→ 断网永久 pending → `await`(initRealms.js:118)永久挂 → 30秒看门狗弹框。SW 超时对它无效(请求没进 SW)** | **根治:`init/index.ts:53` 加 `&& lib.device !== "ios"` 让 iOS 也跳过沙盒(和 Safari 浏览器一致,已验证能进)。沙盒仅隔离联机远程代码、单机不依赖,且本 fork 编译期已禁用沙盒(initRealms.js SANDBOX_ENABLED=false),跳过零副作用 |
| SW 未命中缓存的资源断网 fetch 永久 pending | 未命中用无超时 fetch;iOS 断网 fetch 不 reject | miss 分支超时分档(见下),但注意:绕过 SW 的请求(如沙盒 iframe)此法无效,那类要从源头跳过 |
| jit-test.ts / service-worker.js 断网加载失败 | 这些 dist 根级散文件漏在预缓存清单外(清单只扫子目录) | build.ts 补扫 dist 根一层的 .js/.ts 进核心清单 |

### 断网白屏根治方案(超时两难的正解)—— 血泪史,反复横跳过,务必读完

**白屏本质**:boot() 一开始 arm 一个 30 秒看门狗(init/index.ts:30),启动某个网络 `await` 永久 pending → 30 秒没加载完 → `lib.init.reset` 弹"游戏似乎未正常载入,是否重置"→ 白屏。**能否离线启动,唯一取决于"启动文件在不在缓存"**;超时只决定"卡 30 秒白" vs "快速失败"。

**为什么只有 iOS Safari/WebKit 中招、Chromium(Edge)不中招**:
- **WebKit 断网时 `fetch()` 不 reject,而是永久 pending**(Chromium 秒 reject)。所以"无超时的 miss fetch"只坑 WebKit。**测离线必须用 Safari,Edge 测不出这个 bug**。

**历史横跳教训(每条都真出过事,别重蹈)**:
- ❌ 导航请求用 Network-First → Safari 断网 fetch 挂死。**导航必须 Cache-First(SWR),绝不改回**。
- ❌ 给所有 fetch 加统一 2s 超时 → 启动不卡了,但「下载离线资源」批量拉未命中文件被 2s 误杀 → 进度倒退。
- ❌ 用 `postMessage`/模块级变量标记"正在下载" → iOS 事件间隙杀空闲 SW,重启后 flag 丢失,又误杀。**只用请求级无状态信号**。
- ❌❌ **miss 超时靠 `navigator.onLine === false` 门控**(曾以为"确定离线才快失败")→ **iOS 主屏 PWA 飞行模式下 onLine 常仍报 true** → 门控失效 → 走无超时 fetch → 永久 pending → **standalone 白屏(浏览器却正常,因浏览器 onLine 可靠为 false)**。这是 standalone-only 白屏的头号真凶,查了极久。**miss 超时绝不能依赖 navigator.onLine**。

**正解(pwa-sw.js `missTimeoutMs`)**:miss 一律给有限超时,**不看 onLine**:
- **下载器 + 清单**(唯一带 `req.cache === "no-cache"` 进 handler)→ **绝不超时**(避开误杀下载)
- **启动关键资源**(destination = script/style/document/font)→ **4s** 快失败
- **其余**(XHR/.ts JIT源/import 子资源 destination=""/图片/音频)→ **8s** 快失败
- **script/style/font 的 miss 失败要返回 `Response.error()`,不能返回带文本 body 的 504**——否则浏览器把"离线且资源未缓存"当模块解析,报 `importing binding 'c' is not found`(crypto-js 的 _virtual/index4.js 导出名就叫 c)

**为什么 no-cache 信号可靠**:下载器 destination 是空串(不是 image/audio),但带 `cache:"no-cache"`;启动请求是 default cache 模式。两个信号正交、无状态(扛得住 iOS 杀 SW 重启)。

**standalone vs 浏览器的差异(为什么 standalone 更容易白屏)**:
1. **独立存储分区**:主屏 PWA 和 Safari 浏览器的 Cache/SW 不共享 → "相同操作"不等于"缓存了相同字节",两边 miss 的文件可能不同
2. **navigator.onLine 在 standalone 飞行模式不可靠**(见上)
3. **SW 冷启接管竞态**:SW 注册在 window load(晚),standalone 冷启动那一刻 SW 可能没接管 → 请求绕过 SW 直连网络 → 超时兜底不在链路上。缓解:index.html 加 `controllerchange` 后 reload 一次(首次接管后下次冷启即受控)
4. **Cache Storage 驱逐更激进**:standalone 分区配额压力大,可能驱逐掉某模块 → 非打包 eager ESM 图一处洞就整体 link 失败
5. **无浏览器 UI 兜底**:同样卡顿,浏览器有地址栏/刷新/容错,standalone 直接白

**沙盒卡死(已修,别再纠结)**:iOS 主屏 PWA UA 缺"Safari"→ is.safari()=false → 曾启用沙盒 → about:blank iframe 加载 sandbox.js,该 iframe 子请求绕过 SW → 断网永久 pending。已用 `init/index.ts:53 && lib.device !== "ios"` 跳过(lib.device 靠 UA 含 iphone/ipad 判断,可靠;时序 entry.ts:10 赋值早于 boot)。沙盒本 fork 编译期已禁用(SANDBOX_ENABLED=false),跳过零副作用。**这是第一个坑,onLine 是第二个坑,坑坑洼洼逐个填**。

**关于 504 报错(良性,别慌)**:断网启动时控制台一堆 `504 (Offline)` 是**正常且良性的**——核心代码命中缓存(能进游戏),没缓存的大素材(没点"下载离线资源"的立绘/语音/花体字)miss → SW 返回 504 → 游戏 allSettled 跳过它们照常启动。504 = 超时兜底在正常工作(快速告诉游戏"这个没有,别等")。要消除就把"下载离线资源"下全,但不下全也能玩(核心够)。

**残留风险(物理边界,绕不过)**:首访没下完就断网/关 PWA,预缓存不完整 → 下次离线可能缺文件。miss 超时能防"白屏卡死"(变成缺图而非卡死),但缺的文件本身补不回来,除非联网重开。

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
- **BGM 自动播放报 `NotAllowedError`**:浏览器/iOS 安全策略禁止无交互自动播放,用户点一下即恢复。无害,但会被全局 onerror 弹窗打扰。修法:index.html 的 `window.onerror` 里识别 NotAllowedError / "not allowed by the user agent" → 只 console 不 alert。偶发(看 BGM 播放时机是否早于首次交互)

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

---

## 五、同步上游更新后需重新确认的改动清单

本 fork 改了若干**官方文件**(不是新增文件)。同步 `libnoname/noname` 上游后,若上游也动了这些文件可能冲突/被覆盖,照此清单逐个核对、被覆盖的补回来:

| 文件 | 我们的改动 | 检查点 |
|---|---|---|
| `apps/core/noname/init/browser.js` | 文件接口退回 URL + IndexedDB(纯静态模式) | 探测文件服务器 + 读写走 fetch/IndexedDB 还在吗 |
| `apps/core/noname/init/index.ts` | ①启动超时 30s ②`sandboxEnabled` 加 `&& lib.device !== "ios"`(跳沙盒治白屏) | 这两处还在吗 |
| `apps/core/index.html` | ①localStorage 内存兜底 ②PWA meta/SW 注册 ③onerror 忽略 NotAllowedError ④QUERY_PRECACHE | 这几段内联脚本还在吗 |
| `apps/core/noname/game/index.js` | ①createServer/connect 的 PeerJS 分流 ②createServer 开头 `if(!lib.node)lib.node={}` | 联机 P2P 分流还在吗 |
| `apps/core/noname/library/element/content.ts` | waitForPlayer 改 `await game.createServer()` | 还在吗 |
| `apps/core/mode/connect.js` | 「创建房间」按钮 + 不弹邀请链接 confirm | 还在吗 |
| `apps/core/noname/library/init/index.js` | 下载离线资源(downloadOfflineAssets)增量补课 | 还在吗 |
| `apps/core/noname/ui/create/index.js` | 分享文本改房间号引导 | 还在吗 |
| `apps/core/noname/ui/create/menu/pages/otherMenu.js` | 检查更新按钮 + 双主页链接 | 还在吗 |
| `scripts/build.ts` | ①产物校验 ②生成 pwa-core/all-assets.json(含 dist 根散文件) | 清单生成还在吗 |
| 新增文件(不会冲突) | `pwa-sw.js`、`manifest.webmanifest`、`peerAdapter.js`、`wrangler.jsonc`、`image/pwa/*`、本文档、README-PWA.md | 上游不会动,一般安全 |
