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

	// 只处理同源 GET
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;
	if (BYPASS.some(p => url.pathname.endsWith(p))) return;

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);
			const cached = await cache.match(req);

			// 后台拉取并更新缓存
			const fetchAndUpdate = fetch(req)
				.then(async resp => {
					// 只缓存成功的完整响应(200)。不透明响应(跨源)已被上面过滤
					if (resp && resp.status === 200) {
						// 洗白重定向后再缓存(iOS 不接受 redirected 响应)
						const clean = await sanitizeResponse(resp.clone());
						cache.put(req, clean);
					}
					return resp;
				})
				.catch(() => null);

			// 命中缓存:立即返回(离线可玩),后台静默更新。
			// 缓存里的响应经 sanitize 过是干净的;仍兜底洗白一次防旧数据。
			if (cached) {
				fetchAndUpdate;
				return await sanitizeResponse(cached);
			}

			// 未命中:等网络,拿到就返回。返回给页面的也要洗白(否则 iOS 报 redirections)
			const fresh = await fetchAndUpdate;
			if (fresh) return await sanitizeResponse(fresh);

			// 彻底失败(离线且没缓存过)
			return new Response("离线且资源未缓存", { status: 504, statusText: "Offline" });
		})()
	);
});
