import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

/** 执行子命令,非 0 退出码立即终止并报清楚是哪条命令失败 */
function run(cmd: string) {
	const r = spawnSync(cmd, { shell: true, stdio: "inherit" });
	if (r.status !== 0) {
		throw new Error(`构建命令失败(退出码 ${r.status}): ${cmd}`);
	}
}

/**
 * 递归列出 dist 下某目录内所有文件,返回相对 dist 根、以 ./ 开头的 URL 路径。
 * @param {string} dir 相对 dist 的子目录(如 "image");为空则整个 dist
 */
async function listAssets(dir: string): Promise<string[]> {
	const root = "dist";
	const abs = dir ? path.join(root, dir) : root;
	if (!existsSync(abs)) return [];
	const out: string[] = [];
	async function walk(cur: string) {
		const entries = await fs.readdir(cur, { withFileTypes: true });
		for (const e of entries) {
			const full = path.join(cur, e.name);
			if (e.isDirectory()) {
				await walk(full);
			} else if (e.isFile()) {
				// 转成相对 dist 根的 URL(正斜杠,以 ./ 开头)
				const rel = path.relative(root, full).split(path.sep).join("/");
				out.push("./" + rel);
			}
		}
	}
	await walk(abs);
	return out;
}

// 先显式构建本体(core,包名 noname)及其工作区依赖(fs/jit)。
// 注意:`-F noname...` 的 `...` 依赖语法在不同 pnpm 版本行为不一致
// (pnpm 10 曾在 CI 中漏掉 core 本体),故构建后显式校验产物存在。
run("pnpm -F noname... build");
if (!existsSync("apps/core/dist")) {
	throw new Error("apps/core/dist 未生成——core 本体未被构建(检查 pnpm 版本 / -F 过滤器是否匹配到 noname 包)");
}

run("pnpm -F ./packages/extension/** build");

console.log("合并打包结果");
await fs.rm("dist", { recursive: true, force: true });
await fs.mkdir("dist", { recursive: true });
await Promise.all([
	fs.cp("apps/core/dist", "dist", { recursive: true }),
	fs.cp("apps/core/audio", "dist/audio", { recursive: true }),
	fs.cp("apps/core/image", "dist/image", { recursive: true }),
	fs.cp("apps/core/extension", "dist/extension", { recursive: true }),
	fs.cp("docs", "dist/docs", { recursive: true }),
	fs.cp(".nomedia", "dist/.nomedia"),
	fs.cp("LICENSE", "dist/LICENSE"),
	fs.cp("README.md", "dist/README.md"),
	// PWA:清单与离线缓存 SW(纯静态部署可安装、离线可玩)
	fs.cp("apps/core/manifest.webmanifest", "dist/manifest.webmanifest")
	// pwa-sw.js 不在这里直接 cp:要先把构建戳替换进去,见下方"生成 PWA 构建版本戳"
]);

// 构建戳(YYMMDDHHmm 北京时间)。提到这里算,因为 pwa-sw.js 和 pwa-version.json 都要用。
// CF 构建服务器在 UTC,加 8 小时转北京时间,用户看到的数字与 push 时间对得上。
const buildStamp = (() => {
	const now = new Date(Date.now() + 8 * 3600_000); // UTC+8 北京时间
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${String(now.getUTCFullYear()).slice(2)}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
})();

// 生成 PWA 离线资源清单(供 SW 预缓存 + 游戏内一键下载使用)
console.log("生成 PWA 资源清单");
{
	// 核心:启动 + 标准对局必需的代码/UI/数据(不含花体字、武将立绘、语音)。
	// 由 SW 在 install 阶段预缓存,保证断网也能稳定启动、进模式、玩标准局。
	const coreDirs = ["noname", "_virtual", "node_modules", "layout", "theme", "game", "mode", "card", "character"];
	const core = new Set<string>(["./index.html", "./noname.js", "./manifest.webmanifest", "./pwa-version.json"]);
	for (const d of coreDirs) {
		for (const f of await listAssets(d)) core.add(f);
	}
	// dist 根目录的启动必需散文件(jit-test.ts 等 JIT 编译入口、entry)。
	// 之前只扫子目录漏了它们 → 断网时这几个没缓存 → JIT worker 加载失败 → 白屏。
	// 排除仅开发/文档用的散文件(清单本身、README、LICENSE、图标已单列)。
	for (const f of await listAssets("")) {
		// listAssets("") 返回全 dist,只挑根目录一层的 .js/.ts
		const rel = f.replace(/^\.\//, "");
		if (!rel.includes("/") && /\.(js|ts)$/.test(rel) && !rel.startsWith("pwa-")) {
			core.add(f);
		}
	}
	// 【从核心清单剔掉线上根本不会被请求的大块头】install 是 cache:"reload" 全量重下,
	// 清单每大一分,在手机弱网上被中途掐断的概率就高一分——而 install 没跑完就会留下
	// "缓存装着却不被信任"的状态(见 pwa-sw.js install 的 catch),代价是之后每次冷启动
	// 都把几百个代码文件重新联网取一遍。故只装真正启动路径上的东西。
	// 剔掉的仍在 pwa-all-assets.json 里,想要全离线的话「下载离线资源」照样会装。
	const NOT_CORE = [
		// JIT TypeScript 编译器的 SW(4.1MB)。packages/jit/src/entry.ts 开头就按 hostname
		// 拦住了:非 localhost 直接 return,线上永远不注册、永远不会请求这个文件。
		// (它当初被扫进核心是因为上面那段"补根目录散文件",那时还没加 hostname 门。)
		/^\.\/service-worker\.js$/,
		// 代码编辑器的语法检查器(3.1MB)。noname/ui/create/index.js 里是 await import(),
		// 只有真的打开编辑器编 JS 才加载,不在启动路径上。
		/eslint-linter-browserify/,
		// 上游留的废弃兼容层:内容就两行,`console.error("将在下版本废弃")` + `export * from "vue"`。
		// 本体一处都不 import 它,而它 re-export 的裸说明符 "vue" 只有主文档的 importmap 认得——
		// 缓存住反而掩盖问题。真有老扩展引它,「下载离线资源」照样会装。
		/^\.\/game\/vue\.esm-browser\.js$/,
	];
	for (const f of [...core]) {
		if (NOT_CORE.some(re => re.test(f))) core.delete(f);
	}
	// 花色/基础字体符号属核心(界面必用),花体字(xinwei/yuanli 等大文件)不算核心
	for (const f of await listAssets("font")) {
		if (/\/(suits|motoyamaru)\.woff2$/.test(f)) core.add(f);
	}
	// 【PWA 图标不进核心 —— 71333e1 加进来是白占】当时的理由是"每次冷启动都打网络"。
	// 但它们**不在 boot 的 await 链上**:浏览器按 <link rel="icon"> / manifest icons 去拉是
	// 独立于模块加载的旁路,拉不到只是没图标,一毫秒都不耽误启动;而 iOS 主屏图标是安装
	// 那一刻由系统固化进 SpringBoard 的,压根不读 Cache Storage。
	// 想离线也有图标的话「下载离线资源」照样会装(它们在 pwa-all-assets.json 里)。

	// 【启动路径上的小素材也进核心】实测 20 轮冷启动,这几张每轮必现(19~20/20):
	// ol_bg.jpg 是主菜单背景、handcard/tiesuo_mark 是卡牌 UI 框、splash/style1/* 是 11 张
	// 模式启动图(default-splash.ts 的默认 style)。它们和 PWA 图标同理 —— 不管用户有没有点过
	// 「下载离线资源」,每次冷启动都要,没缓存的话离线时要各等满 missTimeoutMs。
	// 加起来约 1.4MB,相对核心清单 30MB 可以忽略。
	// 【为什么 xinwei.woff2(7.5MB)和 music_default.mp3(3.4MB)不进】它们同样每轮必现,但
	// 单个就顶掉核心清单 1/4~1/3 的体积,而 install 是 cache:"reload" 全量重下 —— 清单越大,
	// 手机弱网被中途掐断的概率越高,而掐断的代价是留下"缓存装着却不被信任"的状态(见 pwa-sw.js
	// install 的 catch),那个损失远大于省下的两次超时。它们靠「下载离线资源」装,装完之后
	// assetRevalidateWindow 保证不再重复校验。
	for (const f of await listAssets("image/splash/style1")) core.add(f);
	for (const f of ["./image/background/ol_bg.jpg", "./image/card/handcard.png", "./image/card/tiesuo_mark.png"]) {
		if (existsSync(path.join("dist", f.slice(2)))) core.add(f);
	}

	// 全量可下载:核心之外的大素材(立绘、语音、内置扩展、花体字)。
	// 由游戏内"下载离线资源"按钮按需批量缓存,可中断续传。
	const heavy: string[] = [];
	for (const d of ["image", "audio", "extension", "font"]) {
		for (const f of await listAssets(d)) {
			if (!core.has(f)) heavy.push(f);
		}
	}
	// 上面从核心剔掉的大块头收到这里:平时不装(省 install),但"下载离线资源"仍会缓存,
	// 想要彻底全离线的用户不会因为这次瘦身少拿东西。
	for (const f of [...(await listAssets("")), ...(await listAssets("node_modules"))]) {
		if (!core.has(f) && NOT_CORE.some(re => re.test(f))) heavy.push(f);
	}

	// 【index.html 必须排在第一位】install 是 BATCH=50 严格串行下载的,而 .sort() 之后
	// "./index.html" 落在第 280 项(第 6 批)—— 前面压着 17MB。install 在手机弱网上被掐断
	// 是常态,掐在第 6 批之前就等于这一版的新首页压根没装上,而"启动就报错"这类故障恰恰
	// 要靠 index.html 里的自修复来救 → 修复代码永远到不了用户手里。故把它拎到最前面。
	// 【清单必须收录自己】pwa-core-assets.json 原来不在自己的清单里,于是 install 的 catch
	// 分支里 cache.match("./pwa-core-assets.json") 对"从没点过下载离线资源"的用户恒为 null
	// → BUILD_KEY 和 STALE_KEY 双双被删 → 全部代码文件永久 Network-First(首屏 1381→4231ms),
	// 而且不自愈(戳只有下次 install 完整成功才补得回来)。
	const coreList = ["./index.html", ...[...core].sort().filter(f => f !== "./index.html"), "./pwa-core-assets.json"];
	await fs.writeFile("dist/pwa-core-assets.json", JSON.stringify(coreList));
	await fs.writeFile("dist/pwa-all-assets.json", JSON.stringify(heavy.sort()));
	console.log(`  核心预缓存清单: ${coreList.length} 文件`);
	console.log(`  可下载资源清单: ${heavy.length} 文件`);
}

// 写出构建版本戳:pwa-version.json 给界面显示,同时把戳替换进 pwa-sw.js。
// 【为什么 SW 里也要有戳】浏览器判断"有没有新 SW"只看 pwa-sw.js 的**字节**变没变。
// 以前这文件内容恒定,每次部署浏览器都认为 SW 没变 → reg.update() 找不到新版
// → 「检查更新」永远弹"已是最新版本";而且没有 install 就没有代码整版换新的时机,
// 逐文件 SWR 会把缓存搞成跨版本混搭(chunk 绑定对不上 → 启动 SyntaxError)。
{
	await fs.writeFile("dist/pwa-version.json", JSON.stringify({ build: buildStamp }));

	const swSource = await fs.readFile("apps/core/pwa-sw.js", "utf8");
	if (!swSource.includes("__BUILD_STAMP__")) {
		throw new Error("pwa-sw.js 里找不到 __BUILD_STAMP__ 占位符——戳没注入进去的话,SW 字节恒定,更新机制会静默失效");
	}
	await fs.writeFile("dist/pwa-sw.js", swSource.replaceAll("__BUILD_STAMP__", buildStamp));

	// index.html 里也埋一份:window.__PWA_RUNNING_BUILD__ = "页面正在跑的构建"。
	// 【为什么不能只有 pwa-version.json】那个文件读到的是缓存里哪一版,不是页面内存里跑的哪一版
	// —— 新 SW 装好后两者就分叉了,「检查更新」按钮拿它比对必然误报"已是最新"(详见 index.html 处注释)。
	const htmlPath = "dist/index.html";
	const html = await fs.readFile(htmlPath, "utf8");
	if (!html.includes("__PWA_BUILD_STAMP__")) {
		throw new Error("dist/index.html 里找不到 __PWA_BUILD_STAMP__ 占位符——戳没注入的话,「检查更新」按钮无法判断页面在跑哪一版,会一直误报「已是最新」");
	}
	await fs.writeFile(htmlPath, html.replaceAll("__PWA_BUILD_STAMP__", buildStamp));

	console.log(`  构建版本戳: ${buildStamp} (北京时间,已写入 pwa-version.json、pwa-sw.js 与 index.html)`);
}
