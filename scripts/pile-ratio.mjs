/**
 * 牌堆构成计算器 —— 算「开了哪些卡牌包 + 禁了哪几张 + 牌堆补充怎么设」之后，
 * 牌堆里基本/锦囊/装备各占多少、杀闪桃各多少张。
 *
 * 为什么需要它：开了扩展卡牌包（尤其是纯装备包如曹操传）以后，手感会变，
 * 但「变了多少」肉眼算不出来 —— 因为 cardpile 扩展的补充量是个非线性公式，
 * 牌堆越大补得越多。每次靠对话临时算一遍太慢，故固化成脚本。
 *
 * 三个数据来源，全部从源码里读，不手抄：
 *  1. 各包的 `list`（apps/core/card/*.js）—— 每张牌的花色/点数/牌名
 *  2. 各包 `card` 里每张牌的 `type`/`subtype` —— 用来归类基本/锦囊/延时/装备
 *  3. cardpile 扩展的参照表（apps/core/extension/cardpile/extension.js）
 *
 * 【补充公式】（extension/cardpile/extension.js:75）
 *   num = Σ round(参照表张数 × 该类倍率)        // 倍率 = 补充全部 1 / 补充一半 0.5 / 不补充 0
 *   dn  = num × (牌堆总数 − 160) / (160 − num)  // 上限 1000
 *   各类补充 = round(dn × 该类 getn / num)
 * 参照表是「军争 160 张」的**固定字面量**，与你实际开了哪些包无关 ——
 * 也就是说补充部分的构成永远是军争配比（其中杀占 44/113 ≈ 38.9%）。
 *
 * 【由此得到的关键结论】设某包自身杀密度为 s，则往牌堆里加 1 张牌会连带补充
 * 2.404 张，合计 +3.404 张，其中杀 = s + 0.936。故**边际杀密度 = (s + 0.936) / 3.404**：
 *   · 一个 0 杀的包 → 27.5%，正好等于当前杀比例，**完全不稀释杀**
 *   · 一个 27% 杀的包 → 35.4%，**反而把杀比例拉高**
 * 所以「开扩展包会稀释杀」这个直觉，在开了牌堆补充之后是错的：被稀释的是装备和锦囊。
 *
 * 用法：
 *   node scripts/pile-ratio.mjs                      # 跑内置对照场景
 *   node scripts/pile-ratio.mjs --packs standard,extra,caocaozhuan \
 *        --ban hanbing,fangtian,bagua,zhuge,tengjia --refill all
 *   --refill 取值：all（全部补充）/ default（游戏默认档）/ none（关掉扩展）
 *                  或逐项指定 sha=1,shan=1,tao=0.5,...
 *   --packs 可选：standard extra sp yingbian guozhan zhulu xianxia yongjian huodong caocaozhuan
 *   --ban   写牌名（如 bagua），重复的牌写几次就禁几张
 */
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CARD_DIR = path.join(ROOT, "apps/core/card");
const ALL_PACKS = ["standard", "extra", "sp", "yingbian", "guozhan", "zhulu", "xianxia", "yongjian", "huodong", "caocaozhuan"];

// ── cardpile 扩展的军争参照表（与 extension/cardpile/extension.js:8-62 逐字对应）──
const REF = {
	sha: { diamond: 6, club: 14, heart: 3, spade: 7 },
	huosha: { diamond: 2, heart: 3 },
	leisha: { spade: 5, club: 4 },
	shan: { heart: 6, diamond: 18 },
	jiu: { diamond: 1, spade: 2, club: 2 },
	tao: { heart: 9, diamond: 3 },
	wanjian: { heart: 1 },
	nanman: { spade: 2, club: 1 },
	guohe: { spade: 3, club: 2, heart: 1 },
	shunshou: { spade: 3, diamond: 2 },
	wuxie: { heart: 2, diamond: 1, spade: 2, club: 2 },
	tiesuo: { spade: 2, club: 4 },
};
const REF_TOTAL = 160;
/** 游戏里各项的 init 值（library/index.js extensionMenu.cardpile）*/
const CFG_DEFAULT = { sha: 1, huosha: 1, leisha: 1, shan: 1, tao: 0, jiu: 0, wuxie: 0.5, nanman: 0, wanjian: 0, guohe: 0, shunshou: 0, tiesuo: 0 };
const CFG_ALL = Object.fromEntries(Object.keys(REF).map(k => [k, 1]));
const CFG_NONE = Object.fromEntries(Object.keys(REF).map(k => [k, 0]));

/** 花括号/方括号配平地切出从 `from` 之后第一个 `{`（或 `[`）起的完整字面量，跳过字符串和注释 */
function sliceLiteral(src, from) {
	let s = from;
	while (s < src.length && src[s] !== "{" && src[s] !== "[") {
		s++;
	}
	let depth = 0;
	for (let i = s; i < src.length; i++) {
		const c = src[i];
		if (c === "{" || c === "[") {
			depth++;
		} else if (c === "}" || c === "]") {
			depth--;
			if (!depth) {
				return [s, i + 1];
			}
		} else if (c === '"' || c === "'" || c === "`") {
			const q = c;
			i++;
			while (i < src.length && src[i] !== q) {
				if (src[i] === "\\") {
					i++;
				}
				i++;
			}
		} else if (c === "/" && src[i + 1] === "/") {
			i = src.indexOf("\n", i);
		} else if (c === "/" && src[i + 1] === "*") {
			i = src.indexOf("*/", i) + 1;
		}
	}
	return [s, -1];
}

/**
 * 读所有卡牌包，返回 { lists, types, names }。
 * 少数包的 list 里有动态项（随机花色/点数），用桩求值 —— 我们只关心牌名。
 */
async function loadPacks() {
	const lists = {};
	const types = {};
	const names = {};
	const stubLib = { suit: { randomGet: () => "spade" } };
	const stubGet = { rand: () => 1 };
	for (const pack of ALL_PACKS) {
		const src = (await fs.readFile(path.join(CARD_DIR, `${pack}.js`), "utf8")).split("\r\n").join("\n");

		const listAt = src.indexOf("\n\tlist: [");
		if (listAt >= 0) {
			const [s, e] = sliceLiteral(src, listAt);
			lists[pack] = new Function("lib", "get", `return ${src.slice(s, e)}`)(stubLib, stubGet);
		} else {
			lists[pack] = [];
		}

		const cardAt = src.indexOf("\n\tcard: {");
		if (cardAt >= 0) {
			const [cs, ce] = sliceLiteral(src, cardAt);
			const body = src.slice(cs, ce);
			const re = /\n\t\t([A-Za-z_]\w*): \{/g;
			let m;
			while ((m = re.exec(body))) {
				const [bs, be] = sliceLiteral(body, m.index + m[0].length - 1);
				const blk = body.slice(bs, be);
				// 只认第一层（三个 tab）的 type，避免读到技能里嵌套的同名字段
				const t = blk.match(/\n\t\t\ttype: "(\w+)"/);
				if (t) {
					types[m[1]] ??= t[1];
				}
				re.lastIndex = m.index + m[0].length - 1 + (be - bs);
			}
		}
		for (const m of src.matchAll(/\n\t\t([A-Za-z_]\w*): "([^"]{1,16})",/g)) {
			if (!/_info$|_config$/.test(m[1])) {
				names[m[1]] ??= m[2];
			}
		}
	}
	return { lists, types, names };
}

/** 火杀/雷杀在牌堆装配后会被改写成带属性的杀（game/index.js:8011） */
const norm = n => (n === "huosha" || n === "leisha" ? "sha" : n);

const BUCKET = { basic: "基本", trick: "锦囊", delay: "延时", equip: "装备" };

function build({ lists, types }, { packs, banned = {}, cfg }) {
	// ① 各包 list 汇总；banned 按张数削减（计数分析下与游戏里按 index 删等价）
	const base = [];
	for (const pack of packs) {
		const quota = { ...banned };
		for (const entry of lists[pack]) {
			const name = entry[2];
			if (quota[name] > 0) {
				quota[name]--;
				continue;
			}
			base.push(name);
		}
	}
	const packTotal = base.length;

	// ② cardpile 补充
	let num = 0;
	const getn = {};
	for (const type in REF) {
		for (const suit in REF[type]) {
			const v = Math.round(REF[type][suit] * cfg[type]);
			getn[`${type}|${suit}`] = v;
			num += v;
		}
	}
	let dn = (num * (packTotal - REF_TOTAL)) / (REF_TOTAL - num);
	if (dn > 1000) {
		dn = 1000;
	}
	const refill = [];
	if (dn > 0) {
		for (const key in getn) {
			let n = Math.round((dn * getn[key]) / num);
			const type = key.split("|")[0];
			while (n--) {
				refill.push(type);
			}
		}
	}

	const all = [...base, ...refill];
	const byName = {};
	const byBucket = {};
	for (const raw of all) {
		const name = norm(raw);
		byName[name] = (byName[name] || 0) + 1;
		const b = BUCKET[types[name]] ?? "??";
		byBucket[b] = (byBucket[b] || 0) + 1;
	}
	return { packTotal, num, dn, refillTotal: refill.length, total: all.length, byName, byBucket };
}

function report(title, r) {
	const pct = v => `${((v / r.total) * 100).toFixed(1)}%`;
	const g = n => r.byName[n] || 0;
	const pad = (v, n) => String(v).padStart(n);
	console.log(`\n=== ${title} ===`);
	console.log(`包内 ${r.packTotal} 张 + 补充 ${r.refillTotal} 张（num=${r.num}, dn=${r.dn.toFixed(2)}）= 总计 ${r.total} 张`);
	console.log(`  基本 ${pad(r.byBucket["基本"] || 0, 3)} ${pad(pct(r.byBucket["基本"] || 0), 6)}   ` + `装备 ${pad(r.byBucket["装备"] || 0, 3)} ${pad(pct(r.byBucket["装备"] || 0), 6)}   ` + `锦囊 ${pad(r.byBucket["锦囊"] || 0, 3)} ${pad(pct(r.byBucket["锦囊"] || 0), 6)}   ` + `延时 ${pad(r.byBucket["延时"] || 0, 3)} ${pad(pct(r.byBucket["延时"] || 0), 6)}`);
	console.log(`  杀 ${pad(g("sha"), 4)} ${pad(pct(g("sha")), 6)}   闪 ${pad(g("shan"), 4)} ${pad(pct(g("shan")), 6)}   ` + `桃 ${pad(g("tao"), 4)} ${pad(pct(g("tao")), 6)}   酒 ${pad(g("jiu"), 3)}   杀:闪 = ${(g("sha") / g("shan")).toFixed(2)}`);
	return r;
}

function parseRefill(arg) {
	if (!arg || arg === "all") {
		return CFG_ALL;
	}
	if (arg === "default") {
		return CFG_DEFAULT;
	}
	if (arg === "none") {
		return CFG_NONE;
	}
	const cfg = { ...CFG_NONE };
	for (const kv of arg.split(",")) {
		const [k, v] = kv.split("=");
		if (!(k in REF)) {
			throw new Error(`--refill 里 "${k}" 不是牌堆补充的项（可选：${Object.keys(REF).join(" ")}）`);
		}
		cfg[k] = parseFloat(v);
	}
	return cfg;
}

const argv = process.argv.slice(2);
const arg = name => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : null;
};

const data = await loadPacks();

if (arg("packs")) {
	const packs = arg("packs").split(",");
	for (const p of packs) {
		if (!ALL_PACKS.includes(p)) {
			throw new Error(`没有卡牌包 "${p}"（可选：${ALL_PACKS.join(" ")}）`);
		}
	}
	const banned = {};
	for (const n of (arg("ban") || "").split(",").filter(Boolean)) {
		banned[n] = (banned[n] || 0) + 1;
	}
	report(`${packs.join("+")}${Object.keys(banned).length ? ` 禁${Object.values(banned).reduce((a, b) => a + b, 0)}张` : ""}`, build(data, { packs, banned, cfg: parseRefill(arg("refill")) }));
} else {
	// 内置对照场景：军争基准 → 当前配置 → 逐个候选包的边际效果
	const BAN = { hanbing: 1, fangtian: 1, bagua: 1, zhuge: 1, tengjia: 1 };
	const CUR = ["standard", "extra", "caocaozhuan"];
	report("① 军争基准（standard+extra，不开补充）", build(data, { packs: ["standard", "extra"], cfg: CFG_NONE }));
	report("② +曹操传，禁 5 张重复装备，全部补充", build(data, { packs: CUR, banned: BAN, cfg: CFG_ALL }));
	report("③ 同②但用游戏默认补充档", build(data, { packs: CUR, banned: BAN, cfg: CFG_DEFAULT }));
	report("④ 同②但关掉牌堆补充", build(data, { packs: CUR, banned: BAN, cfg: CFG_NONE }));
	console.log("\n\n──────── 在②的基础上再开一个包 ────────");
	for (const p of ["sp", "zhulu", "yongjian", "xianxia", "guozhan", "huodong", "yingbian"]) {
		report(`② + ${p}`, build(data, { packs: [...CUR, p], banned: BAN, cfg: CFG_ALL }));
	}
	console.log("\n\n──────── 推荐组合 ────────");
	report("② + zhulu + sp", build(data, { packs: [...CUR, "zhulu", "sp"], banned: BAN, cfg: CFG_ALL }));
}
