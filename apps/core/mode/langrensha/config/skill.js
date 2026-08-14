import { game, ui, _status, ai, lib, get } from "noname";

import { markGuessedGood, markInsight } from "./ai.js";

// 狼人杀的两条"规则技"。技能名以下划线开头 → game.finishSkill 会自动 addGlobalSkill，
// 无需给每个角色手动加技能；ruleSkill 只是把优先级压低(_priority -= 75)，让它排在角色技后面。
export default {
	// 每轮开始的"夜晚"：所有人同时行动，30 秒限时，之后按 觉孤 → 狼刀 → 女巫 → 预言家 的顺序结算。
	_sw_roundSkill: {
		trigger: { global: "roundStart" },
		ruleSkill: true,
		charlotte: true,
		direct: true,
		slient: true,
		firstDo: true,
		filter(event, player, name) {
			// 全局技能每个角色身上都会触发一次，用轮次号去重，保证一轮只跑一遍
			return !_status.langrenshaRound || _status.langrenshaRound < game.roundNumber;
		},
		async content(event, trigger, player) {
			_status.langrenshaRound = game.roundNumber;
			// 本轮的狼刀记账（playerid → 已安排的伤害），供狼刀 AI 避免把刀叠在同一人身上浪费。
			// 每轮清空。只记 AI 狼的选择：真人是并行秘密选的，主机在他响应前拿不到，
			// 而且把真人的秘密选择透给 AI 队友也不合适。
			_status.swNightPlan = {};
			_status.swNightPlanText = "";
			const targets = game.players.slice(0).sortBySeat();
			let answer_result = [[], []];
			let humans = targets.filter(current => current === game.me || current.isOnline()); // 真人
			let locals = targets.slice(0).randomSort(); // 本机托管的角色
			locals.removeArray(humans);
			// 【AI 狼排在真人之前决策】原来是"真人并行 → AI 顺序"，于是真人狼永远看不到 AI 队友
			// 刀了谁 —— 而真狼人杀里狼队是能互相看的（本模式只给了队内聊天，AI 又不会发言）。
			// 把 AI 狼提到最前面，它们决策完就往队内频道报一句、并汇总进 _status.swNightPlanText
			// 塞给真人狼的选择提示，真人于是能避开重复刀、或者一起集火收人头。
			// 决策顺序不影响结算：下面的结算是按 getAbility 遍历 answer_result 的，与顺序无关。
			const localLang = locals.filter(current => current.getAbility() === "lang");
			const localOther = locals.slice(0);
			localOther.removeArray(localLang);
			// 按身份给出对应的夜间选择。同一函数既在主机本地执行，也被 send 到客户端执行，
			// 故内部不能引用闭包外的变量。
			const send = current => {
				let next;
				switch (current.getAbility()) {
					case "lang":
						next = current.chooseTarget(get.prompt2("狼刀"));
						next.set("ai", target => {
							const player = get.player();
							const dmg = player?.swState?.langdao || 1;
							// _status.swNightPlan 记的是本轮已经由 AI 狼安排出去的刀（见下面 locals 循环）。
							// 狼刀同目标会累加，所以要区分三种情形，否则会出现"三头狼把 4 点全砸在
							// 1 血的人身上"这种纯浪费，或者"永远只挑没刀过的满血人、第二轮不去收残血"。
							const planned = (_status.swNightPlan && _status.swNightPlan[target.playerid]) || 0;
							let score = -get.attitude(player, target);
							if (planned >= target.hp) {
								score -= 4; // 队友的刀已经够收掉他了，再叠上去是纯浪费
							} else if (planned + dmg >= target.hp) {
								score += 3; // 这一刀正好能收人头 —— 最高优先
							} else {
								score += (5 - Math.min(5, target.hp)) * 0.3; // 收不掉就越残血越优先
							}
							return score;
						});
						// 提示里带上 AI 队友已经选好的刀（_status.swNightPlanText，只推给狼），
						// 免得真人狼盲选：要么撞在同一个满血目标上浪费，要么该集火时没集火。
						// 气泡会消失，但队内聊天里也报了一份，翻记录能查。
						next.set("prompt2", "选择一名角色，使其流失" + (current.swState.langdao || 1) + "点体力。（不触发技能）" + (_status.swNightPlanText ? '<br><span class="bluetext">队友已选：' + _status.swNightPlanText + "</span>" : ""));
						next.set("_global_waiting", true);
						break;
					case "nvwu":
						next = current.chooseButtonTarget({
							createDialog: [
								`###${get.prompt2("巫术")}###<div class="text center">选择复活或者毒杀一名角色<br>（每局游戏仅能使用一次！首轮无法使用！）</div>`,
								[
									[
										["revive", "复活"],
										["kill", "毒杀"],
									],
									"tdnodes",
								],
							],
							filterButton(button) {
								// get.event("xxx") 是废弃写法，每次调用都会打一条 console 警告（compatible.js:191）
								if (!get.event().canuse) {
									return false;
								}
								if (button.link == "revive") {
									return game.dead.length;
								}
								return true;
							},
							filterTarget(card, player, target) {
								return true;
							},
							selectTarget() {
								// 复活只能选死人、毒杀只能选活人，故按选中的按钮动态改写 filterTarget
								if (ui.selected.buttons.length) {
									const link = ui.selected.buttons[0].link;
									if (link == "revive") {
										_status.event.deadTarget = true;
										_status.event.filterTarget = function (card, player, target) {
											return target.isDead();
										};
										return 1;
									} else {
										_status.event.deadTarget = false;
										_status.event.filterTarget = function (card, player, target) {
											return !target.isDead();
										};
										return 1;
									}
								}
								return 0;
							},
							ai1(button) {
								const player = get.player();
								if (button.link == "revive") {
									// 复活回来是 3 体力 + 3 张牌，很值，但只救自己真信得过的人
									let best = 0;
									for (const current of game.dead) {
										best = Math.max(best, get.attitude(player, current));
									}
									return best - 2;
								}
								// 毒是一局一次的一发子弹，只对已经咬定的狼放
								let worst = 0;
								for (const current of game.players) {
									if (current == player) {
										continue;
									}
									worst = Math.min(worst, get.attitude(player, current));
								}
								return -worst - 2;
							},
							ai2(target) {
								const player = get.player();
								// 上面的 selectTarget 已按选中的按钮把 filterTarget 切成"只能选死人/只能选活人"，
								// 这里跟着 deadTarget 取相反方向：救人挑最信的，下毒挑最恨的
								return get.event().deadTarget ? get.attitude(player, target) : -get.attitude(player, target);
							},
						});
						next.set("canuse", !current.swState.nvwu && game.roundNumber > 1);
						next.set("_global_waiting", true);
						break;
					case "yvyanjia":
						next = current.chooseTarget(get.prompt2("预言"), "选择一名未查验过的角色，查验其的身份。");
						next.set("filterTarget", (card, player, target) => {
							return target != player && !player.getStorage("sw_yvyanjiaInsight").includes(target);
						});
						next.set("ai", target => {
							const player = get.player();
							// 查验没有代价，不该空过——chooseTarget 的 AI 在最高分 <=0 时会放弃
							// （ai/basic.js:223），所以给个正基线，再按可疑度排序。
							// 已经很信任的人反过来不值得占掉这次查验
							return 3 - get.attitude(player, target);
						});
						next.set("_global_waiting", true);
						break;
					case "jx_gudushaonv":
						if (!current?.swState?.jx_anlian && game.roundNumber == 1) {
							next = current.chooseTarget(get.prompt2("书以寄情"), lib.filter.notMe);
							next.set("ai", target => {
								const player = get.player();
								// 认下偶像后自己就归平民阵营，而偶像死在自己手上直接判本局目标失败，
								// 所以挑一个看着最像好人、又最耐活的
								return get.attitude(player, target) + target.hp + target.countCards("h") / 2;
							});
							next.set("prompt2", "选择一名角色，使其成为你的偶像");
							next.set("forced", true);
							next.set("_global_waiting", true);
							break;
						}
					// 已选过偶像的觉孤落到 default：与平民一样只有空过一手
					// eslint-disable-next-line no-fallthrough
					default:
						next = current.chooseBool(get.prompt2("空白"), "你没有能够在此时发动的技能，点哪个都一样~~~");
						next.set("_global_waiting", true);
						break;
				}
				if (game.online) {
					game.resume();
				}
				return next;
			};
			event._global_waiting = true;
			let time = 30000; // 30s 选择时间
			game.players.forEach(current => current.showTimer(time));
			game.broadcastAll(() => {
				_status.roundSkilling = true;
			});
			await game.delayx();
			// ── ① AI 狼先决策，结果播报给狼队 ──
			if (localLang.length > 0) {
				for (const current of localLang) {
					const result = await send(current).forResult();
					answer_result[0].push(current);
					answer_result[1].push(result);
					if (!result?.bool || !result.targets?.length) {
						continue;
					}
					const knifed = result.targets[0];
					const dmg = current?.swState?.langdao || 1;
					if (knifed?.playerid) {
						// 记账供后面的 AI 狼避免把刀叠在同一人身上浪费
						_status.swNightPlan[knifed.playerid] = (_status.swNightPlan[knifed.playerid] || 0) + dmg;
					}
					// 往队内频道报一句。chatTeamOnline 只发给狼（且只有 game.me / 在线真人狼收得到，
					// AI 之间互相不用看），并且会进 lib.SWchatHistory，气泡消失后还能翻聊天记录
					current.chatTeamOnline(`我刀 ${get.translation(knifed)}（${dmg}点）`);
					_status.swNightPlanText += `${_status.swNightPlanText ? "、" : ""}${get.translation(current)}→${get.translation(knifed)}(${dmg}点)`;
				}
				// 汇总只推给狼，不 broadcastAll —— 没必要让非狼的客户端也拿到狼队的计划
				if (_status.swNightPlanText) {
					const wolves = game.filterPlayer2();
					for (let i = 0; i < wolves.length; i++) {
						if (!wolves[i].isLang()) {
							continue;
						}
						if (wolves[i] === game.me) {
							continue; // 主机侧 _status 已经是同一份
						}
						if (wolves[i].isOnline2()) {
							wolves[i].send(text => {
								_status.swNightPlanText = text;
							}, _status.swNightPlanText);
						}
					}
				}
			}
			if (humans.length > 0) {
				const solve = function (resolve, reject) {
					return function (result, player) {
						answer_result[0].push(player);
						answer_result[1].push(result);
						resolve();
					};
				};
				// 真人并行等待：谁先选完谁先落袋，不按座位顺序阻塞
				await Promise.all(
					humans.map(current => {
						return new Promise((resolve, reject) => {
							if (current.isOnline()) {
								current.send(send, current);
								current.wait(solve(resolve, reject));
							} else {
								const next = send(current);
								const solver = solve(resolve, reject);
								if (_status.connectMode) {
									game.me.wait(solver);
								}
								return next.forResult().then(result => {
									if (_status.connectMode) {
										game.me.unwait(result, current);
									} else {
										solver(result, current);
									}
								});
							}
						});
					})
				).catch(() => {});
			}
			// ── ③ 其余 AI（预言家/女巫/猎人/觉孤）最后决策 ──
			if (localOther.length > 0) {
				for (const current of localOther) {
					const result = await send(current).forResult();
					answer_result[0].push(current);
					answer_result[1].push(result);
				}
			}
			delete event._global_waiting;
			game.players.forEach(current => current.hideTimer());
			game.broadcastAll(() => {
				_status.roundSkilling = false;
				// 队友刀谁的提示只在本轮夜里有意义，清掉免得下一轮/别处的提示里带出旧内容
				_status.swNightPlanText = "";
			});
			// 结算觉醒孤独少女：认下偶像并暂时归入平民阵营
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "jx_gudushaonv" && result?.targets?.length) {
					const target = result.targets[0];
					game.broadcastAll(
						(player, target) => {
							player.swState ??= {};
							player.swState.jx_anlian = target;
							player.swState._trueCamp = "ren";
						},
						now,
						target
					);
				}
			}
			// 结算狼刀：同一目标被多把刀选中则伤害累加
			const langdao = [[], []];
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "lang") {
					const target = result.targets[0];
					const index = langdao[0].indexOf(target);
					const dnum = now?.swState?.langdao || 1;
					if (index == -1) {
						langdao[0].push(target);
						langdao[1].push(dnum);
					} else {
						langdao[1][index] += dnum;
					}
				}
			}
			game.log("#b系统", "开始结算", "#y伤害类事件");
			for (let i = 0; i < langdao[0].length; i++) {
				const now = langdao[0][i];
				// 用 loseHp 而非 damage：狼刀不触发受伤类技能，_reason 供觉孤判定继承阵营
				await now.loseHp(langdao[1][i]).set("_triggered", null).set("_reason", "lang");
				// 被狼刀是公开可见的，而狼不会刀自己队友 → 全场推定他是好人。
				// 这是 AI 唯一的破冰信息源：开局所有人 ai.shown 都是 0，没有这一笔态度会全场归零
				markGuessedGood(now);
			}
			// 结算女巫
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "nvwu") {
					const target = result.targets[0];
					if (result.links == "revive") {
						if (!target.isDead()) {
							continue;
						}
						game.log(target, "因为", "#b女巫", "的", "#y神力", "复活了");
						await target.reviveEvent(3);
						await target.draw(3).set("_triggered", null).set("_reason", "nvwu");
						// 复活是全场可见的，女巫不会救狼 → 同狼刀，推定他是好人
						markGuessedGood(target);
					} else if (result.links == "kill") {
						if (!target.isIn()) {
							continue;
						}
						await target.loseHp(3).set("_triggered", null).set("_reason", "nvwu");
						// 毒杀不标记：掉体力的样子跟狼刀分不出来，而"女巫觉得他是狼"是女巫的私有判断，
						// 标出去就等于把女巫的想法广播给全场 AI
					}
					game.broadcastAll(player => {
						player.swState ??= {};
						player.swState.nvwu = true;
					}, now);
				}
			}
			// 结算预言家：查验结果只给预言家自己看 5 秒
			for (let i = 0; i < answer_result[0].length; i++) {
				const now = answer_result[0][i];
				const result = answer_result[1][i];
				if (!result?.bool) {
					continue;
				}
				if (now.getAbility() == "yvyanjia") {
					const target = result.targets[0];
					if (!target.isIn() || !now.isIn()) {
						continue;
					}
					const player = now;
					player.markAuto("sw_yvyanjiaInsight", [target]);
					event.videoId = lib.status.videoId++;
					const insightResult = get.insightResult(player, target);
					// 只记在预言家自己的 player.ai 上（不进 swState，swState 会被 syncState 广播给全场）。
					// 查出"狼"是铁证，查出"好人"只能算推定——隐狼的查验结果就是好人
					markInsight(player, target, insightResult);
					const send = (clientTarget, clientInsightResult, id) => {
						var classList = clientTarget.classList,
							nonStratagemInsightFlashing = classList.contains("flash-animation-iteration-count-infinite");
						if (nonStratagemInsightFlashing) {
							clientTarget.nonStratagemInsightFlashing = true;
						} else {
							classList.add("flash-animation-iteration-count-infinite");
						}
						var identity = get.translation(`${clientInsightResult}2`);
						var node;
						if (clientTarget.node.swPrompt) {
							node = clientTarget.node.swPrompt;
							node.innerHTML = "";
							node.className = "damage normal-font damageadded";
						} else {
							node = ui.create.div(".damage.normal-font", clientTarget);
							node.style.zIndex = 114515;
							clientTarget.node.swPrompt = node;
							ui.refresh(node);
							node.classList.add("damageadded");
						}
						node.innerHTML = identity;
						node.dataset.nature = clientInsightResult || "soil";
					};
					if (player == game.me) {
						send(target, insightResult, event.videoId);
					} else if (player.isOnline()) {
						player.send(send, target, insightResult, event.videoId);
					}
					const afterInsight = clientTarget => {
						if (clientTarget.node.swPrompt) {
							clientTarget.node.swPrompt.delete();
							delete clientTarget.node.swPrompt;
						}
						if (clientTarget.nonStratagemInsightFlashing) {
							delete clientTarget.nonStratagemInsightFlashing;
							return;
						}
						const classList = clientTarget.classList;
						if (classList.contains("flash-animation-iteration-count-infinite")) {
							classList.remove("flash-animation-iteration-count-infinite");
						}
					};
					setTimeout(() => {
						if (player == game.me) {
							afterInsight(target);
						} else if (player.isOnline()) {
							player.send(afterInsight, target);
						}
					}, 5000);
				}
			}
		},
	},
	// 死亡结算：先把狼刀伤害转移给存活狼队友，再让猎人/白狼开枪
	_sw_dieSkill: {
		trigger: {
			player: ["dieAfter"],
		},
		ruleSkill: true,
		charlotte: true,
		forceDie: true,
		nopop: true,
		popup: false,
		log: false,
		async cost(event, trigger, player) {
			if (player?.swState?.langdao) {
				const target = game.filterPlayer(current => current.isLang() && current != player).randomGet();
				if (target) {
					target.swState ??= {};
					target.swState.langdao ??= 0;
					target.swState.langdao += player.swState.langdao;
					const str = "您的" + player.swState.langdao + "点狼刀伤害已经转移给了" + get.translation(target);
					const str2 = get.translation(player) + "的" + player.swState.langdao + "点狼刀伤害已经转移给了您";
					if (player == game.me) {
						game.createTip(str);
					} else if (player.isOnline()) {
						player.send(str => {
							game.createTip(str);
						}, str);
					}
					if (target == game.me) {
						game.createTip(str2);
					} else if (target.isOnline()) {
						target.send(str => {
							game.createTip(str);
						}, str2);
					}
				}
			}
			switch (player.identity) {
				case "lieren":
				case "bailang":
					event.result = await player
						.chooseTarget(get.prompt2("开枪"), lib.filter.notMe, "选择一名其他角色，对其造成" + player.maxHp + "点伤害")
						.set("ai", target => {
							const player = get.player();
							return -get.attitude(player, target);
						})
						.forResult();
					break;
				default:
					// 其他身份没有死亡技，走一个空询问保持各端节奏一致，再把 bool 抹掉不进 content
					event.result = await player.chooseBool(get.prompt2("空白"), "你没有能够在此时发动的技能，点哪个都一样~~~").forResult();
					event.result.bool = false;
					break;
			}
		},
		async content(event, trigger, player) {
			switch (player.identity) {
				case "lieren":
				case "bailang": {
					const target = event?.targets[0];
					game.log(player, "对", target, "发动了", "【开枪】");
					player.line(target);
					await target.damage(player, player.maxHp);
					break;
				}
				default:
					break;
			}
		},
	},
};
