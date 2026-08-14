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
| **改了图但路径不变 → 设备上永远显示旧图,点「下载离线资源」还说"已下载完毕"(2026-08-13,换 25 张卡面时发作)** | 素材存 IndexedDB、键是 pathname,而下载器的 `pending = all.filter(url => !cachedSet.has(pathOf(url)))` **只判"有没有"不判"变没变"** → 跳过。SW 的读取路径从库里拿到就直接返回,**一个网络请求都不发**,CF 的 ETag 再正确也到不了。而记录里只有 `{ buf, mime, len }`、**没有 ETag**,发不出 `If-None-Match` —— 所以"校验"没有便宜路子。代码没这问题是因为换版时 install 用 `cache:"reload"` 整版重下核心清单,那条路绕开一切缓存;而 `image/card/` 的 581 张全在**可下载清单**里,压根不走那条路 | 构建产出**内容哈希清单** `pwa-asset-hashes.json`(SHA-256 前 16 位),客户端与本地基线 diff → 精确变更集,只补那几个。详见本节下方「素材内容版本」 |
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

### ★ 素材内容版本(2026-08-13)—— 「改了图但文件名不变」怎么让设备知道

**触发场景**:把 25 张卡面图重画后部署,设备上仍是旧图;点「下载离线资源」直接说「已下载完毕」。

**为什么代码能更新、素材不能**(两条路从设计上就不同,别混着想):

| | 代码 | 素材 |
|---|---|---|
| 存哪 | Cache Storage `noname-code-v1` | IndexedDB `noname-assets` |
| 换版怎么拿到新的 | install 里 `cache:"reload"` **整版重下核心清单**,绕开一切缓存 | 无 —— 命中即返回 |
| 有没有版本信息 | 有(`BUILD_KEY` 整版戳) | **没有**(记录只有 `{ buf, mime, len }`) |

**四个此路不通的方向**(都想过,都不行):

1. **靠 ETag 条件请求** —— 记录里没存 ETag,发不出 `If-None-Match`。就算发,1.4 万个素材是 1.4 万次往返(正是病因三)。
2. **读本地 `len` 和清单比** —— IDB 取一条会把**整条(含 `buf`)反序列化**出来,没法只读某个字段。"读全部 len"= 把 1.16GB 素材全读一遍。
3. **靠 `assetRevalidateWindow`** —— 它是**内存变量**,只在 install 里置 true,且只对"窗口开着时恰好被请求到"的素材生效。iOS 回收 SW 很凶,翻到那张牌时实例早没了。
   → 原注释写的「丢了只是更快,没有正确性损失」**是错的**:对"改了内容但路径不变"的素材,丢了就是永久读旧字节。
4. **文件名内嵌 hash** —— 见本文「为什么至今没给产物加 content hash」。那份决策的第 4 点已经指明它**治不了素材**(`image/character/xxx.jpg` 的路径是按武将 ID 拼的)。本方案补的正是那个缺口,**且不动任何文件名**,与那份决策不冲突。

**做法:比清单,不比文件。**

```
构建   对 dist 每个文件算 SHA-256 取前 16 位 → pwa-asset-hashes.json
客户端 下这一份(几百 KB,CF 会 gzip)与本地基线 diff → 精确变更集 → 只重下那几个
```

**基线必须本地算,不能采信服务端清单。** 直接把服务端那份存为基线等于替本地撒谎:库里明明是旧字节,
基线却声称与线上一致,之后**永远** diff 不出差异。本地算能对上构建时的哈希,因为存进库的就是 CF 上的
原始字节 —— 下载器用 `await r.arrayBuffer()`,SW 只在 `resp.redirected` 时重建 Response 且 body 原样搬,两处都不改字节。

**基线存成一条记录**(键 `__asset_baseline__`,值 `{ map: {路径: 哈希} }`),不是给每条素材加字段
—— 正是因为上面第 2 点(IDB 没法只读某字段)。

#### 实现时踩到的四个坑(都会静默出错,没有一个会报错)

| 坑 | 后果 | 处置 |
|---|---|---|
| **`pruneAssets` 会删掉基线** | 它以传入清单为唯一事实源删"清单外"的条目,而基线不在资源清单里 → 每次被删 → **基线永远建不起来**,每次检查都要重算 | 保留键从 `getAssetKeys` / `countAssets` / `pruneAssets` 一并排除 |
| **`onlyList` 模式若 prune 就是灾难** | 传进去的是几十个差异文件,一 prune 就把**另外一万多个素材全删了** | forced 模式硬跳过 prune(`if (db && !forced)`) |
| **`computeBaseline` 第一版会 OOM** | 写成"同步推进游标 + 哈希排成 Promise 链",游标一路跑到底而链在后面慢慢算 → 1.4 万个 buffer(可达 1.16GB)被闭包**同时按住** | 先 `getAllKeys`(不读值,很轻)再按 40 条一批取值,峰值只有一批。**不能在游标 `onsuccess` 里 await 后再 `continue`** —— 事务会在空转时自动提交 |
| **★ 哈希清单自己被 SW 缓存** | 它是根目录 `.json` → `isCodeAsset` 判为代码 → 掉进 Cache-First 主分支 → SW 发**上一版**清单 → diff 恒为空 → 界面报「素材与线上一致」而实际是旧图,**一句错都不报**;更糟的是基线会照这份旧清单写进去,连下次也一起错 | 加进 `pwa-sw.js` 那条清单专用的 **Network-First** 名单。**注意调用方写 `cache:"no-cache"` 没用** —— 那只约束浏览器 HTTP 缓存,请求照样进 SW 被 Cache Storage 拦下(这是本文第三节表格里同一个陷阱的**第二次现身**) |

#### 交互(一次点完)

点「检查更新」→ 代码检查照旧 → 首次问是否建基线(纯本地、不联网、不耗流量,带 `n/总数` 进度)
→ 建完**立刻用新基线再比一次** → 「发现 N 个素材与线上不一致,现在更新?」→ 只下这 N 个。
之后每次检查都只是几百 KB 的清单比对。清单取不到(老构建/离线)时 `inspectAssets` 返回 null,
这一项静默跳过,不影响版本检查。

#### 未实测

哈希清单的实际大小、构建多算这一遍的耗时、`computeBaseline` 在真机上读完全部素材要多久 —— 都没测。
构建日志会打一行 `内容哈希清单: N 文件 (XKB)`,以那个为准。


---

## 四、联机(PeerJS 房间号 P2P)

| 现象 | 根因 | 修法 |
|---|---|---|
| 点"创建房间"选模式点启 → 直接开单机 | 诊断日志确认 connectMenu=true(联机分支对);真正 bug 是 createServer 里 `lib.node.clients=[]` 在纯浏览器崩(lib.node 是 Electron 专有) | createServer 开头 `if(!lib.node) lib.node={}` 兜底 |
| 跨设备连不上/卡"连接中"/连上又断刷新 | WorkSpace(云主机)当 host + VPN 网络 = 重 NAT,WebRTC 打洞难、免费 TURN 兜不住;断开触发 onclose→game.reload("刷新") | 网络问题非代码问题。真机测用两台普通设备同 WiFi(局域网免打洞)。日常若免费 TURN 不稳需付费 TURN |
| 分享文本显示 `undefined房间` + 过时"启用邀请链接" | game.roomId 在 P2P 下不存在 | 纯浏览器分享文本改"房间号:XXX + 输房间号加入" |

**机制**:connect 模式服务器纯转发、逻辑权威在房主客户端,故 P2P 化不动引擎——只在传输层加 PeerJS 后端(peerAdapter.js 把 DataConnection 适配成 WebSocket)。同机 Edge+Chrome 验证连接/进房/开始全通=代码 OK。够 2 真人点开始,空位游戏开始时自动 AI 填充。

---

## 五、冷启动变慢(2026-08-11)—— 一个症状,七个独立病因

**症状是一个**:冷启动(关掉 standalone PWA 再开)从 7~8 秒变 15 秒,**在线和离线一样慢**。
**病因查出来是七个,机制互不相同**(病因五、六是修前四个时自己引入/暴露的,见各节)。这一点非常反直觉,查的时候差点用一个解释套住两边 ——
「在线要重下 35MB」解释得了在线,但**离线一个字节都不下载,那条解释在离线场景下根本不成立**。
先记住这个分流判据:

> **在线慢 = 吞吐问题(下了多少字节)。离线慢 = 延迟问题(等了多少个超时)。**
> 如果在线和离线耗时**差不多**,瓶颈就一定不在吞吐 —— 因为离线不下载,却没有变快。

> **⚠️ 2026-08-12 补:病因七才是那 15 秒的真凶,前六个都是陪跑。**
> 上面这条分流判据**不足以定位它** —— 它两边都慢,却既不是吞吐也不是超时,而是**存储引擎的
> 固定延迟**。修完前六个,冷启动仍是 15.8 秒。**如果你在读这一节,先跳到病因七。**

七个病因速览(详见各小节):

| | 影响面 | 机制 | 修法 |
|---|---|---|---|
| 病因一 | 在线 | install 失败删构建戳 → 缓存完整但 SW 全部绕开 → 重下 35MB | 保戳,改记 `STALE_KEY`(可收敛) |
| 病因二 | 离线 | 4 个必然 404 的请求串在 boot await 链上各等 4s | `ALWAYS_404` 短路 |
| 病因三 | 两边 | 素材后台 SWR 每次冷启动跑 12 个(**下得越全跑得越多**) | `assetRevalidateWindow` 每构建只校验一次 |
| 病因四 | 桌面/安卓离线 | 沙盒 iframe 加载 `sandbox.js`,iframe 不走 SW → 永久 pending → 60s 都出不了首屏 | `sandboxEnabled = false` 无条件跳过 |
| 病因五 | 离线 | 断掉代码文件逐文件 SWR 后,`failStreak` 唯一的喂食来源也断了 → `looksOffline()` 恒假 → 快失败短路永不生效 | **未修**,改法待定(见下) |
| 病因六 | 两边 | install 换版只写 `./index.html` 不写 `/`,导航读的是 `/` → 首页永远靠 SWR 慢一拍 | install 对首页额外 `put("/")` |
| **病因七 ★真凶** | **两边(仅 iOS/WebKit)** | **Cache Storage 条目一多,SW 冷启动首次 `caches.open()` 要摸遍该 origin 下每个桶的每一条 record 文件。21307 条 × ≈0.74ms = 15.8 秒,全花在拿到 index.html 之前** | **未修**。唯一杠杆是**降条目数**(拆桶、压体积都无效,已证伪) |

**⚠️ 病因二的修法引入过一个回归,病因三顺带修掉了** —— 详见病因二末尾。这是本节最值得记住的一课:
**删一个"纯浪费"的请求前,先查有没有别的机制在靠它的副作用工作。**
**这一课在同一天又被违反了一次,代价是线上变砖 —— 见病因五。**

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

### 病因五(离线,**未修**):砍掉那 600 个"纯浪费"请求,把离线判定一起饿死了

**病因二末尾那条教训,在同一天被同一个人又违反了一次,这次代价是线上变砖。** 完整记下来。

`02331f7` 给命中分支的后台 revalidate 加了 `!isCodeAsset()`(为堵混搭源头,**这个修复本身是对的**)。
但它顺带砍掉的那 600 个请求,**是 `failStreak` 唯一的喂食来源**。缓存装齐的冷启动从此一个
`noteNetResult` 都产生不了:

- 代码文件不再逐个后台校验 —— 那 600 个失败原本是 streak 的唯一来源
- 素材校验被 `assetRevalidateWindow` 关着(病因三的修法,每构建只开一次)
- `codeNeedsNetwork` 分支在 `STALE_KEY` 不存在时整个跳过
- 导航分支的 `bgUpdate` 用 `.catch(() => null)` 把失败静静吞了,压根不记账

于是 `failStreak` 恒为 0 → `looksOffline()` 恒假 → miss 分支那个「离线时一个网络往返都不发」的
快失败短路(注释里自称"离线启动从分钟级降到秒级的关键")**永不生效**,离线冷启动退化成
"每个未缓存资源各等满 `missTimeoutMs` 4~8s、串行累加"。

> **★ 反直觉结论:缓存下得越全,离线启动越慢。** 因为下得越全越没有失败样本,SW 越发觉不出自己离线。

#### 失败的修复尝试(`0589a49`,已被 `2783aff` revert)

给 `noteNetResult(ok, strong)` 加 `strong`,导航请求失败时让 `failStreak` **一次顶满**。
线上结果:`SyntaxError: importing binding name 'c' is not found`,**在线离线都坏**。

**错在哪**:`looksOffline()` 有三个消费点,我当时以为它们都是"省时间"的,漏了一个是**正确性机制**:

| 消费点 | 类别 | 被跳过的后果 |
|---|---|---|
| `pwa-sw.js` miss 分支快失败 | latency | 只是慢 |
| 素材后台校验 | latency | 只是慢 |
| **`codeNeedsNetwork`** | **correctness** | **直接从缓存喂跨版本混搭 chunk → link 失败 → 变砖** |

`codeNeedsNetwork` 是 install 装不齐时把代码文件补成当前构建字节的**唯一补救**。误判成本因此
从"少发几个请求"升级成"喂错字节"。而 CF 刚部署那次冷启动,导航的 2s 超时**在线也会超**
(SW 正在装、单线程忙),所以在线同样被误判 —— 这就是为什么在线也坏。

#### ★ 更深的坑:`failStreak` 到 3 之后会**自锁**

这一条是事后测绘才发现的,比上面那个更阴:**所有 `noteNetResult(true)` 的复位点,都被
`looksOffline()` 自己把着门。**

- `codeNeedsNetwork`(含 `noteNetResult(true)`)要求 `!looksOffline()`
- 素材后台校验(含 `noteNetResult(true)`)要求 `!looksOffline()`
- miss 分支在 `ms > 0` 时直接短路 return,**走不到**后面那次 `fetch` 和它的 `noteNetResult(true)`
- 而除 `cache:"no-cache"` 外,所有请求的 `ms` 都 > 0(4000/8000)

**结果:`failStreak` 一旦到 3 就再也降不回来**,本次 SW 生命周期内只有下载器 / `repair()` 的
`no-cache` 请求能解锁。一次误判会把补救分支**永久**关掉 —— correctness 风险从"慢一次"升级为
"持续变砖"。

> **★ 判据(下次改这块必读):任何"疑似离线"启发式,只能驱动 latency 类分支,绝不能驱动
> correctness 类分支。** 而且改之前先问:这个状态一旦误置为真,**有没有路径能让它恢复?**

**现状:病因五未修。** 它慢但不坏;而上一版修法的代价是变砖。改法待定,已知约束:
`codeNeedsNetwork` 必须无条件走(速度让位于正确性)、不能重新依赖 `navigator.onLine`
(iOS standalone 飞行模式下恒报 true,已证伪)、不能回退 `02331f7` 的"代码永不逐文件 SWR"。

### 病因六(两边):install 换版漏写 `/`,首页永远靠 SWR 慢一拍

**发现过程**:病因五的自修复本该接住 `binding name 'c'` 报错,但用户**从未见过**那个全屏
「正在自动修复」提示。查出来是两层,第二层就是这个。

**第一层(`3583599` 已修)**:`index.html` 里 112 行起那个块的 `window.onerror` 排在自修复 IIFE
(218 行起)**之前**,属性式处理器与 `addEventListener` 按注册顺序执行 → 它先跑,而它最后那句
`alert()` 是**同步阻塞**的:线程停在弹窗上,自修复的监听器根本轮不到。
`ce6634a` 当时专门论证了"触发点必须用 `addEventListener`,因为 `noname/util/error.ts` 会重新赋值
`window.onerror`" —— 那个分析对的是 `error.ts`,**漏了 `index.html` 自己就有一个更早、且带 alert 的**。
修法:两个属性式处理器遇到混版措辞时让路,转调 `window.__pwaRepair()`。

**同时修掉的死锁**:`alreadyTried` 靠 hash 上的 `__pwafixed` 判定,而摘掉标记要等一个 **20 秒**的
`setTimeout`。但真实故障下报错在启动瞬间发生,用户看完弹窗就退出 —— 那 20 秒永远走不完,标记
永久钉住,**自修复此后一次都不再触发**。修过一次(哪怕没修成)就再也修不了。改成立刻摘掉,
防循环交给内存里的 `alreadyTried`(本次加载不重修,下次打开可再试)。

**第二层(`2d5bca7` 已修)**:上面的修复推上线后**仍然没生效**,因为手机拿到的还是缓存里的旧首页。
核心清单里首页写作 `"./index.html"`,install 用 `cache:"reload"` 取回后只 `put("./index.html")`;
而**导航分支实际命中的 key 是 `"/"`**。两个 key 不同 → install 明明整版重下了新首页,导航读的
`"/"` 还是旧的 → 首页只能靠导航分支的 SWR 慢一拍更新(本次喂旧、写回新、下次才生效)。

> **★ 后果:任何改 `index.html` 的修复都至少要开两次 App 才生效** —— 而"启动就报错"这类故障
> 根本撑不到第二次(用户看到弹窗就退出了)。**修白屏类故障的代码,自己却需要两次启动才上线,
> 等于没修。**

`repair()` 里早就写对了这一条(它对 `index.html` 额外 `put("/")`,注释还写着"漏了它会继续启动
旧首页"),**install 这边一直漏着 —— 同一个坑只补了一处**。修法:install 主循环与重试轮遇到
`index.html` 时额外 `cache.put("/", ...)`。

**★ 教训:同一份内容有多个缓存 key 时,写入方必须全写、读取方的匹配顺序必须查清。**
`repair()` 和 install 是两个独立的写入方,只有一个记得写 `"/"`。

### 病因七(★真凶,2026-08-12):Cache Storage 的条目数,是 iOS 冷启动的一次项

**修完前六个病因,冷启动仍是 15.8 秒。这一节是那 15 秒的真正归宿。**

#### 实测数据(iOS standalone,满缓存 21307 条 / 1805MB)

在 SW 里逐段打点得到(注意:**页面侧 PerformanceResourceTiming 测不出来**,见下面「测量陷阱」):

| 段 | 耗时 | 说明 |
|---|---|---|
| 唤醒+派发 SW | **6ms** | 系统起 SW 线程 → fetch 事件到达。**iOS 硬伤假设由此否掉** |
| `caches.keys()` | **15.8s** | ★ 全部时间在这里。而它只是**列桶名**,不开桶、不读内容 |
| `indexedDB.open()`(空库) | **4ms** | 对照组:同一台机器,别的存储引擎不慢 |
| `navigator.storage.estimate()` | **1ms** | 配额核算路径**不参与**(曾被怀疑是元凶,由此排除) |
| `cache.match()` | **2ms** | 桶开好之后极快(内存 `m_records` 命中) |
| 之后 645 个请求 | **682ms** | 拿到 index.html 之后的整个模块加载,很快 |

**总 16.4s = 首页 15.7s + 之后 0.7s。93% 的时间花在 SW 交出 index.html 之前。**

对照:桌面 Edge/Chromium,**同样约 2 万条、SW 活着、满缓存冷启动**,同一行只要几十毫秒。

#### 机制(WebKit 源码,多方独立逐行核对)

```
caches.open(任意桶)
  → DOMCacheStorage::open() 先调 retrieveCaches()        ← 不是直接开那个桶
  → IPC CacheStorageAllCaches
  → CacheStorageManager::allCaches():
        for (Ref cache : borrow(m_caches).get()) cache->open(...);   ← 对 origin 下每个桶
  → CacheStorageCache::open() → readAllRecordInfos()
  → CacheStorageDiskStore::readAllRecordInfosInternal():
        双层 listDirectory,对每条 record 文件 SafeFileData::read() + 解码 header
```

**四条结论,每条都能独立解释一个实测现象:**

1. **账按 origin 算,不按桶** —— `for (每个桶)` 那一行。**这就是拆桶必然无效的原因**,而且是代码
   **事前预测**出来的,不是事后附会。
2. **磁盘上没有 record 级索引** —— 持久化辅助文件只有 `cacheslist`(仅存桶名)/`estimatedsize`/
   `origin`/`salt`。条目索引 `m_records` 只能靠全量扫描在内存里现建,`m_isInitialized` 是**纯内存**
   → 解释了"之后 match 只要 2ms",也解释了为什么每次冷启动都要重付。**这不是可调参数,是架构差异。**
3. **贵的是条目数,不是字节** —— 扫描里显式 `if (recordName.endsWith(blobSuffix)) continue;`,
   大 body 存成独立 `-blob` 文件、扫描时跳过。**所以压缩素材体积对这个瓶颈完全无效。**
   (注意 `WTF::pageSize()` 在 iOS arm64 是 16KB,≤16KB 的 body 是 inline 存在 record 文件里的。)
4. **iOS 比桌面慢的机制性原因** —— `SafeFileData::read()` 每个文件先调
   `isSafeToUseMemoryMapForPath`,其 iOS 实现(`FileSystemCocoa.mm`,`#if PLATFORM(IOS_FAMILY)`)
   是 `[NSFileManager attributesOfItemAtPath:]` 元数据查询,必要时还 `setAttributes:` 写文件保护类;
   **非 iOS 平台该函数是空实现 `return true`**。即 iOS 每条 record 多付一次 NSFileManager 往返。

成本构成:15.8s / 21307 ≈ **0.74ms/条**,正是冷态闪存随机读 + per-file syscall 的区间。

**Chromium 为什么不受影响**:它有持久化条目索引(`index.txt` + protobuf + SimpleCache pickle,
每条目元数据 8 字节),打开 cache 时**不碰条目文件**。

#### ⚠️ 已证伪,别再走这几条路

| 假设 | 为什么错 |
|---|---|
| 拆成代码桶/素材桶能缓解 | `allCaches()` 对每个桶都全量扫。**实测拆了没用,源码也预测了没用** |
| 压缩素材体积 / 减小文件 | 扫描跳过 `-blob` 实体,与字节数无关。`estimate()` 只花 1ms 也佐证 |
| 「15000 次 SHA-1 ≈ 15 秒」 | **算错约 400 倍**。SHA1 走 CommonCrypto(ARM64 硬件加速),只校验 header,量级 ≈46ms(0.3%) |
| 「1GB 实体被 mmap + hash 了一遍」 | 没有,`-blob` 文件被显式跳过 |
| 是 iOS 系统层唤醒 SW 慢 | 唤醒+派发实测 **6ms** |
| 是配额核算(`getUsageFunction`)在扫 | `estimate()` 实测 **1ms** |
| 等新版 Safari 修 | **WebKit Bugzilla 上没有任何跟踪这个开销的 bug**(多路检索确认)。这是当前设计的既定行为,不是待修缺陷 |
| 桌面 Edge 快 ⇒ 我们代码没问题 | Chromium 有持久化索引、WebKit 没有,是**架构差异**。**桌面对照组对 WebKit 结论零信息量** |

#### ★ 教训:「条目数」是一个没人告诉你要预算的维度

- **官方文档全是字节维度**(MDN Cache、web.dev Storage、Chromium README、WebKit 存储策略),
  **没有任何条目数上限或推荐量级**。这不是"违反了 best practice",而是**掉进了文档盲区**。
- **社区也没有那条 practice**。五路独立检索都没找到 web.dev / MDN / Chrome 团队 / Jake Archibald /
  Workbox 说过"大批量二进制该放 IndexedDB"。**Chrome 存储团队的建议恰好相反**
  (`developer.chrome.com/docs/ai/cache-models`:"recommends the Cache API"、"IndexedDB ... the worst
  place")。**但那篇文全文零 benchmark、原文自陈 "not generalizable"、样例条目数=1、全文不提
  iOS/Safari** —— 它测的是"单个巨大 blob 的吞吐",我们的问题是"1.5 万条目下的固定延迟",
  **两个正交的轴**。曾经拿它当"别迁"的依据,是跨引擎的范围转移。
- **唯一真正可比的先例是 Kiwix JS PWA**(离线维基百科,单档 110GB+):Cache Storage **只放代码**,
  内容是"单个大文件 + 内部索引 + 随机读",走 OPFS。Unity WebGL 同理(打包好的 `.data` 存 IndexedDB)。
  **共同点不是"用哪个 API",而是"素材不以一个文件一条记录的形式存在"。**
- **本项目的选型错误**:全程按字节预算做设计(1GB 够不够、会不会被驱逐),而 iOS 上真正线性
  收费的维度是条目数;且用**桌面 Chromium 实测**给 iOS 开了绿灯。

#### ⚠️ 测量陷阱(这轮踩了三个,都产出过假数据)

1. **`performance.now()` 的原点是导航开始,不是脚本执行时刻。** SW 花 14 秒才吐出 index.html 时,
   内联脚本一执行 `now()` 就已经是 14000 —— 拿它当 t0,`bootDone - t0` 只剩 470ms,
   **把最慢那段整个减掉了**。实测就报出过「面板 470ms / 人等 15 秒」。**起点必须固定为 0。**
2. **iOS/WebKit 不填 `workerStart` / `transferSize` / `decodedBodySize`。** 拿它们做分类会得到
   「请求 645(过SW 0)| 0.00MB」这种自相矛盾的数(缓存命中**必然**过 SW,因为 Cache Storage
   只有 SW 和页面 JS 能读)。**缺字段要如实显示"字段缺失",绝不显示 0** —— 那种"看起来像数据的 0"
   会把人带向完全错误的方向。**结论:导航阶段的拆分只能靠 SW 自己 `Date.now()` 打点**
   (SW 与页面共享墙钟,`SW 收到事件的绝对时刻 − (timeOrigin + nav.fetchStart)` = 唤醒+派发开销)。
3. **★ 埋点自己会烧掉被测的时间。** 为了"顺手报个条目数"在导航分支里加了
   `(await cache.keys()).length` 两句,而 `caches.keys()` 正是那个 15.8 秒的操作 ——
   **冷启动从 16.4s 变成 54.3s**。而当时给这两句写的注释还是"排在计时之后,不污染任何一项":
   只想到别污染数字,没想到会污染**用户的启动**。
   **在已知昂贵的路径上加诊断,先算清诊断本身的成本。**

#### 修法方向(未实施,2026-08-12 决定)

**唯一杠杆是降条目数。** 三条路的取舍:

| | 冷启动 | 每次读一张图 | 增量更新 | 改动量 |
|---|---|---|---|---|
| **IndexedDB,一素材一条,存 ArrayBuffer** | O(1)(开一个 SQLite + 读 schema,不枚举记录) | B-tree 精确命中,2~3 页 | **保留** | 1:1 映射,最小 |
| 打包成少量大文件 + 留在 Cache Storage | ~0.8s | **白读几 MB**(`Response` 没有随机访问,只能流式跳到偏移) | 改一张重下整个包 | 要设计包格式+索引+流式读 |
| OPFS + 打包 | 读路径不枚举 | `File.slice()` 真随机读 | 改一张重下整个包 | 最大;`createWritable` 要 Safari 26,SW 里只能异步读、拿不到同步句柄 |

**选 IndexedDB**,因为"打包"的前提是**存储支持随机读**,而 Cache Storage 不支持 ——
在这里打包是硬凑。(Kiwix/Lumafield 用 pack 是配 OPFS 用的,不是配 Cache Storage。)
而若一素材一条就能解决,压根不需要打包这一层复杂度。

**红线:绝不存 Blob,只存 ArrayBuffer + 单独存 MIME。** 两个理由:
1. WebKit 下 IDB 里的 Blob 会**每个落成一个独立 `.blob` 文件** —— 把"万文件"问题原样搬过去,白干。
2. iOS 存 Blob 有至今未修的损坏/写失败 bug:WebKit **235687**、**240216**(均 NEW)、
   **188438**(2018 标 FIXED,但 iOS 18.7 / 26.5.2 仍有新报告)。

**已知风险,实施时必须处理:**
- **WebKit 287876(NEW):iOS 18 PWA 下 `put` 会间歇性失败。** 写 2 万条必须做**重试 + 断点续传**,
  不能假设 put 一定成功。**这个不需要预先实测 —— 直接把自愈做进去。**
- 存 ArrayBuffer 后 **`Content-Type` 必须自己填**(按扩展名映射)。
- **mp3 走 `<audio>` 必须实现 Range/206** —— Safari 对媒体要求 Range,返回 200 会被拒。
- **迁移必须真正删掉旧的 Cache Storage 素材**,留着 = 15 秒照旧(账按 origin 算)。
- **迁移不必让用户重下** —— 理论上可本地从 Cache Storage 读出再写入 IDB,只付一次那 15.8 秒。未验证。
- 仍未有人公开实测 iOS 上 1GB / 1.4 万条 IDB 冷开(全球范围的数据空白)。机制上 `open` 不枚举
  记录、`idbStorageSize` 只 stat `*.sqlite3`,故**预期**为 O(1),但这是源码推断而非实测。

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
   → **这一点已在 2026-08-13 单独解决**:改用**独立的内容哈希清单**(`pwa-asset-hashes.json`)而不是
   把 hash 塞进文件名,于是素材也有了内容版本,而文件名一个都没动 —— 上面那四笔代价一笔都不用付。
   见**第三节**「★ 素材内容版本」。**本决策(代码产物不加文件名 hash)不变。**

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
| `apps/core/pwa-sw.js` | (新增文件)缓存策略 + `missTimeoutMs` 超时分档 + `failStreak` 离线启发式 + `ALWAYS_404` 短路 + install 失败保戳记 `STALE_KEY` + `assetRevalidateWindow`(素材每构建只校验一次,**校验结果写 IndexedDB**) | 上游不会动,但改它前必读本文档「断网白屏根治方案」、第五节,以及**病因七** |
| `apps/core/pwa-asset-db.js` | (新增文件)素材仓库(IndexedDB)。**素材不再进 Cache Storage** —— 见病因七 | 上游不会动。改它前先读病因七的「红线」:只存 ArrayBuffer 绝不存 Blob;任何往 Cache Storage 写素材的代码都会把那 15.8 秒养回来 |
| `scripts/build.ts` | 核心清单:剔掉 `service-worker.js`/eslint-linter/废弃 vue 兼容层;补进 11 张 splash + `ol_bg`/`handcard`/`tiesuo_mark` + 基础字体。**PWA 图标不进核心**(见代码注释,71333e1 加进来是白占,已撤) | 收录判据见第五节,别凭直觉加减 |
| `apps/core/noname/entry.ts` | 无改动,但 `await import("/preload.js")` 这个**故意失败**的探测被 `ALWAYS_404` 短路了 | 上游若改了平台分派方式(不再靠 import 失败),要同步删掉 `ALWAYS_404` 里的 `/preload.js`,否则会挡住真实文件 |
| `apps/core/noname/game/index.js` | ①createServer/connect 的 PeerJS 分流 ②createServer 开头 `if(!lib.node)lib.node={}` | 联机 P2P 分流还在吗 |
| `apps/core/noname/library/element/content.ts` | waitForPlayer 改 `await game.createServer()` | 还在吗 |
| `apps/core/mode/connect.js` | 「创建房间」按钮 + 不弹邀请链接 confirm | 还在吗 |
| `apps/core/noname/library/init/index.js` | 下载离线资源(downloadOfflineAssets)增量补课;**素材写 IndexedDB、代码写 Cache Storage**(见病因七) | 还在吗;分流判据(`isCodeAsset`)必须与 `pwa-sw.js` 严格一致 —— 写进 A、从 B 读 = 等于没缓存 |
| `apps/core/noname/ui/create/index.js` | 分享文本改房间号引导 | 还在吗 |
| `apps/core/noname/ui/create/menu/pages/otherMenu.js` | 检查更新按钮 + 双主页链接 | 还在吗 |
| `scripts/build.ts` | ①产物校验 ②生成 pwa-core/all-assets.json(含 dist 根散文件) ③`NOT_CORE` 剔大块头 ④**素材库出两份产物**:`pwa-asset-db.js`(classic,给 SW 的 importScripts)+ `pwa-asset-db-esm.js`(ESM,给页面 import),并校验导出名齐全 | 清单生成还在吗;`NOT_CORE` 三条理由是否仍成立;**改 `pwa-asset-db.js` 的函数名要同步 `dbExports` 数组**,否则构建直接抛错(那是故意的:免得导出一个不存在的名字让页面 import 静默失败) |
| `apps/core/character/{bingshi,clan,huicui,mobile,newjiang,onlyOL,refresh,sb,sp,xianding}/character.js` | 给 35 个无立绘武将插 `img:` 字段(消除剪影),搜注释 `无自有立绘,复用同一人物的本体立绘` 可定位全部 | 跑 `node scripts/audit-character-images.cjs`,应报"零剪影"。**上游若补了真图,删掉我们的 `img:` 行**。详见 [docs/CHARACTER-IMAGES.md](./docs/CHARACTER-IMAGES.md) |
| `apps/core/index.html` | ①`window.onerror`/`onunhandledrejection` 遇模块混版措辞让路给 `__pwaRepair()` ②缓存自修复 IIFE(约 200 行) | **上游若重排内联 `<script>` 块顺序,必须重查**:自修复靠"内联脚本已同步执行完、`entry.ts` 在文件末尾才加载"才保证 `__pwaRepair` 已定义;且属性式 `onerror` 若又排到自修复前面而没有让路判断,自修复会再次形同虚设(病因六第一层) |
| `apps/core/pwa-sw.js` | install 主循环与重试轮对 `index.html` 额外 `cache.put("/")` | 导航分支的 key 匹配顺序若变,这里要跟着改(病因六第二层)。**别删** —— 删了改 `index.html` 的修复要开两次 App 才生效 |
| `apps/core/game/package.js` | `card:` 里加了一行 `caocaozhuan: "曹操传"`(曹操传宝物卡牌包的登记处) | **上游动过这文件(近 200 commit 里 1 次)**,同一个 `card: {}` 块里两边都加包就会冲突 —— 那是好事,冲突会明确报出来,**两边都保留**即可。真正危险的是上游把整个 `card:` 块重写(比如改成扫目录),那样我们这行可能被静默吞掉,症状是「选项 → 卡牌」里曹操传消失。**合并后务必去菜单里确认这一项还在。** |
| 新增文件(不会冲突) | `pwa-sw.js`、`pwa-asset-db.js`、`manifest.webmanifest`、`peerAdapter.js`、`wrangler.jsonc`、`image/pwa/*`、`card/caocaozhuan.js`、`image/card/ccz_*.png`、本文档、README-PWA.md | 上游不会动,一般安全。**卡牌包的卡 id 一律带 `ccz_` 前缀**:上游若哪天出同名卡也不会互相覆盖(覆盖是静默的,极难查) |

**★ 2026-08-12 实测:上游那 20 个 commit 一个 PWA 文件都没碰。** 108 个改动文件全是内容
(`audio/skill` 20、`image/character` 13、`character/*` 37、`typings`/`mode` 各 2),
`pwa-*` / `sw.js` / `manifest` / `build.ts` / `index.html` / `library/init` **零命中**。
原因很简单:PWA 那套整个是本 fork 新增的,上游仓库里压根没有这些文件。
**所以本清单不必每次同步都逐条核** —— 先 `git diff --name-only HEAD...upstream/main`
过一遍上表的文件名,有命中才核对。没命中就是纯内容合并,放心合。

---

## 七、「改了卡面图,设备上永远是旧的」(2026-08-14)—— 七个提交,只有一个修对了

**症状**:改了 25 张卡面 PNG(路径不变)推上线,设备上一直是旧图;点「检查更新」永远说
「素材与线上一致」;后来图**自己**变新了。

**真凶只有一个,而且蠢得不能更蠢**:`otherMenu.js` 里三处写着

```js
await import(`${lib.assetURL}pwa-asset-db-esm.js`)
```

而 `lib.assetURL` 是**空字符串**(`util/index.js:4`)。拼出来是
`import("pwa-asset-db-esm.js")` —— **裸模块说明符**。不以 `/`、`./`、`../` 开头的
说明符按 import map 解析,而 import map 里没这个名字 → 直接抛
`TypeError: Failed to resolve module specifier`(Safari 措辞:*module name … does not
resolve to a valid URL*)。异常被 `catch` 吃掉,于是:

- `inspectCache` 的 `assets` 保持 null → 体检报「素材 0 个」/「素材库打不开」
- `inspectAssets` 直接 `return null` → **素材比对整段跳过**
- 检查更新因此**恒报「与线上一致」**

**素材更新这条路从上线那天起一次都没跑通过。** 修法:改用 `rootURL`
(`new URL("./", import.meta.url)`,带尾斜杠的真实绝对 URL)。下载器
(`library/init/index.js:98`)一直用的就是它,所以**下载一直是好的** —— 库里 1.4 万个
素材是满的,离线立绘正常就是铁证。

### 为什么"图后来自己变新了"

不是哪套机制修好了,是 SW 的**换版后台校验**(`assetRevalidateWindow`)碰运气补上的:
它是 SW 实例的内存标志,只在 install 时置位,且只更新"窗口开着时恰好被请求到"的那几张。
25 张装备牌要在一局里都出现才可能都更新,iOS 回收 SW 窗口就没了。
**它能用,但不可靠;可靠的那条(哈希清单比对)当时是坏的。**

### ★ 教训一:这类 bug 静态检查一个都抓不到

裸模块说明符、`legacyAssetCache` 悬空标识符、曹操传那个多余的 `},`(第三节)——
**三次事故同一类:语法合法、运行时才炸**。`node --check`、`tsc --noEmit`、grep、
`pnpm build` 全部通过。

> **我一路在改"账本逻辑",却从来没验证过"读账本的代码能不能跑起来"。**
> 那三处 `import()` 只要在浏览器里执行一次就当场报错。

**可操作的防线**:凡是 动态拼接的 `import()` 路径 这种动态拼接的模块路径,
必须确认那个变量**带协议或以 `./` 开头**。仓库里 `lib.assetURL` 是空串、`rootURL`
才是 URL —— 两者名字像、语义完全不同,是个现成的陷阱。

### ★ 教训二:「读不到」绝不能伪装成「空」

原来的写法:

```js
async function getAssetKeys() { try { … } catch { return new Set(); } }  // 读失败 → 空集
async function countAssets()  { try { … } catch { return 0; } }         // 读失败 → 0
```

一次失败,被伪装成两个"正常":空集让 15132 条素材全被判成"本地压根没有" →
`changed` 恒空 → 报「与线上一致」;0 让体检显示「素材 0 个」,而**我据此推断"库被清空了"
——完全错**,用户反复强调离线立绘正常(那只可能来自 IDB)。

统一改成**返回 `null` 并把真实错误存进 `lastError`**(`getLastDbError()`),
再加一个「素材库诊断」按钮(选项 → 其它)把它报到屏幕上。**是这个按钮一次点出真凶的** ——
在此之前我猜了四轮。

### ★ 教训三:两个地方判断"已缓存",判据必须是同一个

修完真凶后出现新矛盾:检查更新说「另有 41 个未下载」,点「下载离线资源」却说「已完整」。

两边都没错,判据不同:

| | "已有"的判据 |
|---|---|
| `inspectAssets` | 只看 **IDB 键** |
| `downloadOfflineAssets` | **代码桶 ∪ IDB** |

核心清单里有 **104 个非代码文件**(12 张模式启动图、卡背/血条/边框主题图、
`suits`/`motoyamaru` 字体、`ol_bg.jpg`、`handcard.png`…),由 install 预缓存进
**Cache Storage 代码桶**,压根不进 IDB。于是一边报"缺",一边报"有"。
已让 `inspectAssets` 也算上代码桶的键(开它很便宜,就 738 条 —— 拆桶就是为了这个)。

#### 同一个口径不一致还有第二个症状:核心素材被存成两份

排查过程中发现素材库比应有值**多** 63 条(14463 vs 14400)。同一个根:
**两条写入路径的归类口径不一致**。

| 谁在写 | 归属规则 | 对 `image/splash/style1/identity.jpg` |
|---|---|---|
| `install` | 看**在不在核心清单里** | 在 → **代码桶** |
| SW 「访问即缓存」 | 看**是不是代码**(`isCodeAsset`) | 不是 → **IDB** |

于是:install 还没装到某张启动图时它就被请求 → IDB 先存一份 → install 再往代码桶
存一份 → **同一个文件两份**。而读的时候 IDB 优先,代码桶那份就闲着。
只有那 104 个"在核心清单里 + 不是代码"的文件处在两条规则的交叉点,它们是唯一
可能重复的那批(代码两边都说代码桶;可下载清单里的立绘 install 压根不装)。

**修法(`a6badddf8`)**:加一个 `installing` 内存标志,install 期间「访问即缓存」
不往 IDB 写非代码文件。

> 【为什么不用 `isBootAsset` 挡 —— 这是个陷】看着“一行的事”:它本就是读核心清单的。
> 但它要从**代码桶读** `pwa-core-assets.json`,而重复恰好只发生在清单还没落地的
> 那个窗口 —— 那时 `getBootSet()` 返回 null、`isBootAsset` 退化回 `isCodeAsset`,**照样写 IDB**;
> 而装完之后代码桶已命中,压根走不到那条分支。**所以那一行是白写的** ——
> 必须用不依赖缓存的内存标志。差点就提了一行上去。

`installing = false` 必须放 `.finally()`:install 体内任何一处抛异常都会跳过它,
而那之后**整个 SW 生命周期**都不往素材库写东西(访问即缓存全废、离线立绘变剥图),
代价远大于它防的那点重复。

**已有的重复不清**:`pruneAssets` 以"不在清单里"为判据,而它们恰好**在**清单里。
专门为此加一个按清单删的接口不值得 —— 1MB 出头 + 63 条记录,而且不影响 iOS 冷启动
那笔账(那算的是 **Cache Storage** 条目数)。老设备会一直显示 14463,**那是历史包袋不是故障**;
新装的设备就是干净的 14400。

### ★ 教训四:存储结构上"账"和"实物"能分开出错,就一定会出错

版本账本原来是**单独一条记录**(`__asset_baseline__`,14403 行挤在一个 value 里),
实测三种烂法全中:

1. **搬货不记账** —— 素材写入有三个入口(下载器 / SW 访问即缓存 / SW 换版后台校验),
   `grep baseline pwa-sw.js` = **0 次**,一个都没记;
2. **账活着实物没了** —— prune 把基线列为保留键删不掉;
3. **读账失败被当成"账是空的"** —— 见教训二。

三个 bug 一个成因。**逐个补是补不完的**,只要账和实物能分开出错就还会有第四个。
根治:`DB v1 → v2` 加一张 `versions` 表(`path → sha16`),把算哈希+写版本号**塞进
`putAsset`/`putAssets` 内部、和字节同一个 IDB 事务** —— 结构上不存在"只写字节不写
版本号"这个选项,新增第四个写入口也自动是对的。删掉了
`getBaseline`/`saveBaseline`/`computeBaseline`/`updateBaseline` 和「建立基线」那步 UI。

> 为什么非要拆一张表:账本原来是一大条,在 `putAsset` 里改一行得整条 800KB 读改写。
> 而"每条素材加个 sha 字段"也不行 —— IDB 取一条会把整条(含 `buf`)反序列化,
> "读全部版本号"就等于反序列化 1.16GB。**两个约束只有分表能同时满足。**

### ★ 教训五:升级(`onupgradeneeded`)里绝不能干重活

我自己踩的:把"老基线 14403 行摊平进版本表"写在 `onupgradeneeded` 里。
versionchange 事务一旦 abort(配额 / WebKit 的 IDB 间歇失败 / 单事务写量太大),
**整个 `open` 就失败,而库仍停在旧版本** → 之后每次 `open(v2)` 都重跑同一个升级、
都失败 → **永久打不开**。时间点是铁证:v2 发布前设备报「素材 0 个」,v2 之后变成
「素材库打不开」。

改法:升级里**只建表**(O(1)),摊平改成惰性 `migrateLegacyBaseline()`,用普通
readwrite 事务分批(2000 条/批);失败也只是"版本未知",本地补算一遍即可,库照样能读。

### ★ 教训六:`onblocked` 写成空函数 = 整个接口镀死

原注释:「被别的连接挡住:不 reject,等它让开。**卡死也无所谓 —— 调用方都有 try/catch**」
—— **后半句是错的**。调用方 `await` 的是那个记忆化 promise,它永不结束就是整个素材库
接口镀死,而 **`try/catch` 接不到悬着的 promise**。已给 8 秒上限,超时如实 reject。

### 复盘:7 个提交的有效性

| 提交 | 判定 |
|---|---|
| `4e5331458` 裸说明符 | ✅ **唯一真正修对的** |
| `4c7b39897` 读不到≠空 | ✅ 有效(诊断)——**正是它让故障显形,才顺着查到真凶** |
| `b420d370e` 基线盲区 | ⚠️ 真 bug,但下游 import 跑不起来,修了没人用;还白加了一轮哈希 |
| `34e80a0d1` 版本表重构 | ⚠️ 正确,但当时真凶不是账本 —— 是"以后不会烂"的保险,不是这次的解药 |
| `e2eaa6bdc` / `6821b2071` / `90fff9a89` | ❌ **全在修我自己前一个提交留的坑** |
| `9ac70f098` / `a6badddf8` 口径统一 | ✅ 有效 —— 两个症状(假“41 个未下载”、核心素材存两份)同一个根,见教训三 |

**7 个里只有 1 个解决了问题,3 个是自伤自愈。** 根因是没有先验证"这条路到底跑不跑得起来"
就开始改逻辑 —— 见教训一。

---
