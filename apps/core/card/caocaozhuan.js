import { lib, game, ui, get, ai, _status } from "noname";

export const type = "card";

/**
 * 曹操传宝物卡牌包
 *
 * 取材于 KOEI《三國志曹操傳》的宝物系统。原作是单机 RPG，宝物给的是属性加成
 * （攻击力+15、防御力+10、MP+20 之类），三国杀里没有这些概念，故一律折算成
 * 触发式效果。折算原则：
 *   1. **优先做成被动/锁定技** —— AI 有通用的装备估值逻辑，被动装备零 AI 成本；
 *      需要主动决策的效果得另写 ai 字段，容易写歪（狼人杀那六个身份没写 AI，
 *      单机直接卡死在夜间刀人那步，就是活教材）。
 *   2. **能挂本体现成技能的绝不自己写** —— 少一份代码就少一处走样，而且现成技能
 *      的 AI 早就调好了。本包里遁甲天书/青囊书/养由基之弓都是直接挂。
 *   3. MP、经验值、移动力、地形这类原作概念在三国杀里无对应物，相关宝物不做
 *      （白羽扇、圣者宝剑、六韬、三略、风车轮…）。
 *
 * 【为什么不做成扩展而做成本体卡牌包】本 fork 是纯静态部署，而「制作扩展」生成的
 * 代码要靠原生 import() 去 fetch /extension/<名>/extension.js —— 那个路径在 CDN 上
 * 不存在，装了重启即失效（详见 README-PWA）。本体卡牌包跟着构建走，卡面图自动
 * 进核心清单，还能在「选项 → 卡牌」里跟其他包并列勾选。
 *
 * 【id 一律带 ccz_ 前缀】避免与本体、以及民间卡牌(bxyr_)等第三方包撞名。
 * 撞名的后果是后加载的覆盖前面的，且不报错 —— 极难排查。
 *
 * 【牌堆比例提醒】本包 18 张里装备占满 18 张，单开「标准」时装备占比会从 17.6%
 * 升到 29.4%（实测算过）。若觉得净摸装备，有三个现成手段：
 *   · 开启内置扩展「牌堆比例」(cardpile)，它按军争 160 张的官方花色分布自动补基本牌；
 *   · 在「编辑牌堆」里单独勾掉不想要的卡（bannedpile）；
 *   · 全开 9 个卡牌包时本包影响很小（17.7% → 20.6%）。
 */

/**
 * 装备技能的通用前置检查：目标有没有"无视防具"能力。
 * 【为什么每个防具都要查】本体的 unequip / unequip2 是"无视防具"机制的实现
 * （青釭剑、朱雀羽扇的部分效果、以及一些武将技能都会设它）。防具类技能若不查，
 * 就会出现"青釭剑无视了防具，但我们的防具还是生效了"的规则错误。
 * 抄的是 extra.js 里藤甲(tengjia3)与白银狮子(baiyin_skill)的写法。
 */
function armorValid(event, player) {
	if (player.hasSkillTag("unequip2")) {
		return false;
	}
	const src = event.source || event.player;
	if (
		src &&
		src.hasSkillTag("unequip", false, {
			name: event.card ? event.card.name : null,
			target: player,
			card: event.card,
		})
	) {
		return false;
	}
	return true;
}

/** @type { importCardConfig } */
export default {
	name: "caocaozhuan",
	connect: true,
	card: {
		// ================= 武器 =================

		/**
		 * 方天画戟 —— 原版（本体 standard 的 fangtian）是"手里只剩这一张牌时【杀】可指定
		 * 任意多目标"，条件苛刻到几乎不触发。这里按曹操传的"引导攻击"重做成扩散伤害。
		 * 【为什么"每名角色每回合限一次"能防住无限连锁】视为使用的【杀】若造成伤害，
		 * 会再次满足本技能的触发条件 → 又能弃牌打下一个 → 一圈打完全场。而场上人数
		 * 有限、每人只能被此法指定一次，最坏情况一圈即止，不可能无限。
		 * 比"每回合限一次"更好的是：多杀武将（黄盖、张飞）仍能连续触发，符合"越打越顺"。
		 */
		ccz_fangtianhuaji: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -3 },
			ai: { basic: { equipValue: 6 } },
			skills: ["ccz_fangtianhuaji_skill"],
		},

		/**
		 * 吕布之弓 —— 原作"麻痹攻击"。三国杀里最贴近"麻痹"的是让人下回合打不出输出。
		 * 【为什么范围只给 3】本体的规律是效果越强、攻击范围越小：雌雄/青釭范围 2（ev2）、
		 * 青龙/蛇矛/贯石斧范围 3（ev3~4）、麒麟弓范围 5 但效果最弱（ev3）。
		 * "下回合不能使用【杀】"等于让对手空一轮输出，比麒麟弓强得多，
		 * 再给范围 5 就是双强 —— 故取范围 3（attackFrom -2），ev 给 5。
		 */
		ccz_lvbuzhigong: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -2 },
			ai: { basic: { equipValue: 5 } },
			skills: ["ccz_lvbuzhigong_skill"],
		},

		/** 李广之弓 —— 原作"禁咒攻击"（使敌人无法使用策略）→ 下回合不能发动技能 */
		ccz_ligzhigong: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -2 },
			ai: { basic: { equipValue: 5 } },
			skills: ["ccz_ligzhigong_skill"],
		},

		/**
		 * 金火罐炮 —— 原作"中毒攻击"。poison 是本体原生支持的属性（lib.nature 里与
		 * fire/thunder/ice/stab/kami 并列，有自己的配色与音效），不需要自己造判定。
		 * 【毒的特殊之处】player.js 里 `if (next.hasNature("poison")) delete next._triggered`
		 * —— 毒伤害**无法被"防止伤害"类效果拦住**（藤甲、仁王盾那种"此伤害无效"对它失效）。
		 * 所以它天生穿防具，比火/雷都强，故攻击范围只给 1（炮车笨重，符合原作）。
		 */
		ccz_jinhuoguanpao: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			ai: { basic: { equipValue: 6 } },
			skills: ["ccz_jinhuoguanpao_skill"],
		},

		/**
		 * 五火神焰扇 —— 原作"辅助火类策略"。
		 * 【为什么判据是"火属性伤害"而不是"火杀或火攻"】前者自动覆盖一切火属性来源
		 * （火【杀】、【火攻】、以后新增的火系卡、武将的火技能），正是"增强火系输出"的原意；
		 * 后者要逐个枚举，加一张新卡就漏一处。
		 * 注意它与太平要术互为攻防：打装了太平要术的人，对方反而多回 1 血。
		 */
		ccz_wuhuoshenyanshan: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -1 },
			ai: { basic: { equipValue: 4 } },
			skills: ["ccz_wuhuoshenyanshan_skill"],
		},

		/** 七星剑 —— 原作"辅助策略命中"→ 你的锦囊不可被【无懈可击】响应 */
		ccz_qixingjian: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -1 },
			ai: { basic: { equipValue: 6 } },
			skills: ["ccz_qixingjian_skill"],
		},

		/**
		 * 养由基之弓 —— 原作是把箭术练到极致的名将，效果同甘宁〖乱击〗
		 * （两张同花色手牌当【万箭齐发】使用）。
		 * 【为什么自带一份而不直接挂 luanji】luanji 定义在 shenhua 武将包里，
		 * 而武将包是可以被玩家关掉的 —— 关了之后这张卡就成了"AI 照样穿、但没有任何
		 * 效果"的哑巴装备，不报错、极难查。本体全部 9 个卡牌包也都是自带技能定义，
		 * 没有一个跨包挂武将技能的先例。故本包三处外部依赖全部改为自带。
		 * loading.ts 里 `if (lib[configName][itemName] == null)` 保证不覆盖已有同名技能，
		 * 所以用独立的 ccz_ 前缀名，两边共存无冲突。
		 */
		ccz_yangyoujizhigong: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -3 },
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_luanji"],
		},

		// ================= 防具 =================

		/**
		 * 镜铠 —— 原作"防御远距攻击"（大幅克制弓箭等远程物理）。
		 * 【为什么判据是攻击范围而不是"弓"】卡面右上角那个字（qilin_bg:"弓"）只是显示用，
		 * 本体只有麒麟弓/诸葛连弩两张标了它，靠单字匹配以后加卡必漏。改用"来源装备区里
		 * 有攻击范围 ≥4 的武器"——弓类武器的共性就是远程，判据客观、新卡自动生效。
		 * 门槛取 4 而非 3：≥4 只圈住麒麟弓(5)、方天画戟(4)、朱雀羽扇(4) 三把；
		 * ≥3 会把贯石斧、丈八蛇矛等一批 attackFrom:-2 的近战武器也算进来，太宽。
		 */
		ccz_jingkai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_jingkai_skill"],
		},

		/**
		 * 连环铠 —— 原作"防御两次攻击"（敌人的连续攻击只算一次）。
		 * 译成"每回合只受一次【杀】造成的伤害"，非【杀】的伤害不受影响。
		 * 【为什么用 clearTime】它让技能存的标记在回合结束时自动清空，
		 * 不用自己挂 phaseEnd 去擦（standard.js 的 qinglong_skill 就这么用）。
		 */
		ccz_lianhuankai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 8 } },
			skills: ["ccz_lianhuankai_skill"],
		},

		/** 黄金铠 —— 原作"防御致命一击"→ 防止一切属性伤害（火/雷/冰/毒…） */
		ccz_huangjinkai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_huangjinkai_skill"],
		},

		/**
		 * 白银铠 —— 原作"减轻策略损伤"。
		 * 【实际范围比字面宽，这是有意的】"技能造成的伤害"在代码里没有直接标记，
		 * 只能反向判断 `!event.card`（没有来源卡）。这会顺带挡住毒伤害等一切无源伤害。
		 * 与原作"减轻策略损伤"的泛指相符，故接受这个宽度，不再另加判据
		 * （若要严格只挡技能，得去查 event.getParent() 的名字是否为技能名，更复杂也更易漏）。
		 */
		ccz_baiyinkai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_baiyinkai_skill"],
		},

		/**
		 * 龙鳞铠 —— 原作"防御MP"，三国杀无 MP 概念，改成防锦囊伤害。
		 * 它挡住的是很大一块：决斗、火攻、南蛮入侵、万箭齐发、闪电、火烧连营…
		 * 故 ev 给到 8（本包最高的防具）。
		 */
		ccz_longlinkai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 8 } },
			skills: ["ccz_longlinkai_skill"],
		},

		/** 凤凰羽衣 —— 原作"每回合恢复HP"，原样照做 */
		ccz_fenghuangyuyi: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_fenghuangyuyi_skill"],
		},

		// ================= 宝物（equip5，与木牛流马同栏，一次只能装一件）=================

		/**
		 * 遁甲天书 —— 原作"策略模仿"（可以复制敌方使用的策略）。
		 * 效果同 ps2070 郭嘉〖全谋〗：其他角色使用锦囊结算结束后，若你是目标，
		 * 你可以弃置一张与此牌颜色相同的手牌并获得之——语义与原作"模仿策略"一致。
		 * 【为什么自带一份】psquanmou 在 offline 武将包里，包被关掉这张卡就成了哑巴装备。
		 */
		ccz_dunjiatianshu: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 8 } },
			skills: ["ccz_quanmou"],
		},

		/**
		 * 青囊书 —— 效果与本体那张（mb_qingnangshu）完全一致，即华佗〖青囊〗。
		 * 【为什么另做一张而不复用】本体那张属 huodong 包，只有开那个包才摸得到；
		 * 这里是让开曹操传包的人也能摸到。id 带 ccz_ 前缀，两个包同开时会有两张，不冲突。
		 */
		ccz_qingnangshu: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 8 } },
			skills: ["ccz_qingnang"],
		},

		/**
		 * 玉玺 —— 原作"致命一击攻击"。
		 * 【为什么给"失去时弃两张手牌"的负面】纯增伤的宝物太强（等于常驻半个贯石斧），
		 * 加一个失去代价既平衡，也贴合"传国玉玺，得之者不祥"的观感。
		 * 注意本体已有 yuxi/传国玉玺，故 id 与效果都独立。
		 */
		ccz_yuxi: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 9 } },
			skills: ["ccz_yuxi_skill", "ccz_yuxi_lose"],
		},

		/**
		 * 太平要术 —— 原作"每回合恢复MP"，无 MP 概念，改成"属性伤害转为回复体力"。
		 * 本体 huodong 包已有同名卡（taipingyaoshu，效果是防止属性伤害），
		 * 这里是更强的版本：不只免疫，还倒转成回血。故 ev 给 10。
		 */
		ccz_taipingyaoshu: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 10 } },
			skills: ["ccz_taipingyaoshu_skill"],
		},

		/**
		 * 太平清领道 —— 原作"每回合恢复状态"（自动解除异常）。
		 * 三国杀里的"异常状态"就是判定区的延时锦囊（乐不思蜀、兵粮寸断、闪电）。
		 * 【为什么不设代价】原作是自动解除，故这里也不要求弃牌
		 * （本体同类技能 pslongxin/jsrgfeiyang 都要弃牌，那是武将技能的平衡需要，
		 * 装备已经占了一个宝物位，代价足够）。
		 */
		ccz_taipingqinglingdao: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 8 } },
			skills: ["ccz_taipingqinglingdao_skill"],
		},
	},

	skill: {
		/**
		 * —— 自带的三个通用技能 ——
		 * 效果分别照抄本体的 luanji（甘宁·乱击，shenhua 包）、psquanmou（ps2070郭嘉·全谋，
		 * offline 包）、qingnang（华佗·青囊，standard 包)。
		 * 【为什么不直接挂原技能名】那三个定义在**武将包**里，而武将包玩家可以关掉。
		 * 关了之后卡还在牌堆里、AI 照样穿，但一点效果都没有 —— 不报错，纯哑巴故障。
		 * 本体全部 9 个卡牌包都是自带技能定义、没有一个跨包挂武将技能的，故随此惯例。
		 */

		/** 乱击：两张同花色手牌当【万箭齐发】使用（养由基之弓） */
		ccz_luanji: {
			equipSkill: true,
			enable: "phaseUse",
			position: "hs",
			viewAs: { name: "wanjian" },
			filterCard(card, player) {
				if (ui.selected.cards.length) {
					return get.suit(card) === get.suit(ui.selected.cards[0]);
				}
				// 手里得有另一张同花色的才能选这张，否则选了也凑不成对
				return player.getCards("hs").some(c => c !== card && get.suit(c) === get.suit(card));
			},
			selectCard: 2,
			check(card) {
				return 6 - get.value(card);
			},
			ai: { order: 8, useful: 1, value: 1 },
		},

		/** 全谋：其他角色使用锦囊后，若你是目标，可弃一张同色手牌获得之（遁甲天书） */
		ccz_quanmou: {
			equipSkill: true,
			trigger: { global: "useCardAfter" },
			filter(event, player) {
				return get.type2(event.card) === "trick" && event.player !== player && event.targets?.includes(player) && event.cards?.filterInD("odj").length && player.countCards("h", card => get.color(card) === get.color(event.card));
			},
			async cost(event, trigger, player) {
				event.result = await player
					.chooseToDiscard(get.prompt("ccz_quanmou"), `弃置一张${get.translation(get.color(trigger.card))}手牌，获得${get.translation(trigger.cards)}`, "h", card => get.color(card) === _status.event.color)
					.set("color", get.color(trigger.card))
					.set("ai", card => _status.event.val - get.value(card))
					.set("val", get.value(trigger.cards, player))
					.forResult();
			},
			async content(event, trigger, player) {
				// filterInD("odj")：牌还在弃牌堆/判定区里才拿得到 —— 若已被别的效果收走就作罢
				const cards = trigger.cards.filterInD("odj");
				const inOD = cards.filterInD("od");
				if (inOD.length) {
					await player.gain(inOD, "gain2");
				}
				const inJ = cards.filterInD("j");
				if (inJ.length) {
					await player.gain(inJ, get.owner(inJ[0]), "give");
				}
			},
		},

		/** 青囊：出牌阶段限一次，弃一张手牌令一名已受伤角色回复 1 点体力（青囊书） */
		ccz_qingnang: {
			equipSkill: true,
			enable: "phaseUse",
			filterCard: true,
			usable: 1,
			check(card) {
				return 9 - get.value(card);
			},
			filterTarget(card, player, target) {
				return target.isDamaged();
			},
			async content(event, trigger, player) {
				await event.target.recover();
			},
			ai: {
				order: 9,
				result: {
					target(player, target) {
						if (target.hp === 1) {
							return 5;
						}
						if (player === target && player.countCards("h") > player.hp) {
							return 5;
						}
						return 2;
					},
				},
				threaten: 2,
			},
		},

		// —— 方天画戟 ——
		ccz_fangtianhuaji_skill: {
			equipSkill: true,
			trigger: { source: "damageSource" },
			// clearTime：回合结束自动清掉"本回合已被此法指定过的人"，不用自己擦
			clearTime: true,
			filter(event, player) {
				if (!event.card || event.card.name !== "sha" || !event.player?.isIn()) {
					return false;
				}
				// 上/下家里还有没被此法打过的，且自己有牌可弃
				const done = player.getStorage("ccz_fangtianhuaji_used");
				return [event.player.next, event.player.previous].some(t => t?.isIn() && t !== player && !done.includes(t) && player.canUse("sha", t, false)) && player.countCards("he");
			},
			async cost(event, trigger, player) {
				const done = player.getStorage("ccz_fangtianhuaji_used");
				const list = [trigger.player.next, trigger.player.previous].filter(t => t?.isIn() && t !== player && !done.includes(t) && player.canUse("sha", t, false));
				event.result = await player
					.chooseTarget(get.prompt2("ccz_fangtianhuaji"), (card, player, target) => _status.event.list.includes(target))
					.set("list", list)
					.set("ai", target => get.effect(target, { name: "sha" }, get.player(), get.player()))
					.forResult();
			},
			async content(event, trigger, player) {
				const target = event.targets[0];
				const { result } = await player.chooseToDiscard("he", true, `弃置一张牌，视为对${get.translation(target)}使用一张【杀】`);
				if (!result?.bool) {
					return;
				}
				player.markAuto("ccz_fangtianhuaji_used", [target]);
				await player.useCard({ name: "sha", isCard: false }, target, false);
			},
		},

		// —— 吕布之弓：下回合不能使用【杀】——
		ccz_lvbuzhigong_skill: {
			equipSkill: true,
			trigger: { source: "damageSource" },
			forced: true,
			filter(event, player) {
				return event.card?.name === "sha" && event.player?.isIn();
			},
			async content(event, trigger, player) {
				// addTempSkill 的第二参给 phaseAfter：从现在起到"目标下个回合结束"都禁用，
				// 覆盖了"下回合"这段。若给 phaseUseAfter 则本回合末就失效，等于没禁到。
				trigger.player.addTempSkill("ccz_mabi", { player: "phaseAfter" });
			},
		},
		/** 麻痹：不能使用【杀】。equipSkill 不设——它是挂在**被打的人**身上的临时技能 */
		ccz_mabi: {
			mark: true,
			marktext: "痹",
			intro: { content: "不能使用【杀】" },
			mod: {
				cardEnabled(card) {
					if (get.name(card) === "sha") {
						return false;
					}
				},
				cardSavable(card) {
					if (get.name(card) === "sha") {
						return false;
					}
				},
			},
		},

		// —— 李广之弓：下回合不能发动技能 ——
		ccz_ligzhigong_skill: {
			equipSkill: true,
			trigger: { source: "damageSource" },
			forced: true,
			filter(event, player) {
				return event.card?.name === "sha" && event.player?.isIn();
			},
			async content(event, trigger, player) {
				trigger.player.addTempSkill("ccz_jinzhou", { player: "phaseAfter" });
			},
		},
		/**
		 * 禁咒：不能发动技能。
		 * 【用 skillEnabled 而不是逐个禁】本体的 mod.skillEnabled 是"这个技能现在能不能发动"
		 * 的统一入口，返回 false 即全禁，不必枚举对方有哪些技能。
		 * 装备技能(equipSkill)不禁 —— 否则连自己身上装备的效果都没了，那是"卸装备"不是"禁咒"。
		 */
		ccz_jinzhou: {
			mark: true,
			marktext: "咒",
			intro: { content: "不能发动技能（装备技能除外）" },
			mod: {
				skillEnabled(skill, player) {
					const info = get.info(skill);
					if (info?.equipSkill || info?.charlotte) {
						return;
					}
					return false;
				},
			},
		},

		// —— 金火罐炮：【杀】改毒属性 ——
		ccz_jinhuoguanpao_skill: {
			equipSkill: true,
			trigger: { player: "useCard1" },
			forced: true,
			filter(event, player) {
				return event.card?.name === "sha" && !game.hasNature(event.card);
			},
			async content(event, trigger, player) {
				game.setNature(trigger.card, "poison");
			},
		},

		// —— 五火神焰扇：你造成的火属性伤害 +1 ——
		ccz_wuhuoshenyanshan_skill: {
			equipSkill: true,
			trigger: { source: "damageBegin1" },
			forced: true,
			filter(event, player) {
				return game.hasNature(event, "fire");
			},
			async content(event, trigger, player) {
				trigger.num++;
			},
		},

		// —— 七星剑：你的锦囊不可被【无懈可击】——
		ccz_qixingjian_skill: {
			equipSkill: true,
			mod: {
				// 【为什么用 cardRespondable 而不是拦 wuxie 事件】前者是本体判断
				// "这张牌能不能被响应"的统一入口，AI 与人类走同一条路；
				// 而事后拦无懈会漏掉 AI 的预判逻辑，出现"AI 以为能无懈、结果无效"。
				cardRespondable(card, player, target) {
					if (get.type2(card) === "trick" && player.getEquips("ccz_qixingjian").length) {
						return false;
					}
				},
			},
		},

		// —— 镜铠：来源武器攻击范围 ≥4 时，【杀】伤害无效 ——
		ccz_jingkai_skill: {
			equipSkill: true,
			trigger: { player: "damageBegin4" },
			forced: true,
			filter(event, player) {
				if (!event.card || event.card.name !== "sha" || !event.source) {
					return false;
				}
				if (!armorValid(event, player)) {
					return false;
				}
				// 来源装备区里有攻击范围 ≥4 的武器
				return event.source.getCards("e", card => {
					const info = get.info(card);
					if (!info || info.subtype !== "equip1") {
						return false;
					}
					const af = info.distance?.attackFrom;
					return typeof af === "number" && 1 - af >= 4;
				}).length > 0;
			},
			async content(event, trigger, player) {
				trigger.cancel();
			},
		},

		// —— 连环铠：每回合只受一次【杀】造成的伤害 ——
		ccz_lianhuankai_skill: {
			equipSkill: true,
			trigger: { player: "damageBegin4" },
			forced: true,
			clearTime: true,
			filter(event, player) {
				if (!event.card || event.card.name !== "sha") {
					return false;
				}
				if (!armorValid(event, player)) {
					return false;
				}
				// 本回合已经受过一次【杀】伤害了 → 后续的无效
				return player.hasSkill("ccz_lianhuankai_used", null, false);
			},
			async content(event, trigger, player) {
				trigger.cancel();
			},
			group: "ccz_lianhuankai_mark",
		},
		/** 记账用：本回合受过【杀】伤害就打个标记，clearTime 到回合结束自动清 */
		ccz_lianhuankai_mark: {
			equipSkill: true,
			trigger: { player: "damageEnd" },
			forced: true,
			silent: true,
			popup: false,
			filter(event, player) {
				return event.card?.name === "sha";
			},
			async content(event, trigger, player) {
				player.addTempSkill("ccz_lianhuankai_used");
			},
		},
		/**
		 * 纯记账标记，不是给人看的技能。
		 * 【charlotte】让它不被"清除技能"类效果带走（否则对手一个洗剑就把记账擦了，
		 * 连环铠这一回合等于失效）。
		 * 【nopop / 无 mark】不弹提示、不在武将牌上显示图标 —— 它没有任何效果，
		 * 只是"本回合受过一次【杀】伤害"这个事实的载体，露出来只会让人困惑。
		 */
		ccz_lianhuankai_used: { charlotte: true, nopop: true },

		// —— 黄金铠：防止一切属性伤害 ——
		ccz_huangjinkai_skill: {
			equipSkill: true,
			trigger: { player: "damageBegin4" },
			forced: true,
			filter(event, player) {
				// hasNature(event) 不带第二参 = "有任何属性"
				return game.hasNature(event) && armorValid(event, player);
			},
			async content(event, trigger, player) {
				trigger.cancel();
			},
		},

		// —— 白银铠：防止一切"无来源卡"的伤害（技能/效果造成的）——
		ccz_baiyinkai_skill: {
			equipSkill: true,
			trigger: { player: "damageBegin4" },
			forced: true,
			filter(event, player) {
				return !event.card && armorValid(event, player);
			},
			async content(event, trigger, player) {
				trigger.cancel();
			},
		},

		// —— 龙鳞铠：防止锦囊造成的伤害 ——
		ccz_longlinkai_skill: {
			equipSkill: true,
			trigger: { player: "damageBegin4" },
			forced: true,
			filter(event, player) {
				return event.card && get.type2(event.card) === "trick" && armorValid(event, player);
			},
			async content(event, trigger, player) {
				trigger.cancel();
			},
		},

		// —— 凤凰羽衣：回合开始回 1 体力 ——
		ccz_fenghuangyuyi_skill: {
			equipSkill: true,
			trigger: { player: "phaseBegin" },
			forced: true,
			filter(event, player) {
				return player.isDamaged();
			},
			async content(event, trigger, player) {
				await player.recover();
			},
		},

		// —— 玉玺：【杀】【决斗】伤害 +1 ——
		ccz_yuxi_skill: {
			equipSkill: true,
			trigger: { source: "damageBegin1" },
			forced: true,
			filter(event, player) {
				return event.card && ["sha", "juedou"].includes(event.card.name);
			},
			async content(event, trigger, player) {
				trigger.num++;
			},
		},
		/**
		 * 玉玺失去时弃两张手牌。
		 * 【为什么 charlotte:true】失去装备的瞬间装备技能就已经不在身上了，
		 * 普通装备技能触发不到"自己被弃置"这件事。charlotte 让技能不随装备移除而立即失效，
		 * 才能在 loseAfter 里跑完。本体 baiyin_skill 的 subSkill.lose 就是这个套路。
		 */
		ccz_yuxi_lose: {
			equipSkill: true,
			charlotte: true,
			trigger: { player: "loseAfter" },
			forced: true,
			filter(event, player) {
				// 这次失去的牌里有玉玺，且现在装备区已经没有了
				return event.cards?.some(card => get.name(card) === "ccz_yuxi") && !player.getEquips("ccz_yuxi").length && player.countCards("h");
			},
			async content(event, trigger, player) {
				await player.chooseToDiscard("h", 2, true);
			},
		},

		// —— 太平要术：属性伤害改为回复 1 点体力 ——
		ccz_taipingyaoshu_skill: {
			equipSkill: true,
			trigger: { player: "damageBegin4" },
			forced: true,
			filter(event, player) {
				return game.hasNature(event) && armorValid(event, player);
			},
			async content(event, trigger, player) {
				trigger.cancel();
				await player.recover();
			},
		},

		// —— 太平清领道：判定阶段开始时，可弃置判定区一张牌 ——
		ccz_taipingqinglingdao_skill: {
			equipSkill: true,
			trigger: { player: "phaseJudgeBegin" },
			filter(event, player) {
				return player.countCards("j") > 0;
			},
			async cost(event, trigger, player) {
				event.result = await player
					.chooseCardButton(get.prompt2("ccz_taipingqinglingdao"), player.getCards("j"))
					.set("ai", button => {
						// 判定区的牌对自己都是负面，值越低越该先弃
						return 10 - get.value(button.link, get.player());
					})
					.forResult();
			},
			async content(event, trigger, player) {
				await player.discard(event.cards ?? event.result?.links ?? []);
			},
		},
	},

	translate: {
		caocaozhuan_card_config: "曹操传",

		// 武器
		ccz_fangtianhuaji: "方天画戟",
		ccz_fangtianhuaji_bg: "戟",
		ccz_fangtianhuaji_info: "当你使用【杀】对目标角色造成伤害后，你可以弃置一张牌，视为对该角色的上家或下家使用一张【杀】。每名角色每回合限一次。",
		ccz_fangtianhuaji_skill: "方天画戟",
		ccz_fangtianhuaji_skill_info: "当你使用【杀】对目标角色造成伤害后，你可以弃置一张牌，视为对该角色的上家或下家使用一张【杀】。每名角色每回合限一次。",

		ccz_lvbuzhigong: "吕布之弓",
		ccz_lvbuzhigong_bg: "弓",
		ccz_lvbuzhigong_info: "锁定技，当你使用【杀】造成伤害后，目标角色本回合与其下个回合内不能使用【杀】。",
		ccz_lvbuzhigong_skill: "吕布之弓",
		ccz_lvbuzhigong_skill_info: "锁定技，当你使用【杀】造成伤害后，目标角色本回合与其下个回合内不能使用【杀】。",
		ccz_mabi: "麻痹",
		ccz_mabi_info: "你不能使用【杀】。",

		ccz_ligzhigong: "李广之弓",
		ccz_ligzhigong_bg: "弓",
		ccz_ligzhigong_info: "锁定技，当你使用【杀】造成伤害后，目标角色本回合与其下个回合内不能发动技能（装备技能除外）。",
		ccz_ligzhigong_skill: "李广之弓",
		ccz_ligzhigong_skill_info: "锁定技，当你使用【杀】造成伤害后，目标角色本回合与其下个回合内不能发动技能（装备技能除外）。",
		ccz_jinzhou: "禁咒",
		ccz_jinzhou_info: "你不能发动技能（装备技能除外）。",

		ccz_jinhuoguanpao: "金火罐炮",
		ccz_jinhuoguanpao_bg: "炮",
		ccz_jinhuoguanpao_info: "锁定技，你使用的普通【杀】改为毒属性【杀】。（毒属性伤害无法被“防止伤害”类效果抵消）",
		ccz_jinhuoguanpao_skill: "金火罐炮",
		ccz_jinhuoguanpao_skill_info: "锁定技，你使用的普通【杀】改为毒属性【杀】。",

		ccz_wuhuoshenyanshan: "五火神焰扇",
		ccz_wuhuoshenyanshan_bg: "焰",
		ccz_wuhuoshenyanshan_info: "锁定技，当你造成火属性伤害时，此伤害+1。",
		ccz_wuhuoshenyanshan_skill: "五火神焰扇",
		ccz_wuhuoshenyanshan_skill_info: "锁定技，当你造成火属性伤害时，此伤害+1。",

		ccz_qixingjian: "七星剑",
		ccz_qixingjian_bg: "星",
		ccz_qixingjian_info: "锁定技，你使用的锦囊牌不能被【无懈可击】响应。",
		ccz_qixingjian_skill: "七星剑",
		ccz_qixingjian_skill_info: "锁定技，你使用的锦囊牌不能被【无懈可击】响应。",

		ccz_yangyoujizhigong: "养由基之弓",
		ccz_yangyoujizhigong_bg: "弓",
		ccz_yangyoujizhigong_info: "你可以将两张相同花色的手牌当【万箭齐发】使用。",
		ccz_luanji: "乱击",
		ccz_luanji_info: "你可以将两张相同花色的手牌当【万箭齐发】使用。",

		// 防具
		ccz_jingkai: "镜铠",
		ccz_jingkai_bg: "镜",
		ccz_jingkai_info: "锁定技，当你受到【杀】造成的伤害时，若伤害来源的装备区里有攻击范围不小于4的武器牌，此伤害无效。",
		ccz_jingkai_skill: "镜铠",
		ccz_jingkai_skill_info: "锁定技，当你受到【杀】造成的伤害时，若伤害来源的装备区里有攻击范围不小于4的武器牌，此伤害无效。",

		ccz_lianhuankai: "连环铠",
		ccz_lianhuankai_bg: "环",
		ccz_lianhuankai_info: "锁定技，每回合你第二次及以后受到【杀】造成的伤害时，此伤害无效。（非【杀】造成的伤害不受影响）",
		ccz_lianhuankai_skill: "连环铠",
		ccz_lianhuankai_skill_info: "锁定技，每回合你第二次及以后受到【杀】造成的伤害时，此伤害无效。",

		ccz_huangjinkai: "黄金铠",
		ccz_huangjinkai_bg: "金",
		ccz_huangjinkai_info: "锁定技，属性伤害对你无效。",
		ccz_huangjinkai_skill: "黄金铠",
		ccz_huangjinkai_skill_info: "锁定技，属性伤害对你无效。",

		ccz_baiyinkai: "白银铠",
		ccz_baiyinkai_bg: "银",
		ccz_baiyinkai_info: "锁定技，非因卡牌造成的伤害（技能等）对你无效。",
		ccz_baiyinkai_skill: "白银铠",
		ccz_baiyinkai_skill_info: "锁定技，非因卡牌造成的伤害（技能等）对你无效。",

		ccz_longlinkai: "龙鳞铠",
		ccz_longlinkai_bg: "鳞",
		ccz_longlinkai_info: "锁定技，锦囊牌造成的伤害对你无效。",
		ccz_longlinkai_skill: "龙鳞铠",
		ccz_longlinkai_skill_info: "锁定技，锦囊牌造成的伤害对你无效。",

		ccz_fenghuangyuyi: "凤凰羽衣",
		ccz_fenghuangyuyi_bg: "凰",
		ccz_fenghuangyuyi_info: "锁定技，回合开始时，你回复1点体力。",
		ccz_fenghuangyuyi_skill: "凤凰羽衣",
		ccz_fenghuangyuyi_skill_info: "锁定技，回合开始时，你回复1点体力。",

		// 宝物
		ccz_dunjiatianshu: "遁甲天书",
		ccz_dunjiatianshu_bg: "遁",
		ccz_dunjiatianshu_info: "当其他角色使用锦囊牌结算结束后，若你是此牌的目标，你可以弃置一张与此牌颜色相同的手牌并获得之。",
		ccz_quanmou: "全谋",
		ccz_quanmou_info: "当其他角色使用锦囊牌结算结束后，若你是此牌的目标，你可以弃置一张与此牌颜色相同的手牌并获得之。",

		ccz_qingnangshu: "青囊书",
		ccz_qingnangshu_bg: "囊",
		ccz_qingnangshu_info: "出牌阶段限一次，你可以弃置一张手牌，令一名已受伤的角色回复1点体力。",
		ccz_qingnang: "青囊",
		ccz_qingnang_info: "出牌阶段限一次，你可以弃置一张手牌，令一名已受伤的角色回复1点体力。",

		ccz_yuxi: "玉玺",
		ccz_yuxi_bg: "玺",
		ccz_yuxi_info: "锁定技，①当你使用【杀】或【决斗】造成伤害时，此伤害+1。②当你失去装备区里的【玉玺】后，你弃置两张手牌。",
		ccz_yuxi_skill: "玉玺",
		ccz_yuxi_skill_info: "锁定技，当你使用【杀】或【决斗】造成伤害时，此伤害+1。",
		ccz_yuxi_lose: "玉玺",
		ccz_yuxi_lose_info: "锁定技，当你失去装备区里的【玉玺】后，你弃置两张手牌。",

		ccz_taipingyaoshu: "太平要术",
		ccz_taipingyaoshu_bg: "术",
		ccz_taipingyaoshu_info: "锁定技，当你受到属性伤害时，防止此伤害，然后你回复1点体力。",
		ccz_taipingyaoshu_skill: "太平要术",
		ccz_taipingyaoshu_skill_info: "锁定技，当你受到属性伤害时，防止此伤害，然后你回复1点体力。",

		ccz_taipingqinglingdao: "太平清领道",
		ccz_taipingqinglingdao_bg: "清",
		ccz_taipingqinglingdao_info: "判定阶段开始时，你可以弃置你判定区里的一张牌。",
		ccz_taipingqinglingdao_skill: "太平清领道",
		ccz_taipingqinglingdao_skill_info: "判定阶段开始时，你可以弃置你判定区里的一张牌。",
	},

	/**
	 * 入牌堆清单：每件 1 张，共 18 张。
	 * 【为什么每件只 1 张】本体惯例如此 —— standard 的 17 种装备全部 ×1（只有八卦阵、
	 * 诸葛连弩 ×2），yingbian 的 25 种装备同样全 ×1。装备是稀有品，基本牌才是牌堆主体
	 * （standard 里【杀】×30、【闪】×15、【桃】×8）。
	 * 【花色点数怎么选】尽量贴原作观感并避开重复：弓类给♠（肃杀）、火系给♥/♦（红色=火）、
	 * 铠甲给♣（厚重）、宝物给♦（珍宝）。同一花色内点数不重复，免得同花色同点数
	 * 在【无懈可击】判定、以及吃花色的技能（制衡、洛神等）里产生怪异手感。
	 */
	list: [
		// 武器
		["spade", 12, "ccz_fangtianhuaji"],
		["spade", 10, "ccz_lvbuzhigong"],
		["spade", 11, "ccz_ligzhigong"],
		["spade", 6, "ccz_yangyoujizhigong"],
		["heart", 4, "ccz_jinhuoguanpao"],
		["heart", 12, "ccz_wuhuoshenyanshan"],
		["diamond", 7, "ccz_qixingjian"],
		// 防具
		["club", 2, "ccz_jingkai"],
		["club", 4, "ccz_lianhuankai"],
		["club", 12, "ccz_huangjinkai"],
		["club", 10, "ccz_baiyinkai"],
		["club", 8, "ccz_longlinkai"],
		["heart", 2, "ccz_fenghuangyuyi"],
		// 宝物
		["diamond", 3, "ccz_dunjiatianshu"],
		["heart", 8, "ccz_qingnangshu"],
		["diamond", 13, "ccz_yuxi"],
		["heart", 6, "ccz_taipingyaoshu"],
		["diamond", 11, "ccz_taipingqinglingdao"],
	],
};
