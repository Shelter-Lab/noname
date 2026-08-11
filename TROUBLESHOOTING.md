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
   (`grep -c` 会数出 243:多的那个是 dist/index.html:12 的**内联** JIT 引导块,首行 `if (!LOCAL_HOSTS.includes(location.hostname)) return;`,线上恒为 no-op、不发请求。)
5. **【最关键的判据】能不能怪"缺文件"?看看门狗响没响**。看门狗在 boot 内部(`init/index.ts:30`)才 arm,所以**它一响就说明整个模块图 link 成功了**。而 miss 是**毫秒级快失败**(4s 上限 + `Response.error()`),解释不了"要等到 30s"。
   → 于是"卡 30 秒/1 分钟"必然是 **boot 内部某个 `await` 挂住了**,而不是资源缺失。查白屏先按这个岔路分流,能省掉大半弯路。
6. **`<script src="vue">` 这三个标签本来就 404,在线也一样**(dist/index.html:440/462/463)。`src` 按 URL 解析、**不走 importmap**(importmap 只作用于模块内的 import specifier),故解析成 `/vue` → 线上实测 404。游戏照常跑 = 它们**不是白屏线索**(别拿它们当报错的根因去查)。
   **但"不是白屏线索"≠"无害"** —— 这条 2026-08-11 修正过一次:在线它们只各浪费一个 404 往返(几十毫秒,确实无感),**离线时每个都要等满 `missTimeoutMs` 的 4 秒,而且串在 boot 的 await 链上**,是离线白屏十几秒的主要来源。现已由 SW 的 `ALWAYS_404` 短路(见第六节)。教训:**"在线看不出问题"和"离线看不出问题"是两个独立结论,不能互推**。

| 现象 | 根因 | 修法 |
|---|---|---|
| **standalone 断网启动要等 1 分多钟(比 Safari 慢 3 倍以上),先弹 iOS「蜂窝移动数据已关闭」再弹「是否重置游戏」,多等一会儿其实能进(真凶,2026-08-07)** | **`browser.js` 探测文件用的是 `HEAD` 请求,而 `pwa-sw.js:190 if (req.method !== "GET") return;` 让它【完全绕过 SW】→ SW 的超时兜底不在链路上 → 只能等 iOS 网络栈自己的默认超时(NSURLSession ≈ 60s)→ boot 的 `await` 空转一分钟。且 `noname.config.txt` 【线上就不存在】(404,两个清单里也没有),所以每次离线启动必中** | **`browser.js` 加 `fetchWithTimeout()`(2s AbortController),`game.checkFile` 的 HEAD 探测走它。绕过 SW 的请求必须【在源头自带超时】** |
| `Response served by service worker has redirections` 白屏 | CF 把 `/index.html` 307 重定向到 `/`,SW 缓存了 redirected 响应;iOS 禁止 SW 返回 redirected 响应 | `sanitizeResponse()`:redirected 响应用响应体重建干净副本再缓存/返回。`start_url` 改 `/` 避免重定向 |
| `localStorage null is not an object` 崩溃 | iOS PWA/隐私模式下 localStorage 可能为 null | index.html 最早期做内存兜底(usable 探测→内存实现) |
| 冷启动"加载内容失败(undefined)" | 冷启动并发拉大量文件、SW 未接管,偶发失败 | 超时 30s + boot 失败自动 reload 重试一次(sessionStorage 防死循环) |
| **断网启动白屏几十秒 / 弹"未正常载入"(真凶)** | **iOS 主屏 PWA 的 UA 缺"Safari"→ `get.is.safari()=false` → 启用沙盒 → `initializeSandboxRealms` 建 about:blank iframe 加载 sandbox.js;该 iframe 子请求在 iOS WebKit 上【不走父页 SW】→ 断网永久 pending → `await`(initRealms.js:118)永久挂 → 30秒看门狗弹框。SW 超时对它无效(请求没进 SW)** | **2026-08-11 扩大到无条件跳过:`sandboxEnabled = false`。原来只对 iOS/Safari 跳过,于是桌面/安卓浏览器仍中招 —— 实测桌面 UA 离线冷启动 60 秒出不了首屏(卡死→30s 看门狗→entry.ts 自动 reload→再卡 30s),而 iOS 走跳过分支只要 1 秒。iframe 绕过 SW **不是 iOS 独有,规范如此**,之前误以为是 iOS 特性 |
| SW 未命中缓存的资源断网 fetch 永久 pending | 未命中用无超时 fetch;iOS 断网 fetch 不 reject | miss 分支超时分档(见下),但注意:绕过 SW 的请求(如沙盒 iframe)此法无效,那类要从源头跳过 |
| 断网启动慢到"分钟级"(不只是某一个请求挂死) | SW 是单线程事件循环,几百个注定失败的 miss 各等满 4~8s 会排成长队,累加轻松几十秒 → 撞 30s 看门狗 | `pwa-sw.js` 加**纯内存离线启发式**:连续 3 个网络请求全失败 → 判"疑似离线" → 之后 miss 直接快失败、hit 分支也不发后台 revalidate;任何一次成功立即复位。下载器(`no-cache`)永不短路 |
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
3. **无浏览器 UI 兜底**:同样卡顿,浏览器有地址栏/刷新/容错,standalone 直接白
4. ~~SW 冷启接管竞态~~ / ~~Cache Storage 驱逐更激进~~ —— **这两条已证伪,见下面「已证伪的假设」**

### 已证伪的假设(2026-08-07 系统排查,别再走回头路)

查这个 bug 时提了一堆假设,下面这些**都被实证否掉了**,写下来省得下次重新猜一遍:

| 假设 | 为什么不成立 |
|---|---|
| **ESM 模块图 link 失败 → 白屏** | 弹了「是否重置游戏」就证明它不成立:看门狗在 `init/index.ts:30`(boot 内部)才 arm,boot 跑到了 = `entry.js` 求值成功 = 整图 link 成功。另外脚本实测:242 个外部 module 标签的传递闭包 = 239 个模块,**全在核心清单里,0 缺失**;709 项磁盘 0 缺失 |
| **`window.onerror` 的 `alert` 风暴锁死主线程** | ①`index.html` 那个 handler 在 boot 第 41 行被 `error.ts:108 setOnError` **整体覆盖**;②HTML 规范:模块 fetch 失败只 `fire an event named error at el`,**不冒泡到 window**,全仓库也没有 capture-phase 的 window error 监听 → 243 个失败产生 **0 个 alert** |
| **sourcemap 放大器**(每帧 XHR 拉 `.map` 各等 8s) | `build.ts:132/174` 两处都是 `sourcemap: false`,`find dist -name "*.map"` = 0,产物无尾部 `sourceMappingURL` 注释 → `stacktrace-gps` 连 `.map` 的 URL 都构造不出来,一次都不 fetch。且 `error.ts:87` 是 `Promise.all`(并行),不是串行累加 |
| **IndexedDB 缺 `onblocked` → 永久挂死** | `onblocked` 不会自解,一挂就是永远;但实测"多等一会儿能进" → 不是它。(仍是个值得补的小硬化项,只是不是本次真凶) |
| **standalone 配额压力大 → 驱逐掉某模块** | [webkit.org/blog/14403](https://webkit.org/blog/14403/) 原文:origin quota = **总磁盘 15%**,且主屏 PWA "has the same origin quota and overall quota as when it is opened in a browser app"。实测全站 `core∪all` = 14993 项 / **1.2GB**,128G 机 15% ≈ 19.2G → **配额根本不是瓶颈**。且驱逐是 **per-origin LRU、整个 origin 一起删**,不存在"只掉某个模块"。原 :64 那条两个子命题全错,还和 :82「主屏 PWA 缓存稳定不会被乱清」自相矛盾,已删 |
| **SW 冷启接管竞态 → 加 `controllerchange` reload** | 离线那次打开时 SW 早已 active、页面天然受控,对离线白屏**毫无用处**;代价是每次新版 SW 接管就整页重载 → 部署后首次打开耗时翻倍(实测明显变慢)。**已回退(`57e310a` 加的,纯亏本)**,`index.html` 里留了"别再加"的注释 |
| **WebKit 已知 bug 就是本次病因** | 引文都真(见下),但四个都是 **RESOLVED FIXED**(iOS 12.1 / 14.6 / 16.5 / 17.2),2026 年的机子上没一个是活 bug。而且 225083 是**导航层**失败(整页打不开、脚本一行没跑),与"boot 跑了、看门狗响了"直接矛盾 —— 是类别论证,不能当根因 |

### 业界参照(证明这条路历来脆弱,但别拿来当根因)

社区不是没经验,是这条路**每代 iOS 都回归一次**,所以经验很快过时(我们现在是 OS 26,下面全是已修的历史):

- [WebKit 225083](https://bugs.webkit.org/show_bug.cgi?id=225083) REGRESSION (iOS 14.5):带 SW 的主屏 PWA **间歇性离线打不开**,症状"首次常成功、反复关开后开始失败"。FIXED(r276845)
- [WebKit 190269](https://bugs.webkit.org/show_bug.cgi?id=190269) iOS 12:**主屏 PWA 拿不到 SW 缓存**(NetworkProcessProxy 匹配不到 WebsiteDataStore → 返回 ephemeral 参数),当年打爆了 Workbox(workbox#1672)。FIXED
- [WebKit 261767](https://bugs.webkit.org/show_bug.cgi?id=261767) REGRESSION (iOS 17):`caches.match()` 直接 reject 成 `TypeError: Internal error`。官方 workaround = **先 `caches.open()` 再 match**(我们本来就是这么写的,已天然规避)。Safari 17.2 修
- [WebKit 256219](https://bugs.webkit.org/show_bug.cgi?id=256219) iOS 16.4:开 Screen Time / MDM 内容过滤就白屏,16.5 修
- [Apple Forums 737827](https://developer.apple.com/forums/thread/737827)(13k 浏览、**0 条官方回复**):"必须先在 Safari 里打开一次才能恢复"
- [angular/angular#50378](https://github.com/angular/angular/issues/50378):一整年的社区诊断,共识 = **所有 Cache API 调用都要包 try/catch**(Angular 侧防御不足 + Safari 缓存本身有 bug)

**结论(回答"是不是只能一步一个坑")**:通用坑社区确实有共识(Cache API 包 try/catch、导航 Cache-First、别信 `navigator.onLine`),这些我们都做了;但**"哪个 await 挂住了"是本项目特有的**(HEAD 探测一个线上不存在的文件),没人能替我们查 —— 这类只能靠"列出所有绕过 SW 的请求"逐个排,而不是继续读社区帖子。

**沙盒卡死(已修,别再纠结)**:iOS 主屏 PWA UA 缺"Safari"→ is.safari()=false → 曾启用沙盒 → about:blank iframe 加载 sandbox.js,该 iframe 子请求绕过 SW → 断网永久 pending。已用 `init/index.ts:53 && lib.device !== "ios"` 跳过(lib.device 靠 UA 含 iphone/ipad 判断,可靠;时序 entry.ts:10 赋值早于 boot)。沙盒本 fork 编译期已禁用(SANDBOX_ENABLED=false),跳过零副作用。**这是第一个坑,onLine 是第二个坑,坑坑洼洼逐个填**。

**关于 504 报错(良性,别慌)**:断网启动时控制台一堆 `504 (Offline)` 是**正常且良性的**——核心代码命中缓存(能进游戏),没缓存的大素材(没点"下载离线资源"的立绘/语音/花体字)miss → SW 返回 504 → 游戏 allSettled 跳过它们照常启动。504 = 超时兜底在正常工作(快速告诉游戏"这个没有,别等")。要消除就把"下载离线资源"下全,但不下全也能玩(核心够)。

**残留风险(物理边界,绕不过)**:首访没下完就断网/关 PWA,预缓存不完整 → 下次离线可能缺文件。miss 超时能防"白屏卡死"(变成缺图而非卡死),但缺的文件本身补不回来,除非联网重开。

### 明确不要动
- 导航分支保持 Cache-First(SWR)+ 多 key 兜底
- 不给所有 fetch 加统一超时;超时只在 miss 分支且 no-cache 豁免
- 不用**必须跨 SW 重启存活**的状态标记(iOS 会杀空闲 SW,flag 丢了就误杀下载)。
  注:`failStreak` 离线启发式**不违反这条** —— 它是"随时可重新探测的缓存",SW 被杀重启后归零,最多多花几个请求重学一遍,正确性不受影响
- 不做"SW 提前注册 + clients.claim"、**不加 `controllerchange → location.reload()`**(对离线白屏无用,离线那次页面天然已被 active SW 接管;还会让部署后首次打开耗时翻倍。已踩过,见「已证伪的假设」)
- hit 分支 SWR、BYPASS、`pwa-version.json` + 两个 `*-assets.json` 的 Network-First 都别动
- **Network-First 只许用于"必须最新的小元数据"(版本号/资源清单),绝不可推广到导航或普通资源** ——
  导航走 Network-First 就是 WebKit 断网白屏(见上「历史横跳教训」第一条)。清单能用是三个条件同时成立:
  ①调用频率极低(只在点「下载离线资源」和 SW install 时)②体积小有 2s 超时兜底 ③有缓存 fallback
- **缓存桶名恒为 `noname-pwa-v2`,activate 只删非当前桶**;改文件名/桶名会让"换版部署离线可用"风险剧增
- **新增任何"绕过 SW"的请求(非 GET / 跨域 / iframe 子请求 / 浏览器自己发的 icon)必须自带 `AbortController` 超时,或者干脆别发** —— SW 的超时兜底对它们无效。这是本项目重复踩了**四次**的同一类坑(沙盒 iframe 的 iOS 分支、HEAD 探测、`ALWAYS_404` 必须放在 `method !== "GET"` 之前、沙盒 iframe 在桌面/安卓上同样中招)。
  **判据:凡是不由页面 JS 直接 `fetch()` 发出的请求,都先问一句"它进不进 SW"。**
- **`ALWAYS_404` 只许放"线上结构性不存在"的路径**,且必须放在 `req.method !== "GET"` 判断**之前**(见第五节)。往里加东西前先确认那个路径**永远**不会有文件 —— 加错了就是把真实资源挡死,而且离线时查不出来
- **`assetRevalidateWindow` 只许由 install 打开,别改成"每次启动开"或落盘持久化** —— 它存在的全部意义就是让
  素材校验跟着换版走一次而不是每次冷启动都跑(见第五节病因三)。改回去就是把那 12 个请求请回来
- **沙盒保持 `sandboxEnabled = false`** —— 要真启用得先解决 iframe 绕过 SW(见第五节病因四)

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
| **产物更新后"下载离线资源"仍显示旧总数(如清单已 14294 却仍报 14993)** | 两个清单 json 走**默认 SWR 分支** → 命中旧缓存秒返回,新清单只在后台更新、下次打开才生效。下载器虽写了 `cache:"no-cache"`,但那**只约束浏览器 HTTP 缓存,请求照样进 SW 被 Cache Storage 拦下** —— SW 里 `no-cache` 仅用于 `missTimeoutMs` 豁免超时,从不用来跳过缓存。**危害不只是数字难看:按旧清单下载会漏掉新增素材**(新补的立绘照样是剪影) | `pwa-sw.js` 把两个 `*-assets.json` 和 `pwa-version.json` 一起走 **Network-First**。清单 gzip 后仅 57KB / 实测 0.14s,`fetchSafe` 默认 2s 超时余量 14 倍,超时/离线 fallback 缓存。**另:离线兜底体必须按类型分流** —— 清单给 `[]`,`pwa-version.json` 给 `{}`;原先统一给 `{}` 会让下载器 `[...new Set([...coreList, ...allList])]` 抛 not iterable |
| **进度条虚报"下载完成 N/N"(潜在隐患,尚未发作)** | `downloadOfflineAssets` 批处理里只有 `if (r.status === 200)` 才 `cache.put`,但**非 200 也正常 resolve** → `allSettled` 判 `fulfilled` → `done++`。即"计数涨了但缓存里没东西" | 实测当前清单**无 404**(890 个非 ASCII 路径经 `fetch` 自动编码后都是 200),故暂未发作。若哪天清单与产物脱节(上游删文件而清单未更新)就会悄悄骗人。修法:非 200 抛错,或单独计失败数并在结尾提示 |

**清单口径别搞混**:`pwa-core-assets.json` = **730**(SW install 预缓存,启动+标准局必需,31.2MB);
`pwa-all-assets.json` = **14350**(核心之外的大素材)。两者**交集 0** —— 
下载器核对的是**合并清单**,所以界面显示的总数是两者之和(15080),不是 14350。core 排在合并数组前面,
故按钮下载时**核心优先**(且它们通常已被 SW 预缓存过,直接算已完成)。

**核心清单的收录判据(2026-08-11 校准,别再凭直觉加减)**:进核心的唯一标准是
**「冷启动路径上一定会被请求」**,不是「重要」也不是「小」。清单越大,install 那次
`cache:"reload"` 全量重下在手机弱网上被掐断的概率越高,而掐断会落进「缓存装着却不被信任」
(见第六节),代价远大于少缓存几个文件。
- **剔出去过的**:`service-worker.js`(4.1MB,JIT 编译器的 SW —— `packages/jit/src/entry.ts` 开头
  就按 hostname 拦住,非 localhost 直接 return,**线上永不注册、永不请求**)、
  `eslint-linter-browserify`(3.1MB,`ui/create/index.js:232` 是 `await import()`,只有真打开
  编辑器编 JS 才加载)、`game/vue.esm-browser.js`(上游废弃兼容层,本体一处都不 import)。
  它们仍在 `pwa-all-assets.json` 里,「下载离线资源」照样装,想全离线的不会少拿东西。
- **补进去过的**:`image/pwa/*.png` + 根目录 `icon-192.png`/`apple-touch-icon.png`。
  **踩点在这**:整个 `image/` 目录本来都划给「下载离线资源」,于是核心清单里 `image/` 开头的
  文件数是 **0**。但这几张图不是游戏代码 fetch 的,是**浏览器自己**按 `<link rel="icon">` 和
  `manifest.icons` 去拉的 —— 不管用户点没点过下载,每次冷启动都要,standalone 启动图标也用它。
  实测 12 次冷启动 12 次都打网络。**判据是"谁发起这个请求",游戏代码之外还有浏览器自己。**
- **后来又补进去的(2026-08-11)**:11 张 `image/splash/style1/*.jpg`(`default-splash.ts:11`
  的默认 style)+ `image/background/ol_bg.jpg` + `image/card/handcard.png` +
  `image/card/tiesuo_mark.png`,约 1.4MB。实测 20 轮冷启动这几张 **19~20/20 必现**。
- **明确不收的**:`font/xinwei.woff2`(7.5MB)、`audio/background/music_default.mp3`(3.4MB)。
  它们同样每轮必现,但单个就顶掉核心清单 1/4~1/3 体积 —— 收进去反而抬高 install 被掐断的概率。
  它们靠「下载离线资源」装,装完后由 `assetRevalidateWindow` 保证不再重复校验(见第五节病因三)。

**CF 文件数上限**:Workers Static Assets 限 **20000 个文件**(单文件 25MiB)。当前 dist = **15356**
(audio 9380、image 4044、extension 854),余量约 4600。真撞墙时按此优先级处置:
①不部署内置 `extension/`(854,大多不启用)②audio 挪 R2(占 61%,R2 无文件数限制)
③打包分卷 archive 按需解包进 IndexedDB(工程量大)。**限制是文件数而非总容量**,所以"文件多"比"体积大"更容易撞墙。

---

## 四、联机(PeerJS 房间号 P2P)

| 现象 | 根因 | 修法 |
|---|---|---|
| 点"创建房间"选模式点启 → 直接开单机 | 诊断日志确认 connectMenu=true(联机分支对);真正 bug 是 createServer 里 `lib.node.clients=[]` 在纯浏览器崩(lib.node 是 Electron 专有) | createServer 开头 `if(!lib.node) lib.node={}` 兜底 |
| 跨设备连不上/卡"连接中"/连上又断刷新 | WorkSpace(云主机)当 host + VPN 网络 = 重 NAT,WebRTC 打洞难、免费 TURN 兜不住;断开触发 onclose→game.reload("刷新") | 网络问题非代码问题。真机测用两台普通设备同 WiFi(局域网免打洞)。日常若免费 TURN 不稳需付费 TURN |
| 分享文本显示 `undefined房间` + 过时"启用邀请链接" | game.roomId 在 P2P 下不存在 | 纯浏览器分享文本改"房间号:XXX + 输房间号加入" |

**机制**:connect 模式服务器纯转发、逻辑权威在房主客户端,故 P2P 化不动引擎——只在传输层加 PeerJS 后端(peerAdapter.js 把 DataConnection 适配成 WebSocket)。同机 Edge+Chrome 验证连接/进房/开始全通=代码 OK。够 2 真人点开始,空位游戏开始时自动 AI 填充。

---

## 五、冷启动变慢(2026-08-11)—— 一个症状,四个独立病因

**症状是一个**:冷启动(关掉 standalone PWA 再开)从 7~8 秒变 15 秒,**在线和离线一样慢**。
**病因查出来是四个,机制互不相同**。这一点非常反直觉,查的时候差点用一个解释套住两边 ——
「在线要重下 35MB」解释得了在线,但**离线一个字节都不下载,那条解释在离线场景下根本不成立**。
先记住这个分流判据:

> **在线慢 = 吞吐问题(下了多少字节)。离线慢 = 延迟问题(等了多少个超时)。**
> 如果在线和离线耗时**差不多**,瓶颈就一定不在吞吐 —— 因为离线不下载,却没有变快。

四个病因速览(详见各小节):

| | 影响面 | 机制 | 修法 |
|---|---|---|---|
| 病因一 | 在线 | install 失败删构建戳 → 缓存完整但 SW 全部绕开 → 重下 35MB | 保戳,改记 `STALE_KEY`(可收敛) |
| 病因二 | 离线 | 4 个必然 404 的请求串在 boot await 链上各等 4s | `ALWAYS_404` 短路 |
| 病因三 | 两边 | 素材后台 SWR 每次冷启动跑 12 个(**下得越全跑得越多**) | `assetRevalidateWindow` 每构建只校验一次 |
| 病因四 | 桌面/安卓离线 | 沙盒 iframe 加载 `sandbox.js`,iframe 不走 SW → 永久 pending → 60s 都出不了首屏 | `sandboxEnabled = false` 无条件跳过 |

**⚠️ 病因二的修法引入过一个回归,病因三顺带修掉了** —— 详见病因二末尾。这是本节最值得记住的一课:
**删一个"纯浪费"的请求前,先查有没有别的机制在靠它的副作用工作。**

### 病因一(在线):install 失败时删构建戳,是粘住不自愈的性能悬崖

`pwa-sw.js` install 的 catch 分支原来会 `c.delete(BUILD_KEY)`,想法是"缓存来路不明,宁可慢也不能白屏"。
代价被严重低估了:`getCodeState()` 返回 `fresh:false` → `codeNeedsFreshFetch()` 对**每个**代码文件
都返回 true → **缓存里明明装着 625 个文件一个不少,SW 也全部绕开它去联网重取**。

实测(持久化 profile、真关浏览器再开、同一份完整缓存,**只差这一个戳**):

| | 首屏 | 打到网络的请求 | 流量 |
|---|---|---|---|
| 戳在 | 1381ms | 135 个 | 4.6MB |
| **戳丢** | **4231ms** | **462 个** | **35.2MB** |

桌面千兆就 3 倍,手机 4G 上就是 7~8 秒变 15 秒。**更糟的是它不自愈**:戳只有下次 install
完整成功才补得回来,而 install 只在 `pwa-sw.js` 字节变化(= 又部署一版)时才跑 —— 中间每次
冷启动都在白烧几十 MB。而「手机弱网下 33MB 全量 reload 被掐断」恰恰是常态,不是罕见分支。

**修法**:戳保留,把整份清单记进 `STALE_KEY`(`codeNeedsFreshFetch` 本来就有 `st.stale.has()`
这条路,只是这个 catch 分支以前没走它)。语义不变(该走网络的照样走),但它**可收敛**:
`noteStaleResolved()` 让 fetch 每从网络取到一个就把它划掉,启动一次比一次快;全部补齐就删名单,
回到纯缓存启动。**删戳是不可收敛的,永远从头再来。**

- **名单必须落盘,不能只存内存** —— SW 进程空闲几十秒就被回收,内存里的 Set 一起没了,
  那就退化成旧的删戳行为了。(这**不违反**「不用跨重启存活的状态标记」那条:那条针对的是
  "正在下载"这类丢了就误判的 flag;这里丢了最多是多走几次网络,正确性不受影响。)
- 攒 3 秒合并写一次,别每划掉一个就 `cache.put` 一遍 JSON —— 单线程 SW 会被写缓存堵死,反而更慢。

**★ 教训:缓存完整 ≠ SW 会用它。** 排查"明明缓存好了怎么还慢"时,**先查 SW 信不信这份缓存**,
再查缓存里有没有东西。这个状态以前在界面上完全看不出来(版本号显示得好好的、报"已是最新"),
所以「检查更新」按钮现在会体检 `/__pwa_build__` 并如实报出来,不用再靠猜。

### 病因二(离线):四个必然 404 的请求,串在 boot 的 await 链上各等 4 秒

实测 12 次冷启动,这四个 **100% 出现、100% 失败**:

| 请求 | 为什么永远 404 |
|---|---|
| `/vue` | `game/vue.esm-browser.js` 是上游废弃兼容层(`export * from "vue"`),裸说明符只有主文档 importmap 认得,别的上下文解析就退化成 `/vue` |
| `/preload.js` | `entry.ts:14` 的 `await import("/preload.js")` 是**故意**要它失败的 —— catch 里才分派 browser/cordova/node 平台入口,文件永远不存在 |
| `/noname.config.txt` | `init/index.ts:843` 探测有没有导入配置,**没有才是常态** |
| `/theme/style/card` | `library/index.js:2463` 的 `lib.init.css(assetURL+"theme/style/card", ...)` 拼出来指向的是**目录**不是文件 |

在线各浪费一个 404 往返(几十毫秒,无感);**离线每个要等满 `missTimeoutMs` 的 4 秒
(script/document 档),而且是串行的** —— 它们从 `entry.ts:14` 一路 await 到
`init/index.ts:843`,前一个不回来后一个不发。4×3 ≈ 12 秒,这就是离线白屏的主要来源。

**`looksOffline()` 兜不住它**:那个要连续失败 3 次才判定离线,而**学费恰好由启动链最前面
这几个交** —— 等它生效,12 秒已经烧完了。它救的是后面几百个素材请求,救不了最前面这几个。

**修法**:`ALWAYS_404` 列表直接短路返 404,一个网络往返都不发。
- **必须放在 `req.method !== "GET"` 判断之前** —— `checkFile` 用的是 **HEAD**,本来会被那行
  放行到网络,连 SW 的超时兜底都吃不到(`browser.js:37` 那 2 秒超时就是为此加的)。
  这是本项目第三次踩「绕过 SW 的请求」这个坑(前两次:沙盒 iframe、HEAD 探测)。
- **返 404 而不是 `Response.error()`**:消费方都按"文件不存在"处理(`import()` 靠 catch 分派平台、
  `checkFile` 靠非 200 返 -1)。也别返带文本 body 的响应 —— 那会被当 JS 模块解析,引出
  `importing binding name 'c' is not found` 之类的 link 错。

实测改后 19 次冷启动里这四个 **0 次**上网(改前 12/12 必现)。

**⚠️ 但这个修法引入了一个回归(当天即发现并修掉,见病因四)**:直接返 404 就**不会调 `noteNetResult(false)`**
→ `failStreak` 永远涨不到 3 → `looksOffline()` **永远是 false**。那四个"浪费"的请求原来**兼职当离线探针**,
砍掉它们等于把离线检测一起砍了。表现:离线时素材的后台 revalidate 照样发、各等满超时,iOS 还多弹一个
**「蜂窝数据已关闭」**(以前没有)。**教训:删一个看似纯浪费的请求前,先查有没有别的机制在靠它的副作用工作。**

### 病因三(两边都有):素材的后台 SWR 每次冷启动都跑,而且"下得越全跑得越多"

`pwa-sw.js` 命中缓存分支原来对**每个非代码素材**都发一个后台 fetch 问"变了没"。实测每次冷启动
**固定 12 个**:`icon-192.png`×2、`ol_bg.jpg`、`handcard.png`、`tiesuo_mark.png`、`card.png`、
`xinwei.woff2`、`music_default.mp3`、`huangcao.woff2`、11 张 `splash/style1/*.jpg`(轮换出现)。

**★ 反直觉的关键点:它的触发条件是「缓存命中」,所以下载得越全,这种请求越多。** 一个字节都没下的人
反而不会有(走 miss 分支直接下真文件)。排查时被这一点误导过 —— 以为"用户已经下载完了就不该有请求了",
恰恰相反。

代价:
- **在线**:CF 认 `If-None-Match`(实测 `curl -I -H 'If-None-Match: ...'` → `304 Not Modified`),
  所以是 12 个**零字节**往返。字节不是问题,**占满 SW 单线程**才是。
- **离线**:12 个各等满 `missTimeoutMs`,外加 iOS 弹「蜂窝数据已关闭」。

**修法**:`assetRevalidateWindow` —— 素材校验从「每次冷启动」改成「**每个构建一次**」。install 时开窗
(换版必然走 install,而 install 必然在线,因为清单是网络取的),SW 被回收后窗口自然关闭。
- **为什么这不丢更新能力**:素材只可能在"又部署了一版"时变,而那一版必然有 install。校验跟着 install
  走一次就够,不需要每次启动重来。
- **为什么用内存变量而不落盘**:它不需要跨 SW 重启存活 —— 窗口关着正是我们想要的快路径,下次真换版
  又会有新 install 重新开窗。丢了只是更快,没有正确性损失(与 `STALE_KEY` 必须落盘的理由正好相反,
  那个丢了会退化成"永远从头再来")。
- 顺带把**启动路径上的小素材收进核心清单**:11 张 `splash/style1/*.jpg` + `ol_bg.jpg` +
  `handcard.png` + `tiesuo_mark.png`,约 1.4MB(核心 716→730,29.9→31.2MB)。
  **`xinwei.woff2`(7.5MB)和 `music_default.mp3`(3.4MB)故意不收** —— 单个就顶掉核心清单
  1/4~1/3 体积,而 install 是 `cache:"reload"` 全量重下,清单越大在手机弱网被掐断的概率越高,
  掐断的代价是留下"缓存装着却不被信任"的状态(病因一),远大于省下的两次超时。

### 病因四(桌面/安卓,离线):沙盒 iframe 加载 sandbox.js —— 60 秒都出不了首屏

**这条是查病因三时顺带实测挖出来的,之前完全不知道。**

第二节表格里那条"iOS 沙盒 iframe"以前只对 **iOS/Safari** 跳过。实测发现 **iframe 子请求不走父页 SW
是规范行为,不是 iOS 特性** —— 所以桌面/安卓浏览器一直在踩:

| UA | `lib.device` | 沙盒 | 离线冷启动首屏 |
|---|---|---|---|
| 桌面 Edge | `undefined` | **启用** | **60 秒都没出来**(卡死→30s 看门狗→`entry.ts` 自动 reload→再卡 30s,无限循环) |
| iPhone | `"ios"` | 跳过 | **1023ms** |

离线时缓存里明明有 `sandbox.js` 也用不上(请求没进 SW),永久 pending → `initRealms.js:118` 的
`await promise` 挂死。**修法:`sandboxEnabled = false` 无条件跳过。**
安全性论证:本 fork 里 `initRealms.js:5` 是 `SANDBOX_ENABLED = false`,传 `true` 进去也只是白加载
一遍 iframe,`isSandboxEnabled()` 照样返回 false,`security.initSecurity` 拿到 false 后直接 return
—— 即"启用"这条路除了发那个会挂死的网络请求,**什么也没做成**。

**⚠️ 上游合并注意**:若哪天要真启用沙盒(`initRealms.js` 的 `SANDBOX_ENABLED` 改回 true),
必须先解决 iframe 绕过 SW 的问题(如把 sandbox.js 内联 / 用 `blob:` URL 注入),否则离线必然回归白屏。

**★ 这是本项目第四次踩「绕过 SW 的请求」**(前三次:沙盒 iframe 的 iOS 分支、`checkFile` 的 HEAD 探测、
`ALWAYS_404` 的放置位置)。**判据:凡是不由页面 JS 直接 `fetch()` 发出的请求,都要先问一句"它进不进 SW"**
—— iframe 子资源、HEAD、非同源、`<link rel=icon>`/manifest icons 全是这一类。

### ★ 决策记录:为什么至今没给产物加 content hash

**content hash 是什么**:在文件名里嵌内容指纹,`_virtual/aes.js` → `_virtual/aes.a3f9c2d1.js`,
内容变一个字节名字就变。改动量就是 `apps/core/scripts/build.ts:147-149` 那三行
`[name].js` → `[name].[hash].js`。

**它能从根上消灭我们所有缓存一致性的麻烦**,因为那些麻烦全部来自**同名不同内容**这一件事:
`index4.js` 上一版是某模块导出 `{a,b}`,这一版因依赖图漂移成了 crypto-js 导出 `{c}`,而缓存键
都是 `/index4.js` —— SW 从名字看不出这是两个不同的东西。加了 hash 后,
`importing binding name 'c' is not found` 在**物理上不可能发生**:名字对不上就直接 miss 走网络,
新旧两份可以在缓存里共存互不干扰,而且每个文件都能 `Cache-Control: immutable` 永久缓存、连校验都不发。

**于是这一大堆东西会集体失去存在意义**:`BUILD_KEY`、`STALE_KEY`、`getCodeState`、
`codeNeedsFreshFetch`、`noteStaleResolved`、install 的原子全量 reload、`repair()`、
「代码文件绝不后台 revalidate」那条规矩 —— **它们全是在补"文件名不可信"这个漏**。

**但现在不做,四个真实阻力**:
1. **扩展生态会崩** —— 扩展硬编码 `import ... from "../../noname/library/index.js"` 这类路径,
   文件名带 hash 后全部失效。164 个内置扩展 + 用户自装的都要改。
2. **上游合并变地狱** —— 这是 fork,动产物命名 = 动整个构建输出结构,以后每次 merge 上游都要重新调和。
3. **用户要重下一次全部代码**(≈30MB)—— 所有代码文件名都变 = 全部 cache miss。素材不受影响。
4. **hash 只治代码,不治素材** —— `image/character/xxx.jpg` 路径是按武将 ID 拼的,不可能加 hash,
   所以 SWR 那套还得留着。

**判断**:混搭病已由「install 原子全量换版 + 代码文件绝不后台 revalidate」堵住并稳定(见第二节),
现在改属于用大代价换已经解决的问题。
**真正该动手的时机:如果混搭病复发** —— 那说明补丁方案有漏,那时 hash 才值得付上面那四笔代价。

### ★ 顺带回答"这些坑是不是因为用了 PWA"

**一半是,一半不是。**

**PWA 特有的(官方安装包不会有)**:缓存一致性/混搭病、手搓版本协商(「检查更新」改了好几轮)、
`missTimeoutMs`/`looksOffline`/`fetchSafe` 这一整坨补 WebKit 断网不 reject 的代码、
iOS 不许 SW 返回 redirected 响应(`sanitizeResponse`)、后台 install 被系统掐断。

**不是 PWA 的错,换装包一样存在的**:`/preload.js` 靠 `import()` 失败分派平台、
`theme/style/card` 拼出目录路径、废弃的 vue 兼容层 —— 都是上游历史包袱。
**最根本的是启动链是长串行 await**:十几个请求一个等一个,任何一环变慢总时间直接加上去。
装包应用读本地文件是微秒级,把这个设计缺陷**掩盖**了,但它一直在那儿。

**选 PWA 仍然是对的**:核心约束是「iOS 上能玩 + 不过商店 + 离线可玩」,这个组合下 PWA 是唯一解
(iOS 侧个人开发者上架 $99/年 + 审核,而这是 GPL 三国杀同人,过审基本没戏)。
这些磕绊是那个约束的必要成本,不是路选错了。

---

## 调试手段
- 本地纯静态验证:`cd dist && python -m http.server`(无 /checkFile 接口,等效 CF)。跑完停掉服务器,否则锁 dist 导致 build.ts 的 `fs.rm("dist")` 报 EBUSY
- iOS 主屏 PWA 调试:iPhone 设置→Safari→高级→网页检查器;Mac Safari 开发菜单→选 iPhone→主屏 PWA **单独列出**(独立 origin)。断网后看 Network 标签哪个请求一直 pending = 白屏元凶
- macOS Safari 和 iOS Safari 同 WebKit,行为基本一致,可直接 Mac Safari 测离线(断 WiFi 刷新)
- **用 curl 探线上资源时必须自己做 URL 编码** —— 清单里有 **890 个非 ASCII 路径**
  (带声调拼音如 `dc_zhangyì.mp3`、中文卡名如 `db_atk1_克敌先机.png`、中文扩展目录如 `extension/杀海拾遗/`)。
  `curl .../dc_zhangyì.mp3` → **404**,`curl .../dc_zhangy%C3%AC.mp3` → **200**,文件其实好好的。
  浏览器 `fetch()` 会自动经 `new URL()` 把它编码成 `%C3%AC`,所以**游戏里一切正常**;
  是 curl 不编码才假 404。踩过一次:据此误判"890 个文件线上缺失",实为自造的假象。
  正确做法:探测前先 `new URL(raw, origin).href` 再喂给 curl

### 测冷启动性能(两条踩过的坑,不照做会量出假数)
- **别用 `127.0.0.1` 跑 dist** —— `packages/jit/src/entry.ts:6` 的
  `LOCAL_HOSTS = ["localhost","127.0.0.1","10.0.2.2"]` 会放开 JIT 开发用 SW,它**抢占 scope
  且每次启动 reload 两遍**。据此量出过"每次冷启动重取 734 个核心文件"的假数。
  用 **`127.0.0.2`**:仍是安全上下文(SW 能注册),但不在 LOCAL_HOSTS。
- **必须真关掉整个浏览器再开**(Playwright 用 `launchPersistentContext` + 每轮 `ctx.close()`),
  开新标签页不算冷启动 —— SW 进程还活着,`getCodeState` 的内存缓存也还在,测不出真实首屏。
  **2026-08-11 又栽了一次**:验收脚本每轮只 `page.close()` 却复用同一个 browser,于是 SW 从没被回收,
  `assetRevalidateWindow` 全程开着 —— 量出来的 19 轮数据**完全没测到**要验的那个机制。
  **凡是验"跨 SW 生命周期"的行为(内存标记、启发式复位),不真关浏览器就是白测。**
- 想看"每次冷启动到底有多少请求真打到网络",在服务器侧记访问日志最准(SW 命中缓存的请求
  压根不会出现在日志里,这比在浏览器 Network 面板里筛更干净)。
- **测离线要用"服务器收到请求但永不回应"来模拟,不是关服务器** —— 关掉服务器是 TCP 秒拒
  (等于 Chromium 行为),而 iOS WebKit 断网是**长挂**。用一个可切模式的本地服务器
  (`hang` = 收到请求扣住 response 不回),才能复现真实的离线卡死。据此才发现病因四。
- **UA 会改变启动路径,单一 UA 测不全** —— `util/index.js:24` 的 `device` 按 UA 判定,
  桌面拿到 `undefined`、iPhone 拿到 `"ios"`,而沙盒开关直接看它。同一份代码两条路,
  病因四就藏在桌面那条上(iPhone 反而没事)。**测启动性能至少跑桌面 + iPhone UA 两组。**

---

## 六、同步上游更新后需重新确认的改动清单

本 fork 改了若干**官方文件**(不是新增文件)。同步 `libnoname/noname` 上游后,若上游也动了这些文件可能冲突/被覆盖,照此清单逐个核对、被覆盖的补回来:

| 文件 | 我们的改动 | 检查点 |
|---|---|---|
| `apps/core/noname/init/browser.js` | ①文件接口退回 URL + IndexedDB(纯静态模式) ②`fetchWithTimeout` + `checkFile` 的 HEAD 探测带 2s 超时(治 standalone 离线卡 60s) | 探测文件服务器 + 读写走 fetch/IndexedDB 还在吗;**HEAD 还带着超时吗** |
| `apps/core/noname/init/index.ts` | ①启动超时 30s ②`sandboxEnabled = false` **无条件**跳过沙盒(2026-08-11 从"仅 iOS 跳过"扩大而来,治桌面/安卓离线 60s 白屏,见第五节病因四) | 这两处还在吗;**上游若要真启用沙盒,必须先解决 iframe 绕过 SW 的问题** |
| `apps/core/index.html` | ①localStorage 内存兜底 ②PWA meta/SW 注册 ③onerror 忽略 NotAllowedError ④QUERY_PRECACHE | 这几段内联脚本还在吗 |
| `apps/core/pwa-sw.js` | (新增文件)缓存策略 + `missTimeoutMs` 超时分档 + `failStreak` 离线启发式 + `ALWAYS_404` 短路 + install 失败保戳记 `STALE_KEY` + `assetRevalidateWindow`(素材每构建只校验一次) | 上游不会动,但改它前必读本文档「断网白屏根治方案」和第五节 |
| `scripts/build.ts` | 核心清单:剔掉 `service-worker.js`/eslint-linter/废弃 vue 兼容层;补进 `image/pwa`+根图标+11 张 splash+`ol_bg`/`handcard`/`tiesuo_mark` | 收录判据见第五节「核心清单的收录判据」,别凭直觉加减 |
| `apps/core/noname/entry.ts` | 无改动,但 `await import("/preload.js")` 这个**故意失败**的探测被 `ALWAYS_404` 短路了 | 上游若改了平台分派方式(不再靠 import 失败),要同步删掉 `ALWAYS_404` 里的 `/preload.js`,否则会挡住真实文件 |
| `apps/core/noname/game/index.js` | ①createServer/connect 的 PeerJS 分流 ②createServer 开头 `if(!lib.node)lib.node={}` | 联机 P2P 分流还在吗 |
| `apps/core/noname/library/element/content.ts` | waitForPlayer 改 `await game.createServer()` | 还在吗 |
| `apps/core/mode/connect.js` | 「创建房间」按钮 + 不弹邀请链接 confirm | 还在吗 |
| `apps/core/noname/library/init/index.js` | 下载离线资源(downloadOfflineAssets)增量补课 | 还在吗 |
| `apps/core/noname/ui/create/index.js` | 分享文本改房间号引导 | 还在吗 |
| `apps/core/noname/ui/create/menu/pages/otherMenu.js` | 检查更新按钮 + 双主页链接 | 还在吗 |
| `scripts/build.ts` | ①产物校验 ②生成 pwa-core/all-assets.json(含 dist 根散文件) ③`NOT_CORE` 剔大块头 + 补 PWA 图标进核心 | 清单生成还在吗;`NOT_CORE` 的三条理由是否仍成立(见第五节「核心清单的收录判据」) |
| `apps/core/character/{bingshi,clan,huicui,mobile,newjiang,onlyOL,refresh,sb,sp,xianding}/character.js` | 给 35 个无立绘武将插 `img:` 字段(消除剪影),搜注释 `无自有立绘,复用同一人物的本体立绘` 可定位全部 | 跑 `node scripts/audit-character-images.cjs`,应报"零剪影"。**上游若补了真图,删掉我们的 `img:` 行**。详见 [docs/CHARACTER-IMAGES.md](./docs/CHARACTER-IMAGES.md) |
| 新增文件(不会冲突) | `pwa-sw.js`、`manifest.webmanifest`、`peerAdapter.js`、`wrangler.jsonc`、`image/pwa/*`、本文档、README-PWA.md | 上游不会动,一般安全 |
