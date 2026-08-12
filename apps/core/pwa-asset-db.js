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
 * @returns {Promise<Response|null>} null = 库里没有(调用方回退 Cache Storage / 网络)
 */
async function readAsset(pathname) {
	try {
		const db = await openAssetDB();
		const rec = await req(db.transaction(STORE, "readonly").objectStore(STORE).get(pathname));
		if (!rec || !rec.buf) return null;
		// 【Content-Type 必须自己填】存的是裸 ArrayBuffer,不带类型。填错了图不显示、音频不播,
		// 而且 .js/.css 若类型不对会被浏览器拒绝执行 —— 所以 mime 是写入时一起存的,不在这里猜。
		const headers = { "Content-Type": rec.mime || "application/octet-stream" };
		return new Response(rec.buf, { status: 200, headers });
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

/** 库里已有哪些 pathname —— 用 getAllKeys 一次取回,别逐条 get 探测 */
async function getAssetKeys() {
	try {
		const db = await openAssetDB();
		return new Set(await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys()));
	} catch {
		return new Set();
	}
}

/** 库里有多少条 */
async function countAssets() {
	try {
		const db = await openAssetDB();
		return await req(db.transaction(STORE, "readonly").objectStore(STORE).count());
	} catch {
		return 0;
	}
}

/** 删掉清单里已不存在的条目(改名/下架的旧素材),返回删了几条 */
async function pruneAssets(validPathSet) {
	try {
		const db = await openAssetDB();
		const keys = await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
		const dead = keys.filter(k => !validPathSet.has(k));
		if (!dead.length) return 0;
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
