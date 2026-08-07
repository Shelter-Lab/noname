// 无名杀 PWA Service Worker —— 离线缓存
//
// 设计要点:
//  - 只缓存同源 GET 请求(游戏代码、素材、卡牌数据等)
//  - 策略 = Stale-While-Revalidate:命中缓存立即返回(离线可玩),同时后台更新
//  - 不碰 browser.js 用到的文件服务器接口(/checkFile 等)——纯静态部署下这些本就不存在
//  - 与官方 JIT 沙箱的 service-worker.js 互不干扰(文件名不同,且那个已被 index.html 主动注销)
//
// 海量动态文件(15000+)不适合预缓存清单,改为"访问即缓存":首次联网玩过的内容之后离线可复玩。

const CACHE = "noname-pwa-v2";

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

// 决定"未命中缓存的请求"该用多长超时(0=不超时)。用两个正交、无状态的请求级信号分档,
// 一个治断网启动白屏、一个保"下载离线资源"不被误杀,互不打架:
//  - 下载器 + 清单:唯一带 cache:"no-cache" 进 handler 的请求 → 绝不超时(避开历史坑:2s 误杀下载)
//  - 其余所有请求:确定离线(navigator.onLine===false)时都给超时快失败,避免 WebKit 断网 fetch 永久
//    pending 卡到 30s 白屏。启动关键资源(script/style/document/font)4s;其余(XHR/.ts JIT源/import 子资源
//    destination="" / image / audio)也给 8s——【关键】ffb5b66 曾把这些改成无超时(default:0),
//    正是它们断网永久 pending 导致 Safari 离线白屏回归。在线时给足时长避免误杀慢网/首访。
function missTimeoutMs(req) {
	if (req.cache === "no-cache") return 0;
	const offline = self.navigator && self.navigator.onLine === false;
	switch (req.destination) {
		case "script":
		case "style":
		case "document":
		case "font":
			return offline ? 4000 : 15000;
		default:
			// XHR/.ts/import子资源/图片/音频等:离线8s快失败(不永久pending),在线不限时
			return offline ? 8000 : 0;
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
	// install 阶段预缓存"启动+标准对局必需"的核心文件(约 32MB,清单由构建生成)。
	// 保证断网时也能稳定启动、进模式、玩标准局。失败不阻塞安装(降级为访问即缓存)。
	// 注:保持简单快速——曾加"重试3轮+对账709项"导致 install 变慢/在 Safari 上迟迟装不上,
	//     反而让离线失败(回归),故回退到简单版。预缓存完整性靠 fetch 事件的访问即缓存兜底。
	event.waitUntil(
		(async () => {
			try {
				const resp = await fetch("./pwa-core-assets.json", { cache: "no-cache" });
				if (!resp.ok) throw new Error("核心清单获取失败 " + resp.status);
				const list = await resp.json();
				const cache = await caches.open(CACHE);
				// 分批下载,避免一次性数百请求压垮 iOS;单批失败不影响其余。
				// 用 fetch+sanitize 而非 cache.add,以便洗白重定向响应(iOS 不接受 redirected 缓存)。
				const BATCH = 50;
				for (let i = 0; i < list.length; i += BATCH) {
					const batch = list.slice(i, i + BATCH);
					await Promise.allSettled(
						batch.map(async url => {
							const r = await fetch(url, { cache: "no-cache" });
							if (r && r.status === 200) await cache.put(url, await sanitizeResponse(r));
						})
					);
				}
			} catch (e) {
				// 预缓存失败不致命:后续靠 fetch 事件的访问即缓存兜底
				console.warn("[pwa-sw] 核心预缓存未完成:", e);
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

	// pwa-version.json 用 Network-First:检查更新时必须拿到最新版本号,
	// 离线时 fallback 到缓存(显示上次已知版本)。
	if (url.pathname.endsWith("/pwa-version.json")) {
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
					return cached || new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
				}
			})()
		);
		return;
	}

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			const cached = await cache.match(req);

			if (cached) {
				// 命中缓存:立即返回(离线可玩),后台静默更新。
				// 后台用 fetchSafe(短超时):Safari 断网挂住也无所谓,不阻塞。
				fetchSafe(req)
					.then(async resp => {
						if (resp && resp.status === 200) {
							const clean = await sanitizeResponse(resp.clone());
							cache.put(req, clean);
						}
					})
					.catch(() => {});
				return await sanitizeResponse(cached);
			}

			// 未命中:按 missTimeoutMs 分档决定超时(0=不超时)。
			// 启动脚本断网未命中 → 快速失败(504)让启动继续,不再永久 pending 卡到 30s 弹"未正常载入"白屏;
			// 下载器/大素材 → 不超时,慢也该等。
			const ms = missTimeoutMs(req);
			try {
				const resp = ms > 0 ? await fetchSafe(req, undefined, ms) : await fetch(req);
				if (resp && resp.status === 200) {
					const clean = await sanitizeResponse(resp.clone());
					cache.put(req, clean);
				}
				return await sanitizeResponse(resp);
			} catch {
				return new Response("离线且资源未缓存", { status: 504, statusText: "Offline" });
			}
		})()
	);
});
