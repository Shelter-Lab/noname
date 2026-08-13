// 素材仓库(IndexedDB)—— 治「iOS 冷启动 15.8 秒」的那一刀
//
// 【为什么素材不能再放 Cache Storage】详见 TROUBLESHOOTING「病因七」。一句话:
// WebKit 的 caches.open() 会对该 origin 下**每个桶的每一条 record 文件**做一次
// 打开+读头(源码 CacheStorageManager::allCaches → readAllRecordInfos),磁盘上没有
// record 级索引,所以这笔账每次冷启动都要重付。实测 21307 条 × ≈0.74ms = 15.8 秒,
// 而且全部花在 SW 交出 index.html 之前(总 16.4s 里首页占 15.7s)。
// 关键:**账按 origin 算、跟条目数成正比、与总字节无关**(扫描跳过 -blob 实体)。
// 所以拆桶无效(已实测+源码双证)、压缩体积无效,唯一杠杆是**降条目数**。
//
// 【为什么选 IndexedDB 而不是「打包成大文件仍放 Cache Storage」】
// WebKit 的 IDB 后端是 SQLite:open 只开一个文件 + 读 schema 表,**不枚举记录**;
// 读一条走主键 B-tree,2~3 个页命中,与表里有 2 万条还是 200 万条基本无关。
// 而"打包"的前提是存储支持随机读 —— Cache Storage 存的是 Response,没有随机访问,
// 从 25MB 的包里取一张图得把流读到那个偏移,每次读都白费几 MB。Kiwix/Lumafield 那种
// pack 方案配的是 OPFS(File.slice() 是真随机读),不是 Cache Storage。
// 一素材一条既然就能解决,就不引入包格式这层复杂度,还保住了按素材增量更新。
//
// 【红线:只存 ArrayBuffer,绝不存 Blob】两个独立理由,任一条都足以否掉 Blob:
//  1. WebKit 下 IDB 里的 Blob 会**每个落成一个独立 .blob 文件**(SQLiteIDBBackingStore
//     走 BlobRecords/BlobFiles 表 + `<n>.blob` 文件)——等于把"万文件"问题原样搬过来,白干。
//     ArrayBuffer 才是直接 bindBlob 进 Records 表,仍是单个 .sqlite3。
//  2. iOS 存 Blob 有至今未修的损坏/写失败 bug:WebKit 235687、240216(均 NEW)、
//     188438(2018 标 FIXED 但 iOS 18.7 / 26.5.2 仍有新报告)。
// 代价:MIME 要自己存(ArrayBuffer 不携带类型),见 putAsset/readAsset。

const DB_NAME = "noname-assets";
const DB_VERSION = 1;
// 素材表:key = pathname(如 "/image/character/re_caocao.jpg"),value = { buf, mime, len }
const STORE = "assets";

let dbPromise = null;

/**
 * 打开(或首次创建)素材库。
 * 【记忆化】一次 SW/页面生命周期只 open 一次。这不是为了省那几毫秒,而是避免
 * 并发 open 撞上 versionchange 相互阻塞。
 */
function openAssetDB() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const rq = indexedDB.open(DB_NAME, DB_VERSION);
			rq.onupgradeneeded = () => {
				const db = rq.result;
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
			};
			rq.onsuccess = () => {
				const db = rq.result;
				// 【必须挂 onversionchange】另一个 tab/SW 升级版本时,不主动 close 会把它卡住,
				// 那边一直 onblocked、我们这边也拿不到新库。丢掉记忆化让下次重开。
				db.onversionchange = () => {
					try {
						db.close();
					} catch {}
					dbPromise = null;
				};
				resolve(db);
			};
			rq.onerror = () => {
				dbPromise = null; // 失败不要粘住,下次还能重试
				reject(rq.error);
			};
			// 被别的连接挡住:不 reject,等它让开(onsuccess 仍会来)。卡死也无所谓 ——
			// 调用方都有 try/catch 回退到 Cache Storage。
			rq.onblocked = () => {};
		});
	}
	return dbPromise;
}

/** 把 IDBRequest 包成 Promise(IDB 是事件式 API,全靠这个转换) */
function req(r) {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

/**
 * 读一条素材,拼成 Response 直接给浏览器。
 * @param {string} pathname
 * @param {Request} [request] 原始请求——用于处理 Range 请求头(音频/视频必须)
 * @returns {Promise<Response|null>} null = 库里没有(调用方回退 Cache Storage / 网络)
 */
async function readAsset(pathname, request) {
	try {
		const db = await openAssetDB();
		const rec = await req(db.transaction(STORE, "readonly").objectStore(STORE).get(pathname));
		if (!rec || !rec.buf) return null;
		// 【Content-Type 必须自己填】存的是裸 ArrayBuffer,不带类型。填错了图不显示、音频不播,
		// 而且 .js/.css 若类型不对会被浏览器拒绝执行 —— 所以 mime 是写入时一起存的,不在这里猜。
		const mime = rec.mime || "application/octet-stream";
		const total = rec.buf.byteLength;

		// 【Range 请求处理——Safari/WebKit 对媒体(audio/video)强制要求 206】
		// Safari 的 <audio>/<video> 发 Range 请求后如果收到 200(而非 206),会直接拒绝播放
		// (不报错、不触发 onerror,就是静默不播)。Chrome 宽容一些但行为也不稳定。
		// 见 TROUBLESHOOTING.md「mp3 走 <audio> 必须实现 Range/206」。
		const rangeHeader = request && request.headers.get("Range");
		if (rangeHeader) {
			// 解析 Range: bytes=START-END (END 可选)
			const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
			if (m) {
				const start = parseInt(m[1], 10);
				const end = m[2] ? parseInt(m[2], 10) : total - 1;
				// 越界检查
				if (start >= total) {
					return new Response("", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
				}
				const clampedEnd = Math.min(end, total - 1);
				const slice = rec.buf.slice(start, clampedEnd + 1);
				return new Response(slice, {
					status: 206,
					statusText: "Partial Content",
					headers: {
						"Content-Type": mime,
						"Content-Length": String(slice.byteLength),
						"Content-Range": `bytes ${start}-${clampedEnd}/${total}`,
						"Accept-Ranges": "bytes",
					},
				});
			}
		}

		// 非 Range 请求(或 Range 格式无法解析):返回完整内容,带上 Content-Length 和
		// Accept-Ranges 让浏览器知道后续可以发 Range。
		return new Response(rec.buf, {
			status: 200,
			headers: {
				"Content-Type": mime,
				"Content-Length": String(total),
				"Accept-Ranges": "bytes",
			},
		});
	} catch {
		return null; // 库坏了/开不了 → 当作没有,让调用方走原路,绝不因此白屏
	}
}

/** 写一条素材。value 存 { buf: ArrayBuffer, mime, len } */
async function putAsset(pathname, buf, mime) {
	const db = await openAssetDB();
	const tx = db.transaction(STORE, "readwrite");
	tx.objectStore(STORE).put({ buf, mime: mime || "application/octet-stream", len: buf.byteLength }, pathname);
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve(true);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error || new Error("事务被中止"));
	});
}

/**
 * 批量写。一个事务写一批,比逐条各开事务快得多。
 * @returns {Promise<{ok:number, failed:string[]}>} 失败的 pathname 列表(供重试)
 */
async function putAssets(items) {
	if (!items.length) return { ok: 0, failed: [] };
	const db = await openAssetDB();
	const tx = db.transaction(STORE, "readwrite");
	const store = tx.objectStore(STORE);
	const failed = [];
	let ok = 0;
	for (const it of items) {
		try {
			const r = store.put({ buf: it.buf, mime: it.mime || "application/octet-stream", len: it.buf.byteLength }, it.path);
			r.onerror = e => {
				// 【单条失败不能连坐整批】WebKit 287876 下 put 会间歇失败;默认行为是
				// 一条出错就 abort 整个事务,那这一批 50 个全丢。preventDefault 掉,
				// 只把这一条记进 failed 交给上层重试。
				failed.push(it.path);
				e.preventDefault();
				e.stopPropagation();
			};
			r.onsuccess = () => ok++;
		} catch {
			failed.push(it.path);
		}
	}
	return new Promise(resolve => {
		tx.oncomplete = () => resolve({ ok, failed });
		// 整个事务还是挂了(配额超限等)→ 这一批全算失败,让上层决定停还是重试
		tx.onerror = tx.onabort = () => resolve({ ok, failed: items.map(i => i.path) });
	});
}

// —— 基线:本地每个素材的内容哈希 ——
// 【它解决什么】素材键是 pathname,改了内容但路径不变时下载器判定"已有"就跳过,于是永远读旧字节
// (记录里没 ETag,发不出 If-None-Match,"校验"只能整个重下)。有了基线就能和构建产出的
// pwa-asset-hashes.json 逐条比对,精确算出变更集,一次 600KB 的清单下载换掉 1.4 万次往返。
// 【为什么存成一条记录而不是每条素材加个字段】IDB 取一条会把整条(含 buf)反序列化出来,
// 没法只读某个字段 —— 那样"读全部哈希"就等于把 1.16GB 素材全读一遍。存成单条映射则是 O(1)。
// 【为什么必须记"本地实际有什么"而不是直接存服务端清单】直接存服务端那份等于替 IDB 撒谎:
// 本地明明是旧字节,基线却声称与线上一致,之后永远 diff 不出差异。
const BASELINE_KEY = "__asset_baseline__";
// 保留键不是素材,必须从 keys/count/prune 里排除,否则会被当成"清单外的旧素材"删掉
const RESERVED_KEYS = new Set([BASELINE_KEY]);

/** 读基线 —— 返回 { path: hash } 映射;没有则 null */
async function getBaseline() {
	try {
		const db = await openAssetDB();
		const rec = await req(db.transaction(STORE, "readonly").objectStore(STORE).get(BASELINE_KEY));
		return rec && rec.map ? rec.map : null;
	} catch {
		return null;
	}
}

/** 写基线(整体覆盖) */
async function saveBaseline(map) {
	const db = await openAssetDB();
	const tx = db.transaction(STORE, "readwrite");
	tx.objectStore(STORE).put({ map }, BASELINE_KEY);
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve(true);
		tx.onerror = tx.onabort = () => reject(tx.error || new Error("基线写入失败"));
	});
}

/**
 * 不联网地算出本地基线:遍历所有素材,对字节做 SHA-256 取前 16 位。
 * 【为什么能对上构建时的哈希】存进来的就是 CF 上的原始字节 —— 下载器用的是
 * `await r.arrayBuffer()`,SW 那条路只在 resp.redirected 时重建 Response 且 body 原样搬,
 * 两处都不改字节。所以本地算的和构建时算的是同一个输入。
 * 【为什么用游标而不是 getAll】getAll 会把全部素材(可达 1.16GB)一次性装进内存;
 * 游标一条一条来,处理完即可回收,峰值只有一条。
 * @param {(done:number)=>void} [onProgress] 每处理 200 条回报一次
 * @returns {Promise<Record<string,string>>}
 */
async function computeBaseline(onProgress) {
	const db = await openAssetDB();
	// 先只取键(getAllKeys 不读值,很轻),再分批取值 —— 这是内存安全的关键。
	// 【为什么不能用游标一把撸】cursor.continue() 必须在 onsuccess 里同步调用,不能先 await
	// 哈希算完再推进(事务会在空转时自动提交)。若同步推到底、把哈希排成 Promise 链慢慢算,
	// 那 1.4 万个 buffer(可达 1.16GB)会被闭包同时按住 —— 直接 OOM。
	// 分批则峰值只有 BATCH 条,且每批一个短事务,不会长期占着事务。
	const allKeys = await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
	const keys = allKeys.filter(k => !RESERVED_KEYS.has(k));
	const map = {};
	const BATCH = 40;
	for (let i = 0; i < keys.length; i += BATCH) {
		const slice = keys.slice(i, i + BATCH);
		const tx = db.transaction(STORE, "readonly");
		const store = tx.objectStore(STORE);
		const recs = await Promise.all(slice.map(k => req(store.get(k)).catch(() => null)));
		for (let j = 0; j < slice.length; j++) {
			const buf = recs[j] && recs[j].buf;
			if (!buf) {
				continue;
			}
			const digest = await crypto.subtle.digest("SHA-256", buf);
			map[slice[j]] = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
		}
		// recs 这一批出了作用域即可回收
		if (onProgress) {
			onProgress(Math.min(i + BATCH, keys.length), keys.length);
		}
	}
	return map;
}

// 【打不开时返回 null,绝不返回空 Set / 0】空和"读不到"是完全不同的故障:
// 一个是"素材一张没下",另一个是 IDB 被禁用 / open 卡在 onblocked / 隐私模式 / 配额清空。
// 两者都报 0,上层就永远分不清 —— 实测已经在这上面栽过一次:「下载显示 15134 全部完成,
// 体检却说素材 0 个」,而 0 到底是真空还是读不到,当时无从判断,只能靠猜。
// 调用方必须显式处理 null(见 otherMenu 的 inspectCache / inspectAssets)。

/** 库里已有哪些 pathname —— 用 getAllKeys 一次取回,别逐条 get 探测。读不到返回 null */
async function getAssetKeys() {
	try {
		const db = await openAssetDB();
		const keys = await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
		return new Set(keys.filter(k => !RESERVED_KEYS.has(k)));
	} catch {
		return null;
	}
}

/** 库里有多少条(不含保留键)。读不到返回 null */
async function countAssets() {
	try {
		const db = await openAssetDB();
		const n = await req(db.transaction(STORE, "readonly").objectStore(STORE).count());
		const keys = await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
		return n - keys.filter(k => RESERVED_KEYS.has(k)).length;
	} catch {
		return null;
	}
}

/** 删掉清单里已不存在的条目(改名/下架的旧素材),返回删了几条 */
async function pruneAssets(validPathSet) {
	try {
		const db = await openAssetDB();
		const keys = await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
		// 【保留键必须排除】基线不在资源清单里,不排除就会被当成"清单外的旧素材"每次都删掉,
		// 于是基线永远建不起来、每次检查更新都要重算一遍。
		const dead = keys.filter(k => !validPathSet.has(k) && !RESERVED_KEYS.has(k));
		if (!dead.length) return 0;
		// 【★ 保险阀:要删掉一半以上就认定是 keep 集算错了,拒绝执行】
		// prune 的前提是"清单是唯一事实源",可一旦 validPathSet 因任何原因残缺
		// (清单请求拿到旧版本 / location 带了子路径导致 pathname 前缀不一致 /
		//  清单里的相对路径与入库时的键编码不一致),这里就会**把整库清空**,
		// 而调用方只会看到"下载离线资源需要重下 1.4 万个" —— 真正的故障被完全掩盖,
		// 更糟的是基线是保留键、删不掉,于是"基线声称本地有这些图、实际一张都没有",
		// 检查更新从此恒报"与线上一致"。实测就是这么发作的:素材 0 个而基线仍是满的。
		// 正常运维下 dead 只有几千条里的百分之几(改名/下架的历史残留),超过一半必是 bug。
		if (keys.length > 100 && dead.length > (keys.length - 1) * 0.5) {
			console.error(`[素材库] prune 拒绝执行:要删 ${dead.length}/${keys.length} 条(超过一半)。` + `几乎必然是资源清单不完整或路径键不一致,已跳过以免清空整库。`);
			return 0;
		}
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		for (const k of dead) store.delete(k);
		await new Promise(resolve => {
			tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
		});
		return dead.length;
	} catch {
		return 0;
	}
}

/** 按扩展名猜 MIME —— 写入时用它,读取时直接用存下来的值 */
const MIME_MAP = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	bmp: "image/bmp",
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
	wav: "audio/wav",
	m4a: "audio/mp4",
	mp4: "video/mp4",
	webm: "video/webm",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	eot: "application/vnd.ms-fontobject",
	json: "application/json",
	txt: "text/plain; charset=utf-8",
	md: "text/plain; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	html: "text/html; charset=utf-8",
	vue: "text/plain; charset=utf-8",
};

function guessMime(pathname, fallback) {
	// 【优先用服务器给的】它才是权威;猜只是兜底(比如 CF 不给某些扩展名的类型)
	if (fallback && fallback !== "application/octet-stream") return fallback;
	const m = /\.([a-z0-9]+)$/i.exec(pathname);
	const ext = m ? m[1].toLowerCase() : "";
	return MIME_MAP[ext] || fallback || "application/octet-stream";
}
