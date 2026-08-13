import { rootURL, get, lib, game, _status, ui } from "noname";
import { LibInitPromises } from "./promises.js";
import { ContentCompiler } from "@/library/element/gameEvent.js";
import { security } from "@/util/sandbox.js";

export class LibInit {
	#promises;
	/**
	 * 部分函数的Promise版本
	 */
	get promises() {
		if (!this.#promises) this.#promises = new LibInitPromises();
		return this.#promises;
	}

	/**
	 * 一键下载离线资源:把 pwa-all-assets.json 列出的全部大素材(立绘/语音/扩展/花体字)
	 * 批量缓存到 Service Worker 的 Cache Storage,之后断网也能玩。
	 * - 跳过已缓存文件,支持中断后续传(再次点击从未缓存处继续)
	 * - 实时在按钮上显示进度;再次点击可暂停
	 * - 捕获配额超限(iOS 有上限),优雅停止并告知已缓存量
	 * @param {HTMLElement} button 触发的按钮元素(用于显示进度)
	 * @param {{ onlyList?: string[], silent?: boolean }} [options] onlyList:只下这些 URL 且**强制重下**
	 *   (用于「检查更新」比对内容哈希后精确补差异);silent:不弹结果框,由调用方自己报
	 * @returns {Promise<{ done:number, total:number, failed:string[], aborted:boolean, quota:boolean }|undefined>}
	 */
	async downloadOfflineAssets(button, options) {
		const setText = text => {
			if (button) button.innerHTML = `<span>${text}</span>`;
		};
		// 【forced 模式的两个必须】
		//  1. 不能按 cachedSet 过滤 —— 这些文件本来就在库里,要的正是"覆盖掉旧字节";
		//  2. **绝对不能 prune** —— prune 以传入清单为唯一事实源删掉清单外的条目,
		//     而这里传的是几十个差异文件,一 prune 就把另外一万多个素材全删了。
		const forced = options && Array.isArray(options.onlyList) ? options.onlyList.slice() : null;
		const silent = Boolean(options && options.silent);

		// 已在下载 → 再次点击视为暂停
		if (lib.init._offlineDownloading) {
			lib.init._offlineDownloadAbort = true;
			return;
		}
		// 不再用"完成标记"永久锁定:核对已改用 cache.keys() 批量比对(高效,不会白屏),
		// 每次点击都重新核对→只补缺失的文件(增量续传)。这样清单更新后(如新增 jit-test.ts)
		// 能"补课"下新文件,而已缓存的 1GB 素材不会重下。全在则秒提示"已完成"。
		if (!("caches" in window)) {
			alert("当前环境不支持离线缓存(Cache Storage 不可用)。");
			return;
		}

		lib.init._offlineDownloading = true;
		lib.init._offlineDownloadAbort = false;
		setText("准备中…");

		try {
			// 合并核心清单 + 全量清单一起核对,确保核心里的启动必需文件(jit-test.ts 等)
			// 若缺失也能被"补课"下载,而不只是下大素材。
			/** @type {string[]} */
			let all;
			if (forced) {
				all = forced;
			} else {
				const [coreResp, allResp] = await Promise.all([fetch("./pwa-core-assets.json", { cache: "no-cache" }), fetch("./pwa-all-assets.json", { cache: "no-cache" })]);
				if (!allResp.ok) throw new Error("资源清单获取失败 " + allResp.status);
				const coreList = coreResp.ok ? await coreResp.json() : [];
				const allList = await allResp.json();
				all = [...new Set([...coreList, ...allList])];
			}
			// 【代码进 Cache Storage,素材进 IndexedDB】这是治「iOS 冷启动 15.8 秒」的关键改动,
			// 详见 TROUBLESHOOTING 病因七与 pwa-asset-db.js 头部。要点:WebKit 的 caches.open() 会扫
			// 该 origin 下**每个桶的每一条 record**,成本正比于条目数、与字节数无关,且账按 origin 算
			// —— 所以拆桶无效(已实测+源码双证),唯一杠杆是把两万个素材从 Cache Storage 里拿出去。
			// 代码只有 746 条,留着不碍事,而且它有「整版原子一致」的要求(BUILD_KEY/STALE_KEY),
			// 搬走反而要把那套机制重做一遍。
			// 判据与 pwa-sw.js 的 isCodeAsset 必须严格一致,否则写进 A、从 B 读 = 等于没缓存。
			const codeCache = await caches.open("noname-code-v1");
			const CODE_EXT = /\.(js|mjs|ts|css|html|json|webmanifest)$/i;
			const CODE_DIRS = ["noname", "_virtual", "node_modules", "layout", "theme", "game", "mode", "card", "character"];
			const isCodeAsset = pathname => {
				if (!CODE_EXT.test(pathname)) return false;
				const rel = pathname.replace(/^\/+/, "");
				const slash = rel.indexOf("/");
				if (slash === -1) return true; // 根目录散文件
				return CODE_DIRS.includes(rel.slice(0, slash));
			};
			const pathOf = url => new URL(url, location.href).pathname;
			// 【素材库加载失败要能退回老路】素材照样写 Cache Storage,慢但能用 ——
			// 绝不能因为新仓库不可用就让「下载离线资源」整个失效。
			let db = null;
			try {
				db = await import(/* @vite-ignore */ `${rootURL}pwa-asset-db-esm.js`);
			} catch (e) {
				console.warn("素材库不可用,本次下载回退 Cache Storage:", e);
			}
			const legacyAssetCache = db ? null : await caches.open("noname-pwa-v2");

			// 计算待下载(跳过已有)以支持续传。
			// 【两个仓库的已有 key 要合起来算】否则代码那 700 多个或素材会被判成「未缓存」每次重下。
			// 用 keys()/getAllKeys() 一次性取回做 Set 再比对 —— 避免逐个探测 1.4 万次把主线程搞崩
			// (这是历史上「下载完再点会白屏」的成因,别改回逐条 match)。
			const cachedSet = forced ? new Set() : new Set([...(await codeCache.keys())].map(r => new URL(r.url).pathname));
			if (db && !forced) {
				for (const k of await db.getAssetKeys()) cachedSet.add(k);
				// 【顺手清掉清单里已不存在的旧素材】改名/下架过的历史残留没有任何代码会清理,而它们
				// 照样占条目数(实测缓存里比清单多约 6000 条)。以最新构建产物为唯一事实源。
				const pruned = await db.pruneAssets(new Set(all.map(pathOf)));
				if (pruned) console.log(`[素材库] 清掉 ${pruned} 条清单外的旧素材`);
			} else if (!forced) {
				for (const r of await legacyAssetCache.keys()) cachedSet.add(new URL(r.url).pathname);
			}
			const pending = forced ? all.slice() : all.filter(url => !cachedSet.has(pathOf(url)));
			const total = all.length;
			let done = total - pending.length; // 已缓存的算作已完成
			let quotaExceeded = false;

			// 核对后已全部缓存 → 秒提示,不走下载循环
			if (pending.length === 0) {
				setText(forced ? "下载离线资源" : "已下载离线资源");
				if (!silent) alert(`离线资源已全部缓存(${total}/${total}),断网也能玩。`);
				lib.init._offlineDownloading = false;
				return { done: total, total, failed: [], aborted: false, quota: false };
			}

			setText(`下载中 ${done}/${total}`);

			// 并发受控地逐批下载(CF 走 HTTP/2 多路复用,12 并发可用且更快)
			const CONCURRENCY = 12;
			// 【写失败要记下来重试,不能默默丢】WebKit 287876:iOS 18 PWA 下 IDB 的 put 会**间歇性**
			// 失败(至今未修)。两万条里出几条几乎是必然,而丢掉的素材表现为「玩到那里才发现是剪影」,
			// 极难事后定位 —— 所以攒起来在末尾统一重试一轮,仍失败的如实报数并写进库内日志。
			const writeFailed = [];
			// 【顺手把下到的素材记进基线】基线的语义是「本地实际持有的字节的哈希」,而下载器是素材
			// 进库的唯一入口 —— 不在这里记,基线就只覆盖「建立基线那一刻库里有的东西」,之后新装的
			// 素材会落进 inspectAssets 的盲区:库里有(不算新增)+ 基线无(不参与比较)→ **永远查不出
			// 它旧了**。曹操传那 25 张卡面就是这么隐形的:包是后加的,基线是之前建的。
			// 【只并进已存在的基线,不从零创建】没有基线时留空,好让「检查更新」照旧走完整的
			// computeBaseline —— 写一份残缺基线会让 missingBaseline 变 false,反而把那条路堵死。
			const baselineAdd = {};
			const sha16 = async buf => {
				const d = await crypto.subtle.digest("SHA-256", buf);
				return [...new Uint8Array(d)]
					.map(b => b.toString(16).padStart(2, "0"))
					.join("")
					.slice(0, 16);
			};
			for (let i = 0; i < pending.length; i += CONCURRENCY) {
				if (lib.init._offlineDownloadAbort) break;
				const batch = pending.slice(i, i + CONCURRENCY);
				const fetched = [];
				const results = await Promise.allSettled(
					batch.map(async url => {
						const r = await fetch(url, { cache: "no-cache" });
						if (!r || r.status !== 200) return;
						if (db && !isCodeAsset(pathOf(url))) {
							// 素材 → IndexedDB。【只存 ArrayBuffer,绝不存 Blob】WebKit 下 IDB 里的 Blob 会
							// 每个落成一个独立 .blob 文件,等于把「万文件」问题原样搬过去(还有 235687 等
							// 未修的损坏 bug)。代价是 MIME 不随 ArrayBuffer 走,必须单独存 —— 优先用服务器
							// 给的 Content-Type,拿不到才按扩展名猜。
							const buf = await r.arrayBuffer();
							const mime = db.guessMime(pathOf(url), r.headers.get("Content-Type") || "");
							// sha 只用来记基线,putAssets 只挑 buf/mime/len 存,多带这个字段不进库
							fetched.push({ path: pathOf(url), buf, mime, sha: await sha16(buf) });
							return;
						}
						// 代码(或素材库不可用时的一切)→ Cache Storage,行为与以前完全一致。
						// iOS 不接受 redirected 响应:重定向的先用响应体重建干净副本再缓存。
						let toCache = r.clone();
						if (r.redirected) {
							const body = await r.clone().blob();
							toCache = new Response(body, { status: r.status, statusText: r.statusText, headers: r.headers });
						}
						const target = db ? codeCache : isCodeAsset(pathOf(url)) ? codeCache : legacyAssetCache;
						await target.put(url, toCache);
					})
				);
				// 【一个事务写一批,不是一条一个事务】IDB 每个事务都有固定开销,逐条开事务在两万条
				// 量级上会慢一个数量级。
				if (fetched.length) {
					const { failed } = await db.putAssets(fetched);
					if (failed.length) writeFailed.push(...fetched.filter(f => failed.includes(f.path)).map(f => f.path));
					// 只记真正写进库的 —— 写失败的那条本地还是旧字节,基线里声称是新的就等于撒谎
					for (const f of fetched) {
						if (!failed.includes(f.path)) baselineAdd[f.path] = f.sha;
					}
				}
				for (const res of results) {
					if (res.status === "fulfilled") {
						done++;
					} else if (res.reason && (res.reason.name === "QuotaExceededError" || String(res.reason).includes("quota"))) {
						quotaExceeded = true;
					}
				}
				setText(`下载中 ${done}/${total}`);
				if (quotaExceeded) break;
			}

			// 重试写失败的那些(抖动多是瞬时的,重来一次成功率很高)
			if (db && writeFailed.length && !lib.init._offlineDownloadAbort) {
				setText(`重试 ${writeFailed.length} 个…`);
				const retry = [];
				for (const p of writeFailed) {
					try {
						const r = await fetch(p, { cache: "no-cache" });
						if (r && r.status === 200) {
							const buf = await r.arrayBuffer();
							retry.push({ path: p, buf, mime: db.guessMime(p, r.headers.get("Content-Type") || ""), sha: await sha16(buf) });
						}
					} catch {}
				}
				const { failed } = await db.putAssets(retry);
				writeFailed.length = 0;
				writeFailed.push(...failed);
				for (const f of retry) {
					if (!failed.includes(f.path)) baselineAdd[f.path] = f.sha;
				}
				if (failed.length) {
					console.warn(`[素材库] 仍有 ${failed.length} 个写不进去`, failed.slice(0, 20));
				}
			}

			// 把这一趟真正写进库的素材哈希并进基线。放在循环外(而不是每批一写)是因为基线是
			// **单条整体覆盖**的记录,每批写一次等于反复序列化一个越来越大的对象;而中途被掐断
			// (abort / 配额超限)也会走到这儿,已下到的那部分照样记得上。
			if (db && Object.keys(baselineAdd).length && typeof db.getBaseline === "function") {
				try {
					const base = await db.getBaseline();
					// 没有基线就不创建 —— 留给「检查更新」里的 computeBaseline 一次算全
					if (base) {
						Object.assign(base, baselineAdd);
						await db.saveBaseline(base);
					}
				} catch (e) {
					console.warn("[素材库] 基线更新失败(不影响本次下载):", e);
				}
			}

			const outcome = { done, total, failed: writeFailed.slice(), aborted: Boolean(lib.init._offlineDownloadAbort), quota: quotaExceeded };
			if (silent) {
				setText(forced ? "下载离线资源" : done >= total ? "已下载离线资源" : "下载离线资源");
				return outcome;
			}
			if (quotaExceeded) {
				alert(`已达设备缓存容量上限,离线资源部分缓存(${done}/${total})。\niOS 对网页缓存有容量限制,已缓存内容可离线使用。`);
				setText("下载离线资源");
			} else if (lib.init._offlineDownloadAbort) {
				alert(`已暂停。当前已缓存 ${done}/${total},再次点击可继续。`);
				setText("下载离线资源");
			} else if (writeFailed.length) {
				// 【写失败要如实告知】默默说「完成」而实际少了几十个素材,表现成"玩到那里才发现是剪影",
				// 比当场报出来难查得多。再次点击会走续传补齐(它们不在已有 key 里)。
				alert(`离线资源下载完成(${done}/${total}),但有 ${writeFailed.length} 个素材没写进本地库。\n再次点击「下载离线资源」可补齐。`);
				setText("下载离线资源");
			} else {
				alert(`离线资源下载完成(${done}/${total})!断网也能玩了。`);
				setText("已下载离线资源");
			}
			return outcome;
		} catch (e) {
			console.error("下载离线资源失败:", e);
			alert("下载离线资源失败:" + (e instanceof Error ? e.message : String(e)));
			setText("下载离线资源");
		} finally {
			lib.init._offlineDownloading = false;
			lib.init._offlineDownloadAbort = false;
		}
	}

	reset() {
		if (window.inSplash) {
			return;
		}
		if (window.resetExtension) {
			if (confirm("游戏似乎未正常载入，有可能因为部分扩展未正常载入，或者因为部分扩展未载入完毕。\n是否禁用扩展并重新打开？")) {
				window.resetExtension();
				window.location.reload();
			}
		} else {
			if (lib.device) {
				if (navigator.notification) {
					navigator.notification.confirm(
						"游戏似乎未正常载入，是否重置游戏？",
						function (index) {
							if (index == 2) {
								localStorage.removeItem("noname_inited");
								window.location.reload();
							} else if (index == 3) {
								var noname_inited = localStorage.getItem("noname_inited");
								var onlineKey = localStorage.getItem(lib.configprefix + "key");
								localStorage.clear();
								if (noname_inited) {
									localStorage.setItem("noname_inited", noname_inited);
								}
								if (onlineKey) {
									localStorage.setItem(lib.configprefix + "key", onlineKey);
								}
								if (indexedDB) {
									indexedDB.deleteDatabase(lib.configprefix + "data");
								}
								setTimeout(function () {
									window.location.reload();
								}, 200);
							}
						},
						"确认退出",
						["取消", "重新下载", "重置设置"]
					);
				} else {
					if (confirm("游戏似乎未正常载入，是否重置游戏？")) {
						localStorage.removeItem("noname_inited");
						window.location.reload();
					}
				}
			} else {
				if (confirm("游戏似乎未正常载入，是否重置游戏？")) {
					var onlineKey = localStorage.getItem(lib.configprefix + "key");
					localStorage.clear();
					if (onlineKey) {
						localStorage.setItem(lib.configprefix + "key", onlineKey);
					}
					if (indexedDB) {
						indexedDB.deleteDatabase(lib.configprefix + "data");
					}
					setTimeout(function () {
						window.location.reload();
					}, 200);
				}
			}
		}
	}

	startOnline = [
		async event => {
			event._resultid = null;
			event._result = null;
			game.pause();
		},
		async event => {
			if (event._result) {
				if (event._resultid) {
					event._result.id = event._resultid;
				}
				game.send("result", event._result);
			}
			event.goto(0);
		},
	];

	onfree() {
		if (lib.onfree) {
			clearTimeout(window.resetGameTimeout);
			delete window.resetGameTimeout;
			if (!game.syncMenu) {
				delete window.resetExtension;
				localStorage.removeItem(lib.configprefix + "disable_extension");
			}

			if (game.removeFile && lib.config.brokenFile.length) {
				while (lib.config.brokenFile.length) {
					game.removeFile(lib.config.brokenFile.shift());
				}
				game.saveConfigValue("brokenFile");
			}

			var onfree = lib.onfree;
			delete lib.onfree;
			var loop = function () {
				if (onfree.length) {
					onfree.shift()();
					setTimeout(loop, 100);
				}
			};
			setTimeout(loop, 500);
			if (!_status.new_tutorial) {
				game.saveConfig("menu_loadondemand", true, lib.config.mode);
			}
		}
	}

	connection(ws) {
		const client = new lib.element.Client(ws);
		lib.node.clients.push(client);
		ws.on("message", function (messagestr) {
			var message;
			try {
				message = JSON.parse(messagestr);
				if (!Array.isArray(message) || typeof lib.message.server[message[0]] !== "function") {
					throw new Error("err");
				}
				if (client.sandbox) {
					security.enterSandbox(client.sandbox);
				}
				try {
					for (var i = 1; i < message.length; i++) {
						message[i] = get.parsedResult(message[i]);
					}
				} finally {
					if (client.sandbox) {
						security.exitSandbox();
					}
				}
			} catch (e) {
				console.log(e);
				console.log("invalid message: " + messagestr);
				return;
			}
			lib.message.server[message.shift()].apply(client, message);
		});
		ws.on("close", function () {
			client.close();
		});
		client.send("opened");
	}

	sheet() {
		var style = document.createElement("style");
		document.head.appendChild(style);
		for (var i = 0; i < arguments.length; i++) {
			if (typeof arguments[i] == "string") {
				style.sheet.insertRule(arguments[i], 0);
			}
		}
		return style;
	}

	css(path, file, before) {
		const style = document.createElement("link");
		style.rel = "stylesheet";
		if (path) {
			if (path[path.length - 1] == "/") {
				path = path.slice(0, path.length - 1);
			}
			if (file) {
				path = `${path}${/^db:extension-[^:]*$/.test(path) ? ":" : "/"}${file}.css`;
			}
			(path.startsWith("db:") ? game.getDB("image", path.slice(3)).then(get.objectURL) : new Promise(resolve => resolve(path))).then(
				resolvedPath => {
					style.href = resolvedPath;
					if (typeof before == "function") {
						style.addEventListener("load", before);
						document.head.appendChild(style);
					} else if (before) {
						document.head.insertBefore(style, before);
					} else {
						document.head.appendChild(style);
					}
				}
			);
		}
		return style;
	}

	js(path, file, onLoad, onError) {
		if (path[path.length - 1] == "/") {
			path = path.slice(0, path.length - 1);
		}
		if (path == `${lib.assetURL}mode` && lib.config.all.stockmode.indexOf(file) == -1) {
			Promise.resolve(lib.init[`setMode_${file}`]()).then(onLoad);
			return;
		}
		if (Array.isArray(file)) {
			file.forEach(value => lib.init.js(path, value, onLoad, onError));
			return;
		}
		let scriptSource = file ? `${path}${/^db:extension-[^:]*$/.test(path) ? ":" : "/"}${file}.js` : path;
		if (path.startsWith("http")) {
			scriptSource += `?rand=${get.id()}`;
		} else if (
			lib.config.fuck_sojson &&
			!_status.connectMode &&
			scriptSource.includes("extension") != -1 &&
			scriptSource.startsWith(lib.assetURL)
		) {
			const pathToRead = scriptSource.slice(lib.assetURL.length);
			const alertMessage = `检测到您安装了使用免费版sojson进行加密的扩展。请谨慎使用这些扩展，避免游戏数据遭到破坏。\n扩展文件：${pathToRead}`;
			if (typeof game.readFileAsText == "function") {
				game.readFileAsText(
					pathToRead,
					result => {
						if (result.includes("sojson") || result.includes("jsjiami") || result.includes("var _0x")) {
							alert(alertMessage);
						}
					},
					() => void 0
				);
			} else if (location.origin != "file://") {
				lib.init.req(
					pathToRead,
					result => {
						if (result.includes("sojson") || result.includes("jsjiami") || result.includes("var _0x")) {
							alert(alertMessage);
						}
					},
					() => void 0
				);
			}
		}
		const script = document.createElement("script");
		//script.type = "module";
		(scriptSource.startsWith("db:")
			? game.getDB("image", scriptSource.slice(3)).then(get.objectURL)
			: new Promise(resolve => resolve(scriptSource))
		).then(resolvedScriptSource => {
			script.src = resolvedScriptSource;
			if (path.startsWith("http")) {
				script.addEventListener("load", () => script.remove());
			}
			document.head.appendChild(script);
			if (typeof onLoad == "function") {
				script.addEventListener("load", onLoad);
			}
			if (typeof onError == "function") {
				script.addEventListener("error", onError);
			}
		});
		return script;
	}

	req(str, onload, onerror, master) {
		let sScriptURL;
		if (str.startsWith("http")) {
			sScriptURL = str;
		} else if (str.startsWith("local:")) {
			if (lib.assetURL.length == 0 && location.origin == "file://" && typeof game.readFile == "undefined") {
				const e = new Error("浏览器file协议下无法使用此api，请在http/https协议下使用此api");
				if (typeof onerror == "function") {
					onerror(e);
				} else {
					throw e;
				}
				return;
			}
			sScriptURL = lib.assetURL + str.slice(6);
		} else {
			let url = get.url(master);
			if (url[url.length - 1] != "/") {
				url += "/";
			}
			sScriptURL = url + str;
		}
		const oReq = new XMLHttpRequest();
		if (typeof onload == "function") {
			oReq.addEventListener("load", result => {
				if (![0, 200].includes(oReq.status)) {
					if (typeof onerror == "function") {
						onerror(new Error(oReq.statusText || oReq.status));
					}
					return;
				}
				onload(oReq.responseText);
			});
		}
		if (typeof onerror == "function") {
			oReq.addEventListener("error", onerror);
		}
		oReq.open("GET", sScriptURL);
		oReq.send();
	}

	json(url, onload, onerror) {
		const oReq = new XMLHttpRequest();
		if (typeof onload == "function") {
			oReq.addEventListener("load", () => {
				if (![0, 200].includes(oReq.status)) {
					if (typeof onerror == "function") {
						onerror(new Error(oReq.statusText || oReq.status));
					}
					return;
				}
				let result;
				try {
					result = JSON.parse(oReq.responseText);
					if (!result) {
						throw new Error("err");
					}
				} catch (e) {
					if (typeof onerror == "function") {
						onerror(e);
					}
					return;
				}
				onload(result);
			});
		}
		if (typeof onerror == "function") {
			oReq.addEventListener("error", onerror);
		}
		oReq.open("GET", url);
		oReq.send();
	}

	cssstyles() {
		if (ui.css.styles) {
			ui.css.styles.remove();
		}
		ui.css.styles = lib.init.sheet();
		ui.css.styles.sheet.insertRule(
			"#arena .player>.name,#arena .button.character>.name {font-family: " + (lib.config.name_font || "xinwei") + ",xinwei}",
			0
		);
		ui.css.styles.sheet.insertRule(
			"#arena .player>.name,.button.character>.name {font-family: " + (lib.config.name_font || "xinwei") + ",xinwei}",
			0
		);
		ui.css.styles.sheet.insertRule("#arena .player .identity>div {font-family: " + (lib.config.identity_font || "huangcao") + ",xinwei}", 0);
		ui.css.styles.sheet.insertRule(
			".button.character.newstyle>.identity {font-family: " + (lib.config.identity_font || "huangcao") + ",xinwei}",
			0
		);
		if (lib.config.cardtext_font && lib.config.cardtext_font != "default") {
			ui.css.styles.sheet.insertRule(".card div:not(.info):not(.background) {font-family: " + lib.config.cardtext_font + ";}", 0);
		}
		if (lib.config.global_font && lib.config.global_font != "default") {
			ui.css.styles.sheet.insertRule("#window {font-family: " + lib.config.global_font + ",xinwei}", 0);
			ui.css.styles.sheet.insertRule(
				"#window #control{font-family: STHeiti,SimHei,Microsoft JhengHei,Microsoft YaHei,WenQuanYi Micro Hei,Suits,Helvetica,Arial,sans-serif}",
				0
			);
		}
		switch (lib.config.glow_phase) {
			case "yellow":
				ui.css.styles.sheet.insertRule(
					"#arena .player:not(.selectable):not(.selected).glow_phase {box-shadow: rgba(0, 0, 0, 0.3) 0 0 0 1px, rgb(217, 152, 62) 0 0 15px, rgb(217, 152, 62) 0 0 15px !important;}",
					0
				);
				break;
			case "green":
				ui.css.styles.sheet.insertRule(
					"#arena .player:not(.selectable):not(.selected).glow_phase {box-shadow: rgba(0, 0, 0, 0.3) 0 0 0 1px, rgba(10, 155, 67, 1) 0 0 15px, rgba(10, 155, 67, 1) 0 0 15px !important;}",
					0
				);
				break;
			case "purple":
				ui.css.styles.sheet.insertRule(
					"#arena .player:not(.selectable):not(.selected).glow_phase {box-shadow: rgba(0, 0, 0, 0.3) 0 0 0 1px, rgb(189, 62, 170) 0 0 15px, rgb(189, 62, 170) 0 0 15px !important;}",
					0
				);
				break;
		}
	}

	layout(layout, nosave) {
		const loadingScreen = ui.create.div(".loading-screen", document.body),
			loadingScreenStyle = loadingScreen.style;
		loadingScreenStyle.animationDuration = "1s";
		loadingScreenStyle.animationFillMode = "forwards";
		loadingScreenStyle.animationName = "opacity-0-1";
		if (layout == "default") {
			layout = "mobile";
		}
		if (!nosave) {
			game.saveConfig("layout", layout);
		}
		game.layout = layout;
		ui.arena.hide();
		new Promise(resolve => setTimeout(resolve, 500))
			.then(() => {
				if (game.layout == "default") {
					ui.css.layout.href = "";
				} else {
					ui.css.layout.href = lib.assetURL + "layout/" + game.layout + "/layout.css";
				}
				if (game.layout == "mobile" || game.layout == "long") {
					ui.arena.classList.add("mobile");
				} else {
					ui.arena.classList.remove("mobile");
				}
				if (game.layout == "mobile" || game.layout == "long" || game.layout == "long2" || game.layout == "nova") {
					if (game.me && game.me.node.handcards2.childNodes.length) {
						while (game.me.node.handcards2.childNodes.length) {
							game.me.node.handcards1.appendChild(game.me.node.handcards2.firstChild);
						}
					}
				}
				if (game.layout == "default") {
					ui.arena.classList.add("oldlayout");
				} else {
					ui.arena.classList.remove("oldlayout");
				}
				if (
					lib.config.cardshape == "oblong" &&
					(game.layout == "long" || game.layout == "mobile" || game.layout == "long2" || game.layout == "nova")
				) {
					ui.arena.classList.add("oblongcard");
					ui.window.classList.add("oblongcard");
				} else {
					ui.arena.classList.remove("oblongcard");
					ui.window.classList.remove("oblongcard");
				}
				//if(lib.config.textequip=='text'&&(game.layout=='long'||game.layout=='mobile')){
				if (game.layout == "long" || game.layout == "mobile") {
					ui.arena.classList.add("textequip");
				} else {
					ui.arena.classList.remove("textequip");
				}
				if (get.is.phoneLayout()) {
					ui.css.phone.href = lib.assetURL + "layout/default/phone.css";
					ui.arena.classList.add("phone");
				} else {
					ui.css.phone.href = "";
					ui.arena.classList.remove("phone");
				}
				for (var i = 0; i < game.players.length; i++) {
					if (get.is.linked2(game.players[i])) {
						if (game.players[i].classList.contains("linked")) {
							game.players[i].classList.remove("linked");
							game.players[i].classList.add("linked2");
						}
					} else {
						if (game.players[i].classList.contains("linked2")) {
							game.players[i].classList.remove("linked2");
							game.players[i].classList.add("linked");
						}
					}
				}
				if (game.layout == "long" || game.layout == "long2") {
					ui.arena.classList.add("long");
				} else {
					ui.arena.classList.remove("long");
				}
				if (lib.config.player_border != "wide" || game.layout == "long" || game.layout == "long2") {
					ui.arena.classList.add("slim_player");
				} else {
					ui.arena.classList.remove("slim_player");
				}
				if (lib.config.player_border == "normal" && lib.config.mode != "brawl" && (game.layout == "long" || game.layout == "long2")) {
					ui.arena.classList.add("lslim_player");
				} else {
					ui.arena.classList.remove("lslim_player");
				}
				if (lib.config.player_border == "slim") {
					ui.arena.classList.add("uslim_player");
				} else {
					ui.arena.classList.remove("uslim_player");
				}
				if (lib.config.player_border == "narrow") {
					ui.arena.classList.add("mslim_player");
				} else {
					ui.arena.classList.remove("mslim_player");
				}
				ui.updatej();
				ui.updatem();
				return new Promise(resolve => setTimeout(resolve, 100));
			})
			.then(() => {
				ui.arena.show();
				if (game.me) {
					game.me.update();
				}
				return new Promise(resolve => setTimeout(resolve, 500));
			})
			.then(() => {
				ui.updatex();
				ui.updatePlayerPositions();
				return new Promise(resolve => setTimeout(resolve, 500));
			})
			.then(() => {
				ui.updatec();
				loadingScreenStyle.animationName = "opacity-1-0";
				loadingScreen.addEventListener("animationend", animationEvent => animationEvent.target.remove());
			});
	}

	background() {
		if (lib.config.image_background_random) {
			var list = [];
			for (var i in lib.configMenu.appearence.config.image_background.item) {
				if (i == "default") {
					continue;
				}
				list.push(i);
			}
			list.remove(lib.config.image_background);
			localStorage.setItem(lib.configprefix + "background", JSON.stringify(list));
		} else if (lib.config.image_background && lib.config.image_background != "default" && !lib.config.image_background.startsWith("custom_")) {
			localStorage.setItem(lib.configprefix + "background", lib.config.image_background);
		} else if (lib.config.image_background == "default" && lib.config.theme == "simple") {
			localStorage.setItem(lib.configprefix + "background", "ol_bg");
		} else {
			localStorage.removeItem(lib.configprefix + "background");
		}
	}

	/**
	 * @deprecated
	 */
	parsex(item, scope) {
		if (scope) {
			throw new Error("parsex已经被拆分，不再支持scope的使用");
		}
		// parsex 的 Legacy 主体移动到 noname/library/element/GameEvent/compilers/StepCompiler.ts
		return ContentCompiler.compile(item);
	}

	encode(strUni) {
		var strUtf = strUni.replace(/[\u0080-\u07ff]/g, function (c) {
			var cc = c.charCodeAt(0);
			return String.fromCharCode(0xc0 | (cc >> 6), 0x80 | (cc & 0x3f));
		});
		strUtf = strUtf.replace(/[\u0800-\uffff]/g, function (c) {
			var cc = c.charCodeAt(0);
			return String.fromCharCode(0xe0 | (cc >> 12), 0x80 | ((cc >> 6) & 0x3f), 0x80 | (cc & 0x3f));
		});
		return btoa(strUtf);
	}

	decode(str) {
		var strUtf = atob(str);
		var strUni = strUtf.replace(/[\u00e0-\u00ef][\u0080-\u00bf][\u0080-\u00bf]/g, function (c) {
			var cc = ((c.charCodeAt(0) & 0x0f) << 12) | ((c.charCodeAt(1) & 0x3f) << 6) | (c.charCodeAt(2) & 0x3f);
			return String.fromCharCode(cc);
		});
		strUni = strUni.replace(/[\u00c0-\u00df][\u0080-\u00bf]/g, function (c) {
			var cc = ((c.charCodeAt(0) & 0x1f) << 6) | (c.charCodeAt(1) & 0x3f);
			return String.fromCharCode(cc);
		});
		return strUni;
	}

	stringify(obj) {
		var str = "{";
		for (var i in obj) {
			str += '"' + i + '":';
			if (Object.prototype.toString.call(obj[i]) == "[object Object]") {
				str += lib.init.stringify(obj[i]);
			} else if (typeof obj[i] == "function") {
				str += obj[i].toString();
			} else {
				str += JSON.stringify(obj[i]);
			}
			str += ",";
		}
		str += "}";
		return str;
	}

	stringifySkill(obj) {
		var str = "";
		for (var i in obj) {
			str += i + ":";
			if (Object.prototype.toString.call(obj[i]) == "[object Object]") {
				str += "{\n" + lib.init.stringifySkill(obj[i]) + "}";
			} else if (typeof obj[i] == "function") {
				str += obj[i].toString().replace(/\t/g, "");
			} else {
				str += JSON.stringify(obj[i]);
			}
			str += ",\n";
		}
		return str;
	}

	/**
	 * 在返回当前加载的esm模块相对位置。
	 * @param {*} url 传入import.meta.url
	 */
	getCurrentFileLocation(url) {
		let head = window.location.href.slice(0, window.location.href.lastIndexOf("/") + 1);
		let ret = url.replace(head, "");
		return decodeURIComponent(ret);
	}

	/**
	 * @param {string | URL} link - 需要解析的路径
	 * @param {((item: string) => string) | null} [defaultHandle] - 在给定路径不符合可用情况（或基于无名杀相关默认情况）时，处理路径的函数，返回的路径应是相对于根目录的相对路径，默认为`null`，当且仅当无法解析成`URL`时会调用该回调
	 * @param {((item: URL) => unknown) | null} [loadAsDataUrlCallback] - 若存在值，则将资源加载为[Data URL](https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Basics_of_HTTP/Data_URLs)，然后传入进回调函数
	 * @param {boolean} [dbNow] - 此刻是否在解析数据库中的内容，请勿直接使用
	 * @returns {URL}
	 */
	parseResourceAddress(link, defaultHandle = null, loadAsDataUrlCallback = null, dbNow = false) {
		// 适当的摆了，中文错误应该没人会反对
		if (!link) {
			throw new Error(dbNow ? "传入的数据库链接中不存在内容" : "请传入需要解析的链接");
		}

		let linkString = link instanceof URL ? link.href : link;

		// 如果传入值为Data URL，经过分析可知无需处理，故直接返回成品URL
		if (linkString.startsWith("data:")) {
			let result = new URL(linkString);
			if (loadAsDataUrlCallback) {
				loadAsDataUrlCallback(result);
			}
			return result;
		}

		/**
		 * @type {URL}
		 */
		let resultUrl;
		if (linkString.startsWith("ext:")) {
			let resultLink = `extension/${linkString.slice(4)}`;
			resultUrl = new URL(resultLink, rootURL);
		} else if (URL.canParse(linkString)) {
			resultUrl = new URL(linkString);
		} else if (dbNow) {
			let content = new Blob([linkString], { type: "text/plain" });
			get.dataUrlAsync(content).then(loadAsDataUrlCallback);
			// @ts-expect-error 此处的返回值无任何用处
			return;
		} else {
			let resultLink = defaultHandle == null ? linkString : defaultHandle(linkString);
			resultUrl = new URL(resultLink, rootURL);
		}

		if (loadAsDataUrlCallback != null) {
			if (resultUrl.protocol == "db:") {
				// 我思索了一下，如果这玩意能造成无限递归
				// 那么我只能说，你赢了
				game.getDB("image", linkString.slice(3)).then(storeResult =>
					this.parseResourceAddress(storeResult, defaultHandle, loadAsDataUrlCallback, true)
				);
			} else {
				get.blobFromUrl(resultUrl)
					.then(blob => get.dataUrlAsync(blob))
					.then(loadAsDataUrlCallback);
			}
		}

		return resultUrl;
	}
}
