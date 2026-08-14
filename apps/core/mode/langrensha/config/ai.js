import { lib, game, get, _status } from "noname";

/* ========================= 狼人杀的 AI 态度 =========================
 *
 * 本模式的 AI 决策全部靠 get.attitude 排序（夜间狼刀/预言/开枪、白天出牌都是），
 * 原来 get.attitude 返回恒定 -1，所有目标同分，等于随机。
 *
 * 直接照搬身份模式不行：identity.js:3882 的 real*shown 靠"主公身份公开"破冰
 * （identity.js:327 把 game.zhu.ai.shown 直接置 1），而狼人杀全场无人公开，
 * 所有人 ai.shown 都是 0 → real*shown 全为 0 → get.effect 全为 0 → 白天没人出【杀】，
 * 而这个模式死人主要靠白天出【杀】，等于死局。所以先验必须自带权重。
 *
 * 态度由三条通道合成，优先级从高到低：
 *   ① 铁证    —— 狼队友开局互亮、结算后公开身份、预言家自己验出的"狼"
 *   ② 推定    —— 预言家验出的"好人"（隐狼的查验结果就是好人，所以只算推定）、
 *                被狼刀或被女巫救活的人（掉血/复活是公开可见的，全场共享这个推断）
 *   ③ 板子期望 —— 完全没信息时，按板子的公开构成算"随便一个人是狼"的概率
 *
 * ai.shown（行为暴露度，由下面的 logAi 驱动）只作为①的透出权重：越暴露，真实阵营
 * 越占主导。这沿用身份模式的"有限作弊"设计——ai.shown 表达的不是"我推断他是狼"，
 * 而是"他的真实阵营能透出多少"。真正的逐人信念推理是另一个量级，本次不做。
 */

/**
 * 读模式配置，一份逻辑同时服务联机和单机。
 *
 * 联机的房间配置在 lib.configOL 里，键名是 connect_xxx 去掉前缀后的样子
 * （switchMode 里 `lib.configOL[i.slice(8)] = get.config(i)`）；单机则直接 get.config(键名)，
 * 且 lib.configOL 在单机是 undefined（Library.prototype.configOL = undefined），不能瞎点。
 * 所以只要 library/index.js 里两边的键名对齐，这里传同一个字符串即可。
 *
 * 放在 ai.js 而不是 index.js：index.js 要 import 本模块，反向 import 会成环。
 */
export function swConfig(key) {
	return _status.connectMode ? lib.configOL[key] : get.config(key);
}

/** 阵营两两之间的基础态度。敌人权重故意大于队友：漏掉一头狼直接输，打错一个好人只是少个帮手 */
const CAMP_ATTITUDE = {
	lang: { lang: 6, ren: -6, npc: -2 },
	ren: { lang: -6, ren: 4.5, npc: 1 },
	// 觉孤认下偶像前是中立的，谁都不想打
	npc: { lang: 0.5, ren: 0.5, npc: 0.5 },
};

function campAttitude(fromCamp, toCamp) {
	return CAMP_ATTITUDE[fromCamp]?.[toCamp] ?? 0;
}

/** 板子里狼阵营的总人数。身份构成是公开信息（规则说明和 getIdentityList 都列了），可以拿来算先验 */
function totalLangCount() {
	const list = _status.identityList;
	if (!Array.isArray(list)) {
		return 3;
	}
	return list.filter(identity => ["lang", "yinlang", "langwang", "bailang"].includes(identity)).length;
}

/**
 * 标记一名角色"被全场推定为好人"。
 *
 * 狼刀掉血和女巫复活都是公开可见的，而狼不会刀自己队友，所以全场都会做这个推断。
 * 存在 player.ai 上而不是 swState：swState 会被 game.getState/syncState 整块广播给所有客户端，
 * player.ai 只有 ai.shown 会同步，AI 又只在主机侧跑，放这儿不会泄漏。
 * 唯一会被骗到的是隐狼——它被刀了也会被推定成好人，这是故意留着的（人类玩家也会这么误判）。
 */
export function markGuessedGood(target) {
	if (!target?.ai) {
		return;
	}
	target.ai.swCampGuess = "ren";
}

/** 记下预言家自己的验人结果。同样挂 player.ai，别人读不到，AI 不会集体知道底牌 */
export function markInsight(seer, target, result) {
	if (!seer?.ai || !target?.playerid) {
		return;
	}
	seer.ai.swInsight ??= {};
	seer.ai.swInsight[target.playerid] = result;
}

/**
 * 从 from 的视角推定 to 的阵营。
 * confidence 为 1 表示铁证，小于 1 表示可以被欺骗的推定，0 表示一无所知。
 */
function guessCamp(from, to) {
	if (to.identityShown) {
		return { camp: to.getCamp(), confidence: 1 };
	}
	// 狼阵营开局互亮身份（见 chooseCharacterOL 里的 showIdentitySelf 广播）。
	// isLang() 默认把隐狼排除在外，正是"隐狼与狼队友互相不可见"，别改成 isLang(true)
	if (from.isLang() && to.isLang()) {
		return { camp: "lang", confidence: 1 };
	}
	const seen = to.playerid ? from.ai?.swInsight?.[to.playerid] : null;
	if (seen === "huai") {
		return { camp: "lang", confidence: 1 };
	}
	// 查成"好人"只是推定：隐狼的查验结果也是好人（见 get.insightResult）
	if (seen === "hao") {
		return { camp: "ren", confidence: 0.9 };
	}
	if (to.ai?.swCampGuess) {
		// 【狼看这条信息比别人准】swCampGuess 只有"被狼刀过 / 被女巫救活"两种来源，
		// 而狼刀是狼自己下的 —— 狼队清楚谁挨过刀，也就清楚那人不是自己队友，所以对狼是铁证。
		// 别人只能推定（0.75），因为理论上狼可能刀到隐狼队友。
		// 这条不给足置信会有个很反直觉的后果：刀过一个人反而让狼对他没那么恨
		// （-6.34 变 -4.50），把补刀的优先级压到"没刀过的满血人"之下，第二轮不会去收残血。
		return { camp: to.ai.swCampGuess, confidence: from.isLang() ? 1 : 0.75 };
	}
	return { camp: null, confidence: 0 };
}

/** 基于真实阵营的态度。只在有铁证、或按 ai.shown 折算的比例内使用 */
function trueAttitude(from, to) {
	let att = campAttitude(from.getCamp(), to.getCamp());
	// 屠边模式下神职或平民任一类全灭即狼胜，所以狼优先啃只剩一两个人的那一类
	if (att < 0 && from.getCamp() === "lang" && swConfig("langrensha_victoryMode") != "tucheng") {
		const sub = to.getCamp(true);
		if ((sub === "shen" || sub === "ren") && get.campPopulation(sub, true) <= 2) {
			att -= 2;
		}
	}
	return att;
}

/** 不看真实阵营的推定态度：有推定就按推定折算，没有就按板子构成算期望 */
function beliefAttitude(from, to, guess) {
	const myCamp = from.getCamp();
	if (guess.camp) {
		return campAttitude(myCamp, guess.camp) * guess.confidence;
	}
	let unknown = 0;
	let knownLang = myCamp === "lang" ? 1 : 0;
	for (const current of game.players) {
		if (current === from) {
			continue;
		}
		const currentGuess = guessCamp(from, current);
		if (currentGuess.confidence >= 1) {
			if (currentGuess.camp === "lang") {
				knownLang++;
			}
			continue;
		}
		unknown++;
	}
	// 死者的身份到结算才公开，所以场上还剩几头狼是算不出来的，只能用板子总数减掉自己确定的那些。
	// 后果是死了狼之后会偏多疑——这不是作弊，是信息不足下的高估，正好抵掉好人前期过于保守
	const langRatio = unknown > 0 ? Math.max(0, Math.min(1, (totalLangCount() - knownLang) / unknown)) : 0;
	const base = campAttitude(myCamp, "lang") * langRatio + campAttitude(myCamp, "ren") * (1 - langRatio);
	// 【期望为正时必须压到 0】狼占比低于约 43% 时（普通板 9/10 人、觉孤板 6/9 人都是这样），
	// 上面这个期望值会翻正 —— 数学上没错（陌生人大概率是好人），但后果是好人把所有陌生人
	// 当盟友，白天一张【杀】都不出，而这个模式的好人只能靠白天出杀赢，直接成死局。
	// 所以取"不了解的人最多算中立、不能算盟友"：压到 0 以内。
	// 代价是丢掉"人越多越放心"这层细腻度，但那层细腻度产出的是不可用的正值，不值得留。
	const capped = Math.min(base, 0);
	// 再减一个"越强越该压制"的偏置和一个极小常数，保证一定为负且目标之间有区分度。
	// 否则所有人分数完全相同，ai.basic.chooseTarget 在 check(best)<=0 时会让 AI 集体空过
	// （basic.js:223），或者全都同分导致选谁纯看座位顺序。
	const threat = Math.min(0.4, (to.hp + to.countCards("h") / 2) * 0.04);
	return capped - threat - 0.1;
}

/**
 * 只实现 rawAttitude，不要覆盖 attitude：外面那层 get.attitude（get/index.js:6547）
 * 还要处理 isMad 反转和 modAttitudeFrom/To，覆盖掉就全丢了。
 */
export function rawAttitude(from, to) {
	if (!from || !to) {
		return 0;
	}
	if (from === to) {
		return 10;
	}
	// 觉孤对偶像：偶像死在自己手上直接判本局目标失败，所以不管偶像什么阵营都得护住
	if (from?.swState?.jx_anlian === to) {
		return 8;
	}
	const guess = guessCamp(from, to);
	if (guess.confidence >= 1) {
		return trueAttitude(from, to);
	}
	// 【tempIgnore：本体的"别再针对同一个人"机制，必须读】
	// player.useCard / useSkill 每次出牌都会把态度落在 [-1, 0) 的目标塞进 from.ai.tempIgnore
	// （player.js:7736、7805），每人回合开始时清空（content.ts:3362）。它的用途就是让 AI
	// 一个回合内不要死盯一个人 —— 国战的 rawAttitude 就是靠返回 0 来实现的
	// （guozhan/src/patch/get.js:299）。
	// 本模式尤其踩得准：未知玩家的态度稳定在 -0.34 左右，正好每次都落进那个区间，
	// 于是 tempIgnore 一直在积累却没人读，AI 就会一轮又一轮对同一个目标出同一种牌。
	// 返回 0 让 -attitude 归零，AI 本回合就会转去看别人（回合结束自动解除）。
	if (_status.currentPhase === from && from.ai?.tempIgnore?.includes(to)) {
		return 0;
	}
	// 行为暴露度决定真实阵营能透出多少，其余份额交给推定/先验
	const shown = Math.max(0, Math.min(0.95, to.ai.shown || 0));
	let att = trueAttitude(from, to) * shown + beliefAttitude(from, to, guess) * (1 - shown);
	// 难度只在单机生效：联机房里对房主单独手软/加压对其他真人不公平
	if (!_status.connectMode && to === game.me) {
		att += (2 - get.difficulty()) * 1.5;
	}
	return att;
}

/**
 * 行为暴露度的更新入口。
 *
 * core 只在 useCard/useSkill 里做 `typeof this.logAi == "function"` 判断
 * （player.js:7744 / 7812），本体没有默认实现，各模式自己写一份（identity.js:3276 是范本）。
 * 狼人杀原来没写，所以就算修好 attitude，ai.shown 也会永远停在 0，混合公式退化成纯先验。
 *
 * 判定逻辑：对一个"阵营已经看得懂"的人做出有利于自己的事，自己的阵营也就跟着透出来了。
 * 目标还没被看穿的话，帮他/砍他都推不出行动者的立场，系数按目标的可读程度打折。
 */
export function logAi(targets, card) {
	// 【整体包一层 try/catch，不是防御性洁癖，是必须的】
	// core 在 player.useCard / useSkill 里是**不加保护**地调 logAi 的（player.js:7761 / 7813），
	// 就在事件真正建立之前。所以这里一抛，整次出牌就断在半路：牌没被消耗、事件没跑完，
	// 而 AI 的评估条件没变，下一轮又选同一张 —— 表现就是"历史记录里同一个动作无限重复、
	// 手牌数一直不变"，整局卡死。
	// 而 logAi 干的事只是记一笔"暴露度"，纯 AI 记账，失败了最多让 AI 判断得糙一点，
	// 绝不该有能力打断一次出牌。所以宁可吞掉异常并打日志。
	// 主要风险点是下面的 get.effect：它遇到玩家身上有未注册技能时会直接 throw
	// （get/index.js 的 `throw new Error(skill + "不存在的技能")`），而 card 参数还可能是
	// 技能名字符串（useSkill 那条路传的就是 next.skill），各卡牌/技能自己写的
	// ai.effect.target 未必都能接住字符串。
	try {
		logAiUnsafe.call(this, targets, card);
	} catch (e) {
		console.warn("[狼人杀] logAi 出错，已忽略（不影响出牌，但 AI 暴露度这次没记上）", e, {
			player: this?.name,
			card: typeof card === "string" ? card : card?.name,
		});
	}
}

function logAiUnsafe(targets, card) {
	if (this.identityShown || this.ai.shown >= 0.95 || this.isMad()) {
		return;
	}
	if (typeof targets == "number") {
		this.addExpose(targets);
		return;
	}
	if (!Array.isArray(targets) || !targets.length) {
		return;
	}
	const info = get.info(card);
	if (info?.ai?.expose) {
		this.addExpose(info.ai.expose);
	}
	let effect = 0;
	for (const target of targets) {
		// swCampGuess 是公开推断（被狼刀过），所以这类目标一律算"完全可读"
		const legible = target.ai?.swCampGuess ? 1 : Math.max(0, Math.min(1, target.ai.shown || 0));
		const coefficient = legible < 0.2 ? 0 : legible < 0.4 ? 0.5 : legible < 0.6 ? 0.8 : 1;
		if (!coefficient) {
			continue;
		}
		effect += get.effect(target, card, this) * coefficient;
	}
	const targetsSelfOnly = targets.length == 1 && targets[0] == this;
	if (effect > 0 && !targetsSelfOnly) {
		// 让 AI 托管的角色暴露得快一倍。身份模式是把累计值整体 *=2（identity.js:3326），
		// 这里改成只放大本次增量——避免和上面 info.ai.expose 那一笔叠成复利
		const scale = (effect < 1 ? 0.5 : 1) * (this == game.me ? 1 : 2);
		this.addExpose((targets.length == 1 ? 0.2 : 0.1) * scale);
	}
}
