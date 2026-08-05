// 无名杀 PWA Service Worker —— 离线缓存
//
// 设计要点:
//  - 只缓存同源 GET 请求(游戏代码、素材、卡牌数据等)
//  - 策略 = Stale-While-Revalidate:命中缓存立即返回(离线可玩),同时后台更新
//  - 不碰 browser.js 用到的文件服务器接口(/checkFile 等)——纯静态部署下这些本就不存在
//  - 与官方 JIT 沙箱的 service-worker.js 互不干扰(文件名不同,且那个已被 index.html 主动注销)
//
// 海量动态文件(15000+)不适合预缓存清单,改为"访问即缓存":首次联网玩过的内容之后离线可复玩。

const CACHE = "noname-pwa-v1";

// 这些运行期动态接口即使残留也绝不缓存(纯静态部署下不存在,双保险)
const BYPASS = ["/checkFile", "/checkDir", "/readFile", "/readFileAsText", "/writeFile", "/removeFile", "/getFileList", "/createDir", "/removeDir"];

self.addEventListener("install", event => {
	self.skipWaiting();
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
				.then(resp => {
					// 只缓存成功的完整响应(200)。不透明响应(跨源)已被上面过滤
					if (resp && resp.status === 200) {
						cache.put(req, resp.clone());
					}
					return resp;
				})
				.catch(() => null);

			// 命中缓存:立即返回(离线可玩),后台静默更新
			if (cached) {
				fetchAndUpdate;
				return cached;
			}

			// 未命中:等网络,拿到就返回(并已入缓存)
			const fresh = await fetchAndUpdate;
			if (fresh) return fresh;

			// 彻底失败(离线且没缓存过)
			return new Response("离线且资源未缓存", { status: 504, statusText: "Offline" });
		})()
	);
});
