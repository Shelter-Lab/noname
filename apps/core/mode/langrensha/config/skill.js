import { game, ui, _status, ai, lib, get } from "noname";

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
			const targets = game.players.slice(0).sortBySeat();
			let answer_result = [[], []];
			let humans = targets.filter(current => current === game.me || current.isOnline()); // 真人
			let locals = targets.slice(0).randomSort(); // 本机托管的角色
			locals.removeArray(humans);
			// 按身份给出对应的夜间选择。同一函数既在主机本地执行，也被 send 到客户端执行，
			// 故内部不能引用闭包外的变量。
			const send = current => {
				let next;
				switch (current.getAbility()) {
					case "lang":
						next = current.chooseTarget(get.prompt2("狼刀"));
						next.set("ai", target => {
							const player = get.player();
							return -get.attitude(player, target);
						});
						next.set("prompt2", "选择一名角色，使其流失" + (current.swState.langdao || 1) + "点体力。（不触发技能）");
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
								if (!get.event("canuse")) {
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
								return Math.random();
							},
							ai2(target) {
								return Math.random();
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
							return -get.attitude(player, target);
						});
						next.set("_global_waiting", true);
						break;
					case "jx_gudushaonv":
						if (!current?.swState?.jx_anlian && game.roundNumber == 1) {
							next = current.chooseTarget(get.prompt2("书以寄情"), lib.filter.notMe);
							next.set("ai", target => {
								const player = get.player();
								return get.attitude(player, target);
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
			if (locals.length > 0) {
				for (const current of locals) {
					const result = await send(current).forResult();
					answer_result[0].push(current);
					answer_result[1].push(result);
				}
			}
			delete event._global_waiting;
			game.players.forEach(current => current.hideTimer());
			game.broadcastAll(() => {
				_status.roundSkilling = false;
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
					} else if (result.links == "kill") {
						if (!target.isIn()) {
							continue;
						}
						await target.loseHp(3).set("_triggered", null).set("_reason", "nvwu");
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
