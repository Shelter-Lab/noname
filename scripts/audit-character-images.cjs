#!/usr/bin/env node
// 武将立绘缺失审计 —— 找出所有会显示成性别剪影的武将,并判断有没有同人物的图可复用。
//
// 用法: node scripts/audit-character-images.cjs
// 背景/踩坑/补图规格见 docs/CHARACTER-IMAGES.md
//
// 原理: 立绘路径是 image/character/<id>.jpg(见 noname/init/polyfill.ts),文件不存在时
// CSS 多背景兜底成 default_silhouette_{sex}.jpg。所以"缺图"= 该 id 没有同名文件、
// 且定义里没写 img:/ext:/db:/mode:/character: 这类重定向。

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CHAR_DIR = path.join(ROOT, "apps/core/character");
const IMG_DIR = path.join(ROOT, "apps/core/image/character");

// 已存在的立绘文件名(不含扩展名)
const haveImg = new Set(
	fs
		.readdirSync(IMG_DIR)
		.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
		.map(f => f.replace(/\.[^.]+$/, ""))
);

// 去注释:否则我们自己插的中文注释里的 "img" 字样会造成误判(踩过)
const decomment = s => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

// 逐字符剥掉 id 前缀(ol_ / dc_ / sb_ / mb_ / re_ / pot_ / dc_sb_ ...)找同人物候选。
// 【关键】不维护前缀白名单 —— 前缀表永远列不全,漏一个就会误报"无候选"(踩过 ol_)。
const stripPrefix = id => {
	let cur = id;
	for (let i = 0; i < 4; i++) {
		const m = cur.match(/^[a-z0-9]{1,6}_(.+)$/);
		if (!m) break;
		cur = m[1];
	}
	return cur;
};

// 按行切分武将条目。
// 【关键】不要用跨行正则 —— new RegExp("[^]") 在 Node 里不合法([^] 只在正则字面量有效),
// 会静默匹配 0 次并给出"0 缺失"的假结果(踩过两次,还信了一次)。
function parseEntries(src) {
	const out = [];
	const lines = src.split(/\r?\n/);
	let cur = null;
	let buf = [];
	for (const ln of lines) {
		const m = ln.match(/^\t([A-Za-z_][\w]*):\s*\{\s*$/);
		if (m) {
			cur = m[1];
			buf = [];
			continue;
		}
		if (cur && /^\t\},?\s*$/.test(ln)) {
			out.push([cur, buf.join("\n")]);
			cur = null;
			continue;
		}
		if (cur) buf.push(ln);
	}
	return out;
}

const missing = [];
let total = 0;

for (const pack of fs.readdirSync(CHAR_DIR)) {
	const file = path.join(CHAR_DIR, pack, "character.js");
	if (!fs.existsSync(file)) continue;
	const src = fs.readFileSync(file, "utf8");

	for (const [id, rawBody] of parseEntries(src)) {
		total++;
		const body = decomment(rawBody);

		// 有同名立绘文件 → 正常
		if (haveImg.has(id)) continue;
		// 定义里写了重定向 → 正常(上游自己也这么用)
		if (/\bimg\s*:/.test(body)) continue;
		if (/\b(ext|db|mode|character)\s*:\s*["']/.test(body)) continue;
		// 上游主动下架的武将,选将界面根本不出现,不需要图
		if (/\bisUnseen\s*:\s*true/.test(body)) continue;

		// 找同人物候选(去前缀后的名字 + 常见前缀组合)
		const base = stripPrefix(id);
		const cands = [base, ...["", "re_", "dc_", "sb_", "mb_", "ol_", "ns_", "sp_", "xin_", "old_"].map(p => p + base)].filter(
			c => c !== id && haveImg.has(c)
		);

		missing.push({ pack, id, cands: [...new Set(cands)] });
	}
}

const fixable = missing.filter(m => m.cands.length);
const hopeless = missing.filter(m => !m.cands.length);

console.log(`扫到条目: ${total} | 仍缺图: ${missing.length} | 可再修: ${fixable.length} | 真无: ${hopeless.length}`);

if (fixable.length) {
	console.log("\n【可再修】加个 img: 字段即可(⚠️ 务必先核对中文名,同音不同人是真陷阱:张既≠张济、王越≠王悦):");
	for (const m of fixable) console.log(`  ${m.pack}/${m.id}  →  候选: ${m.cands.join(", ")}`);
}
if (hopeless.length) {
	console.log("\n【真无】没有同人物立绘可复用,只能外部找图(规格见 docs/CHARACTER-IMAGES.md)或等上游:");
	for (const m of hopeless) console.log(`  ${m.pack}/${m.id}`);
}
if (!missing.length) console.log("\n✅ 零剪影。");
