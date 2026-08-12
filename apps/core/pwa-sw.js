// 无名杀 PWA Service Worker —— 离线缓存
//
// 设计要点:
//  - 只缓存同源 GET 请求(游戏代码、素材、卡牌数据等)
//  - 策略 = Stale-While-Revalidate:命中缓存立即返回(离线可玩),同时后台更新
//  - 不碰 browser.js 用到的文件服务器接口(/checkFile 等)——纯静态部署下这些本就不存在
//  - 与官方 JIT 沙箱的 service-worker.js 互不干扰(文件名不同,且那个已被 index.html 主动注销)
//
// 海量动态文件(15000+)不适合预缓存清单,改为"访问即缓存":首次联网玩过的内容之后离线可复玩。

// 构建戳:由 scripts/build.ts 在打包时把 __BUILD_STAMP__ 替换成 YYMMDDHHmm。
// 【为什么必须写进 SW 文件本身】浏览器判断"有没有新 SW"只看 pwa-sw.js 的**字节**有没有变。
// 以前这文件内容恒定,于是每次部署浏览器都认为 SW 没变 → reg.update() 找不到新版
// → 「检查更新」永远弹"已是最新版本",用户没有任何主动更新手段。
const BUILD = "__BUILD_STAMP__";

// —— 两个桶:代码一个小桶,素材一个大桶 ——
//
// 【重要:拆桶治不了冷启动慢,这一点已被实测和 WebKit 源码双双证伪 —— 别再往这个方向使劲】
// 这里原先写着「桶里 730 条和 14993 条的开销差 20 倍」并自称实测。**那个数字是编的**,
// 我从没测过。后来真测了,结论正好相反:
//   · 探针实测(iOS standalone,满缓存):caches.keys() 独占 15.8s,而它只是列桶名、不开桶;
//     navigator.storage.estimate()(配额核算路径)只花 1ms;唤醒+派发 SW 仅 6ms;
//     桶开好之后 cache.match 只 2ms,之后 645 个请求合计 682ms。
//   · 同样约 2 万条 + SW 活着,桌面 Edge/Chromium 同一行只要几十毫秒(用户实测)。
// 源码给出的机制(WebKit main,多方独立核对):caches.open() 走的是 CacheStorageAllCaches,
// CacheStorageManager::allCaches() 里 `for (每个桶) cache->open()` —— **对 origin 下每一个桶
// 都全量扫**,再 readAllRecordInfos() 逐条打开 record 文件读元信息。磁盘上没有任何 record 级
// 索引(cacheslist 只存桶名),所以这笔账无法通过分桶规避。Chromium 有持久化索引,故不受影响。
// 成本 ≈ 每文件 I/O × 文件数(15.8s / 21307 ≈ 0.74ms/条,正好是冷态闪存随机读的区间);
// 扫描时 `if (recordName.endsWith(blobSuffix)) continue;` 跳过大 body 实体,故**与总字节无关**
// —— 压缩素材体积没用,唯一的杠杆是**降条目数**。
//
// 【那这两个桶为什么还留着】拆桶本身无害(代码桶小、语义也更清楚),而合回去要动读写两端、
// 且会让用户重下代码 —— 收益为零、风险不为零,故保留现状。真正的解法是让素材不再以
// 「一个文件一条记录」的形式进 Cache Storage(打包成少量大文件),那是另一件事。
// 参见 TROUBLESHOOTING 的冷启动章节。
//
// 【素材桶为什么沿用旧名】换名等于用户下过的 1GB 立绘/语音全部作废重下。代码桶是新名,
// 用户只重下约 27MB 代码,素材一个字节都不碰。
// 【旧桶里那份代码副本不清】它现在是约 27MB 死重,但启动路径已经不查它了,而 633 次
// cache.delete 打在 14993 条的大桶上本身就是一次昂贵操作 —— 省下来的收益抵不上风险。
const CODE_CACHE = "noname-code-v1";
const ASSET_CACHE = "noname-pwa-v2";

// —— 素材仓库(IndexedDB):治病因七的那一刀 ——
// 【为什么用 importScripts 而不是 import】register("./pwa-sw.js") 没带 { type: "module" },
// 这是个 classic worker,ESM import 语法直接是语法错误、整个 SW 装不上。改 type 会让
// 老浏览器/老注册记录出问题,不值当,故用 classic 的 importScripts。
// 【为什么放在顶层而不是懒加载】它只是几个函数定义,解析成本微秒级;而 fetch 事件里
// 用得到,懒加载反而要处理"还没加载完就来请求"的竞态。
// 【失败必须吞掉】importScripts 抛异常会让整个 SW 装不上 → 全站白屏。素材库只是加速层,
// 读不到就回退 Cache Storage,绝不能因为它挂了把主路径带走。
let assetDBReady = false;
try {
	importScripts("./pwa-asset-db.js");
	assetDBReady = typeof readAsset === "function";
} catch (e) {
	console.warn("[pwa-sw] 素材库加载失败,回退纯 Cache Storage:", e);
}

// 【记忆化 caches.open:一次 SW 生命周期只开一次,不是每个请求开一次】
// 原来三处分支(导航 / 清单 / 主分支)各自 `await caches.open(CACHE)`,等于每个 fetch 事件
// 都开一遍。open 本身不是零成本(见上),700 次 × 大桶 = 纯浪费。
let codeCachePromise = null;
let assetCachePromise = null;
const openCode = () => (codeCachePromise ||= caches.open(CODE_CACHE));
const openAsset = () => (assetCachePromise ||= caches.open(ASSET_CACHE));

// 缓存里记录"这批代码是哪个构建的"用的 key(不是真实资源,只存一个戳)
const BUILD_KEY = "/__pwa_build__";
// install 时没装成的文件清单。只有名列其中的代码文件才需要在 fetch 时走网络补齐——
// 不能因为一个文件失败就让全部 622 个代码文件降级走网络(那才是真的拖慢启动)。
const STALE_KEY = "/__pwa_stale__";

// 本体代码文件:必须**整版原子一致**,不能逐文件更新。
// 【为什么】产物文件名不带 hash(index4.js 永远叫 index4.js),而 vite 的 _virtual chunk
// 编号会随依赖图变化漂移——同一个 index4.js,上一版可能是别的模块、导出别的字母,这一版
// 是 crypto-js、导出 `c`。逐文件 SWR 更新必然让缓存里新旧混搭,而 ES 模块图是整体链接的,
// 于是新 entry.js 向旧 index4.js 要 `{ c }` → 拿不到 →
// "SyntaxError: importing binding name 'c' is not found",行列号 0
// (module link 阶段的错,不属于任何一行)。重启越多混得越花,永远不会自愈。
const CODE_EXT = /\.(js|mjs|ts|css|html|json|webmanifest)$/i;
// 只认 install 会整版装齐的那批目录(= pwa-core-assets.json 的管辖范围)。
// 【为什么要限定目录】/extension/ 下有 164 个内置扩展 js,它们在"可下载清单"里、
// install 不会装 → BUILD_KEY 代表不了它们 → 若也判为代码,换版后每次启动都要重新
// 联网取一遍(在线白费流量、离线更慢),而扩展是各自独立加载的,本就不存在跨 chunk
// 绑定问题。核心目录清单与 scripts/build.ts 的 coreDirs 保持一致。
// 【必须锚定在路径开头】用 includes 会误伤:/extension/3D精选/character/skill.js 里含
// "/character/",一度让 131 个内置扩展 js 被判成本体代码。SW 挂在站点根,故一级目录
// 就是 pathname 的第一段。
const CODE_DIRS = ["noname", "_virtual", "node_modules", "layout", "theme", "game", "mode", "card", "character"];
function isCodeAsset(pathname) {
	if (!CODE_EXT.test(pathname)) return false;
	const rel = pathname.replace(/^\/+/, "");
	const slash = rel.indexOf("/");
	// 根目录一层的散文件(noname.js、jit-test.ts、service-worker.js、index.html 等)也算
	if (slash === -1) return true;
	return CODE_DIRS.includes(rel.slice(0, slash));
}

// —— 分桶的判据:「在不在核心清单里」,而不是 isCodeAsset ——
//
// 【上一版拆桶为什么没治好】把桶拆开时,我拿 isCodeAsset 兼当了分桶判据。但这是两个
// **不同的问题**,当时混成了一个:
//   · isCodeAsset 回答的是"这文件必须整版原子一致吗" —— 只有可执行代码才有跨 chunk
//     绑定问题,所以它按扩展名筛,.png/.jpg/.woff2 一律为 false。这个语义是对的,不动。
//   · 分桶要回答的是"这文件在启动路径上吗" —— 与它是不是代码毫无关系。
// 于是核心清单 726 条里有 103 条(11 张 splash、ol_bg、卡背手牌框、theme/style 下 62 张
// CSS 背景图、2 个基础字体…)被判成"素材",**每次冷启动照样去开那个上万条的大桶**。
// 等于把代码挪走了,却把"必然触发打开大桶"的触发器原地留下 —— 实测症状完全对得上:
// 只缓存核心时快(大桶里才 103 条),下到 8000 多个素材就又慢了(大桶跟着涨)。
//
// 【为什么改用核心清单做判据】它就是"启动+标准对局要用什么"的唯一事实源,由 build.ts
// 生成、install 整批装齐,天然与分桶要问的问题同构。实测两个方向都零误判:
//   · 核心清单 726 条 → 全部进 boot 桶(原来只有 623 条)
//   · 全量清单 14352 条 → 落进 boot 桶的 0 条
// (对比:若改成"CODE_DIRS 下不看扩展名",会把 heavy 里 3 条误吸进来 —— 仍不如清单精确。)
let bootSetPromise = null;
function getBootSet() {
	if (!bootSetPromise) {
		bootSetPromise = (async () => {
			try {
				// 清单自己也在自己的清单里(见 build.ts),故 install 装齐后必在 boot 桶。
				const cache = await openCode();
				const r = (await cache.match("./pwa-core-assets.json")) || (await cache.match("/pwa-core-assets.json"));
				if (!r) return null;
				const list = await r.json();
				if (!Array.isArray(list) || !list.length) return null;
				return new Set(list.map(p => new URL(p, self.location.href).pathname));
			} catch {
				return null;
			}
		})();
	}
	return bootSetPromise;
}

/**
 * 这个请求该走 boot 桶(小、启动路径)还是素材大桶?
 * 【读不到清单时退回 isCodeAsset】那是上一版的行为,至少保证代码仍在小桶里,不会更差。
 */
async function isBootAsset(pathname) {
	const set = await getBootSet();
	if (!set) return isCodeAsset(pathname);
	return set.has(pathname);
}

// 这些运行期动态接口即使残留也绝不缓存(纯静态部署下不存在,双保险)
const BYPASS = ["/checkFile", "/checkDir", "/readFile", "/readFileAsText", "/writeFile", "/removeFile", "/getFileList", "/createDir", "/removeDir"];

// 【线上必然 404 的启动期请求:一个网络往返都不发】
// 实测 12 次冷启动,这几个 100% 出现、100% 失败,而且都串在 boot 的 await 链上:
//   /vue            —— entry.ts 的 `import "vue/dist/vue.esm-browser.js"` 之外,还有个废弃兼容层
//                      game/vue.esm-browser.js 写着 `export * from "vue"`。裸说明符只有主文档的
//                      importmap 认得,一旦从别的上下文(iframe/worker)解析就退化成 /vue → 404。
//   /preload.js     —— entry.ts:14 `await import("/preload.js")` 是**故意**要它失败的:catch 里才
//                      分派 browser/cordova/node 平台入口。文件永远不存在,失败是正常流程。
//   /noname.config.txt —— init/index.ts:843 `checkFile("noname.config.txt")` 探测有没有导入配置,
//                      没有才是常态。
//   /theme/style/card —— library/index.js:2463 `lib.init.css(assetURL+"theme/style/card", ...)`,
//                      拼出来指向的是**目录**而不是文件。
// 在线时它们只是各浪费一个 404 往返(几十毫秒);离线时每个都要等满 missTimeoutMs 的
// 4 秒(script/document 档),而且是串行的 —— 这就是离线冷启动那十几秒白屏的主要来源,
// 跟"重下 35MB"是两回事(离线一个字节都不下,那条解释在离线场景下不成立)。
// 【为什么不能靠 looksOffline 兜住】那个要连续失败 3 次才判定离线,而学费恰好由启动链
// 最前面这几个交 —— 等它生效,12 秒已经烧完了。
// 【为什么直接返 404 而不是 Response.error()】它们的消费方都按"文件不存在"处理:
// import() 靠 catch 分派平台、checkFile 靠非 200 返 -1。给个干净的 404 语义最贴近真相,
// 也不会像带文本 body 的响应那样被当 JS 模块解析(那会引出 importing binding 之类的 link 错)。
const ALWAYS_404 = ["/vue", "/preload.js", "/noname.config.txt", "/theme/style/card"];

// Safari/WebKit 断网时 fetch() 不像 Chromium 那样立即 reject,
// 而是长时间 pending 甚至永远不返回。给所有 SW 内的 fetch 加超时保护,
// 超时后 abort → reject → 走缓存/504 兜底,避免白屏卡死。
function fetchSafe(input, init, ms = 2000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	const signal = init?.signal
		? init.signal  // 外部已有 signal 则不覆盖
		: controller.signal;
	return fetch(input, { ...init, signal })
		.then(r => { clearTimeout(timer); return r; })
		.catch(e => { clearTimeout(timer); throw e; });
}

// —— 离线启发式(纯内存、无持久状态)——
// 断网时最贵的开销不是"某个请求挂死",而是"几百个注定失败的请求各等满超时",SW 是单线程事件
// 循环,排起来轻松几十秒 → 撞 boot 的 30s 看门狗。
// 故:连续 OFFLINE_STREAK 个网络请求全失败 → 判定"疑似离线",此后 miss 直接快失败、hit 分支
// 也不再发后台 revalidate;任何一次成功立即复位。
// 【为什么这不违反"不用状态标记"的历史教训】那条针对的是"正在下载"这类**必须跨 SW 重启存活**
// 的状态(iOS 杀 SW 后 flag 丢失 → 误杀下载)。这里是**可随时重新探测的缓存**:SW 被杀重启后
// streak 归零,最多是多花几个请求重新学一遍,正确性不受影响。也不依赖 navigator.onLine
// (standalone 飞行模式下它仍报 true,已证不可靠)。
let failStreak = 0;
const OFFLINE_STREAK = 3;
const looksOffline = () => failStreak >= OFFLINE_STREAK;
function noteNetResult(ok) {
	if (ok) failStreak = 0;
	else if (failStreak < OFFLINE_STREAK) failStreak++;
}

// —— 素材后台校验的开窗:每个构建只开一次,不是每次冷启动都开 ——
// 【病】命中缓存的素材原来一律发一个后台 fetch 问"变了没"。实测每次冷启动稳定 12 个这样的
// 请求(icon/ol_bg/卡背/手牌框/花体字/splash/BGM),而且**下载得越全,这种请求越多**——
// 它的触发条件恰恰是"缓存命中"。代价:在线 12 个 304 往返(零字节但占满 SW 单线程),
// 离线 12 个各等满 missTimeoutMs,iOS 还会因此弹「蜂窝数据已关闭」。
// 【关键认识】素材只有在"又部署了一版"时才可能变。而换版必然伴随一次 install(SW 字节变了),
// 那一次也必然在线(清单都是网络取的)。所以校验只需要跟着 install 走一次,不需要每次启动重来。
// 【为什么用内存标记而不落盘】它不需要跨 SW 重启存活:SW 被回收后窗口自然关闭,而"窗口关着"
// 正是我们想要的快路径;下次真换版又会有新的 install 重新开窗。这跟"下载中"那种必须持久化的
// 状态不同(丢了会误杀下载),这里丢了只是更快,没有正确性损失。
// 【代码文件不受影响】代码永不逐文件 SWR(见 fetch 分支说明),整版由 install 换。
let assetRevalidateWindow = false;

// 决定"未命中缓存的请求"该用多长超时(0=不超时)。
// 【关键教训】不能靠 navigator.onLine 判离线:iOS 主屏 PWA 飞行模式下 onLine 常仍报 true,
// 导致超时档失效→走无超时 fetch→WebKit 断网永久 pending→boot 的 await 挂死→30s 白屏(standalone 白屏真凶)。
// 故 miss 一律给超时(不看 onLine)。命中缓存的请求根本不走这里(hit 分支秒返回),只有真未命中才 fetch,
// 给超时快失败无害;下载器(no-cache)豁免不误杀。代价:在线极慢网的未命中请求也会被超时,可接受。
function missTimeoutMs(req) {
	if (req.cache === "no-cache") return 0; // 下载离线资源:绝不超时(不误杀批量下载)
	switch (req.destination) {
		case "script":
		case "style":
		case "document":
		case "font":
			return 4000; // 启动关键资源:未命中 4s 快失败,让启动继续,不卡 30s 看门狗
		default:
			// XHR / .ts JIT源 / import 子资源(destination="") / 图片 / 音频等:8s 快失败
			return 8000;
	}
}

// iOS Safari 禁止 Service Worker 返回"经过重定向的响应"(response.redirected=true),
// 否则整页报错 "Response served by service worker has redirections" 白屏。
// CF Workers Static Assets 会把 /index.html 307 重定向到 /,故必须把这类响应"洗白"
// (用响应体重建一个 redirected=false 的干净副本)后再缓存/返回。
async function sanitizeResponse(resp) {
	if (!resp || !resp.redirected) return resp;
	const body = await resp.blob();
	return new Response(body, {
		status: resp.status,
		statusText: resp.statusText,
		headers: resp.headers,
	});
}

self.addEventListener("install", event => {
	// 换版了(SW 字节变了才会走 install)→ 给素材开一次后台校验窗口,让更新过的立绘/语音能刷新。
	// 之后的每次冷启动窗口都是关的,一个素材校验请求都不发(见 assetRevalidateWindow 处说明)。
	assetRevalidateWindow = true;
	// install 阶段预缓存"启动+标准对局必需"的核心文件(约 33MB,清单由构建生成)。
	// 保证断网时也能稳定启动、进模式、玩标准局。失败不阻塞安装(降级为访问即缓存)。
	// 注:保持简单快速——曾加"重试3轮+对账709项"导致 install 变慢/在 Safari 上迟迟装不上,
	//     反而让离线失败(回归),故回退到简单版。预缓存完整性靠 fetch 事件的访问即缓存兜底。
	//
	// 【本次新增:代码整版换新】SW 文件带构建戳后,每次部署浏览器都会走一遍 install。
	// 这里就是换版的唯一时机:把整份核心清单用 cache:"reload" 全量重下,一次装齐同一构建的
	// 全部代码文件,从根上排除跨版本 chunk 混搭(见文件头 isCodeAsset 处的说明)。
	// 素材(立绘/语音)不在核心清单里,一个都不会被碰,用户下过的 1GB 完整保留。
	event.waitUntil(
		(async () => {
			try {
				const resp = await fetch("./pwa-core-assets.json", { cache: "no-cache" });
				if (!resp.ok) throw new Error("核心清单获取失败 " + resp.status);
				const list = await resp.json();
				// 核心清单里绝大多数是代码,但也夹着少量启动路径上的小素材(splash/图标/ol_bg/
				// 卡牌框/基础字体)。按 isCodeAsset 分流写进对应的桶 —— 判据必须和 fetch 读取端
				// 完全一致,否则写进 A 桶、从 B 桶找,等于没缓存。
				const codeCache = await openCode();
				const assetCache = await openAsset();
				// install 装的就是核心清单本身 → 整份都归 boot 桶,不必再逐个判。
				// 【为什么不能用 isBootAsset】它要读缓存里的清单,而这会儿清单正在被装;
				// 更重要的是语义上根本不需要:list 就是核心清单,定义上全是 boot 资源。
				const cacheFor = () => codeCache;
				// 分批下载,避免一次性数百请求压垮 iOS;单批失败不影响其余。
				// 用 fetch+sanitize 而非 cache.add,以便洗白重定向响应(iOS 不接受 redirected 缓存)。
				// cache:"reload" 绕开浏览器 HTTP 缓存,确保拿到的是当前构建的真实内容而不是
				// 上一版的副本——否则换版会换成旧字节,等于没换。
				const BATCH = 50;
				let ok = 0;
				/** 没装成的代码文件:只有这些需要在 fetch 时走网络补齐 */
				const missed = [];
				for (let i = 0; i < list.length; i += BATCH) {
					const batch = list.slice(i, i + BATCH);
					const rs = await Promise.allSettled(
						batch.map(async url => {
							const r = await fetch(url, { cache: "reload" });
							if (r && r.status === 200) {
								const cache = cacheFor(url);
								const clean = await sanitizeResponse(r.clone());
								await cache.put(url, clean);
								// 【首页必须把导航分支的每个读取 key 都写一遍】
								// 导航分支按 req(通常 "/")→ "/" → "/index.html" → "./index.html"
								// 顺序匹配,谁先命中用谁;而清单里写的是 "./index.html" —— 排在最后。
								// 只写它等于白写:任何一个更早匹配的旧 key 都会把新首页挡住,于是
								// install 明明用 cache:"reload" 取回了新首页,页面还在跑旧的。
								// 后果:改 index.html 的修复反复冷启动多少次都不生效,而"启动就报错"
								// 这类故障正是要靠 index.html 里的自修复来救 —— 修复代码永远到不了用户手里。
								if (/index\.html$/.test(url)) {
									const buf = await (await sanitizeResponse(r.clone())).arrayBuffer();
									const mk = () => new Response(buf, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
									await Promise.all([cache.put("/", mk()), cache.put("/index.html", mk())]);
								}
								return true;
							}
							throw new Error("预缓存失败 " + url);
						})
					);
					rs.forEach((r, k) => {
						if (r.status === "fulfilled") ok++;
						else missed.push(batch[k]);
					});
				}
				// 【重试一轮没装成的】网络抖一下就让几百个文件永久走 Network-First 太亏,
				// 而失败往往是瞬时的。只重试缺的那几个,代价极小、成功率很高。
				if (missed.length) {
					console.warn(`[pwa-sw] 预缓存缺 ${missed.length} 个,重试一轮`);
					const retry = await Promise.allSettled(
						missed.map(async url => {
							const r = await fetch(url, { cache: "reload" });
							if (r && r.status === 200) {
								const cache = cacheFor(url);
								await cache.put(url, await sanitizeResponse(r.clone()));
								// 同上:首页要把导航分支的每个读取 key 都写一遍
								if (/index\.html$/.test(url)) {
									const buf = await (await sanitizeResponse(r.clone())).arrayBuffer();
									const mk = () => new Response(buf, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
									await Promise.all([cache.put("/", mk()), cache.put("/index.html", mk())]);
								}
								return url;
							}
							throw new Error("重试仍失败 " + url);
						})
					);
					const fixed = new Set(retry.filter(r => r.status === "fulfilled").map(r => r.value));
					ok += fixed.size;
					for (let i = missed.length - 1; i >= 0; i--) {
						if (fixed.has(missed[i])) missed.splice(i, 1);
					}
				}
				// 装齐了 → 记下构建戳,fetch 分支对代码文件走原来的 SWR(启动速度完全不变)。
				// 没装齐 → 只把「缺的那几个」记进 STALE_KEY,而不是让全部 622 个代码文件都走
				// 网络。这样最坏情况的代价正比于真实缺失量,不会因为一个文件失败就整体降级。
				// 两个 key 只描述"代码这一批是哪个构建的",归代码桶(getCodeState 也从代码桶读)
				await codeCache.put(BUILD_KEY, new Response(BUILD, { headers: { "Content-Type": "text/plain" } }));
				if (missed.length) {
					await codeCache.put(STALE_KEY, new Response(JSON.stringify(missed), { headers: { "Content-Type": "application/json" } }));
					console.warn(`[pwa-sw] 核心预缓存 ${ok}/${list.length},仍缺 ${missed.length} 个,这些将走 Network-First`);
				} else {
					await codeCache.delete(STALE_KEY);
					console.log(`[pwa-sw] 核心已整版就绪 build=${BUILD}(${ok}/${list.length})`);
				}
				// 【必须失效内存缓存】getCodeState 只查一次 Cache Storage。install 期间若已有
				// fetch 事件问过它(那时还没写 BUILD_KEY),内存里就存着 fresh:false,之后整个
				// SW 生命周期都会让代码文件走网络——白白拖慢启动。这里装完立刻清掉重算。
				codeStatePromise = null;
				// 同理:install 期间若已有 fetch 事件问过 getBootSet(那时清单还没装完,它返回 null →
				// 整个 SW 生命周期都退回 isCodeAsset,那 103 个启动期素材又会去开大桶)。装完立刻重算。
				bootSetPromise = null;
			} catch (e) {
				// 清单都没拿到(离线/CDN 抽风/iOS 把后台的 install 掐了)→ 这一版没换成。
				//
				// 【为什么不再 delete(BUILD_KEY)】原来这里是删戳,想的是"缓存来路不明,宁可慢也不能
				// 白屏"。但删戳的代价被严重低估了:getCodeState 返回 fresh:false → codeNeedsFreshFetch
				// 对**每个**代码文件都返回 true → 缓存里明明装着 625 个文件、一个不少,SW 也全部
				// 绕开它去联网重取。实测(持久化 profile,同一份完整缓存,只差这一个戳):
				//     戳在 → 首屏 1381ms / 打到网络 135 个 / 4.6MB
				//     戳丢 → 首屏 4231ms / 打到网络 462 个 / 35.2MB
				// 桌面千兆就 3 倍,手机 4G 上是 7~8 秒变 15 秒。
				// 更糟的是它**粘住不自愈**:戳只有下一次 install 完整成功才补得回来,而 install 只在
				// pwa-sw.js 字节变化(= 又部署一版)时才跑,中间每一次冷启动都在白烧几十 MB。
				// 而"手机弱网下 33MB 的全量 reload 被掐断"恰恰是常态,不是罕见分支。
				//
				// 【改成什么】戳保留,把整份清单记进 STALE_KEY —— 这条路 codeNeedsFreshFetch 本来
				// 就有(st.stale.has(pathname)),只是这个 catch 分支以前没走它。语义没变(该走网络的
				// 照样走网络),但它是**可收敛的**:fetch 分支每取到一个就从缺失名单里划掉,启动一次
				// 比一次快;而删戳是不可收敛的,永远从头再来。
				// 拿不到清单时退化成"全部都算 stale",与旧行为等价,不会更差。
				console.warn("[pwa-sw] 核心预缓存未完成:", e);
				try {
					const cache = await openCode();
					let all = [];
					try {
						// 【清单存在两个桶都要找】pwa-core-assets.json 走的是 Network-First 分支,
						// 由那里写进代码桶;而它自己**不在**核心清单里(build.ts 不收录自身),
						// 所以从没点过「下载离线资源」、且这次 install 又拿不到清单的用户,这里
						// 一定读到 null → 走下面的 else 把两个 key 全删 → 全部代码文件永久
						// Network-First(就是注释里那个首屏 1381ms→4231ms 的退化),而且**不自愈**。
						// 兜底再查素材桶:老版本 SW 可能把它写在那儿。
						const r = (await cache.match("./pwa-core-assets.json")) || (await cache.match("/pwa-core-assets.json")) || (await (await openAsset()).match("./pwa-core-assets.json"));
						if (r) all = await r.json();
					} catch {
						/* 清单读不到就留空 */
					}
					if (all.length) {
						await cache.put(BUILD_KEY, new Response(BUILD, { headers: { "Content-Type": "text/plain" } }));
						await cache.put(STALE_KEY, new Response(JSON.stringify(all), { headers: { "Content-Type": "application/json" } }));
					} else {
						// 连清单都没有 → 无从生成缺失名单,只能退回旧行为(全部 Network-First)
						await Promise.all([cache.delete(BUILD_KEY), cache.delete(STALE_KEY)]);
					}
				} catch {
					/* 缓存都开不了,交给下次 install */
				}
				codeStatePromise = null;
				// 同理:install 期间若已有 fetch 事件问过 getBootSet(那时清单还没装完,它返回 null →
				// 整个 SW 生命周期都退回 isCodeAsset,那 103 个启动期素材又会去开大桶)。装完立刻重算。
				bootSetPromise = null;
			}
			await self.skipWaiting();
		})()
	);
});

// 收到页面"检查更新"发来的 SKIP_WAITING → 立即接管,让新版生效(配合手动检查更新按钮)
self.addEventListener("message", event => {
	if (event.data && event.data.type === "SKIP_WAITING") {
		self.skipWaiting();
	}
});

self.addEventListener("activate", event => {
	event.waitUntil(
		(async () => {
			// 清理旧版本缓存。【两个桶都必须放行】漏掉 ASSET_CACHE 会把用户下过的 1GB
			// 立绘/语音直接删掉;漏掉 CODE_CACHE 则每次 activate 把刚装好的代码删光 → 白屏。
			const keys = await caches.keys();
			await Promise.all(keys.filter(k => k !== CODE_CACHE && k !== ASSET_CACHE).map(k => caches.delete(k)));
			await self.clients.claim();
		})()
	);
});

// 读一次缓存状态:这批代码是哪个构建的、哪些文件没装成。
// 结果缓存在内存里(只查一次 Cache Storage),避免几百个请求各查一遍拖慢启动。
// 返回 { fresh, stale:Set } —— fresh 为 false 时全部代码文件走网络;
// fresh 为 true 时只有 stale 里点名的那几个走网络,其余照旧 SWR(启动速度不变)。
let codeStatePromise = null;
// 同理:install 期间若已有 fetch 事件问过 getBootSet(那时清单还没装完,它返回 null →
// 整个 SW 生命周期都退回 isCodeAsset,那 103 个启动期素材又会去开大桶)。装完立刻重算。
bootSetPromise = null;
function getCodeState() {
	if (!codeStatePromise) {
		codeStatePromise = (async () => {
			try {
				const cache = await openCode();
				const rec = await cache.match(BUILD_KEY);
				if (!rec || (await rec.text()) !== BUILD) return { fresh: false, stale: null };
				const staleRec = await cache.match(STALE_KEY);
				if (!staleRec) return { fresh: true, stale: null };
				// 清单里存的是 "./noname/x.js",统一转成 pathname 比对
				const list = await staleRec.json();
				return { fresh: true, stale: new Set(list.map(p => new URL(p, self.location.href).pathname)) };
			} catch {
				return { fresh: false, stale: null };
			}
		})();
	}
	return codeStatePromise;
}

/** 这个代码文件需要绕开缓存去拿吗? */
async function codeNeedsFreshFetch(pathname) {
	const st = await getCodeState();
	if (!st.fresh) return true; // 整批代码来路不明 → 全部走网络
	if (!st.stale) return false; // 装齐了 → 一个都不用走
	return st.stale.has(pathname); // 只补 install 时真没装成的那几个
}

// 缺失名单收敛:fetch 分支每从网络取到一个 stale 文件,就把它划掉。
// 【为什么必须落盘而不只改内存】SW 进程空闲几十秒就被回收,内存里的 Set 一起没了;
// 不落盘的话每次冷启动都从原始名单重新开始,永远收敛不了(那就是旧的删戳行为)。
// 【为什么攒着批量写】一次冷启动可能划掉几百个,每个都 cache.put 一遍 JSON 等于把
// 单线程的 SW 堵死在写缓存上,反而拖慢启动。故只标记,延迟 3 秒合并写一次。
let staleFlushTimer = null;
function noteStaleResolved(pathname) {
	getCodeState().then(st => {
		if (!st.fresh || !st.stale || !st.stale.delete(pathname)) return;
		if (staleFlushTimer) return;
		staleFlushTimer = setTimeout(async () => {
			staleFlushTimer = null;
			try {
				const cache = await openCode();
				const cur = await getCodeState();
				if (!cur.fresh || !cur.stale) return;
				if (cur.stale.size) {
					await cache.put(STALE_KEY, new Response(JSON.stringify([...cur.stale]), { headers: { "Content-Type": "application/json" } }));
				} else {
					// 全部补齐 → 删掉名单,从此这一批代码走原来的纯缓存路径(启动速度回到最快)
					await cache.delete(STALE_KEY);
					console.log("[pwa-sw] 缺失的核心代码已全部补齐,恢复纯缓存启动");
				}
			} catch {
				/* 写不进去无所谓,下次启动继续收敛 */
			}
		}, 3000);
	});
}

self.addEventListener("fetch", event => {
	const req = event.request;

	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	// ===== 导航请求(打开/刷新页面)：Cache-First + 多 key 兜底 =====
	// Safari/WebKit 断网时 fetch() 不会立即 reject(不像 Chromium 秒失败),
	// 而是长时间 pending → 如果用 Network-First 会卡死白屏。
	// 所以导航也走 Cache-First(SWR):有缓存秒返回,后台静默更新;
	// 额外加多 key 匹配兜底,防 / vs /index.html 等 URL 差异导致 miss。
	if (req.mode === "navigate") {
		event.respondWith(
			(async () => {
				// index.html 属代码,放代码桶。但**必须兜底查一次旧的素材桶**:老用户升到这一版时,
				// 唯一那份首页还躺在旧桶里,新代码桶要等 install 装完才有 —— 中间那一瞬若读不到首页,
				// 离线打开就直接 504 白屏。旧桶只在新桶没命中时才查,装齐后这一路永远不走。
				const cache = await openCode();
				// 多 key 尝试:缓存里 URL 可能是 /、/index.html、./index.html 中的任一种
				const cached =
					(await cache.match(req)) ||
					(await cache.match("/")) ||
					(await cache.match("/index.html")) ||
					(await cache.match("./index.html")) ||
					(await (async () => {
						const old = await openAsset();
						return (await old.match(req)) || (await old.match("/")) || (await old.match("/index.html")) || (await old.match("./index.html"));
					})());

				// 后台静默网络更新(fetchSafe 带超时,Safari 断网不会永久挂)
				// 【必须把上面每个读取 key 都写一遍 —— 只写 req 等于永远读不到新首页】
				// 读取端按 req → "/" → "/index.html" → "./index.html" 顺序匹配,谁先命中用谁。
				// 原来只 cache.put(req, ...):若缓存里存在一个更早匹配的旧 key(常见,repair() 和
				// 历史版本都写过 "/"),那份旧首页会一直命中在前面,新写进去的永远排在它后面用不上。
				// 症状:改了 index.html 并部署后,反复冷启动多少次都还在跑旧首页 —— 表现得像
				// "缓存根本没更新",实际是更新写到了另一个 key 上。修 index.html 类故障(白屏、
				// 启动报错)时这一条是致命的:修复代码永远到不了用户手里。
				const bgUpdate = fetchSafe(req)
					.then(async resp => {
						if (resp && resp.status === 200) {
							const html = await sanitizeResponse(resp.clone());
							const buf = await html.arrayBuffer();
							const mk = () => new Response(buf, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
							await Promise.all([cache.put(req, mk()), cache.put("/", mk()), cache.put("/index.html", mk()), cache.put("./index.html", mk())]);
						}
						return resp;
					})
					.catch(() => null);

				if (cached) {
					// 【必须 waitUntil,不能写个裸表达式就走】原来这里是 `bgUpdate;` —— 一句什么都不做的
					// 表达式语句,只是"不 await"。问题在于响应一返回,这个 fetch 事件就算处理完了,
					// 浏览器随时可以回收 SW;而调用方恰恰常是 location.reload()(「检查更新」里点"现在刷新",
					// 或用户自己下拉刷新)—— 页面拆掉、SW 被回收,那次写入就这么没了。
					// 于是"本次给旧首页、同时把新的写回缓存"这个整个导航分支赖以成立的前提根本不保:
					// 新 index.html 一直写不进去,而版本戳是打死在 index.html 里的 → 用户点了刷新、
					// 重开一看戳还是老的(实测好几次都这样);index.html 里那套自修复同样永远到不了用户手里。
					// waitUntil 让 SW 至少活到这次写入完成,代价仅是一次几十 KB 的后台请求(带超时,不会挂死)。
					event.waitUntil(bgUpdate);
					return await sanitizeResponse(cached);
				}

				// 没缓存:只能等网络(首次访问必须联网)
				const fresh = await bgUpdate;
				if (fresh) return await sanitizeResponse(fresh);
				return new Response("离线且未缓存首页", { status: 504 });
			})()
		);
		return;
	}

	// 文件服务器接口:纯静态部署下不存在。SW 立即返回失败,避免离线时
	// browser.js 的 fetch('/checkFile'...) 干等网络超时导致启动白屏几十秒。
	// (返回 {success:false} 让 browser.js 秒判定为纯静态模式)
	if (BYPASS.some(p => url.pathname.endsWith(p) || url.pathname === p)) {
		event.respondWith(
			new Response('{"success":false,"code":404,"errorMsg":"static"}', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		);
		return;
	}

	// 线上必然不存在的启动期请求:直接 404,不碰网络也不碰缓存(见 ALWAYS_404 处说明)。
	// 放在 method 判断之前:checkFile 用的是 HEAD,而 HEAD 本来会被下面 `req.method !== "GET"`
	// 放行到网络、连 SW 的超时兜底都吃不到(browser.js:37 那 2 秒超时就是为此而加)。
	if (ALWAYS_404.includes(url.pathname)) {
		event.respondWith(new Response("", { status: 404, statusText: "Not Found" }));
		return;
	}

	// 其余只处理同源 GET
	if (req.method !== "GET") return;

	// pwa-version.json 和两个资源清单用 Network-First:必须拿到最新的,离线时 fallback 到缓存。
	// 【为什么清单也必须 Network-First】曾漏了清单,导致产物更新后"下载离线资源"界面长期显示
	// 旧总数(线上清单已 14294,界面仍报 14993),因为走默认 SWR 分支 → 命中旧缓存秒返回,新清单
	// 只在后台更新、下次打开才生效。下载器虽写了 `cache:"no-cache"`,但那只约束浏览器 HTTP 缓存,
	// 请求照样进 SW 被 Cache Storage 拦下 —— SW 里 no-cache 仅用于豁免超时(missTimeoutMs)。
	// 后果不只是数字难看:按旧清单下载会漏掉新增素材(新补的立绘照样是剪影)。
	if (url.pathname.endsWith("/pwa-version.json") || url.pathname.endsWith("/pwa-all-assets.json") || url.pathname.endsWith("/pwa-core-assets.json")) {
		event.respondWith(
			(async () => {
				// 清单/版本戳是 .json,isCodeAsset 判它为代码 → 放代码桶,与读取端一致。
				// 离线兜底再查一次旧素材桶:老用户升级前这几个文件躺在那儿。
				const cache = await openCode();
				// 【超时绝不能吃默认的 2 秒】pwa-all-assets.json 有 479KB,手机 4G 上 2 秒本来就未必够;
				// 更要命的是 install 正拿 cache:"reload" 重下 700 多个核心文件(约 30MB)时,SW 单线程
				// 被自己塞满,任何请求都轻易超过 2 秒。而带 no-cache 的调用方(下载器 / index.html 的
				// repair())都是用户点了按钮正在等、界面上还有进度条,该给足耐心;其余情况按 miss 的
				// 默认档 8 秒(与 missTimeoutMs 的兜底档一致)。
				const ms = req.cache === "no-cache" ? 20000 : 8000;
				try {
					const resp = await fetchSafe(req, undefined, ms);
					if (resp && resp.status === 200) {
						const clean = await sanitizeResponse(resp.clone());
						cache.put(req, clean);
					}
					return await sanitizeResponse(resp);
				} catch {
					const cached = (await cache.match(req)) || (await (await openAsset()).match(req));
					if (cached) return cached;
					// 【带 no-cache 的请求绝不能收到下面那个假空清单】它明说了"我要网络上的真相",
					// 而 repair() 给 URL 挂了一次性 bust 串 —— 缓存里必然未命中,于是只要网络抖一下
					// 超了时,它拿到的就是「status 200 + []」这么个合法响应,filter 完长度为 0 →
					// 抛「核心清单为空」→ 修复中止。每次都一样、永远修不好(实测连点几次全是它),
					// 而且报错还把人往"没联网"上引,真因是这个假 200。给它真实的失败状态:
					// repair() 会如实报「核心清单获取失败 504」,下载器走 coreResp.ok 的 [] 分支,都接得住。
					if (req.cache === "no-cache") {
						return new Response("离线且清单未缓存", { status: 504, statusText: "Offline" });
					}
					// 离线且无缓存:兜底体必须与消费方期待的类型一致 ——
					// 清单是数组(下载器 `[...new Set([...coreList, ...allList])]` 展开,给对象会抛 not iterable),
					// pwa-version.json 是对象。
					const empty = url.pathname.endsWith("assets.json") ? "[]" : "{}";
					return new Response(empty, { status: 200, headers: { "Content-Type": "application/json" } });
				}
			})()
		);
		return;
	}

	event.respondWith(
		(async () => {
			// 【这一行就是"下载完离线资源后启动慢 4~5 秒"的根】原来无论请求什么都去开那个
			// 代码+14000 素材混装的大桶,再在里面 match 一次。启动约 700 个请求,每个都这么来
			// 一遍 —— 桶里 730 条时快,14993 条时慢,而这全排在 SW 的单线程上。
			// 现在:代码请求只碰 ~633 条的代码桶,素材请求才碰大桶;而素材是图片/音频,
			// 不在 boot 的 await 链上,慢一点不阻塞启动。
			// 【分桶看"在不在核心清单里",不看是不是代码】见 isBootAsset 处说明:上一版拿
			// isCodeAsset 兼当分桶判据,导致 103 个启动期素材(splash/theme 背景/字体)仍然
			// 每次冷启动都去开上万条的大桶,拆桶的收益被这个触发器抵掉了。
			// 【素材优先查 IndexedDB —— 这是不碰 Cache Storage 的快路径】
			// 只有非代码文件走这里:代码仍住 Cache Storage(746 条,不构成病因七的成本),
			// 且它有整版原子一致的要求(BUILD_KEY/STALE_KEY 那套),搬走反而要重做一遍。
			// 【为什么放在 openCode/openAsset 之前】病因七的账是"第一次碰 Cache Storage"就付,
			// 排在后面就等于已经付过了、白查一趟。
			// 【下载器豁免】它带 cache:"no-cache",本意就是"给我网络上的真东西"用来填库,
			// 若在这里命中库就永远填不进新内容。
			if (assetDBReady && req.cache !== "no-cache" && !isCodeAsset(url.pathname)) {
				const fromDB = await readAsset(url.pathname);
				if (fromDB) return fromDB;
			}
			const isBoot = await isBootAsset(url.pathname);
			const cache = isBoot ? await openCode() : await openAsset();
			// 【boot 资源要兜底查一次大桶】老用户升到这一版时 boot 桶里还没有这 103 个素材
			// (要等 install 装完),而它们此前就躺在大桶里。这一瞬若离线,读不到就白屏/缺图。
			// 装齐后 cache.match 先命中,这一路不再走。
			const cached = (await cache.match(req)) || (isBoot ? await (await openAsset()).match(req) : null);
			// 「要不要整版原子一致」仍由 isCodeAsset 独立回答 —— 只有可执行代码才有跨 chunk
			// 绑定问题,那 103 个图片/字体进了 boot 桶也不该走 Network-First。
			const isCode = isCodeAsset(url.pathname);

			// 代码文件且缓存不是当前构建的 → 缓存里可能是跨版本混搭的 chunk,不能信。
			// 走 Network-First 现取现用(取到就写回),只有网络失败才退回旧缓存。
			// 【为什么不能像素材那样 SWR】SWR 会先把旧 chunk 返给页面,等模块图链接时才发现
			// 新旧绑定对不上,直接 SyntaxError 白屏——那时候后台更新到没到都救不了这一次启动。
			// 【为什么这不会拖慢正常启动】install 装齐后 BUILD_KEY 与 BUILD 相符,这个分支
			// 整个跳过,和以前完全一样;只有"刚换版且预缓存没装齐"这种少见情况才多花网络。
			// 【豁免下载器】下载器的请求带 cache:"no-cache",它只是在批量填缓存、不执行模块,
			// 不存在跨版本绑定问题;而这里的超时会掐断慢网下的批量补课(missTimeoutMs 特意
			// 对它返回 0 就是为了不超时),必须放它走原路。
			const codeNeedsNetwork = req.cache !== "no-cache" && isCode && !looksOffline() && (await codeNeedsFreshFetch(url.pathname));
			if (codeNeedsNetwork) {
				try {
					const resp = await fetchSafe(req, undefined, missTimeoutMs(req));
					noteNetResult(true);
					if (resp && resp.status === 200) {
						cache.put(req, await sanitizeResponse(resp.clone()));
						// 这个文件已经是当前构建的字节了 → 从缺失名单里划掉,下次启动它就不用再走网络。
						// 这样"install 没装完"的代价会一次比一次小,而不是永远从头再来。
						noteStaleResolved(url.pathname);
						return await sanitizeResponse(resp);
					}
				} catch {
					noteNetResult(false);
				}
				// 网络没拿到:有旧缓存也只能先用(离线可玩优先),没有则往下走未命中逻辑
				if (cached) return await sanitizeResponse(cached);
			}

			if (cached) {
				// 命中缓存:立即返回(离线可玩),后台静默更新。
				// 疑似离线时跳过 revalidate:否则冷启动会并发几百个注定失败的 fetch,把 SW 的
				// 单线程事件循环堵住,拖慢真正需要网络的请求(离线启动变慢的一大来源)。
				//
				// 【代码文件绝不后台改写 —— 混搭的真正源头就在这里】
				// 以前代码文件也走这个 revalidate:于是每次部署后,还没换版的旧 SW 会一边把旧字节
				// 喂给页面、一边把新构建的字节偷偷写进缓存,而 BUILD_KEY 仍写着旧戳。缓存就这样被
				// 自己搅成"一部分旧版 + 一部分新版",且**自称一致**。只要紧接着的 install 成功,
				// 全量 reload 会把它抹平,所以平时看不出来;但 install 没成那一次(SW 脚本请求失败/
				// iOS 掐后台/那次导航没触发更新检查),下次启动就直接从缓存喂混搭代码 →
				// 模块图链接失败 → "importing binding name 'c' is not found",行列号 0。
				// 而且此时联网也救不了:它认为自己一致,压根不去网络。
				// 故:代码文件只允许由 install 整版写入(cache:"reload" 全量),永不逐文件更新。
				// 顺带每次启动省掉 600+ 个无用的后台请求。
				//
				// 【素材:只在换版那一次校验,不是每次冷启动】原来这里对每个命中缓存的素材都发一个
				// 后台 fetch。实测每次冷启动固定 12 个(icon/ol_bg/卡背/花体字/splash/BGM),在线是
				// 12 个 304 往返、离线是 12 个等满超时 + iOS 弹「蜂窝数据已关闭」。而素材只可能在
				// 换版时变,换版必然有 install、install 必然在线 —— 跟着 install 开一次窗就够了。
				// 【为什么不能靠 looksOffline 兜】它要连续失败 3 次才判离线,前 3 个素材照样各等满
				// 超时;而且 ALWAYS_404 短路后那几个请求不再产生失败计数,streak 更涨不上去。
				if (assetRevalidateWindow && !looksOffline() && !isCode) {
					fetchSafe(req)
						.then(async resp => {
							noteNetResult(true);
							if (resp && resp.status === 200) {
								const clean = await sanitizeResponse(resp.clone());
								cache.put(req, clean);
							}
						})
						.catch(() => noteNetResult(false));
				}
				return await sanitizeResponse(cached);
			}

			// 未命中:按 missTimeoutMs 分档决定超时(0=不超时)。
			// 启动脚本断网未命中 → 快速失败(504)让启动继续,不再永久 pending 卡到 30s 弹"未正常载入"白屏;
			// 下载器/大素材 → 不超时,慢也该等。
			const ms = missTimeoutMs(req);
			// 疑似离线且不是下载器(no-cache 豁免)→ 一个网络往返都不发,直接快失败。
			// 这是离线启动从"分钟级"降到"秒级"的关键:省掉 N×4~8s 的排队等待。
			if (looksOffline() && ms > 0) {
				const d0 = req.destination;
				if (d0 === "script" || d0 === "style" || d0 === "document" || d0 === "font") return Response.error();
				return new Response("离线且资源未缓存", { status: 504, statusText: "Offline" });
			}
			try {
				const resp = ms > 0 ? await fetchSafe(req, undefined, ms) : await fetch(req);
				noteNetResult(true);
				if (resp && resp.status === 200) {
					const clean = await sanitizeResponse(resp.clone());
					cache.put(req, clean);
				}
				return await sanitizeResponse(resp);
			} catch {
				noteNetResult(false);
				// script/style/module 未命中失败时,绝不能返回带文本 body 的响应——
				// 浏览器会把 "离线且资源未缓存" 这段文本当 JS/CSS 模块解析,导致
				// "importing binding 'c' is not found" 之类的 link 错误。
				// 返回 Response.error()(网络错误)让它成为干净的"加载失败",触发正常错误处理。
				const d = req.destination;
				if (d === "script" || d === "style" || d === "document" || d === "font") {
					return Response.error();
				}
				return new Response("离线且资源未缓存", { status: 504, statusText: "Offline" });
			}
		})()
	);
});
