/**
 * 把本体卡牌包 `apps/core/card/caocaozhuan.js` 转成可分发的**扩展 zip**。
 *
 * 【为什么要转，不能直接给源文件】两者的加载方式完全不同：
 *  · 本体卡牌包是 ES 模块（`import ... from "noname"` + `export default`），
 *    由构建打进产物，靠「选项→卡牌」勾选启用；
 *  · 扩展 zip 由 `game.importExtension` 解压后用 **security.eval 执行**，
 *    也就是**经典脚本**——里面写 `import`/`export` 直接语法错误，扩展装不上。
 *    故必须重新包装成 `game.import("extension", function(lib, game, ui, get, ai, _status){...})`。
 *
 * 【卡面图怎么接】扩展不能往本体的 image/card/ 写文件，所以每张卡要显式给 image：
 *    fullskin: true + image: "ext:曹操传/image/card/<id>.png"
 *  `ext:` 会被 card.js 改写成 `extension/曹操传/...`（见其 line 386），
 *  而 importExtension 正是把 zip 内容写到 `extension/<扩展名>/<相对路径>`——两边对得上。
 *  **注意仍然用 fullskin 而不是 fullimage**：fullimage 会给整张卡设 backgroundSize:cover，
 *  图片盖满卡面、连花色点数的卡框都没了；fullskin 才是"art 放进卡框"，
 *  也就是我们这 25 张 120x120 透明图的用法（民间那两个包用的是 fullimage+整张卡面图，
 *  所以它们不能直接照抄）。
 *
 * 【注册时机用 precontent】它在 game.import 里被 **await 执行**（game/index.js:3199），
 *  发生在开局之前；content 要更晚。卡牌必须早于牌堆构建注册，故用 precontent。
 *
 * 【单一事实源】本脚本从卡牌包源码里抽取，不手抄一份——两份平行维护必然走样。
 *
 * 用法：node scripts/build-ccz-extension.mjs   → 产出 dist-ext/曹操传.zip
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const JSZip = require("../apps/core/node_modules/jszip");

const SRC = "apps/core/card/caocaozhuan.js";
const EXT_NAME = "曹操传";
const OUT_DIR = "dist-ext";
const IMG_DIR = "apps/core/image/card";

const raw = await fs.readFile(SRC, "utf8");
const src = raw.split("\r\n").join("\n");

// 【为什么不再抽取顶层函数】卡牌包已改成**零顶层函数**（与本体风格一致：
// card/*.js 与 character/*/skill.js 的顶层 function 数全是 0，每个技能自成一体）。
// 原先这里要把 armorValid / hasNatureLike 之类抽出来注入 game.import 闭包 ——
// 那一步炸过一次（新加的 hasNatureLike 没抽到，而那个错只在玩家装了扩展、
// 且真碰到黄金铠时才 ReferenceError，构建和 node --check 都查不出来）。
// 摆开之后这个环节直接删掉，少一份只在运行期才炸的风险。
// 留一道断言防回退：真要再加顶层函数，就得同时把注入逻辑加回来。
{
	const strayFns = [...src.slice(0, src.indexOf("export default")).matchAll(/^function\s+(\w+)/gm)].map(m => m[1]);
	if (strayFns.length) {
		throw new Error(
			`卡牌包里出现了顶层函数 ${strayFns.join(", ")} —— 本包约定零顶层函数（与本体一致）。` +
				"要么把它摆回各个技能里，要么在本脚本里重新加回抽取逻辑并注入闭包。"
		);
	}
}
let depth = 0;
// ── ② 抽出 export default 的对象字面量 ──
const defAt = src.indexOf("export default {");
if (defAt < 0) throw new Error("找不到 export default");
const objStart = src.indexOf("{", defAt);
depth = 0;
let objEnd = -1;
for (let i = objStart; i < src.length; i++) {
	const c = src[i];
	if (c === "{" || c === "[") depth++;
	else if (c === "}" || c === "]") {
		depth--;
		if (!depth) {
			objEnd = i + 1;
			break;
		}
	} else if (c === '"' || c === "'" || c === "`") {
		const q = c;
		i++;
		while (i < src.length && src[i] !== q) {
			if (src[i] === "\\") i++;
			i++;
		}
	} else if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i);
	else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i) + 1;
}
if (objEnd < 0) throw new Error("对象字面量括号没配平");
const packSrc = src.slice(objStart, objEnd);

// ── ③ 给每张 fullskin 卡补 image（扩展读不到本体 image/card/）──
// 只给"卡定义"补，不能误伤技能里的字段。判据：紧跟在 `<id>: {` 后面的 `fullskin: true,`。
let cardCount = 0;
const withImages = packSrc.replace(/(\n\t\t(ccz_\w+): \{\n\t\t\tfullskin: true,)/g, (m, whole, id) => {
	cardCount++;
	return `${whole}\n\t\t\timage: "ext:${EXT_NAME}/image/card/${id}.png",`;
});
if (cardCount !== 25) throw new Error(`应给 25 张卡补 image，实际 ${cardCount} 张`);

// ── ④ 组装 extension.js（经典脚本，不能有 import/export）──
const extensionJs = `/**
 * 曹操传 —— 装备/宝物卡牌扩展（25 件，取材于 KOEI《三國志曹操傳》宝物系统）。
 *
 * 本文件由 scripts/build-ccz-extension.mjs 从本体卡牌包
 * apps/core/card/caocaozhuan.js **自动生成**，请勿手改 —— 改源文件后重跑脚本。
 *
 * 只能装在**客户端**（安卓/Windows 等）：游戏内导入扩展要求
 * typeof game.readFile === "function"，网页/PWA 版没有文件系统权限，装不了。
 */
game.import("extension", function (lib, game, ui, get, ai, _status) {
	/** 卡牌包内容（结构同本体 card/*.js） */
	var PACK = ${withImages.split("\n").join("\n\t")};

	return {
		name: "${EXT_NAME}",
		editable: false,
		content: function () {},
		/**
		 * 【用 precontent 而不是 content】precontent 在 game.import 里被 await 执行，
		 * 发生在开局之前；卡牌必须早于牌堆构建注册。
		 */
		precontent: function () {
			for (var id in PACK.card) {
				if (!lib.card[id]) lib.card[id] = PACK.card[id];
			}
			for (var sid in PACK.skill) {
				if (!lib.skill[sid]) lib.skill[sid] = PACK.skill[sid];
			}
			for (var key in PACK.translate) {
				if (!lib.translate[key]) lib.translate[key] = PACK.translate[key];
			}
			// 入牌堆：每件 1 张（与本体惯例一致 —— standard 的 17 种装备全部 x1）
			for (var i = 0; i < PACK.list.length; i++) {
				lib.card.list.push(PACK.list[i]);
			}
		},
		help: {},
		config: {},
		package: {
			intro: "取材于 KOEI《三國志曹操傳》宝物系统的 25 件装备：武器 8 / 防具 6 / 坐骑 2 / 宝物 9。全部技能自带，不依赖任何武将包。",
			author: "Shelter-Lab",
			diskURL: "",
			forumURL: "",
			version: "1.0",
		},
	};
});
`;

// ── ⑤ 打包 ──
const zip = new JSZip();
zip.file("extension.js", extensionJs);

const ids = [...withImages.matchAll(/image: "ext:[^/]+\/image\/card\/(ccz_\w+)\.png"/g)].map(m => m[1]);
if (ids.length !== 25) throw new Error(`卡面图应 25 张，实际 ${ids.length}`);
let bytes = 0;
for (const id of ids) {
	const p = path.join(IMG_DIR, `${id}.png`);
	if (!existsSync(p)) throw new Error(`缺卡面图: ${p}`);
	const buf = await fs.readFile(p);
	bytes += buf.length;
	zip.file(`image/card/${id}.png`, buf);
}

await fs.mkdir(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, `${EXT_NAME}.zip`);
// 【jszip 2.x 的同步 API】仓库里是 2.7.0（本体 SW/游戏侧也用它），没有 generateAsync；
// 且 game.importExtension 里就是 `zip.load(data)` / `zip.generate({type:...})` 那一代写法，
// 用同一个版本打包最保险 —— 不同大版本的压缩产物本体不一定认。
await fs.writeFile(out, zip.generate({ type: "nodebuffer", compression: "DEFLATE" }));

const size = (await fs.stat(out)).size;
console.log(`✓ ${out}`);
console.log(`  extension.js ${(extensionJs.length / 1024).toFixed(0)}KB + 卡面图 ${ids.length} 张 ${(bytes / 1024).toFixed(0)}KB → zip ${(size / 1024).toFixed(0)}KB`);
