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

/**
 * 这张牌（或这次伪造的伤害牌）是不是「带属性」？
 *
 * 【为什么不能直接用 game.hasNature(card)】它只认 card.nature 一种形态（get.nature()
 * 只读这个字段），而属性伤害在 AI 层总共有三种长相，漏一种 AI 就会白扔牌：
 *   ① card.nature —— 火杀/雷杀、铁索连环的连环伤害。hasNature 只能认出这一种。
 *   ② 牌定义里的 cardnature —— 火攻(extra.js:260)、国战两张、sp、standard、
 *      仙侠各一张，本体共 6 处。它们的 card.nature 是 undefined，
 *      所以 ① 的判据对它们恒为 false —— 实测到的「AI 对黄金铠用火攻」就是这个。
 *   ③ 伪牌名 firedamage / thunderdamage / icedamage —— get.damageEffect 给**技能伤害**
 *      造的假牌（张角雷击、我们自己的朱雀/青龙宝玉…）。看 get/index.js：
 *          var name = "damage";
 *          if (nature == "fire") name = "firedamage"; …
 *          get.effect(target, { name: name }, …)   // 连 nature 字段都没有
 *      所以技能伤害也漏。
 *
 * 注：**实际技能的 filter 不用改** —— 它们判的是伤害事件
 * game.hasNature(event)，而 target.damage("fire") 会给事件带上 nature，
 * 所以黄金铠/太平要术本来就真能挡住火攻和雷击，错的只是 AI 提示。
 */
function hasNatureLike(card, nature) {
	if (!card) {
		return false;
	}
	if (game.hasNature(card, nature)) {
		return true;
	}
	const name = get.name(card) || card.name;
	const pseudo = { firedamage: "fire", thunderdamage: "thunder", icedamage: "ice" };
	if (pseudo[name]) {
		return !nature || pseudo[name] === nature;
	}
	const cn = get.info(card)?.cardnature;
	if (!cn) {
		return false;
	}
	return !nature || get.natureList(cn).includes(nature);
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
			// 【距离 -3 = 攻击范围 4，与本体方天画戟一致】standard.js 的 fangtian 就是
			// attackFrom: -3。同名同形制的牌范围不一样会让人误判，对齐它。
			distance: { attackFrom: -3 },
			ai: { basic: { equipValue: 5 } },
			skills: ["ccz_fangtianhuaji_skill"],
		},

		/**
		 * 吕布之弓 —— 原作"麻痹攻击"。三国杀里最贴近"麻痹"的是让人下回合打不出输出。
		 * 【为什么范围只给 3】本体的规律是效果越强、攻击范围越小：雌雄/青釭范围 2（ev2）、
		 * 青龙/蛇矛/贯石斧范围 3（ev3~4）、麒麟弓范围 5 但效果最弱（ev3）。
		 * "下回合不能使用【杀】"等于让对手空一轮输出，比麒麟弓强得多，
		 * 再给范围 5 就是双强。（方天画戟是例外：它跟本体同名牌对齐取范围 4。）
		 */
		ccz_lvbuzhigong: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -2 },
			ai: { basic: { equipValue: 4 } },
			skills: ["ccz_lvbuzhigong_skill"],
		},

		/** 李广之弓 —— 原作"禁咒攻击"（使敌人无法使用策略）→ 下回合不能发动技能 */
		ccz_ligzhigong: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -2 },
			ai: { basic: { equipValue: 4 } },
			skills: ["ccz_ligzhigong_skill"],
		},

		/**
		 * 金火罐炮 —— 原作火器。攻击范围 5，与本体麒麟弓并列全场最远（炮的射程本该是最长一档）。
		 * 【为什么不做"毒属性【杀】"】原先是 setNature(card, "poison")，查过本体后发现 poison 是个
		 * "注册了却没人用"的钩子：lib.nature 里有它（优先级 50、绿色），但
		 * lib.linked = ["fire","thunder","kami","ice"] 不含毒 → 铁索连环不传导；poisonDamage 这个
		 * AI 标签全库只有 2 处命中、都是标签定义本身、无人消费；本体也没有任何卡牌或技能产生毒【杀】。
		 * 净效果只剩"伤害数字变绿"，而因为它算作属性伤害，**反被本包自己的黄金铠完全挡住、
		 * 被太平要术转成回血** —— 招牌效果对着自家两张牌是负面的。故改成实打实的延时掉血。
		 */
		ccz_jinhuoguanpao: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			// 攻击范围 5 —— 与本体麒麟弓并列全场最远。炮的射程本就该是最长的一档
			distance: { attackFrom: -4 },
			ai: { basic: { equipValue: 5 } },
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
			distance: { attackFrom: -3 },
			// 【equipValue 维持 4】先前改过 4.5，那是按“无限次 + 覆盖面宽”定的；
			// 现在技能已削成每回合一次，前提没了，回到 4 —— 和七星剑、两把弓同档。
			ai: { basic: { equipValue: 4 } },
			skills: ["ccz_wuhuoshenyanshan_skill"],
		},

		/** 七星剑 —— 原作"辅助策略命中"→ 你的锦囊不可被【无懈可击】响应 */
		ccz_qixingjian: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -1 },
			ai: { basic: { equipValue: 4 } },
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
			ai: { basic: { equipValue: 5 } },
			skills: ["ccz_luanji"],
		},
		/**
		 * 赤霄剑 —— 刘邦斩白蛇起义之剑，汉室正统的象征。本体没有这张（已核对全部装备名）。
		 * 【为什么不照抄民间卡牌那张「斩蛇之剑」】那张是"你的杀无法闪避 + 防御距离-1"。
		 * "杀不可闪"在本体压根不存在（全库零命中），这不是巧合：【闪】是三国杀防御体系的
		 * 地基，一把常驻的"杀全部不可闪"武器会让防守方摸到【闪】等于摸到废牌。
		 * 民间包敢这么做是因为它本来就不追求平衡。
		 * 【改成什么】保留"天命所归、一击必中"的观感，但给明确成本：被闪之后弃一张牌
		 * 仍造成伤害。机制上是青龙偃月刀（被闪可再出杀）与贯石斧（弃牌强制伤害）的混合，
		 * 本体两个先例都有，AI 也认。
		 * 【范围只给 2】效果强就该近战 —— 与雌雄双股剑、青釭剑（都是范围 2）同档。
		 */
		ccz_chixiaojian: {
			fullskin: true,
			type: "equip",
			subtype: "equip1",
			distance: { attackFrom: -1 },
			ai: { basic: { equipValue: 5 } },
			skills: ["ccz_chixiaojian_skill"],
		},


		// ================= 防具 =================

		/**
		 * 镜铠 —— 原作"防御远距攻击"（大幅克制弓箭等远程物理）。
		 * 判据是"来源与你的实际距离 >= 3"（见 ccz_jingkai_skill 处的完整说明）。
		 */
		ccz_jingkai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: {
				/**
				 * 【本包唯一需要动态估值的一件】其余 24 件的价值都不随场面崩塌:
				 * 常驻增减伤(玉玺、黄金铠…)装了就有用;坐骑的距离修正永远生效;
				 * 主动技能类(四宝玉、青囊书…)的场面判断在各自的 ai.result 里做
				 * (如白虎用 get.recoverEffect,队友满血时自动返回 0)。
				 * 而镜铠是**锁定技、没有 ai.result** —— AI 判断它价值的唯一入口就是这里。
				 *
				 * 【为什么它会真正归零】8 人局座位距离是 1 2 3 4 3 2 1,能挡 3 个人;
				 * 但残局只剩 3 人时所有人距离都是 1,一次都触发不了 —— 而座位关系是固定的,
				 * 不像血量会波动。静态 ev5 会让 AI 在残局照旧抢它、保它,那是可见的错误行为。
				 * (对比凤凰羽衣:满血时只是"这一回合的回血浪费了",下回合受伤照样生效,
				 * 属于暂时闲置而非结构性归零,故不必动态。)
				 *
				 * 【为什么不改回"克制攻击范围>=3的武器"判据】那样残局不归零、也不用动态 ev,
				 * 但会得出荒谬结论:骑赤兔冲到你面前砍你的人,因为手里拿的是长兵器而被镜铠
				 * 挡住 —— 那明明是近战。"距离"判据已经把马算进去了,分得清"远处射来"
				 * 和"冲到面前砍"。规则合理性优先,动态估值只是为此付的代价。
				 */
				equipValue(card, player) {
					const far = game.filterPlayer(t => t !== player && get.attitude(player, t) < 0 && get.distance(t, player) >= 3).length;
					if (!far) {
						return 0; // 没有敌人在射程外 → 此刻这件装备一点用都没有
					}
					return Math.min(8, 3 + far * 2);
				},
				basic: { equipValue: 5 },
			},
			skills: ["ccz_jingkai_skill"],
		},

		/**
		 * 连环铠 —— 原作"防御两次攻击"（敌人的连续攻击只算一次）。
		 * 译成"每回合只受一次【杀】造成的伤害"，非【杀】的伤害不受影响。
		 * 【记账靠 addTempSkill 的默认到期，不是 clearTime】默认到期是
		 * { global: ["phaseAfter","phaseBeforeStart"] } —— 任意回合结束即清，正合"每回合"语义。
		 * clearTime 这个字段在本体库里只出现在两处 UI 判断（info.direct && !info.clearTime），
		 * **不清任何存储** —— 别再拿它当"回合末自动擦标记"用（本包曾因此让方天画戟的限次
		 * 实际变成"每局限一次"）。
		 */
		ccz_lianhuankai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 6 } },
			skills: ["ccz_lianhuankai_skill"],
		},

		/** 黄金铠 —— 原作"防御致命一击"→ 防止一切属性伤害（火/雷/冰/毒…） */
		ccz_huangjinkai: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 5 } },
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
			ai: { basic: { equipValue: 5 } },
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
			ai: { basic: { equipValue: 6 } },
			skills: ["ccz_longlinkai_skill"],
		},

		/** 凤凰羽衣 —— 原作"每回合恢复HP"，原样照做 */
		ccz_fenghuangyuyi: {
			fullskin: true,
			type: "equip",
			subtype: "equip2",
			ai: { basic: { equipValue: 5 } },
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
			ai: { basic: { equipValue: 6 } },
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
			ai: { basic: { equipValue: 6 } },
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
			ai: { basic: { equipValue: 7 } },
			// 【loseDelay: false + onLose】照白银狮子（extra.js:686）：装备离开的那一刻
			// 就把监听技能挂到玩家身上，于是它能在装备技能被移除之后照样结算。
			// ccz_yuxi_lose 不再列进 skills —— 它不是装备技能，而是失去时临时挂上的。
			loseDelay: false,
			async onLose(event, trigger, player) {
				player.addTempSkill("ccz_yuxi_lose");
			},
			skills: ["ccz_yuxi_skill"],
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
			ai: { basic: { equipValue: 7 } },
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
			ai: { basic: { equipValue: 6 } },
			skills: ["ccz_taipingqinglingdao_skill"],
		},
		// ================= 坐骑 =================

		/**
		 * 白龙驹 —— 赵云坐骑（演义常见说法）。原作 50 件里的坐骑（赤兔、的卢、绝影、
		 * 爪黄飞电）本体全都有了，故换两匹本体没占的三国名马来补坐骑这一类。
		 * 【为什么要补坐骑】本包前 18 件里坐骑是 0 张，而武器 +7、防具 +6、宝物 +5 ——
		 * 加进「标准+军争」后坐骑仍是原来那 7 张，占比被稀释。坐骑是距离博弈的关键牌，
		 * 稀释了会让"打不到人"这一层策略变弱。
		 * 效果同大宛/赤兔：你算距离 -1（进攻型），配赵云机动突进的形象。
		 */
		ccz_bailongju: {
			fullskin: true,
			type: "equip",
			subtype: "equip4",
			distance: { globalFrom: -1 },
			ai: { basic: { equipValue: 3 } },
		},

		/**
		 * 乌云踏雪 —— 张飞坐骑（黑身白蹄）。效果同的卢/绝影：别人算与你的距离 +1（防御型），
		 * 配张飞冲阵抗打的形象。一匹 +1马 一匹 -1马，保持本体两类坐骑的均衡
		 * （本体现有 -1马 5 张、+1马 6 张）。
		 */
		ccz_wuyuntaxue: {
			fullskin: true,
			type: "equip",
			subtype: "equip3",
			distance: { globalTo: 1 },
			ai: { basic: { equipValue: 3 } },
		},

		// ================= 四象宝玉（宝物）=================
		//
		// 原作四神是"召唤术"：青龙随机 5 次闪电（雨雪天）、朱雀 3×3 火焰（晴天）、
		// 玄武全场随机施加状态（阴天）、白虎我方全体觉醒+补给（无天气限制）。
		// 三国杀没有召唤与天气，故：**天气限制 → 判定/弃花色**，各神保留自己的性格，
		// 不做成一个模板复制四遍。
		// 花色对应五行方位，且与机制自洽：
		//   青龙 ♣ 东方木（梅花形似草木）  朱雀 ♦ 南方火（方块是红色）
		//   白虎 ♥ 红桃（桃=回血，机制驱动） 玄武 ♠ 北方水
		// 四件同在 equip5，一次只能装一件 —— 正好还原原作"宝玉四选一"。

		/**
		 * 青龙宝玉 —— 原作"随机 5 次闪电"。
		 * 【为什么用判定而不是弃牌】原作的特征就是次数不定、有好有坏，判定才还原得了；
		 * 若改成"弃♣必中 2 点"，期望更高(2.0 vs 1.5)但丢掉了那个特征。
		 * 【为什么是"固定三次各自独立"而不是"失败即中止"】后者期望只有 0.875
		 * (0.5+0.25+0.125)，一发红就结束、太弱；固定三次期望 1.5，且能打出 0~3 的波动。
		 * 顺带三次判定 = 三张牌进弃牌堆，会触发天妒之类吃判定牌的技能，互动更多。
		 */
		ccz_qinglongbaoyu: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_qinglongbaoyu_skill"],
		},

		/**
		 * 朱雀宝玉 —— 原作"3×3 范围火焰"。目标 + 其上下家 = 三人，正是 3×3 的意思。
		 * 一张♦换 3 点火伤看着很赚，但：火属性会被藤甲/黄金铠/太平要术挡、
		 * 打三个人意味着三个人都记恨你、且得先摸到♦。这是本包最需要实战验证的一张。
		 */
		ccz_zhuquebaoyu: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_zhuquebaoyu_skill"],
		},

		/**
		 * 白虎宝玉 —— 原作"我方和友军全体觉醒+大补给"，且是四神里唯一无天气限制的。
		 * 译成群体回血。【为什么不直接当【桃园结义】用】桃园是"所有人各回 1"，含敌人；
		 * 改成"至多 3 名角色"就有了选择空间，也更贴"补给我方"的原意。
		 * 净收益其实不高（弃一张♥、自己最多回 1），价值在给队友送血。
		 */
		ccz_baihubaoyu: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_baihubaoyu_skill"],
		},

		/**
		 * 玄武宝玉 —— 原作"对全场随机施加一种状态（中毒/麻痹/禁咒/混乱…）"。
		 * 【用点数区间还原"随机施加"】判定牌点数 1~4 / 5~8 / 9~12 各 4/13 = 30.8%，
		 * 13 则失效 1/13 = 7.7%。三段各一种 debuff、小概率翻车 —— 高成功率但有反噬，
		 * 正是召唤术该有的手感；而且比"你自己三选一"更还原原作。
		 * 【为什么点数随机反而对 AI 友好】AI 只需估"这个效果整体值不值得"，
		 * 不必预判具体哪一项 —— 若做成"你自己选"，三个 debuff 对不同武将价值天差地别，
		 * AI 反而要写一堆针对性判断。
		 * 【为什么挂在"造成伤害后"而不是主动使用】有前置条件（得先打中人），不是无脑控场；
		 * 且与吕布之弓/李广之弓形成体系 —— 那两件是武器自带单一 debuff，
		 * 玄武是宝物版、三段随机且能禁锦囊（两把弓做不到），不占武器位。
		 */
		ccz_xuanwubaoyu: {
			fullskin: true,
			type: "equip",
			subtype: "equip5",
			ai: { basic: { equipValue: 7 } },
			skills: ["ccz_xuanwubaoyu_skill"],
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

		// —— 方天画戟：【杀】命中后可弃牌连击，最多三刀（三英战吕布）——
		ccz_fangtianhuaji_skill: {
			equipSkill: true,
			trigger: { source: "damageSource" },
			// 【usable: 2 —— 算上你自己那张【杀】正好三个人，即"三英战吕布"】
			// 别把 usable 当"总共打几个人"读:它只数**技能发动了几次**。
			// 你主动出的那张【杀】打 A 是第一个人，技能再发动 2 次牵连 B、C —— 合计三人。
			// (曾经写 3，那是四个人，比典故多一个,而且 4 张卡换 4 次攻击在装备里偏猛。)
			// 连锁本身不用写：这里用 useCard 打出的【杀】若造成伤害，会再次触发同一个 trigger，
			// 于是自然形成"命中→再选一人→再命中→再选"的链。所以真正要做的只是**封顶** ——
			// 不封顶的话手牌够就能连穿全场，那不是强，是失控。
			// 【为什么用内建 usable 而不自己记账】原先是 markAuto 把"本回合打过谁"记进 storage +
			// clearTime，两处都错：没有定义 ccz_fangtianhuaji_used 那个标记技能，没人清它，
			// 实际退化成"每局限一次"；而 clearTime 在本体库里只有两处 UI 判断，压根不清存储。
			usable: 2,
			filter(event, player) {
				// 【排除自伤】若【杀】打到自己，event.player 就是自己 —— 那"选其他人"会把
				// 自己当成起点，等于自伤一下就白得一刀。
				// 【决斗也算】只吃【杀】的话触发面太窄。决斗赢了同样是你把人打疼了，
				// 接着挥戟顺理成章;本包玉玺也是 ["sha","juedou"] 这一对，口径一致。
				// 注:决斗输了的那次伤害来源是对方，source:"damageSource" 不会在你身上触发，不必额外排除。
				if (!event.card || !["sha", "juedou"].includes(event.card.name) || !event.player?.isIn() || event.player === player) {
					return false;
				}
				// 【每名角色每回合限一次】只排除"刚被打的那个"是不够的:那样 A→B→A 仍成立
				// （轮到选第三个时被排除的是 B），三刀就能集火两点砸在一人头上 ——
				// 那是集火处刑，不是"战三英"。故用标记记下本回合已被此法牵连过的人。
				// 【canUse 第三参 false = 无距离限制】连击那一下**不受攻击范围约束**，
				// 能打全场任何人 —— 范围 4 只管你自己主动出的那张【杀】。
				// 有意如此:吕布在阵中转身就砍，不该被"隔了两个人"挡住。
				const done = player.getStorage("ccz_fangtianhuaji_used");
				return player.countCards("h") > 0 && game.hasPlayer(t => t !== player && t !== event.player && !done.includes(t) && (player.canUse("sha", t, false) || player.canUse("juedou", t, false)));
			},
			async cost(event, trigger, player) {
				event.result = await player
					.chooseTarget(get.prompt2("ccz_fangtianhuaji"), (card, player, target) => {
						if (target === player || target === _status.event.hurt || _status.event.done.includes(target)) {
							return false;
						}
						return player.canUse("sha", target, false) || player.canUse("juedou", target, false);
					})
					.set("hurt", trigger.player)
					.set("done", player.getStorage("ccz_fangtianhuaji_used"))
					// 两者取更优的那个来估值 —— 否则对"只能决斗打得动"的目标会算出 0 而不选
					.set("ai", target => {
						const me = get.player();
						return Math.max(me.canUse("sha", target, false) ? get.effect(target, { name: "sha" }, me, me) : 0, me.canUse("juedou", target, false) ? get.effect(target, { name: "juedou" }, me, me) : 0);
					})
					.forResult();
			},
			async content(event, trigger, player) {
				const target = event.targets[0];
				const { result } = await player.chooseToDiscard("h", true, `弃置一张手牌，视为对${get.translation(target)}使用【杀】或【决斗】`);
				if (!result?.bool) {
					return;
				}
				// 【杀 / 决斗二选一】决斗不能被【闪】挡，但拼杀输了伤的是自己 —— 是个真选择。
				// 只把当下合法的那些列出来:若只有一个能用，直接用它，不拿单选项去烦人。
				const usable = ["sha", "juedou"].filter(name => player.canUse(name, target, false));
				if (!usable.length) {
					return;
				}
				let name = usable[0];
				if (usable.length > 1) {
					const { result: pick } = await player
						.chooseControl()
						.set("prompt", `方天画戟：视为对${get.translation(target)}使用哪一张？`)
						.set("choiceList", ["【杀】（可被【闪】抵消）", "【决斗】（拼杀，输了你受伤）"])
						// 【目标要显式传进来，别靠 getParent() 猜事件链】猜错就是 undefined，
						// get.effect 拿到 undefined 恒返回 0 → AI 永远选第 0 项(杀)，而且一声不响。
						.set("targetx", target)
						.set("ai", () => {
							const me = get.event().player;
							const t = get.event().targetx;
							return get.effect(t, { name: "juedou" }, me, me) > get.effect(t, { name: "sha" }, me, me) ? 1 : 0;
						})
						.forResult();
					name = pick.index === 1 ? "juedou" : "sha";
				}
				// 【标记要连"这一环的受害者"一起记】否则链头那个人没进名单，
				// 绕一圈还能回头再打他 —— A→B→A 就是这么漏出来的。
				player.addTempSkill("ccz_fangtianhuaji_used");
				player.markAuto("ccz_fangtianhuaji_used", [trigger.player, target]);
				// 【isCard 必须为 true】本体所有「视为使用杀/决斗」都是 isCard: true
				// (huicui:2596/18980、refresh:3106、tw:16714、collab:8794 … 六处无例外)。
				// 写 false 时【杀】能用、【决斗】走不起来 —— 决斗的 content 要抽牌拼杀、
				// 走完整的"真牌"使用流程，而 isCard: false 把它当成非牌处理了。
				// 【第三个参数 false】useCard 里布尔值落到 addCount —— 不计入出牌次数，正是我们要的。
				await player.useCard({ name, isCard: true }, target, false);
			},
		},
		/**
		 * 记账用：本回合已被方天画戟牵连过的人。
		 * 【三件事必须都对，否则限次静默失效】
		 *  1. 必须**定义**这个技能 —— 只 markAuto 不定义，storage 里的数据没人管；
		 *  2. 用 addTempSkill 挂上去，靠它的默认到期
		 *     （{ global: ["phaseAfter","phaseBeforeStart"] }，任意回合结束即清）；
		 *  3. onremove 必须写字符串 "storage" —— removeSkill 里只认 function 和 string 两种，
		 *     写 onremove: true 落不到任何分支，storage 不会被清。
		 * 本包曾因为漏了第 1 条，让"每回合限一次"实际变成"每局限一次"。
		 */
		ccz_fangtianhuaji_used: { charlotte: true, nopop: true, onremove: "storage" },

		// —— 吕布之弓：下回合不能使用【杀】——
		ccz_lvbuzhigong_skill: {
			equipSkill: true,
			trigger: { source: "damageSource" },
			forced: true,
			filter(event, player) {
				// 【必须排除 event.player === player】source:"damageSource" 在你造成伤害时触发，
				// 而【杀】打到自己也算（反伤类技能、或改变目标的效果）—— 不排除就会自己禁自己。
				return event.card?.name === "sha" && event.player?.isIn() && event.player !== player;
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
				// 同吕布之弓：排除"自己伤到自己"，否则会自己禁自己的技能
				return event.card?.name === "sha" && event.player?.isIn() && event.player !== player;
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

		// —— 金火罐炮：【杀】造成伤害后给目标留「灼伤」，其下个判定阶段判定梅花则掉 1 血 ——
		ccz_jinhuoguanpao_skill: {
			equipSkill: true,
			trigger: { source: "damageSource" },
			forced: true,
			filter(event, player) {
				// 排除"被打的人是自己"：damageSource 的 event.player 是承受伤害者，
				// 而【杀】打到自己也满足 —— 不排除会自己给自己上灼伤。
				return event.card?.name === "sha" && event.player?.isIn() && event.player !== player;
			},
			async content(event, trigger, player) {
				// 【到期时机取 phaseJudgeAfter 而非 phaseAfter】效果要落在"下个判定阶段"。
				// 若用 phaseAfter，当伤害发生在目标自己的回合内时（反伤、改变目标等），
				// 标记会在该回合末就到期，而那时判定阶段早已过去 —— 效果直接蒸发。
				// phaseJudgeAfter 则保证恰好结算一次：phaseJudgeBegin 触发判定，该阶段结束后移除。
				trigger.player.addTempSkill("ccz_zhuoshang", { player: "phaseJudgeAfter" });
			},
		},
		// 灼伤：被金火罐炮的【杀】烧过后留下的余烬。
		// 【为什么叫灼伤而不是中毒】金火罐炮是火器，灼伤更贴；而本体已有两个"毒"：
		// mode/boss.js 的 boss_zhongdu（"中毒"）与 character/tw 的恶泉（marktext "毒"），
		// 二者都是"累积标记数、准备阶段按标记数掉血"，与本技能的"判定梅花掉 1 血"机制不同。
		// 显示名相同并不冲突（id 才决定覆盖），但既然机制不一样，换个名字更不容易混。
		// 本体没有任何叫"灼伤"的技能，不存在撞名。
		ccz_zhuoshang: {
			charlotte: true,
			mark: true,
			marktext: "灼",
			intro: { content: "判定阶段开始时进行判定，若判定结果为梅花则流失1点体力" },
			trigger: { player: "phaseJudgeBegin" },
			forced: true,
			async content(event, trigger, player) {
				// 梅花占四分之一 → 25% 概率掉 1 血。
				// 用 loseHp 而非 damage：余烬不该再触发受伤类技能，否则等于白送对手一次遇伤反击。
				const { suit } = await player.judge(card => (get.suit(card) === "club" ? -1.5 : 0)).forResult();
				if (suit === "club") {
					await player.loseHp();
				}
			},
		},

		// —— 五火神焰扇：你造成的火属性伤害 +1 ——
		ccz_wuhuoshenyanshan_skill: {
			equipSkill: true,
			trigger: { source: "damageBegin1" },
			forced: true,
			// 【每回合限一次】不限的话有两个失控组合：
			//   · 本包朱雀宝玉是**宝物位**（equip5）、本卡是**武器位**（equip1），两个能同穿；
			//     朱雀是对目标及其上下家各 1 点火伤，三下都 +1 → 弃 1 张♦ 打出 6 点。
			//   · 铁索连环连三人 + 火杀，每人都 +1 → 同样 6 点。
			// usable 数的是**技能发动次数**（getStat("skill")[name]），和出杀次数是两个
			// 独立的桶，不会影响你出几张杀。单张火杀/火攻不受影响。
			usable: 1,
			filter(event, player) {
				return game.hasNature(event, "fire");
			},
			async content(event, trigger, player) {
				trigger.num++;
			},
		
			ai: {
				effect: {
					// 同古镠刀的写法（见玉玺处说明）。判据用 hasNatureLike(card, "fire")：
					// game.hasNature 漏火攻（它用 cardnature）和技能伤害的伪牌 firedamage。
					player(card, player, target, current, isLink) {
						if (!hasNatureLike(card, "fire")) {
							return;
						}
						if (target?.hasSkillTag("filterDamage", null, { player: player, card: card })) {
							return;
						}
						// 【必须用**乘数**而不是加数】本体古镠刀写的是 [1, 0, 1, -3]（加数），
						// 而加数会**盖过目标的免疫**。以 boss 周瘀〖火神〗为例（mode/boss.js）：
						//   它的 ai.effect.target 返回 [0, 2, 0, 0] —— 乘数 0 归零 + 加数 +2。
						// 而 get.effect 里加数是在所有乘数**之后**才汇总的（result2 += temp02），于是：
						//   result2 = 原值 × 0  +  2  +  (-3)  =  -1  → 负值 = 对目标有害
						//   → AI 反而认为这是个好攻击，把对方的火免疫直接盖掉了。
						// 本包太平要术（同样是火免疫+回血）也会被同样盖掉。
						// 乘数则能正确复合：普通目标 result2 更负（更想打），
						// 免疫目标 0 × 1.5 = 0，再加对方的 +2 仍为正 → AI 避开。
						// 【为什么是 1.5 而不是 2】伤害从 1 变 2 并不等于收益翻倍 ——
						// 【闪】一抵就全没了，所以取中。
						return [1, 0, 1.5, 0];
					},
				},
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
				// 【判据是实际距离而不是对方装了什么武器】
				// 原先遍历来源装备区找 attackFrom >= 3 的武器,那有个漏洞:靠 +1 马拉近、
				// 或靠技能改距离打过来的,都躲过了检查。而 get.distance 是本体计算距离的
				// 唯一入口,把马、技能、装备的影响全算进去了 —— 一行胜过一堆枚举。
				// 【门槛为什么是 3】8 人局里其他 7 人的座位距离是 1 2 3 4 3 2 1:
				//   >=2 免疫 5 人(71%) —— 全场只有上下家能打你,比本体任何防具都强,且装上即成立;
				//   >=3 免疫 3 人(43%) —— 与仁王盾(挡黑杀约50%)、八卦阵(约40%)同档,
				// 且攻方有明确突破手段(配 +1 马或范围>=3 的长兵器),不是没辙。
				return get.distance(event.source, player) >= 3;
			},
			async content(event, trigger, player) {
				trigger.cancel();
			},
		
			ai: {
				effect: {
					// 判据与 filter 一致：来源与我的距离 ≥3 时【杀】无效 → 远处出杀零收益
					target(card, player, target, current) {
						if (target.hasSkillTag("unequip2")) {
							return;
						}
						if (
							player.hasSkillTag("unequip", false, { name: card ? card.name : null, target: target, card: card }) ||
							player.hasSkillTag("unequip_ai", false, { name: card ? card.name : null, target: target, card: card })
						) {
							return;
						}
						if (card.name === "sha" && get.distance(player, target) >= 3) {
							return "zeroplayertarget";
						}
					},
				},
			},},

		// —— 连环铠：每回合只受一次【杀】造成的伤害 ——
		ccz_lianhuankai_skill: {
			equipSkill: true,
			trigger: { player: "damageBegin4" },
			forced: true,
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
		
			ai: {
				effect: {
					// 本回合已受过一次【杀】伤害 → 之后的【杀】对我零收益。
					// 判据用 hasSkill 查那个标记技能，与 filter 完全一致。
					target(card, player, target, current) {
						if (target.hasSkillTag("unequip2")) {
							return;
						}
						if (
							player.hasSkillTag("unequip", false, { name: card ? card.name : null, target: target, card: card }) ||
							player.hasSkillTag("unequip_ai", false, { name: card ? card.name : null, target: target, card: card })
						) {
							return;
						}
						if (card.name === "sha" && target.hasSkill("ccz_lianhuankai_used", null, false)) {
							return "zeroplayertarget";
						}
					},
				},
			},},
		/** 记账用：本回合受过【杀】伤害就打个标记。靠 addTempSkill 的默认到期
		 * （{ global: ["phaseAfter","phaseBeforeStart"] }，任意回合结束即清）——
		 * 不是靠 clearTime，那个字段在本体库里只有两处 UI 判断，不清存储。 */
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
		
			ai: {
				effect: {
					// 属性伤害对我无效 → 带属性的牌打我零收益（火杀/雷杀/火攻/铁索连环的火雷…）
					target(card, player, target, current) {
						if (target.hasSkillTag("unequip2")) {
							return;
						}
						if (
							player.hasSkillTag("unequip", false, { name: card ? card.name : null, target: target, card: card }) ||
							player.hasSkillTag("unequip_ai", false, { name: card ? card.name : null, target: target, card: card })
						) {
							return;
						}
						if (hasNatureLike(card)) {
							return "zeroplayertarget";
						}
					},
				},
			},},

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

			ai: {
				effect: {
					// 【本卡挡的就是“没有牌的伤害”= 技能伤害】而 AI 评估技能伤害时走的是
					// get.damageEffect，它会造一张叫 damage / firedamage / thunderdamage / icedamage
					// 的**伪牌**丢进 get.effect。所以这几个名字就是“技能伤害”在 AI 层的长相。
					// 原来没有 ai 块 —— 于是张角雷击、张宝高順之类的技能照样往白银铠身上砸。
					target(card, player, target, current) {
						if (target.hasSkillTag("unequip2")) {
							return;
						}
						if (
							player.hasSkillTag("unequip", false, { name: card ? card.name : null, target: target, card: card }) ||
							player.hasSkillTag("unequip_ai", false, { name: card ? card.name : null, target: target, card: card })
						) {
							return;
						}
						if (["damage", "firedamage", "thunderdamage", "icedamage"].includes(card ? get.name(card) || card.name : null)) {
							return "zeroplayertarget";
						}
					},
				},
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
		
			ai: {
				effect: {
					// 锦囊造成的伤害对我无效 → 伤害类锦囊打我零收益（火攻、决斗、南蛮、万箭…）
					target(card, player, target, current) {
						if (target.hasSkillTag("unequip2")) {
							return;
						}
						if (
							player.hasSkillTag("unequip", false, { name: card ? card.name : null, target: target, card: card }) ||
							player.hasSkillTag("unequip_ai", false, { name: card ? card.name : null, target: target, card: card })
						) {
							return;
						}
						if (get.type2(card) === "trick" && get.tag(card, "damage")) {
							return "zeroplayertarget";
						}
					},
				},
			},},

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
		
			ai: {
				effect: {
					// 【照本体古镠刀的写法】extra.js:1125 同样是“伤害 +1”，它给的就是
					// ai.effect.player 返回 [1, 0, 1, -3]：前两个不动自己那侧的估值，
					// 后两个把“对目标的收益”再推 3 分（result2 对伤害牌是负值，所以 -3）。
					// 不写的后果不是白扔牌，而是**低估** —— AI 不知道自己这一刀是 2 伤，
					// 于是不优先出【杀】、也不拿它去收残血。
					// 【不担心把黄金铠算反】get.effect 里 zerotarget 是**最后**才应用的
					// （if (zerotarget) result2 = 0，在所有乘数/加数之后），防具的归零会盖住这个加数。
					player(card, player, target, current, isLink) {
						if (isLink || !card || !["sha", "juedou"].includes(get.name(card))) {
							return;
						}
						// 目标能减伤的话这 +1 不一定到位，别让 AI 乐观（古镠刀也这么防）
						if (target?.hasSkillTag("filterDamage", null, { player: player, card: card })) {
							return;
						}
						// 【必须用**乘数**而不是加数】本体古镠刀写的是 [1, 0, 1, -3]（加数），
						// 而加数会**盖过目标的免疫**。以 boss 周瘀〖火神〗为例（mode/boss.js）：
						//   它的 ai.effect.target 返回 [0, 2, 0, 0] —— 乘数 0 归零 + 加数 +2。
						// 而 get.effect 里加数是在所有乘数**之后**才汇总的（result2 += temp02），于是：
						//   result2 = 原值 × 0  +  2  +  (-3)  =  -1  → 负值 = 对目标有害
						//   → AI 反而认为这是个好攻击，把对方的火免疫直接盖掉了。
						// 本包太平要术（同样是火免疫+回血）也会被同样盖掉。
						// 乘数则能正确复合：普通目标 result2 更负（更想打），
						// 免疫目标 0 × 1.5 = 0，再加对方的 +2 仍为正 → AI 避开。
						// 【为什么是 1.5 而不是 2】伤害从 1 变 2 并不等于收益翻倍 ——
						// 【闪】一抵就全没了，所以取中。
						return [1, 0, 1.5, 0];
					},
				},
			},
		},
		/**
		 * 玉玺失去时弃两张手牌。
		 * 【为什么 charlotte:true】失去装备的瞬间装备技能就已经不在身上了，
		 * 普通装备技能触发不到"自己被弃置"这件事。charlotte 让技能不随装备移除而立即失效，
		 * 才能在 loseAfter 里跑完。本体 baiyin_skill 的 subSkill.lose 就是这个套路。
		 */
		/**
		 * 玉玺失去时弃两张手牌。
		 * 【为什么监听要挂在玩家身上，而不是装备技能自己等 loseAfter】
		 * 装备离开时它的 equipSkill 会被一并移除 —— 等不到那个 after 事件就已经没了。
		 * 本体白银狮子的正解是在**卡牌的 onLose** 里 addTempSkill（extra.js:692，
		 * 配 loseDelay: false），把监听挪到玩家身上，不再依赖装备存活。见 ccz_yuxi 的 onLose。
		 * 【触发清单照孙尚香〖枭姬〗抄】那是「失去装备区的牌」的标准写法，本卡正是它的反面
		 * （枭姬摸两张 / 玉玺弃两张）。原先只写 player: "loseAfter"，漏掉
		 * gainAfter（被【顺手牵羊】拿走）、equipAfter（被新装备换下）等一大半途径。
		 * 判"这次失去里有没有玉玺"用 event.getl(player).es，别自己猜 event.cards。
		 */
		ccz_yuxi_lose: {
			charlotte: true,
			forced: true,
			popup: false,
			trigger: {
				player: "loseAfter",
				global: ["equipAfter", "addJudgeAfter", "gainAfter", "loseAsyncAfter", "addToExpansionAfter"],
			},
			filter(event, player) {
				const evt = event.getl(player);
				if (!evt || evt.player !== player || !evt.es?.length) {
					return false;
				}
				// 这次失去的装备里有玉玺，且现在装备区确实没有了（换上第二张玉玺不该罚）
				const lost = evt.es.some(card => {
					const v = evt.vcard_map?.get(card);
					return (v?.name || get.name(card)) === "ccz_yuxi";
				});
				return lost && !player.getEquips("ccz_yuxi").length && player.countCards("h") > 0;
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
		
			ai: {
				effect: {
					// 【必须用数组形式 [乘数, 加数]，单个数字表达不了】get.effect 里
					// 数字分支走的是 result2 *= temp2 —— 那是**乘数**（get/index.js:7011）。
					// 而 result2 对伤害牌本身是负值，所以返回 0.5 只是"伤害减半"，方向根本不对。
					// 本卡的真实效果是「伤害归零 + 目标回 1 血」，那正是 [0, 回血收益]：
					// 乘数 0 抹掉伤害，加数补上回血（result2 += temp02，见 get/index.js:7035）。
					// 不写的话 AI 会往穿太平要术的人身上砸火杀 —— 那不是白扔，是**主动给敌人治疗**。
					target(card, player, target, current) {
						if (target.hasSkillTag("unequip2")) {
							return;
						}
						if (
							player.hasSkillTag("unequip", false, { name: card ? card.name : null, target: target, card: card }) ||
							player.hasSkillTag("unequip_ai", false, { name: card ? card.name : null, target: target, card: card })
						) {
							return;
						}
						if (hasNatureLike(card)) {
							return [0, get.recoverEffect(target, player, target)];
						}
					},
				},
			},},

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


		// —— 赤霄剑：【杀】被闪抵消后，可弃一张牌令其仍造成伤害 ——
		ccz_chixiaojian_skill: {
			equipSkill: true,
			trigger: { player: ["shaMiss", "eventNeutralized"] },
			filter(event, player) {
				// event.type === "card" 照贯石斧补的：非牌途径产生的【杀】事件没有完整的
				// _result 结构，上面那两行赋值会抛。
				if (event.type !== "card" || !event.card || event.card.name !== "sha" || !event.target?.isIn()) {
					return false;
				}
				return player.countCards("h") > 0;
			},
			async cost(event, trigger, player) {
				event.result = await player
					.chooseToDiscard("h", get.prompt2("ccz_chixiaojian", trigger.target))
					.set("ai", card => {
						// 目标是敌人才值得弃牌;弃的牌越便宜越好
						const t = _status.event.getTrigger().target;
						if (get.attitude(get.player(), t) >= 0) {
							return 0;
						}
						return 8 - get.value(card);
					})
					.forResult();
			},
			async content(event, trigger, player) {
				// 【不能自己 damage()，要**取消那次闪避**】本体贯石斧（standard.js:3811，
				// 机制完全一样：弃牌令杀仍造成伤害）的写法就是把「闪成功」改成「没闪掉」，
				// 让那张【杀】自己的 damageTarget() 跑完。
				// 原来写 trigger.target.damage(player, get.nature(trigger.card))，那是**另一次伤害**，
				// 不是"这张杀的伤害"，于是四处全错：
				//   · 酒的 +1 不生效 —— damage() 读的是 _status.event.baseDamage，而技能事件没这个字段，永远算 1 点
				//   · 玉玺的 +1 不生效 —— 它的 filter 要 event.card.name 是 sha，而这里 event.card 是 undefined
				//   · 连环铠/镜铠挡不住 —— 它们同样判 event.card.name === "sha"
				//   · 白银铠会误挡 —— 它防的是 !event.card（无来源牌的伤害），恰好把这一下当技能伤害挡下了
				// 描述写的是「仍受到此【杀】的伤害」，这个写法才名副其实。
				if (event.triggername === "shaMiss") {
					trigger.untrigger();
					trigger.trigger("shaHit");
					trigger._result.bool = false;
					trigger._result.result = null;
				} else {
					trigger.unneutralize();
				}
			},
		},

		// —— 青龙宝玉：三次判定，每次黑色造成 1 点雷电伤害 ——
		ccz_qinglongbaoyu_skill: {
			equipSkill: true,
			enable: "phaseUse",
			usable: 1,
			filterCard(card) {
				return get.suit(card) === "club";
			},
			// 【只能弃手牌，不能弃装备区】"he" 会把装备区算进去 —— 而装备区里恰好有
			// 这件宝玉本身，玩家能"弃掉青龙宝玉来发动青龙宝玉"。
			position: "h",
			check(card) {
				return 8 - get.value(card);
			},
			filterTarget(card, player, target) {
				return target !== player;
			},
			async content(event, trigger, player) {
				const target = event.target;
				// 【四次而不是三次】实测三次太弱：期望 1.5 点伤，而成本是一张梅花手牌 +
				// 出牌阶段限一次，不如直接出一张【杀】。四次 = 期望 2 点雷伤。
				for (let i = 0; i < 4; i++) {
					// 目标死了/自己死了就停,别对着空位继续判
					if (!target.isIn() || !player.isIn()) {
						break;
					}
					const { color } = await player
						.judge(card => (get.color(card) === "black" ? 2 : -2))
						.set("judge2", result => result.bool)
						.forResult();
					if (color === "black") {
						await target.damage(player, "thunder");
					}
				}
			},
			ai: {
				order: 8,
				result: {
					// 期望 2 点雷电伤害(4 次判定 × 黑色 50%)。damageEffect 会自动算目标血量/属性/防具/会不会被杀死,
					// 乘以 2 就是期望收益 —— 不用自己算"值不值得"。
					target(player, target) {
						return 2 * get.damageEffect(target, player, target, "thunder");
					},
				},
			},
		},

		// —— 朱雀宝玉：弃♦，对目标及其上下家各 1 点火属性伤害 ——
		ccz_zhuquebaoyu_skill: {
			equipSkill: true,
			enable: "phaseUse",
			usable: 1,
			filterCard(card) {
				return get.suit(card) === "diamond";
			},
			// 【只能弃手牌，不能弃装备区】"he" 会把装备区算进去 —— 而装备区里恰好有
			// 这件宝玉本身，玩家能"弃掉朱雀宝玉来发动朱雀宝玉"。
			position: "h",
			check(card) {
				return 8 - get.value(card);
			},
			filterTarget(card, player, target) {
				return target !== player;
			},
			async content(event, trigger, player) {
				const target = event.target;
				// 先把三个目标定下来再逐个结算 —— 否则前一个死了会改变 next/previous 的指向
				const list = [target, target.next, target.previous].filter(t => t?.isIn() && t !== player);
				for (const t of new Set(list)) {
					if (t.isIn()) {
						await t.damage(player, "fire");
					}
				}
			},
			ai: {
				order: 8.5,
				result: {
					target(player, target) {
						// 三个人的收益要加起来:主目标 + 上下家(排除自己)
						let sum = get.damageEffect(target, player, player, "fire");
						for (const t of [target.next, target.previous]) {
							if (t && t !== player && t !== target && t.isIn()) {
								sum += get.damageEffect(t, player, player, "fire");
							}
						}
						return sum;
					},
				},
			},
		},

		// —— 白虎宝玉：弃♥，至多 3 名角色各回复 1 点体力 ——
		ccz_baihubaoyu_skill: {
			equipSkill: true,
			enable: "phaseUse",
			usable: 1,
			filterCard(card) {
				return get.suit(card) === "heart";
			},
			position: "h",
			check(card) {
				return 8 - get.value(card);
			},
			selectTarget: [1, 2],
			multitarget: true,
			multiline: true,
			filterTarget(card, player, target) {
				return target.isDamaged();
			},
			async content(event, trigger, player) {
				for (const t of event.targets) {
					if (t.isIn() && t.isDamaged()) {
						await t.recover();
					}
				}
			},
			ai: {
				order: 9,
				result: {
					target(player, target) {
						return get.recoverEffect(target, player, target);
					},
				},
			},
		},

		// —— 玄武宝玉：造成伤害后弃♠，按判定点数施加一种 debuff ——
		ccz_xuanwubaoyu_skill: {
			equipSkill: true,
			trigger: { source: "damageSource" },
			// 【每回合限一次】不限的话一张【万箭齐发】打中 5 人 = 5 次伤害事件，
			// 连弃 5 张黑桃就能把 5 个人全禁一轮。另三枚宝玉都是出牌阶段限一次，频率对齐。
			usable: 1,
			filter(event, player) {
				// 【必须排除 event.player === player】damageSource 在"你造成伤害"时触发，
				// 而"你对自己造成伤害"（苦肉、崩坏这类）同样满足 —— 不排除就会给自己上 debuff。
				if (!event.player?.isIn() || event.player === player) {
					return false;
				}
				return player.countCards("h", card => get.suit(card) === "spade") > 0;
			},
			async cost(event, trigger, player) {
				event.result = await player
					.chooseToDiscard("h", card => get.suit(card) === "spade", get.prompt2("ccz_xuanwubaoyu", trigger.player))
					.set("ai", card => {
						if (get.attitude(get.player(), _status.event.getTrigger().player) >= 0) {
							return 0;
						}
						return 8 - get.value(card);
					})
					.forResult();
			},
			async content(event, trigger, player) {
				const target = trigger.player;
				const { number } = await player.judge(() => 0).forResult();
				// A~4 麻痹(禁杀) / 5~8 禁咒(禁技能) / 9~Q 混乱(禁锦囊) / K 失效
				// 各段 4/13 = 30.8%,13 只占 1/13 = 7.7% —— 高成功率但有小概率反噬。
				let skill = null;
				if (number >= 1 && number <= 4) {
					skill = "ccz_mabi";
				} else if (number >= 5 && number <= 8) {
					skill = "ccz_jinzhou";
				} else if (number >= 9 && number <= 12) {
					skill = "ccz_fengnang";
				}
				// 【K 从"无效果"改成本体的真·混乱】原来 K 是 7.7% 的空模——弃了一张黑桃、
				// 用掉每回合那一次，什么都没得到。而 K 是最大的点数，配最强的效果才自然。
				// 本体的混乱(goMad)并不是个有规则文本的技能，mad 只是个标记，
				// 机制全在两处：
				//   get/index.js:6554  attitude()  → if (from.isMad()) att = -att;  敌友颠倒
				//   player.js:13316  isUnderControl() → 混乱者失去操作权，交 AI 托管
				// 即「敌友颠倒 + 失控一回合」。本体只有 boss 模式和杀海拾遗在用。
				// 命中率从 92.3% 变 100%，而且多了个 7.7% 的大奖。
				if (!skill) {
					target.goMad({ player: "phaseAfter" });
					player.popup("混乱", "thunder");
					return;
				}
				target.addTempSkill(skill, { player: "phaseAfter" });
			},
			ai: {
				// 12/13 概率能施加一个 debuff,期望价值按"控住对手一轮"算
				expose: 0.2,
			},
		},

		/** 混乱：不能使用锦囊牌。与 ccz_mabi(禁杀)、ccz_jinzhou(禁技能) 同族 */
		ccz_fengnang: {
			mark: true,
			marktext: "囊",
			intro: { content: "不能使用锦囊牌" },
			mod: {
				cardEnabled(card) {
					if (get.type2(card) === "trick") {
						return false;
					}
				},
			},
		},
	},

	translate: {
		caocaozhuan_card_config: "曹操传",

		// 武器
		ccz_fangtianhuaji: "方天画戟",
		ccz_fangtianhuaji_bg: "戟",
		ccz_fangtianhuaji_info: "每回合限两次且每名角色限一次，当你使用【杀】或【决斗】对其他角色造成伤害后，你可以弃置一张手牌，视为对另一名角色使用一张【杀】或【决斗】（无距离限制）。",
		ccz_fangtianhuaji_skill: "方天画戟",
		ccz_fangtianhuaji_skill_info: "当你使用【杀】对目标角色造成伤害后，你可以弃置一张牌，视为对该角色的上家或下家使用一张【杀】。每名角色每回合限一次。",

		ccz_lvbuzhigong: "吕布之弓",
		ccz_lvbuzhigong_bg: "弓",
		ccz_lvbuzhigong_info: "锁定技，当你使用【杀】对其他角色造成伤害后，该角色直到其下个回合结束前不能使用【杀】。",
		ccz_lvbuzhigong_skill: "吕布之弓",
		ccz_lvbuzhigong_skill_info: "锁定技，当你使用【杀】对其他角色造成伤害后，该角色直到其下个回合结束前不能使用【杀】。",
		ccz_mabi: "麻痹",
		ccz_mabi_info: "你不能使用【杀】。",

		ccz_ligzhigong: "李广之弓",
		ccz_ligzhigong_bg: "弓",
		ccz_ligzhigong_info: "锁定技，当你使用【杀】对其他角色造成伤害后，该角色直到其下个回合结束前不能发动技能（装备技能除外）。",
		ccz_ligzhigong_skill: "李广之弓",
		ccz_ligzhigong_skill_info: "锁定技，当你使用【杀】对其他角色造成伤害后，该角色直到其下个回合结束前不能发动技能（装备技能除外）。",
		ccz_jinzhou: "禁咒",
		ccz_jinzhou_info: "你不能发动技能（装备技能除外）。",

		ccz_jinhuoguanpao: "金火罐炮",
		ccz_jinhuoguanpao_bg: "炮",
		ccz_jinhuoguanpao_info: "锁定技，当你使用【杀】对其他角色造成伤害后，该角色获得“灼伤”标记：其下个判定阶段开始时进行判定，若判定结果为梅花则流失1点体力。",
		ccz_jinhuoguanpao_skill: "金火罐炮",
		ccz_jinhuoguanpao_skill_info: "锁定技，当你使用【杀】对其他角色造成伤害后，该角色获得“灼伤”标记：其下个判定阶段开始时进行判定，若判定结果为梅花则流失1点体力。",
		ccz_zhuoshang: "灼伤",
		ccz_zhuoshang_info: "判定阶段开始时，你进行一次判定，若判定结果为梅花则流失1点体力。",

		ccz_wuhuoshenyanshan: "五火神焰扇",
		ccz_wuhuoshenyanshan_bg: "焰",
		ccz_wuhuoshenyanshan_info: "锁定技，每回合限一次，当你造成火属性伤害时，此伤害+1。",
		ccz_wuhuoshenyanshan_skill: "五火神焰扇",
		ccz_wuhuoshenyanshan_skill_info: "锁定技，当你造成火属性伤害时，此伤害+1。",

		ccz_qixingjian: "七星剑",
		ccz_qixingjian_bg: "星",
		ccz_qixingjian_info: "锁定技，你使用的锦囊牌不能被【无懈可击】响应。",
		ccz_qixingjian_skill: "七星剑",
		ccz_qixingjian_skill_info: "锁定技，你使用的锦囊牌不能被【无懈可击】响应。",

		ccz_yangyoujizhigong: "养由基之弓",
		ccz_yangyoujizhigong_bg: "弓",
		ccz_yangyoujizhigong_info: "出牌阶段，你可以将两张相同花色的手牌当【万箭齐发】使用。",
		ccz_luanji: "乱击",
		ccz_luanji_info: "出牌阶段，你可以将两张相同花色的手牌当【万箭齐发】使用。",

		// 防具
		ccz_jingkai: "镜铠",
		ccz_jingkai_bg: "镜",
		ccz_jingkai_info: "锁定技，当你受到【杀】造成的伤害时，若伤害来源与你的距离不小于3，此伤害无效。",
		ccz_jingkai_skill: "镜铠",
		ccz_jingkai_skill_info: "锁定技，当你受到【杀】造成的伤害时，若伤害来源与你的距离不小于3，此伤害无效。",

		ccz_lianhuankai: "连环铠",
		ccz_lianhuankai_bg: "环",
		ccz_lianhuankai_info: "锁定技，每回合你只会受到一次【杀】造成的伤害，之后的【杀】伤害均无效（非【杀】造成的伤害不受影响）。",
		ccz_lianhuankai_skill: "连环铠",
		ccz_lianhuankai_skill_info: "锁定技，每回合你第二次及以后受到【杀】造成的伤害时，此伤害无效。",

		ccz_huangjinkai: "黄金铠",
		ccz_huangjinkai_bg: "金",
		ccz_huangjinkai_info: "锁定技，属性伤害对你无效。",
		ccz_huangjinkai_skill: "黄金铠",
		ccz_huangjinkai_skill_info: "锁定技，属性伤害对你无效。",

		ccz_baiyinkai: "白银铠",
		ccz_baiyinkai_bg: "银",
		ccz_baiyinkai_info: "锁定技，不由卡牌造成的伤害（如武将技能造成的伤害）对你无效。",
		ccz_baiyinkai_skill: "白银铠",
		ccz_baiyinkai_skill_info: "锁定技，不由卡牌造成的伤害（如武将技能造成的伤害）对你无效。",

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

		// 坐骑
		ccz_bailongju: "白龙驹",
		ccz_bailongju_bg: "+1",
		ccz_bailongju_info: "锁定技，你计算与其他角色的距离时始终-1。",

		ccz_wuyuntaxue: "乌云踏雪",
		ccz_wuyuntaxue_bg: "-1",
		ccz_wuyuntaxue_info: "锁定技，其他角色计算与你的距离时始终+1。",

		// 武器（赤霄剑）
		ccz_chixiaojian: "赤霄剑",
		ccz_chixiaojian_bg: "霄",
		ccz_chixiaojian_info: "当你使用的【杀】被【闪】抵消后，你可以弃置一张手牌，令目标角色仍受到此【杀】的伤害。",
		ccz_chixiaojian_skill: "赤霄剑",
		ccz_chixiaojian_skill_info: "当你使用的【杀】被【闪】抵消后，你可以弃置一张手牌，令目标角色仍受到此【杀】的伤害。",

		// 四象宝玉
		ccz_qinglongbaoyu: "青龙宝玉",
		ccz_qinglongbaoyu_bg: "龙",
		ccz_qinglongbaoyu_info: "出牌阶段限一次，你可以弃置一张梅花手牌并选择一名其他角色，然后进行四次判定：每次判定结果为黑色，你对其造成1点雷电伤害。",
		ccz_qinglongbaoyu_skill: "青龙宝玉",
		ccz_qinglongbaoyu_skill_info: "出牌阶段限一次，你可以弃置一张梅花手牌并选择一名其他角色，然后进行四次判定：每次判定结果为黑色，你对其造成1点雷电伤害。",

		ccz_zhuquebaoyu: "朱雀宝玉",
		ccz_zhuquebaoyu_bg: "雀",
		ccz_zhuquebaoyu_info: "出牌阶段限一次，你可以弃置一张方块手牌，对一名其他角色及其上下家各造成1点火属性伤害（不含你，故目标为你的邻座时只有两名角色受到伤害）。",
		ccz_zhuquebaoyu_skill: "朱雀宝玉",
		ccz_zhuquebaoyu_skill_info: "出牌阶段限一次，你可以弃置一张方块手牌，对一名其他角色及其上下家各造成1点火属性伤害（不含你，故目标为你的邻座时只有两名角色受到伤害）。",

		ccz_baihubaoyu: "白虎宝玉",
		ccz_baihubaoyu_bg: "虎",
		ccz_baihubaoyu_info: "出牌阶段限一次，你可以弃置一张红桃手牌，令至多两名已受伤的角色各回复1点体力。",
		ccz_baihubaoyu_skill: "白虎宝玉",
		ccz_baihubaoyu_skill_info: "出牌阶段限一次，你可以弃置一张红桃手牌，令至多两名已受伤的角色各回复1点体力。",

		ccz_xuanwubaoyu: "玄武宝玉",
		ccz_xuanwubaoyu_bg: "武",
		ccz_xuanwubaoyu_info: "每回合限一次，当你对其他角色造成伤害后，你可以弃置一张黑桃手牌并进行判定，令该角色直到其下个回合结束前：判定结果为A~4，不能使用【杀】；5~8，不能发动技能（装备技能除外）；9~Q，不能使用锦囊牌；K，进入混乱状态。",
		ccz_xuanwubaoyu_skill: "玄武宝玉",
		ccz_xuanwubaoyu_skill_info: "每回合限一次，当你对其他角色造成伤害后，你可以弃置一张黑桃手牌并进行判定，令该角色直到其下个回合结束前：判定结果为A~4，不能使用【杀】；5~8，不能发动技能（装备技能除外）；9~Q，不能使用锦囊牌；K，进入混乱状态。",
		ccz_fengnang: "封囊",
		ccz_fengnang_info: "你不能使用锦囊牌。",
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
		// 坐骑
		["heart", 3, "ccz_bailongju"],
		["spade", 5, "ccz_wuyuntaxue"],
		// 武器（赤霄剑）
		["diamond", 12, "ccz_chixiaojian"],
		// 四象宝玉：花色对应五行方位（青龙♣东方木、朱雀♦南方火、白虎♥红桃、玄武♠北方水）
		["club", 1, "ccz_qinglongbaoyu"],
		["diamond", 1, "ccz_zhuquebaoyu"],
		["heart", 1, "ccz_baihubaoyu"],
		["spade", 1, "ccz_xuanwubaoyu"],
	],
};
