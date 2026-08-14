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

// 【为什么要第二张表存版本号】素材要能回答"我手上这份是哪一版",否则改了图但路径不变时
// 无从判断新旧(记录里没 ETag,发不出 If-None-Match)。历史上这份账放在**单独一条记录**
// (`__asset_baseline__`,14403 行挤在一个 value 里),于是"账"和"实物"成了两份能各自出错的
// 数据 —— 实测三种烂法全中:
//   ① 搬货不记账:素材写入有三个入口(下载器 / SW 访问即缓存 / SW 换版后台校验),
//      **一个都没记账**,于是"建立基线"之后新装或被覆盖的素材永久隐形;
//   ② 账活着实物没了:prune 把基线列为保留键删不掉,清空素材后账还声称有 14403 条;
//   ③ 读账失败被当成"账是空的",于是恒报"与线上一致"。
// 根治办法不是逐个补记账(靠自觉,已经忘了两处),而是**让写字节和写版本号变成同一个动作** ——
// 塞进 putAsset/putAssets 内部、同一个 IDB 事务。而这要求"批量读全部版本号"必须便宜,
// 单条大记录做不到(改一行要整条 800KB 读改写),所以拆成一张 path→sha 的小表。
// 收益:不再需要 getBaseline/saveBaseline/computeBaseline/updateBaseline 那一整套,净减代码。
const DB_NAME = "noname-assets";
const DB_VERSION = 2;
// 素材表:key = pathname(如 "/image/character/re_caocao.jpg"),value = { buf, mime, len }
const STORE = "assets";
// 版本表:key = 同一个 pathname,value = 该素材字节的 SHA-256 前 16 位十六进制。
// 每条 16 字节,getAll() 全取回来只有几百 KB —— 这是"能塞进 putAsset"的前提。
const VSTORE = "versions";

let dbPromise = null;

// 【为什么要存最后一个错误】这些读函数对外统一返回 null(“读不到”),
// 但“读不到”有十几种原因(被占住/版本升级失败/store 不存在/隐私模式禁用 IDB…),
// 先前就因为只能看到“打不开”而连猜了几轮。把真实错误存下来、在体检里报出去。
let lastError = null;

/** 最后一次失败的真实原因(供「检查更新」展示);从未失败过则 null */
function getLastDbError() {
	if (!lastError) {
		return null;
	}
	const e = lastError;
	return e.name ? e.name + ": " + (e.message || "") : String(e);
}

/**
 * 打开(或首次创建)素材库。
 * 【记忆化】一个 SW/页面生命周期只 open 一次。这不是为了省那几毫秒,而是避免
 * 并发 open 撞上 versionchange 相互阻塞。
 */
function openAssetDB() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const rq = indexedDB.open(DB_NAME, DB_VERSION);
			rq.onupgradeneeded = () => {
				// 【升级里只建表,绝不干重活】上一版把“把老基线 14403 行摄平进版本表”
				// 放在这里做 —— 那是个陷:versionchange 事务一旦因任何原因 abort
				// (配额/WebKit 的 IDB 间歇失败/写量太大),**整个 open 就失败**,
				// 而库仍停在 v1 —— 于是之后每次 open(v2) 都重跑同一个升级、都失败,
				// 变成**永久打不开**。建表本身是 O(1) 的,摄平改成事后惰性做
				// (migrateLegacyBaseline),它失败也只是“版本未知”,本地补算一遍就行。
				const db = rq.result;
				if (!db.objectStoreNames.contains(STORE)) {
					db.createObjectStore(STORE);
				}
				if (!db.objectStoreNames.contains(VSTORE)) {
					db.createObjectStore(VSTORE);
				}
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
				lastError = rq.error || new Error("indexedDB.open 失败");
				dbPromise = null; // 失败不要粘住,下次还能重试
				reject(lastError);
			};
			// 【被占住不能永久悬着】旧写法是空函数 + 注释“卡死也无所谓”—— 那是错的:
			// 调用方 await 的是这个记忆化 promise,它永不结束就是**整个素材库接口镀死**,
			// 而且 try/catch 接不到悬着的 promise。给它一个上限,如实报错。
			// (正常情况下对方的 onversionchange 会立刻 close,这个定时器根本不会到点。)
			rq.onblocked = () => {
				setTimeout(() => {
					if (rq.readyState === "done") {
						return;
					}
					lastError = new Error("素材库被另一个连接占住(onblocked),等待超时");
					dbPromise = null;
					reject(lastError);
				}, 8000);
			};
		});
	}
	return dbPromise;
}

/**
 * 把 v1 时代那条单 record 基线摄平进版本表(惰性、一次性)。
 * 用普通 readwrite 事务做 —— 失败不影响库可用性,最坏是“版本未知”。
 * @returns {Promise<number>} 摄平了几条
 */
async function migrateLegacyBaseline() {
	try {
		const db = await openAssetDB();
		const rec = await req(db.transaction(STORE, "readonly").objectStore(STORE).get(LEGACY_BASELINE_KEY));
		const map = rec && rec.map;
		if (!map) {
			return 0;
		}
		const paths = Object.keys(map);
		// 分批写,别把 14403 条塞进一个事务 —— 一旦 abort 就全白干
		const BATCH = 2000;
		for (let i = 0; i < paths.length; i += BATCH) {
			const tx = db.transaction(VSTORE, "readwrite");
			const vs = tx.objectStore(VSTORE);
			for (const path of paths.slice(i, i + BATCH)) {
				vs.put(map[path], path);
			}
			await new Promise(resolve => {
				tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
			});
		}
		// 摄平完把这条 800KB 的大记录删掉 —— 它同时也是 prune 的保留键,
		// 留着只会继续制造“账实不符”的可能。
		const txd = db.transaction(STORE, "readwrite");
		txd.objectStore(STORE).delete(LEGACY_BASELINE_KEY);
		await new Promise(resolve => {
			txd.oncomplete = txd.onerror = txd.onabort = () => resolve();
		});
		return paths.length;
	} catch (e) {
		lastError = e;
		return 0;
	}
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

/** 算内容版本号:SHA-256 取前 16 位十六进制(= 64 bit,1.4 万文件下碰撞概率约 5e-12) */
async function sha16(buf) {
	const digest = await crypto.subtle.digest("SHA-256", buf);
	return [...new Uint8Array(digest)]
		.map(b => b.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 16);
}

/**
 * 写一条素材。value 存 { buf: ArrayBuffer, mime, len },同时把版本号写进版本表。
 * 【两者必须同事务】这是整套机制的地基:不存在"只写字节不写版本号"这个选项,
 * 所以三个写入口(下载器 / SW 访问即缓存 / SW 换版后台校验)谁都不可能忘记记账。
 */
async function putAsset(pathname, buf, mime) {
	// 【哈希必须在开事务之前算完】crypto.subtle.digest 是异步的,而 IDB 事务在事件循环
	// 空转一轮就自动提交 —— 在事务里 await 会让事务提前关掉,之后的 put 全抛
	// TransactionInactiveError。
	const sha = await sha16(buf);
	const db = await openAssetDB();
	const tx = db.transaction([STORE, VSTORE], "readwrite");
	tx.objectStore(STORE).put({ buf, mime: mime || "application/octet-stream", len: buf.byteLength }, pathname);
	tx.objectStore(VSTORE).put(sha, pathname);
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
	// 哈希全部在开事务之前算完,理由同 putAsset(事务里 await 会让它提前提交)
	const shas = await Promise.all(items.map(it => sha16(it.buf)));
	const db = await openAssetDB();
	const tx = db.transaction([STORE, VSTORE], "readwrite");
	const store = tx.objectStore(STORE);
	const vstore = tx.objectStore(VSTORE);
	const failed = [];
	let ok = 0;
	for (let i = 0; i < items.length; i++) {
		const it = items[i];
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
			const rv = vstore.put(shas[i], it.path);
			rv.onerror = e => {
				e.preventDefault();
				e.stopPropagation();
			};
		} catch {
			failed.push(it.path);
		}
	}
	const result = await new Promise(resolve => {
		tx.oncomplete = () => resolve({ ok, failed });
		// 整个事务还是挂了(配额超限等)→ 这一批全算失败,让上层决定停还是重试
		tx.onerror = tx.onabort = () => resolve({ ok, failed: items.map(i => i.path) });
	});
	// 【字节写失败的,版本号也不能留下】IDB 单条失败不连坐,所以可能出现"版本号写进去了、
	// 字节没写进去" —— 那正是我们要消灭的谎言(账说新的、实物是旧的)。补一个事务删掉它们。
	if (result.failed.length) {
		try {
			const tx2 = db.transaction(VSTORE, "readwrite");
			const vs2 = tx2.objectStore(VSTORE);
			for (const path of result.failed) {
				vs2.delete(path);
			}
			await new Promise(resolve => {
				tx2.oncomplete = tx2.onerror = tx2.onabort = () => resolve();
			});
		} catch {
			/* 删不掉最坏是多报一次"有更新",不会造成"漏报" */
		}
	}
	return result;
}

// —— 版本表:本地每个素材的内容版本号 ——
// 【为什么需要它】素材的键是 pathname,改了内容但路径不变时,光看键无从判断新旧
// (记录里没 ETag,发不出 If-None-Match)。有了版本号就能和构建产出的
// pwa-asset-hashes.json 逐条比对,精确算出变更集 —— 一次 792KB 的清单下载
// 换掉 1.4 万次条件请求往返。
// 【为什么本地版本号必须来自"本地实际的字节"而不是直接抄服务端清单】抄清单等于替
// 素材库撒谎:本地明明是旧字节,版本表却声称与线上一致,之后永远 diff 不出差异。
// 写入路径(putAsset/putAssets)算的正是刚从网络拿到、即将入库的那份字节,天然满足。

// v1 时代那条单record基线的键。只在 v1→v2 迁移时用一次(摊平进版本表后删除)。
const LEGACY_BASELINE_KEY = "__asset_baseline__";
// 保留键不是素材,必须从 keys/count/prune 里排除。迁移后素材表里不该再有它,
// 但老库在迁移跑完前仍可能存在,故保留这层过滤。
const RESERVED_KEYS = new Set([LEGACY_BASELINE_KEY]);

/** 读全部版本号 —— 返回 { path: sha } 映射;读不到返回 null(≠空对象,见文件下方说明) */
async function getVersions() {
	try {
		const db = await openAssetDB();
		const read = async () => {
			const store = db.transaction(VSTORE, "readonly").objectStore(VSTORE);
			// 每条只是 16 字符的字符串,getAll 整取回来几百 KB —— 不像素材表那样有 1.16GB 的顾虑
			const [keys, values] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
			const map = {};
			for (let i = 0; i < keys.length; i++) {
				map[keys[i]] = values[i];
			}
			return map;
		};
		let map = await read();
		// 【空表时惰性摄平老基线】迁移故意不在 onupgradeneeded 里做(那里 abort 会让
		// 整个 open 永久失败),改成第一次真正读版本表时才做。失败也只是继续
		// "全部版本未知",本地补算一遍就行,库照样能读。
		if (!Object.keys(map).length) {
			if (await migrateLegacyBaseline()) {
				map = await read();
			}
		}
		return map;
	} catch (e) {
		lastError = e;
		return null;
	}
}
/**
 * 给"素材在库里但版本号未知"的那些补算版本号(纯本地,不联网)。
 * 只有两种来源:① v1 时代从没建过基线的老库;② 迁移时基线本身就缺的那些条目。
 * 正常写入路径不会产生未知版本 —— putAsset/putAssets 同事务就写好了。
 *
 * 【为什么分批而不是游标一把撸】cursor.continue() 必须在 onsuccess 里同步调用,不能先 await
 * 哈希算完再推进(事务会在空转时自动提交)。若同步推到底、把哈希排成 Promise 链慢慢算,
 * 那 1.4 万个 buffer(可达 1.16GB)会被闭包同时按住 —— 直接 OOM。
 * 分批则峰值只有 BATCH 条,且每批一个短事务,不会长期占着事务。
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<number>} 补了几条
 */
async function backfillVersions(onProgress) {
	const db = await openAssetDB();
	const known = (await getVersions()) || {};
	const allKeys = await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
	const keys = allKeys.filter(k => !RESERVED_KEYS.has(k) && !known[k]);
	const BATCH = 40;
	let done = 0;
	for (let i = 0; i < keys.length; i += BATCH) {
		const slice = keys.slice(i, i + BATCH);
		const recs = await Promise.all(slice.map(k => req(db.transaction(STORE, "readonly").objectStore(STORE).get(k)).catch(() => null)));
		const pairs = [];
		for (let j = 0; j < slice.length; j++) {
			const buf = recs[j] && recs[j].buf;
			if (buf) {
				pairs.push([slice[j], await sha16(buf)]);
			}
		}
		if (pairs.length) {
			const tx = db.transaction(VSTORE, "readwrite");
			const vs = tx.objectStore(VSTORE);
			for (const [path, sha] of pairs) {
				vs.put(sha, path);
			}
			await new Promise(resolve => {
				tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
			});
			done += pairs.length;
		}
		// recs 这一批出了作用域即可回收
		if (onProgress) {
			onProgress(Math.min(i + BATCH, keys.length), keys.length);
		}
	}
	return done;
}

// 【打不开时返回 null,绝不返回空 Set / 0】空和"读不到"是完全不同的故障:
// 一个是"素材一张没下",另一个是 IDB 被禁用 / open 卡在 onblocked / 隐私模式 / 配额清空。
// 两者都报 0,上层就永远分不清 —— 实测已经在这上面栽过一次:「下载显示 15134 全部完成,
// 体检却说素材 0 个」,而 0 到底是真空还是读不到,当时无从判断,只能靠猜。
// 调用方必须显式处理 null(见 otherMenu 的 inspectCache / inspectAssets)。

/**
 * 读一条素材的原始字节 + 存的 MIME。只给诊断用 ——
 * 它能现场重算本地字节的哈希,回答"我手上这份到底是不是新的",
 * 绕开"版本表是否可信"这个前提。读不到返回 null。
 */
async function getAssetRaw(pathname) {
	try {
		const db = await openAssetDB();
		const rec = await req(db.transaction(STORE, "readonly").objectStore(STORE).get(pathname));
		return rec && rec.buf ? { buf: rec.buf, mime: rec.mime, len: rec.len } : null;
	} catch (e) {
		lastError = e;
		return null;
	}
}

/** 库里已有哪些 pathname —— 用 getAllKeys 一次取回,别逐条 get 探测。读不到返回 null */
async function getAssetKeys() {
	try {
		const db = await openAssetDB();
		const keys = await req(db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys());
		return new Set(keys.filter(k => !RESERVED_KEYS.has(k)));
	} catch (e) {
		lastError = e;
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
	} catch (e) {
		lastError = e;
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
		// 【字节和版本号同事务一起删】漏删版本号会留下"版本表说有、素材表没有"
		// 的孤儿记录 —— 那正是 v1 撕裂状态的同一种形态，必须同事务消掉。
		const tx = db.transaction([STORE, VSTORE], "readwrite");
		const store = tx.objectStore(STORE);
		const vstore = tx.objectStore(VSTORE);
		for (const k of dead) {
			store.delete(k);
			vstore.delete(k);
		}
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
