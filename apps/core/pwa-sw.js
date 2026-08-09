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

// 桶名保持固定,**不带构建戳**:带戳等于每次部署换新桶,用户辛苦下的 1GB 立绘/语音
// 全部作废重下,代价远大于收益。版本一致性用下面的"代码文件原子换版"解决。
const CACHE = "noname-pwa-v2";

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

// 这些运行期动态接口即使残留也绝不缓存(纯静态部署下不存在,双保险)
const BYPASS = ["/checkFile", "/checkDir", "/readFile", "/readFileAsText", "/writeFile", "/removeFile", "/getFileList", "/createDir", "/removeDir"];

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
				const cache = await caches.open(CACHE);
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
								await cache.put(url, await sanitizeResponse(r));
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
								await cache.put(url, await sanitizeResponse(r));
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
				await cache.put(BUILD_KEY, new Response(BUILD, { headers: { "Content-Type": "text/plain" } }));
				if (missed.length) {
					await cache.put(STALE_KEY, new Response(JSON.stringify(missed), { headers: { "Content-Type": "application/json" } }));
					console.warn(`[pwa-sw] 核心预缓存 ${ok}/${list.length},仍缺 ${missed.length} 个,这些将走 Network-First`);
				} else {
					await cache.delete(STALE_KEY);
					console.log(`[pwa-sw] 核心已整版就绪 build=${BUILD}(${ok}/${list.length})`);
				}
				// 【必须失效内存缓存】getCodeState 只查一次 Cache Storage。install 期间若已有
				// fetch 事件问过它(那时还没写 BUILD_KEY),内存里就存着 fresh:false,之后整个
				// SW 生命周期都会让代码文件走网络——白白拖慢启动。这里装完立刻清掉重算。
				codeStatePromise = null;
			} catch (e) {
				// 清单都没拿到(离线/CDN 抽风)→ 这一版一个文件都没换成。
				// 必须清掉构建戳,让代码文件全部走 Network-First:此时缓存里极可能是上一版的
				// 混搭状态,宁可慢也不能白屏。装齐的那次 install 会把戳补回来。
				console.warn("[pwa-sw] 核心预缓存未完成:", e);
				await caches
					.open(CACHE)
					.then(c => Promise.all([c.delete(BUILD_KEY), c.delete(STALE_KEY)]))
					.catch(() => {});
				codeStatePromise = null;
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
			// 清理旧版本缓存
			const keys = await caches.keys();
			await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
			await self.clients.claim();
		})()
	);
});

// 读一次缓存状态:这批代码是哪个构建的、哪些文件没装成。
// 结果缓存在内存里(只查一次 Cache Storage),避免几百个请求各查一遍拖慢启动。
// 返回 { fresh, stale:Set } —— fresh 为 false 时全部代码文件走网络;
// fresh 为 true 时只有 stale 里点名的那几个走网络,其余照旧 SWR(启动速度不变)。
let codeStatePromise = null;
function getCodeState() {
	if (!codeStatePromise) {
		codeStatePromise = (async () => {
			try {
				const cache = await caches.open(CACHE);
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
				const cache = await caches.open(CACHE);
				// 多 key 尝试:缓存里 URL 可能是 /、/index.html、./index.html 中的任一种
				const cached = await cache.match(req)
					|| await cache.match("/")
					|| await cache.match("/index.html")
					|| await cache.match("./index.html");

				// 后台静默网络更新(fetchSafe 带超时,Safari 断网不会永久挂)
				const bgUpdate = fetchSafe(req)
					.then(async resp => {
						if (resp && resp.status === 200) {
							cache.put(req, await sanitizeResponse(resp.clone()));
						}
						return resp;
					})
					.catch(() => null);

				if (cached) {
					bgUpdate; // 不 await,后台更新
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
				const cache = await caches.open(CACHE);
				try {
					const resp = await fetchSafe(req);
					if (resp && resp.status === 200) {
						const clean = await sanitizeResponse(resp.clone());
						cache.put(req, clean);
					}
					return await sanitizeResponse(resp);
				} catch {
					const cached = await cache.match(req);
					if (cached) return cached;
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
			const cache = await caches.open(CACHE);
			const cached = await cache.match(req);

			// 代码文件且缓存不是当前构建的 → 缓存里可能是跨版本混搭的 chunk,不能信。
			// 走 Network-First 现取现用(取到就写回),只有网络失败才退回旧缓存。
			// 【为什么不能像素材那样 SWR】SWR 会先把旧 chunk 返给页面,等模块图链接时才发现
			// 新旧绑定对不上,直接 SyntaxError 白屏——那时候后台更新到没到都救不了这一次启动。
			// 【为什么这不会拖慢正常启动】install 装齐后 BUILD_KEY 与 BUILD 相符,这个分支
			// 整个跳过,和以前完全一样;只有"刚换版且预缓存没装齐"这种少见情况才多花网络。
			// 【豁免下载器】下载器的请求带 cache:"no-cache",它只是在批量填缓存、不执行模块,
			// 不存在跨版本绑定问题;而这里的超时会掐断慢网下的批量补课(missTimeoutMs 特意
			// 对它返回 0 就是为了不超时),必须放它走原路。
			const codeNeedsNetwork = req.cache !== "no-cache" && isCodeAsset(url.pathname) && !looksOffline() && (await codeNeedsFreshFetch(url.pathname));
			if (codeNeedsNetwork) {
				try {
					const resp = await fetchSafe(req, undefined, missTimeoutMs(req));
					noteNetResult(true);
					if (resp && resp.status === 200) {
						cache.put(req, await sanitizeResponse(resp.clone()));
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
				if (!looksOffline()) {
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
