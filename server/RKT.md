# 使魔大战3 网页版 · 复刻对照追踪表 (Replica Tracking / RKT)

> **唯一真相来源 (SSOT)**: `e/源码解析成为txt/*.ecode`（易语言可读中文文本）
> **目标**: 后端 NestJS+TS / 前端 Vue3 / Prisma，1:1 逐行复刻
> **状态图例**: ✅已完成 · 🔶部分完成 · ⬜未开始 · ⚠️已知偏差(按原版保留)
>
> 本表用于逐模块/逐函数追踪复刻进度，每次复刻完一个单元后更新其状态，并补充「原文行号 + 复刻代码 + 自检结论」到本表对应条目。

---

## 0. 源码体量基线 (e/源码解析成为txt/*.ecode 行数)

| 文件 | 行数 | 角色 |
|------|------|------|
| _主程序.ecode | 12070 | 主流程 / 指令分发 (134+ 命令分支) |
| 战斗相关.ecode | 5438 | 伤害/战斗/反伤/掉落核心 |
| 加成计算.ecode | 4342 | 玩家/怪物属性计算、升级公式、套装、增益 |
| 物品操作.ecode | 3019 | 装备/武器/制造/分解/载具/箱子 |
| 数据显示.ecode | 3875 | 面板/信息文本渲染 |
| 使魔技能.ecode | 2745 | 使魔被动/主动技能、召唤 |
| 数据存取.ecode | 1717 | 存档读写 |
| 后台运作.ecode | 1696 | 定时器/每分钟/世界事件 |
| 地图操作.ecode | 1691 | 地图移动/连接/怪物刷新 |
| 数据分析.ecode | 1096 | 统计/排行榜 |
| 接口1.ecode | 1523 | 外部接口(DULU/MYQQ 对接原版) |
| 使魔家园.ecode | 375 | 家园系统 |
| 管理操作.ecode | 97 | 管理命令 |
| 文本操作.ecode | 406 | 文本工具 |
| 快捷输入.ecode | 165 | 快捷指令 |
| 主程序集_DULU.ecode | 198 | DULU 机器人入口 |
| 主程序集_MYQQ.ecode | 146 | MYQQ 机器人入口 |
| @Struct.ecode | 806 | 数据结构定义 |
| @Global.ecode | 91 | 全局变量 |
| @Constant.ecode | 281 | 常量 |
| 窗口程序集_窗口1.ecode | 257 | 原版 Windows 窗口(映射为无 UI 逻辑) |

---

## 1. 基础设施 / 已建成

| 单元 | 原文 | TS 实现 | 状态 | 备注 |
|------|------|---------|------|------|
| 指令引擎分发 | _主程序.ecode L3-259 (Main) | `command/command.service.ts` dispatch | ✅ | 前缀路由(两/三/四字命令) → DB Command 表 + handler |
| 选使魔门禁 | _主程序.ecode L798 | `command.service.ts` getFirstFamiliarGate | ✅ | 非老玩家发任何指令拦截 |
| 离线时间补偿 | 加成计算 L2383-2408 | `game.service.calculateTimeElapsed` | ✅ | 距上次>10秒按回复率回血/盾/甲 |
| Socket 实时推送 | (原版无, 新增) | `command.service.pushState` | ✅ | 指令后 pushPlayerUpdate/pushMapUpdate |
| 静态配置加载 | @Resource*.txt / 常量 | `static-data.service.ts` + `prisma/data/*.json` | ✅ | 22 文件进版本控制, 懒加载 |
| 玩家身份字段 | (原版 QQ) | `User.qqNumber` / `User.externalId` | ✅ | openid 与 QQ 号分离兼容 |

---

## 2. 加成计算.ecode (4342 行)

| 单元 | 原文行号 | TS 实现 | 状态 | 备注 |
|------|----------|---------|------|------|
| 加成限制 | L3 | — | ⬜ | |
| 加成限制1 | L64 | — | ⬜ | |
| 计算增益 | L81 | `bonus.service`? | ⬜ | 不要放修改.属性的增益 |
| 获得地图增益 | L577 | `map.service`? | ⬜ | |
| 计算战斗力 | L653 | — | ⬜ | |
| 获得增益2 | L664 | — | ⬜ | 战斗中获得 buff |
| 叠加加成 | L682 | — | ⬜ | |
| **升级经验公式** | **L1781-1794** | `player.service.calcUpgradeExp` L64 | ✅ | `(c*c+5)*(1+升级经验/100)*(1-风月入墨/100)`；注意 addExp 尚未接入 bonus.升级经验/风月入墨减益(暂按0) |
| _计算玩家 (玩家属性构建) | L1567-1833 | `combat-system.buildAttackerBonus` / `player.service.recalcLevelStats` | ✅ | 1:1 还原：L1567-1680 装备循环/增幅器/植入体复位、L1681-1779 武器循环(冷却/锁定/机械触手/普拉娜)、L1781-1794 升级经验公式、L1799-1833 通用成长+使魔专属加成、L1836-2188 称号/套装/特殊序号分支、L2187-2221 宠物存活、L2222-2244 黑色兔子玩偶/一拳、L2274-2342 套装判断2/植入体/增幅器/晚礼服、L2343-2382 三回复/脏弹/宙斯盾、L2409-2464 反转童话/兰音、L2523-2559 宙斯盾/纯洁无瑕/破刃、L2596-2608 卷土重来/线圈、L3097-3142 计算buff(增益列表并入)。全部已在 buildAttackerBonus 落地，103 用例通过 |
| _初始化怪物 (怪物属性构建·等级成长) | L2644-2777 / 2847-2861 | `map.service.refreshMapMonsters` | ✅ | 三层池血量对齐 L2764-2766：`(1+等级*0.05)*(基础+等级*20)*(1+觉醒/200)`；其余属性(L2767-2777)仅×lvFactor×觉醒因子；旧实现漏 `+等级*20` 与觉醒因子已修正；见下方「2.2 _初始化怪物 深层」 |
| 法宝加成2 | L3053 | — | ⬜ | |
| 计算buff | L3097 | `bonus.service.calculateBuffs` + `combat-system.buildAttackerBonus` 接入 | ✅ | 1:1 还原(mqtx/湮灭/削弱闪避/xla/xlb/xlc 特殊效果 + default 遍历增益列表叠加)；buildAttackerBonus 末尾已接入调用，增益列表(buffs.json)中文key→英文key映射(zhToEn)；新增 test/combat.spec.ts 3用例(网增益闪避2-30→×0.7) |
| 法宝加成 | L3143 | — | ⬜ | |
| 最终加成 | L3233 | — | ⬜ | |
| 载具加成 | L3334 | — | ⬜ | |
| 套装判断2 | L3381 | — | ⬜ | |
| 增加穿透 | L3446 | `combat-system`? | ⬜ | |
| 增强器 | L3453 | — | ⬜ | 1护盾2装甲3生命 |
| 计算载具 | L3556 | `combat-system.computeVehicle` + `vehicle-parts.json` | ✅ | 1:1 还原(L3556-3912)：载具.加成重置；展开内置零件+匹配部件列表套用上限/行走/防御/武器/功能四类(正负二分支，原版L3647-3714)；硅基核心阿尔法=1.035/贝塔=1.025；核心partType=0设上限与行走方式；逆转力场攻击/攻击2/韧性×0.34+全抗加成(L3752)；湮灭圣光+氢弹→贯穿+20/审判/星爆/炼狱导弹+导弹→贯穿+10/8/5并加穿透(L3769-3801)；小雫/小凰/小蓝/小粉上限+1(L3804-3815)；超限判定当前生命=0/行走方式=0(L3836-3854)；部件限制按`物品3.名称/数量`统计，超限清零(L3855，修复了临时对象复用和错误读取`数值`)；上限标志1→3/2(L3887-3894)；封顶当前生命≤加成.生命(L3895)；产出分支L3898-3911已接入`calculateVehicleProduction`。`vehicle-parts.json`现为完整导出的166条载具部件规格，为硬前置数据。`test/combat.spec.ts`及`test/vehicle-production.spec.ts`覆盖核心/内置部件/超限 |
| 叠加载具加成 | L3913 | `combat-system.stackVehicleBonus` | ✅ | 1:1 还原(L3913-4020)：核心负面降低=硅基核心加成>1?1-(硅基核心加成-1)*2:1；逐字段>0用硅基核心加成否则用核心负面降低(攻击2/生命2/护盾2/装甲2/闪避2/命中2/电火冰物伤2/溅射2/速度2/生命回复2/护盾回复2/装甲回复2/攻击/护盾/装甲/生命/闪避/命中/电火冰物伤/溅射/速度)；生产字段生产类?×1:×1/4；攻击次数累加 |

### 2.2 _初始化怪物 深层 (buildMonsterBonusFromDef) 自检 (🔶 阶段A)

> 迁移背景：原 `GameMap.spawnMonsters/tempMonsters` 是 JSON 快照，已废弃；怪物现持久化于 `GameMonster` 表（1:1 对齐 @Struct.ecode 玩家结构 L287-341）。`refreshMapMonsters` 读取 `monsters.json`（bonus 已预合并的中文 key JSON），再经本函数套用 `_初始化怪物` L2748-3052 的**纯计算层**（属性已由 JSON 提供，故跳过"生成装备"那步）。

【原文 L2748-3052 关键句（节选）】
```
' L2764-2766 三层池(生命/护盾/装甲)等级成长
生命/护盾/装甲 = (1 + 等级*0.05) * (基础 + 等级*20) * (1 + 觉醒/200)
' L2767-2777 其余属性等级成长
攻击/防御/速度/闪避/命中/暴击... = 成长因子 × 基础 × 好感系数(a1) × 觉醒因子
' L2829 击杀标记加成 (觉醒>0 时按标记叠抗/攻)
' L2847-2861 觉醒分层: 觉醒≥100 / ≥200 / ≥400 逐级强化
' L2871 一拳套: 攻击 +25%
' L2873 雪心套: 闪避 -25%
' L2875 恶智套: 再生减半
' L2877 线圈套: 四系伤害减半(原版 冰伤=火伤/2 疑似笔误, 按原版保留)
' L1581 套装判断 → 写入 玩家.套装
```

【复刻】`map.service.ts` `buildMonsterBonusFromDef(defBonus, opts)`:
```ts
// 好感系数 a1：从 defBonus.affinity / 好感 取，缺省 1
const a1 = 1 + (affinity / 1000);  // 原版好感/1000 形式
// 觉醒因子 lvFactor 见 L2764-2784
const lvFactor = (1 + level * 0.05);                  // 三层池
const otherFactor = (1 + level * 0.05);               // 其余(原版系数)
// 三层池：基础+等级*20 然后 ×觉醒因子
b.生命 = lvFactor * (baseHp + level*20) * (1 + awaken/200);
// 觉醒分层 ≥100/200/400
if (awaken >= 100) { /* 强化 */ }
// 一拳/雪心/恶智/线圈 → 调用 combatState.setJudgment 按 equipments 名称判定
const setData = combatState.setJudgment(setData, eqName, specialSeq);
// 一拳: attack *= 1.25 ；雪心: dodge *= 0.75 ；恶智: regen/2 ；线圈: 四系伤害/2
```

【自检】阶段 A 已对齐：三层池 `+等级*20` 与觉醒因子、好感系数、觉醒分层、一拳/雪心/恶智/线圈四套效果（线圈保留原版 `冰伤=火伤/2` 疑似笔误）、套装判定经 `combatState.setJudgment` 写入 `b.套装`。⚠️已知偏差：原版 L2748-2760「生成装备」步在本次实现中跳过（JSON 的 bonus 已预合并，无需再生成），后续若需动态装备生成再补；法宝加成(L2863)/载具加成/增益计算/战斗力(L3031) 仍⬜，依赖怪物对象扩展 markers/sets/好感/成就/活力 字段。

### 2.3 端到端实测 + setJudgment 短路 bug 修复 (2026-08-17)
经 `NestFactory.createApplicationContext` 直接调 `MapService.refreshMapMonsters` 并查远程 MySQL GameMonster 表验证：
- **等级成长 1:1 对齐 L2764-2777**：医疗室 L1 史莱姆 hp=52(=1.05×(30+20)×1)、shield/armor=21、atk=10、speed=105、dodge/hit=10、物伤=5.25、四抗=10、暴伤=157.5；飞龙谷 L1 冰霜飞龙 hp=2121、dodge=210、hit=241、冰伤=315 —— 全部命中公式。
- **发现并修复 2 个真实 bug**（setJudgment 翻译错误）：
  1. `combat-state.service.ts` `setJudgment` 第一段 `if(特殊序号!==0){switch{...}return;}` —— 无论 switch 是否命中都 `return`，导致 specialSeq 非0时**名称判定段永远不执行**（原版语义是"命中才返回"）。改为每个 case 命中 `return`、default `break` 后继续第二段名称判定。
  2. `map.service.ts` `buildMonsterBonusFromDef` 仅遍历 `opts.equipments` 调 setJudgment，**未用怪物自身 specialSeq 调一次** → 怪物穿线圈套(specialSeq=123)不触发。补 `setJudgment(setData,'',selfSeq)`。
  3. 一拳套装判定原误用 `w1=substring(0,4)==='一拳'`（"一拳套装"4字="一拳套"不匹配），改为 `w2==='一拳'`（取2字，对齐原版 取文本左边(名称,2)）。
  4. 一拳加攻原误用 `addMonsterAttackPercent`（乘四伤），原版「增加攻击(玩家,,25)」第二参数为空→加**攻击力**，改 `b.攻击*=1.25`；`refreshMapMonsters` 写 attack 字段优先用 `finalBonus.攻击`（含一拳加成）。
- **修复验证**：一拳套(4件)→攻击125、线圈(动能线圈123)→物伤÷2=75、雪心增益(xuexin)→闪避×0.75、觉醒400→生命×3，全部正确。
- 经完整原版数据重建后，monsters.json **已含带套装装备的怪物**（34 个：防爆16/生命19/无畏5/动力5/圣诞6/强袭6/纳米3/纯白9/黑婚1/黑手1/心形2/创可贴1/线圈1），怪物套装效果已随 refreshMapMonsters 写入 GameMonster.set 生效；玩家侧套装经 2026-08-17 recomputeSets 修复后亦生效。

---

### 2.1 升级经验公式 自检 (✅ 已对齐)

【原文 L1786-1794】
```
a2 = (c * c + 5) * (1 + 玩家.加成.升级经验 / 100) * (1 - a3 / 100)
.判断循环首 (a1 - a2 > 0)
    a1 = a1 - a2
    c = c + 1
    a2 = (c * c + 5) * (1 + 玩家.加成.升级经验 / 100) * (1 - a3 / 100)
.判断循环尾 ()
玩家.等级 = c
玩家.升级经验 = a2
玩家.剩余经验 = a1
```
【复刻】`player.service.ts` L64 `calcUpgradeExp(level, upgradeExpBonus=0, fengyueReduction=0)`:
```ts
const base = level * level + 5;
const exp = base * (1 + upgradeExpBonus / 100) * (1 - fengyueReduction / 100);
```
【自检】数值 1:1。原版循环累减求等级，TS 直接按公式算单级门槛(等价)。**偏差**: 原版 `a3`=风月入墨减益在 `_计算玩家` 中经 `增益要求("风月入墨",...)` 取; 当前 `calcUpgradeExp` 默认 0, addExp 未接入 → ⚠️已知偏差, 待 _计算玩家 完整后接入。

---

## 3. 战斗相关.ecode (5438 行)

| 单元 | 原文行号 | TS 实现 | 状态 | 备注 |
|------|----------|---------|------|------|
| 武器攻击 | L3 | `combat-system.weaponAttack` | 🔶 | 已接攻击入口 |
| **造成伤害 (核心伤害模型)** | **L872** | `combat-system.calcDamage` L1417 + `weaponAttack` weapons-effects 区块 | 🔶 | 命中/闪避倍率、下限归一、随机区间、三段暴击评级、百分比穿透、等级差距新人加成 **已对齐**; 套装/使魔专属特效已分三批落地(第二批 L1813-2160 创世纪/安乐天使/永恒主宰/短衬衫2/负面类型/感电星尘/圣诞/龙姬驱魔；第三批 L2161-2258/2439/2471-2586 古月娜/恶毒之刃/伊芙利特燃烧/绝灭炮冠/军姬影光万象2/星尘斗转星移/恶毒色欲/龙姬怒吼/长萌承受/saber ex/四糸乃冰凯/吸血姬猩红/战斗女仆守护超频/绝灭光盾/军姬剑阵招架/剑阵标记，均对照原版 specialSeq 常量实现); **第四批武器特殊序号判断(2026-08-18) 已落地 L1827-1867**：仿真尾巴(-36)遍历攻击方武器对处于冷却者CD-5、火焰飞羽(-30)防御方加飞羽增益、纵横(-13)额外生命火伤+=防御方生命×0.05×额外伤害倍率、矢量(-12)额外装甲冰伤+=防御方装甲×0.05、影光(-23)防御方加影光增益、寒风(-10)防御方所有武器CD+30、光棱(-29)攻击方「类型+技能冷却」-60(释放使魔技能因循环依赖未注入，列为待补)；⚠️ 框架约定对齐：`markers2`(数组,{name,expireAt毫秒})=原版「标记2」(武器/技能冷却容器，与L295-322武器冷却同容器)，`markers`(对象,{key:秒})承载原版「标记」及被复用为标记2的时间间隔(短衬衫2/永恒主宰等)；本批次仿真尾巴/寒风/光棱的冷却读写统一走`markers2`毫秒，纵横/矢量走BonusData，火焰飞羽/影光走buffs，battle-e2e 7用例全过； **格挡系统已落地(2026-08-18)**：L2512-2688 几率判断(格挡)子系统完整复刻——花园猫幻时/阿尔缇娜/防爆盾(+10)/金刚不坏(+10)/圆盾(+5+冷却120回满三池免疫)/烟雾弹(+20)/裸体围裙/透明围裙/含光(陪睡>6 +50, >7 随机比例)/铃铛 累计格挡值，触发后暴击倍率×0.25(默认)或随机比例，圆盾三池回满+免疫；套装类型减伤 L2689-2723(防爆/游骑兵/游侠/动力/无畏 按武器类型×(1-套装值/10))；激变星增益伤害0免疫 L2724-2727；**修复 poolDamage 缩放**：forcedMult/dodge 倍率改动最终伤害后，applyDamageToMonster 与 formatDamageText 改用按 finalDamage/damage 比例同步缩放的三池 poolDamage，否则格挡后实际扣血/展示文本仍按未乘倍率的原 damage 三池数值(如格挡×0.25 后仍扣满原伤害导致误杀)；**已接入**：卷土重来L3674（怪物击杀玩家→满状态复活，见上表新增行）；**仍待补（属载具受击子系统，依赖载具战斗闭环，玩家当前无驾驶载具被攻击入口）**: 伤害过低未破防L3440(伤害<0.05×载具总状态→伤害=0)/贯穿L3192(攻击方.贯穿-防御方.抗贯穿 几率判定+载具部位穿透)/载具受击L3175(载具当前生命>0时阿尔缇娜贯穿×1.5) |
| 攻击目标 | L4021 | `combat-system` + `combat-state` | 🔶 | **基石层已建**：`combat-state.service.ts` 1:1 复刻 添加成就L678/取成就熟练度L719/置成就熟练度L850/标记要求L747/添加标记L778/增益要求L799/获得增益L1522/时间间隔要求L1008。待补：护盾层(L4113-4271)/装甲层(L4275-4396)/生命层(L4398-4511)特效分支（激变星/强袭/坚韧护盾/盾逆/吸血姬/兰音护盾文本/破盾成就/捕捉模式/免死/麻醉等）需怪物对象扩展 markers/sets/好感/成就/活力 字段后接入 |
| _初始化怪物(深层) | L2748-3052 | `map.service.buildMonsterBonusFromDef`/`combat-state` | 🔶 | **基石层+阶段A已建**：状态机helper + `套装判断`(物品操作L1581,完整specialSeq常量映射 `constants/special-seq.constant.ts`)+`装备要求`(L1512)+`buildMonsterBonusFromDef`(整合L2748-3052等级成长/好感/击杀标记/觉醒/一拳/雪心/恶智/线圈/套装判定)。待补：装备生成(L2748)/法宝加成(L2863)/载具加成/增益计算/战斗力(L3031)。依赖怪物对象扩展 markers/sets/好感/成就/活力 字段 |
| 套装判断 | L1581 | `combat-state.setJudgment` | ✅ | 1:1 复刻：按 specialSeq switch + 按名称前缀(取文本左边4/2字)累加 SetData 字段；增幅器71-75/植入体76-79范围、动力封顶5 等已对齐 |
| 套装效果生效(玩家) | _计算玩家 L2284/L3381 | `item.service.recomputeSets`+`buildAttackerBonus` | ✅ | **2026-08-17 修复**：原 player.sets 永不被写入→玩家穿套装全不生效。新增 recomputeSets 在 equipItem/unequipItem/equipImplantItem/equipAmplifierItem/equipmentPreset 装备变更后遍历 equipment+weapons 调 setJudgment 累加写入 player.sets；buildAttackerBonus 实时消费 maid/amplifier/lifeBless/onePunch/implan/coil 等（植入体×1.25/L2329、增幅器==1冷却/L2609、科学家≥4/L2619、晚礼服≥4/L2590、线圈÷2/L2596、一拳==4/L2239 等已就位）。test/item-system.spec.ts 5 用例回归 |
| 装备要求 | L1512 | `combat-state.equipRequire` | ✅ | 1:1 复刻：武器(当前手持)/装备(名称或specialSeq)检索，增幅器/植入体范围判断 |
| 战斗 | L4512 | `combat.service` / `game-command` | 🔶 | 怪物闪避/幻时/移动临时怪物已部分 |
| 挑战怪物 | L4726 | `combat-system.challengeMonsterName` | ✅ | 按整数 a 分段返回怪物名(绿毛龟/水元素/.../精英兔子/露娜)；新增 test/combat.spec.ts 5用例 |
| 计算反伤 | L4791 | `combat-system.calcReflectDamage` + `calcDamage` 调用处 | ✅ | 1:1 还原(L4791-4873)：恶毒好感≥100(色欲30s)→100%/军姬好感≥40(剑阵)→100%/荆棘之翼(#18)+0.15/小鱼发饰(#35)+2(60s冷却)/军姬2(#24)好感≥40→+1+(2+技能×0.05)带军姬倍率限制(≤(2+技能×0.05)×总状态)；倍率默认0.1(L4803)→无来源也按10%基础反伤；a2=攻击方理论受伤×伤害倍率/100、a1=防御方理论伤害(含z2武器系数)、封顶防御方当前状态、最终=a2/a1×100;test/combat.spec.ts 8用例(含2个中/英文key兼容用例)。**2026-08-18 数据格式统一**：combat-state 新增 `normalizeBuffItem` 兼容层，markerRequire/buffRequire/avoidDeath 读取前将英文key(name/expireAt,秒)归一化为中文key(名称/有效期至,毫秒)，存量数据两套格式互认；calcReflectDamage 已验证军姬/恶毒反伤运行时中英文格式均能触发 |
| 战利品 | L4874 | `item-system.distributeLoot` + `combat-system.handleMonsterDeath` | ✅ | 装备展开/资源(好感·经验·默认)/成就/背包写入/掉落文本；combat-system注入itemSystem；新增 test/item-system.spec.ts 4用例 |
| 掉落残骸 | L4947 | `combat-system.dropWreckage` | ✅ | 地精系列累加载具残骸次数；新增 test/combat.spec.ts 3用例 |
| 光荣弹 | L4987 | — | ⬜ | 死亡触发一次性反击：构造临时装备(四伤25+必中)、按 死方(生命+装甲+护盾)与 攻方(四伤*0.25) 比值算倍率a1、护盾/装甲/生命穿透+50、调造成伤害(光荣弹a)；依赖完整造成伤害对外调用链(临时装备+返回伤害文本w1)，当前 calcDamage 闭包未暴露该入口，待接入 |
| 免死 | L5020 | `combat-system.avoidDeath` + 接入 `playerDeath` | ✅ | 1:1 还原(L5020-5096)：龙姬(specialSeq=12)怒吼→b=2、伊芙利特(specialSeq=11)五番冷却未过→获得增益五番a、战斗女仆(specialSeq=8)守护3→b=5、吸血姬(活力=-15)与分身(活力=-16)互换生命、猫爪吊坠(specialSeq=23)猫爪冷却未过→获得增益猫爪；L5072 独立判断 增益要求猫爪→b=4/五番a→b=3/默认→b=1（⚠️原版 L5072 默认 b=1 会覆盖 龙姬b=2/战斗女仆b=5，致怒吼/守护3 实际不免死，原版疑似冗余分支，按原版保留）；b==2 总伤害+当前生命-1且当前生命=1、b==3/4/5 生命-0免死返回真。依赖 combatState.gainBuff/timeIntervalRequire + playerService.getMarkerValue；**兼容性修复**：avoidDeath 内部调用 combatState.normalizeBuffItem 将 buffs/markers2 原地归一化为中文key(兼容英文key+秒级)，playerDeath 调用时传浅拷贝副本避免污染本函数后续英文key读取；新增 test/combat.spec.ts 10用例 |
| 行动无限制 | L5097 | `combat-system.actionUnrestricted` | ✅ | 1移动2复活3采集4工作5躺下6自动开采；markers2秒级expireAt一致；新增 test/combat.spec.ts 9用例 |
| 玩家死亡 | L5173 | `combat-system.playerDeath` | ✅ | 卷土重来/军姬森罗万象/死亡行者/石中剑 复活豁免；军姬宠物存活借 map.summons 近似；**已接入 avoidDeath（原版 免死 优先于 玩家死亡，L5020 先于 L5173 调用）**；新增 test/combat.spec.ts 5用例 |
| 选择目标 | L5233 | `combat-system.selectTargets` | ✅ | 支持指定目标、目标名称回退、全体攻击和随机单目标选择；由 `weaponAttack` 统一调用。 |
| 置掉落 | L5245 | `combat-system.setDrop` | ✅ | 掉落率dl/品质dp/传说率xy/宝石缎带ds 写入怪物标记；⚠️原版L5291传说率段误用掉落品质按原版保留；新增 test/combat.spec.ts 4用例 |
| 生成前线 | L5319-5422 | `combat-system.generateFrontline` + `familiar-system.handleHomeFrontline` / `game.service.handleStartBattle` | ✅ | 生成前线主体、首次查看前线自动生成、阵地召唤物/载具状态持久化均已接线；开始战斗后按前线等级生成地精波次、写入 `GameMonster`、置掉落并写入地图活动标记。原版建筑加成.攻击无对应静态建筑时仍按原版走默认火力自动步枪分支；阵地载具使用完整 `computeVehicle`。`test/integration-home-frontline.spec.ts` 覆盖首次生成、重复查看保留状态及 `<15/<40/<60/≥60` 波次 |
| 选择高血量目标 | L5423 | `combat-system.selectHighHpTarget` | ✅ | 返回生命+装甲+护盾总和最大者索引；新增 test/combat.spec.ts 4用例 |
| **怪物反击扩至全图玩家** | **战斗相关.ecode L4647-4713** | `combat-system.monsterCounterAttack` + `monsterCounterAttackOnePlayer` | ✅ | 原版怪物作为攻击方遍历 `d.玩家`，筛选「在线(活跃增益)+当前生命>0+无隐匿模式+无炮冠」加入防御方，怪物对每个武器攻击全图防御方。本版：注入 StatsService 取在线集合，查同地图玩家(D) + 攻击者本人(内存mock/原版攻击者在地图玩家列表) 逐一过滤（离线/死亡/隐匿模式/炮冠 跳过），抽取 `monsterCounterAttackOnePlayer` 对每个受害者独立做命中/闪避/幻时/含光/光荣弹/伤害结算。✅ 2026-08-18 完成；端到端实测(test/integration-counter-attack.spec.ts 真实远程库) 验证：A攻击后文本同时含"攻击你"与"攻击端到端测试b"，证明全图反击生效；回归 battle-e2e 幻时/含光用例（补 statsService mock 解决） |
| **卷土重来（玩家被击杀复活）** | **战斗相关.ecode L3674** | `combat-system.monsterCounterAttackOnePlayer` 死亡分支 | ✅ | 怪物击杀玩家时若 `jlq` 冷却(60s)未过→发放"卷土重来"增益(30+玩家.加成.卷土重来 秒)并满状态(生命/护盾/装甲=上限)复活，不入死亡。与 playerDeath L5182-5184「已持卷土重来增益→免死」互补 |

### 3.1 造成伤害 核心已对齐段 自检 (🔶)

【原文 L2274-2379 摘要】
```
总伤害倍率 = 攻击命中 / 防御闪避      ' L2274
倍率×下限 > 1 时归一为 1              ' L2289 (防高命中爆炸)
随机区间 [倍率×伤害下限, 1+伤害上限] ' L2317
三段暴击评级 绝杀/完美/致命/强力/正中/擦过/描边 ' L2309-2379
百分比穿透: 有效抗性=(单项抗+全抗)×(1-穿透/100) ' L4140
等级差距新人加成: 等级<世界等级×10 → gap=1-等级/(世界等级×10) ' L1817
```
【复刻】`combat-system.service.ts` calcDamage (L1417起):
- 命中/闪避倍率 + 索敌计算机保留逻辑 ✅
- 随机区间 + 下限归一 ✅
- 七级暴击评级 + 熟练度累加 ✅
- 百分比穿透 ✅ (effectiveResist = (single+all)*(1-pen/100))
- 等级差距放大 ✅
【自检】核心模型已对齐。待补清单见上表 L3440/L3192/L2583 等。

---

## 4. 物品操作.ecode (3019 行)

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 计算价值 | L3 | `item-system`? | ⬜ |
| 强化植入体 | L57 | `handlers/info?` | ⬜ |
| 强化增幅器 | L211 | — | ⬜ |
| 制造 | L365 | `handlers`? | ⬜ |
| 加成转数据 | L541 | — | ⬜ |
| 背包操作 (搜索/查看/丢弃/保护) | L696 | `inventory.handler` | 🔶 |
| 操作保险柜 | L1009 | `inventory.handler`? | ⬜ |
| 丢弃物品 | L1050 | `inventory`? | ⬜ |
| 生成装备 | L1128 | `item-system.generateEquipment` | ✅ | 深度还原(L1128-1261)：品质随机/词条展开(随机护盾等)/去重/词条转换/特效生成/序列化 |
| 词条转换 | L1838 | `item-system.rollAffix` | ✅ | 深度还原(L1838-1996)：中文词条→英文BonusData键，按品质倍率随机区间(护盾500-1000×倍率等) |
| 词条数据层(静态JSON) | 数据存取 L513 / 使魔大战.txt 属性= | `convert-e-to-json.ts`+`StaticDataService` | ✅ | equipments.json 296/307 装备已带属性=词条(原硬编码'[]')；generateEquipment 经 gameEquip.affixes 读取并展开 |
| 解析装备 | L1262 | `item-system.parseEquip` | ⬜ |
| 物品要求 | L1784 | `item-system.itemRequire` | ✅ | 1:1 还原(L1784-1811)：遍历物品数组，空要求数量→存在即满足写回下标；指定数量→数量≥要求才满足；不足→found=false 且 hint="需要X的NAME，你只有Y"；未命中→false。返回封装{found,index,hint}；test/item-system.spec.ts 6用例 |
| 装备要求 | L1512 | `item-system` | ⬜ |
| 套装判断 | L1581 | `bonus`? | ⬜ |
| 物品要求 | L1784 | — | ⬜ |
| 判断物品2 | L1812 | — | ⬜ |
| 寻找装备 | L1824 | — | ⬜ |
| 资源需求 | L1997 | — | ⬜ |
| 取物品数量 | L2022 | — | ⬜ |
| 装备特效要求 | L2042 | — | ⬜ |
| 是否装备 | L2065 | — | ⬜ |
| 分解装备 | L2076 | `handlers/use?` | ⬜ |
| 取逆向值 | L2158 | — | ⬜ |
| 部件类型转换 | L2180 | — | ⬜ |
| 是否部件 | L2196 | — | ⬜ |
| 打开箱子 | L2220 | `gather`? | ⬜ |
| 激活装备特效 | L2459 | — | ⬜ |
| 宠物觉醒装备 | L2493 | — | ⬜ |
| 组装载具 | L2518 | `game.service.handleAssembleVehicle` / `handleInstallPart` | 🔶 | 基础组装与部件安装已接线；完整拆卸返还、仓储和所有原版分支仍需逐项核对 |
| 取咏星加成 | L2599 | — | ⬜ |
| 配方配平 | L2612-2690 | `game.service.handleVehicleProduction` 的`配平`分支 | ✅ | 按目标配方消耗、其他配方产出、耐久、副产物倍率、生产效率和顺序写回生产力；原版无匹配产出时保留提示。 |
| 取生产产出 | L2692-2954 | `combat-system.calculateVehicleProduction` / `produceVehicle` | ✅ | 首次读取时间、生产速度/副产物/消耗倍率、生产力超限效率、限制库存、按配方顺序消耗与产出、无生产力具现装置、超限停止均已实现；`test/vehicle-production.spec.ts` 10/10 |
| 叠加物品数组 | L2955-2963 | `combat-system.mergeVehicleItem` / `addVehicleItemArray` | ✅ | 同名物品合并、中文/英文存量字段兼容、消耗归零删除，生产产出与载具零件写回使用同一逻辑 |
| 获得物品 | L2964 | `item-system.gainItem` | 🔶 |

---

## 5. 使魔技能.ecode (2745 行)

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 军姬X传送判断 | L3 | `familiar-skills`? | ⬜ |
| 普拉娜幼崽剪毛 | L14 | `familiar-system.pranaShear` | ✅ | 1:1 复刻：玩家.type==普拉娜幼崽 且装备剪刀时，每小时给当前地图动物剪毛获得毛发x1（_主程序 多处理 普拉娜幼崽剪毛 调用 + 使魔技能 L14-49）。familiar-system.service.ts L3520-3562 已实现 |
| 全属性调整 | L87-124 | `bonus.adjustAllAttributes` | ✅ | 按原版字段顺序原地缩放护盾/装甲/生命、三层抗性、命中闪避、四属性伤害、暴击、回复、贯穿及三层攻击伤害上限字段；`calculateBuffs` 的梦倾天下分支已调用。 |
| 取羽毛 | L125-163 | `combat-system.getFeather` | ✅ | 按原版时间锚点每10秒恢复、技能等级封顶、日轮1.5倍上限/好感≥40时恢复间隔减半、指定扣除及`-0.371`清空分支；炮击、光翼和属性计算已接入，专项断言已补。 |
| 纯白之翼 | L164-176 | `familiar-system.autoCastSkill` | ✅ | 检查“纯白之翼”、纯白cd、使魔公共冷却和自动训练冷却后触发技能；`test/familiar-auto-skill.spec.ts` 覆盖花园猫/兰音/冷却分支 |
| 释放使魔技能 (自动释放) | L179-207 | `familiar-system.autoCastSkill` + `familiar-skills.executeSkill` | ✅ | 兰音公共冷却归零时切换“形神合一”，其余技能沿用统一技能入口 |
| 召唤物存在 | L210-235 | `map.summonExists` | ✅ | 类型1跨全部地图查询友方 `summons`，类型2查询 `GameMonster`，兼容中英文字段和 JSON 字符串。 |
| 攻击召唤 | L236-373 | `combat-system.attackSummons` | ✅ | 兰音/雷火剑专属召唤、装备攻击文本召唤、全局唯一 QQ、60秒冷却、重力井拦截、宠物分身继承、友方地图写回与敌方 `GameMonster` 写入均已接入 `weaponAttack`；专项测试覆盖。 |
| 宠物搜索物品 | L374-485 | `familiar-skills.searchPetItems` | ✅ | 按麒麟/高好感/全宠物顺序、好感概率、魅力数量与冷却、建筑/小挎包、200好感装备分支处理；`test/familiar-search.spec.ts` 6例 |
| 随机未冷却武器 | L486-503 | `combat-system.randomAvailableWeapon` | ✅ | 从未冷却武器中随机返回1-based索引，并由技能攻击链路消费 |
| 技能经验 | L506-538 | `familiar-skills.gainSkillExperience` | ✅ | 按原版“最高技能/白套装/bj2/创可贴/nydg”顺序计算倍率并写回“类型+技能熟练度”；伊芙利特专项测试覆盖技能经验文本与标记 |
| 急救包 | L539-547 | `familiar-skills.applyFirstAid` | ✅ | 按属性三层上限的10%恢复护盾、装甲、生命，保持原版输出顺序 |
| **灼烂歼鬼（伊芙利特）** | **L1967-2006** | `familiar-skills.scorchedFinger` / `game-command.handler` | ✅ | 特殊序号门禁、冷却核心50/60秒、急救包、三层回满、库洛牌30/37.5秒增益、技能经验/使用技能/活跃度及好感≥100时当前武器“空间震a”全体攻击均已接入；`test/familiar-scorched-finger.spec.ts` 4例通过 |
| 释放闪避 | L550 | `game.service.handleDodge` | ✅ | 1:1 复刻：发「闪避」指令(_主程序 L1839 分发)→ 飞羽套装冷却加成(a2封顶10, L1840-1844)→ 冷却公式 15*(1+a2*0.05)(L1848)→ 释放闪避子程序(使魔技能 L550-633)：麻醉标记静默(L561)、闪避属性≤1拒绝(L564-565)、持续秒数 a1=(a/(25+a)+1)*4(L567-568, a=闪避熟练度)、空间主宰 a1*2(L569-573)、文本"名称尝试闪避攻击(a1秒)"(L576)、成就"闪避"/"闪避熟练度"+1(L577-578)、写入"闪避"增益 a1秒(L579)；使魔分支：花园猫(aff100→啾啾猫猫+闪避击 L580-585)、战斗女仆(aff100→清空武器冷却 L587-597)、龙姬(aff60→龙闪 L599-608)、普拉娜(aff30→火力压制 L610-619)。specialSeq 按 @Constant 修正(familiars.json 原全0→花园猫1/战斗女仆8/龙姬12/普拉娜22/兰音23等)，存量玩家 specialSeq 已远程修复(saber→19)。**2026-08-18 补全普拉娜(22)/兰音(23)使魔定义**：familiars.json 原缺失此2条导致无法选使魔；现已按 @Constant 补全(specialSeq 唯一无冲突)，selectFamiliar 兰音初始好感=20 逻辑(isLanyin)自动生效。端到端实测 test/integration-dodge.spec.ts 3例 + test/integration-familiar-select.spec.ts 2例(普拉娜seq22/兰音seq23+好感20)通过 |
| **使魔技能 (触发)** | **L634** | `familiar-skills` | ✅ | 兰音(specialSeq=23)全技能已落地：形神合一(L1545,地图怪物麻醉+风月入墨经验减)/风月入墨(L1640,好感≥20)/心无所扰(L1687,好感≥40,无视闪避必中)/梦倾天下/反转童话(L2535,好感≥80)/月落寸光(L2550,好感≥100,抗性穿透)；公共冷却 30-技能等级*0.5+a2(冷却核心-10)；兰音模式2友方召唤物同步(使魔技能 L2395/L1602)。普拉娜(specialSeq=22)火力全开(L897,攻击+60%好感加成,持续30秒)。指令分发 game-command.handler 兰音技能组(形神合一/风月入墨/心无所扰/梦倾天下/反转童话/月落寸光)+火力全开 已全部接线。selectFamiliar 兰音初始好感=20(isLanyin)对齐 #兰音 常量。✅ 2026-08-18 补全普拉娜/兰音使魔定义后端到端 test/integration-familiar-select.spec.ts 2例通过。**2026-08-18 实战端到端实测**：新建 test/integration-lann-plana-skill.spec.ts 8例(真实远程库)，逐一验证：风月入墨地图增益 value=-17.5%(skillLevel10,对齐 expReduce=15+等级*0.25)、心无所扰模式2友方召唤物 buffs 同步 mustHitNext、月落寸光模式2同步 nextPenetration+skillLevelForPen=10、形神合一地图风月入墨增益+友方同步文本、梦倾天下/反转童话蓄势标记写入、好感<40拦截心无所扰、普拉娜火力全开攻击加成落地+类型不匹配拦截。同步逻辑 ownerId 用 String(userId)(Prisma Player 无 qq 字段，getAllySummons 用 player.qq||String(userId) 故友方召唤物归属须=userId字符串)。13例端到端(dodge3+select2+lann8)全通过 |
| 月落寸光 | L2603 | `familiar-skills.moonlightInch` | ✅ | 好感≥100、公共冷却、抗性穿透与兰音模式2友方召唤物同步已接入；见 `test/integration-lann-plana-skill.spec.ts` |
| 反转童话 | L2631 | `familiar-skills.reverseFairytale` | ✅ | 好感≥80、下次攻击反转标记与公共冷却已接入；见 `test/integration-lann-plana-skill.spec.ts` |

---

## 6. 地图操作.ecode (1691 行)

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 地图移动/连接/怪物刷新 | 全文件 | `map.service` | 🔶 | 出生刷怪/semiDynamicFields 已修；`refreshMapResources` 对齐地图操作.ecode L995-1020，同时重建 `resources/resources2`；移动/连接其余分支仍待逐行 |

---

## 7. 后台运作.ecode (1696 行) / 定时

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 副本关闭与地图刷新 | 后台运作.ecode L1039-1106 | `dungeon.service.closeDungeon` | ✅ | 迁移玩家、合并召唤物/载具到地图23、移除“(副本)”入口、清理标记并刷新怪物/资源；`test/dungeon.spec.ts` 2例 |
| 每分钟刷新怪物/世界事件 | 全文件 | `schedule.service` | 🔶 | cron 主体已接入；后台世界事件及部分特殊分支仍需逐项核对 |

---

## 8. 数据显示.ecode (3875 行) / 面板

| 单元 | 原文行号 | TS 实现 | 状态 |
|------|----------|---------|------|
| 玩家/使魔/装备/任务 信息文本 | 全文件 | `info.handler` / `status.handler` | 🔶 |

---

## 9. _主程序.ecode 指令分发 (200+ 命令分支)

> **本表已于 2026-08-18 全量刷新**。原版 `_主程序.ecode` 的 `Main` 是单一巨型子程序（约 12000 行），用「取文本左边 2/3/4/5/6 字」路由到 200+ 命令分支。
> 现版分发架构：DB `Command` 表（指令元数据/权限/别名）+ `game-command.handler.ts`（`switch(cmdName)` 分发器，约 1600 行，200+ `case`，每个命令支持「中文命令名 + 英文别名」双 key）。
> 截至 2026-08-18，原版 **绝大部分命令分支已在 handler 中注册并实现内部逻辑**，下表按**模块**给出覆盖矩阵与真实缺口，不再逐条列举（逐条维护会迅速过时，见 §11 的真实待补清单）。

### 9.1 模块覆盖矩阵

| 模块（对应原版章节） | 注册命令数 | 内部逻辑状态 | 说明 |
|----------------------|-----------|--------------|------|
| 战斗入口（攻击/覅攻击pd/覅公jj/开始战斗/扫荡/停止战斗） | ~12 | 🔶 半 | `攻击`、`扫荡` 已走完整战斗模型；`开始战斗` 已复刻家园前线地精波次和活动接线，自动攻击循环已存在。通用战斗模式停止命令及部分后台驱动仍待补 |
| 召唤/使魔（召唤使魔/召唤1白1/命名/切换预设/使魔详细） | ~20 | ✅ 完 | 含随机召唤、协同攻击、成长公式 |
| 装备/武器（装备/卸下/切换武器/锁定/强化/解析/植入体/增幅器） | ~30 | ✅/🔶 | 装备/卸下/切换 ✅；植入体/增幅器强化 🔶 部分 |
| 物品（制造/移除/保护/丢弃/分解/图鉴/使用/背包搜索） | ~25 | ✅ 完 | 含战利品分发、词条转换 |
| 地图（观察附近/移动/传送/飞到/探测/拾取/采集） | ~25 | ✅ 完 | 出生刷怪、地图连接、资源点 |
| 家园（家园/搬迁/命名/音乐/操作/前线/产出） | ~10 | 🔶 半 | 动态院子/屋内/前线地图、入口、改名/搬迁持久化及前线状态已接通；家园产出核心已实现但特殊宠物/资源分支仍有逐项缺口 |
| 副本（开启副本/刷新副本/副本清空） | ~5 | ✅ | `game.service.handleStartDungeon/handleRefreshDungeon/handleClearDungeon` + `dungeon.service` 已接线；正式数据按复活点分为9组/25张地图，保留副本券、300秒刷新冷却、120秒通关标记和30秒延时关闭 |
| 商店（使魔商店/兑换/设置购物） | ~6 | 🔶 半 | 商店刷新定时 ✅；兑换交互 ⬜ |
| 捕捉（捕捉/开始捕捉/停止捕捉） | ~4 | ✅ | `familiar-system.capturePet` 已实现开始/停止捕捉、麻醉门禁、饲料扣除、成功转宠物、特殊捕捉奖励及 `GameMonster` 优先读取；`test/capture.spec.ts` 覆盖主分支 |
| 救助/对话/呼叫/设置跟随/福音书/安乐天使/炮击 | ~10 | ⬜ 占位 | handler 已注册，内部为占位/部分 |
| 任务/查看/成就/标记/管理命令 | ~30 | ✅ 完 | 任务发放、面板、管理后台 |
| 日常/定时（自动战斗/自动采集/商店刷新/神王降临/副本） | 后台 | ✅ 完 | `后台运作.ecode` 经 cron 驱动 |

图例：✅ 完全实现并接线 ｜ 🔶 部分实现/存在子分支缺口 ｜ ⬜ 已注册 handler 但内部为占位或空白

### 9.2 已确认的"收口级"缺口（低成本、确定、无需架构决策）
- `生成前线 L5319`：函数、家园前线首次查看和开始战斗接线已完成；剩余差异仅是原版战斗建筑静态数据尚未全部导入。
- `启示录混乱`：技能"启示录"本身已实现，但其"混乱状态"分支未实现（依赖怪物 AI 改写）。
- `贯穿 L3192` / `贯穿抵抗`：已在伤害模型实现，`贯穿抵抗` 词条解析待补（small）。

---

## 10. 测试现状 (见 test/ 目录)

| 测试目标 | 覆盖算法 | 状态 |
|----------|----------|------|
| 升级经验公式 | 加成计算 L1786 | ✅ `test/bonus.spec.ts` |
| 伤害计算模型 | 战斗相关 L2274-2379 | ✅ `test/combat.spec.ts`（34 用例） |
| 生成装备+词条转换 | 物品操作 L1128/L1838 | ✅ `test/item-system.spec.ts` |
| 战利品分发 | 战斗相关 L4874 | ✅ `test/item-system.spec.ts`（4 用例） |
| 使魔兰音 etc. 专项 | 使魔技能 L? | ✅ `test/integration-lann-plana-skill.spec.ts` |
| 伊芙利特灼烂歼鬼 | 使魔技能 L1967-2006 | ✅ `test/familiar-scorched-finger.spec.ts`（4用例） |
| 副本生命周期 | 后台运作 L1039-1106 / _主程序 L3863-3965、L7396-7409 | ✅ `test/dungeon.spec.ts`（2用例） |
| 指令分发路由 | _主程序 L126-130 | 🔶 部分（依赖 §11.1 战斗循环，路由层本身已通） |
| 怪物抗性映射 | buildMonsterBonus | ✅ 已含于 combat.spec.ts |
| 战斗循环 driver e2e | 战斗相关 L320-499 | ✅ `test/battle-e2e.spec.ts` |

本轮验证：`npm test` 通过 20/20 套件、244/244 测试；`npm run build` 通过；`git diff --check` 通过。地图静态数据共90张，正式副本候选9组/25张，`noSpecial` 按原版字段转换为26张 `true`、64张 `false`。

---

## 11. 真实剩余缺口与复刻方案（待你决策）

> 以下为**架构级/子系统级**缺口。按项目规则（"觉得原版哪里需要重构应告知方案由你决定"），我**未擅自大改**，仅列出方案供你拍板。

### §11.1 战斗循环 driver（用户已选「完整 1:1」，2026-08-18 复核结论：主体已落地）
- **复核结论（重要，修正此前过时判断）**：经完整通读 `combat-system.service.ts`，战斗循环 driver 的**主体实际已落地**，并非从零缺失：
  - `weaponAttack`（L237-2001）已串联：**玩家出手 → 召唤物协同(`summonCoAttack` L2013) → 怪物反击全图玩家(`monsterCounterAttack` L2109 → `monsterCounterAttackOnePlayer` L2179)**。
  - `monsterCounterAttackOnePlayer` 已实现怪物→玩家双向闭环：命中判定 → 玩家闪避（含幻时凝固 L2189 / 含光回防 L2237 / 花园猫反击 L2229）→ 三池扣血 → **玩家死亡→卷土重来 L2305 / 光荣弹 L2330** → `savePlayer`。
  - `startAutoCombat`(L5177) 已是「每5秒自动 `weaponAttack`」的 cron 式循环；`schedule.service.ts` 已有每分钟怪物刷新等定时。
  - 故不再新建 `runBattleRound`（会与现有 `weaponAttack`+自动战斗闭环分裂，违反单一真相）。
- **本轮补齐的真实子链路（用户点名「载具」）**：
  - **载具承伤**（原版 L3175-3288）：在 `monsterCounterAttackOnePlayer` 扣玩家血前插入——玩家驾驶载具(`victim.vehicle` 匹配 `map.vehicles` 实例且 `currentHp>0`) → 普通伤害先扣载具耐久；原版普通分支在载具承伤后清零剩余三池，因此载具耐久不足时同一次普通攻击不会把余量继续打到玩家；阿尔缇娜(`specialSeq=7`)攻击额外贯穿×1.5+伤害×(1.25+技等/200)；载具状态写回并持久化 `map.vehicles`。**部件级细节（损伤控制系统/贯穿抵抗/侵彻拆分）仍待逐行补齐**，不以近似实现冒充完成。
  - **扫荡走完整模型**（原版扫荡=攻击循环）：`handleSweep`(game.service L2893) 原用 `playerAtk-monster.defense` 假公式 → 改为逐怪调用 `combatSystem.weaponAttack`（含反击/召唤物闭环），消除与原版不一致。
- **仍待补（下一轮，独立大项）**：载具部件级受击（损伤控制系统/贯穿抵抗/侵彻拆分，L3194-3288 全量）；天神降世(觉醒)在反击方怪物侧的加成；家园产出剩余特殊分支；占位 handler 内部（§11.4）。

### §11.2 载具受击子系统（已部分落地，见 §11.1）
- 核心承伤闭环（载具先承伤/普通分支清零余池/阿尔缇娜贯穿）已于 2026-08-19 在 `monsterCounterAttackOnePlayer` 接入；普通载具耐久不足的原版行为由 `test/battle-e2e.spec.ts` 覆盖。
- 余下部件级细节随 §11.1 待补项单独立项。

### §11.2.1 载具生产逐行对照（2026-08-19）

【原文 `_主程序.ecode L10929-L11222`】

- `生产` 无参数的帮助文本、`生产0` 查看生产线、`生产1` 时间加速。
- `生产限制/配平/排序/配方名+生产力` 均在同一载具上下文内执行，载具来源优先接管状态，其次玩家驾驶状态。

【原文 `物品操作.ecode L2612-L2690`】

- 配方配平按目标配方的消耗寻找其他配方产出，乘耐久、副产物、生产效率和生产速度后写回生产力。

【原文 `物品操作.ecode L2692-L2954`】

- 以配方首项时间戳计算经过时间，按生产配方顺序消耗/产出；支持生产调度系统 I/II、生产加速、九尾狐、咏星、兰音幼崽、小凰/小雫/具现装置、生产限制、生产力超限和超限部件停止。
- 生产结果写回地图 JSON 或 `GameVehicle`，并推进生产成就及按物品拆分的任务。

【原文 `物品操作.ecode L2955-L2963`、`@Struct.ecode L635-L645`】

- 载具物品使用 `物品3.名称/数量/类型/耐久`；`mergeVehicleItem` 兼容现有英文 `name/quantity/type/durability` 存量数据。

【复刻】

- `server/src/modules/game/combat-system.service.ts`：`computeVehicle`、`calculateVehicleProduction`、`produceVehicle`、`mergeVehicleItem`。
- `server/src/modules/game/game.service.ts`：`findProductionVehicle`、`handleVehicleProduction`、`handleDriveVehicle`、`handleTakeoverVehicle`。
- `server/src/modules/command/handlers/game-command.handler.ts`：裸 `生产/生产0/生产1` 路由；`家园 生产` 保留家园命令路由。
- `server/prisma/convert-e-to-json.ts`、`server/prisma/data/vehicle-parts.json`、`server/prisma/data/vehicle-recipes.json`：完整静态载具数据 166/95。

【自检结论】

- `test/vehicle-production.spec.ts`：10/10；`test/combat.spec.ts`、`test/battle-e2e.spec.ts` 与生产相关回归合计 135/135。
- `npm run build` 通过；全量 `npm test`：20/20 套件、244/244 测试通过。
- 已知偏差：载具受击的损伤控制系统、贯穿抵抗、侵彻拆分仍未完成；部件限制全局无外部配置时按原版空数组运行。不得据此把整个 RKT 标记为完成。

### §11.2.2 副本生命周期与伊芙利特技能逐行对照（2026-08-19）

【原文 `_主程序.ecode L3863-L3965`、`后台运作.ecode L1039-L1106`、`_主程序.ecode L7396-L7409`】

- 开启副本按 `关卡 && !开拓地 && 名称前缀 != 使魔挑战` 收集复活点；消耗“副本券”、增加“开启副本”与5点活跃度，并追加“复活点(副本)”入口。
- 刷新副本使用“刷新副本冷却”300秒；关闭时把同复活点地图的玩家、召唤物、载具迁移到地图列表[23]，删除副本入口，刷新地图并清理配置的删除标记。
- 副本通关使用同复活点“刷新”标记120秒，并延时30秒调用关闭逻辑。

【原文 `使魔技能.ecode L506-L547、L1967-L2006`】

- `scorchedFinger` 按特殊序号11门禁；冷却核心决定50/60秒；执行急救包、回满生命/护盾/装甲、写入30秒或库洛牌37.5秒“灼烂歼鬼”，再记技能经验、使用技能和活跃度；好感≥100且有怪物时调用当前武器“空间震a”全体攻击。

【复刻与自检】

- `server/src/modules/game/dungeon.service.ts`：`getInstanceGroups`、`closeDungeon`；`server/src/modules/game/game.service.ts`：三个副本命令入口；`server/src/modules/game/familiar-skills.service.ts`：`scorchedFinger`、技能经验与急救包；`server/prisma/convert-e-to-json.ts`：地图字段转换。
- `server/test/dungeon.spec.ts` 2/2、`server/test/familiar-scorched-finger.spec.ts` 4/4、`server/test/attack-summon.spec.ts` 6/6；全量20/20套件、244/244测试及构建均通过。

### §11.3 家园子系统（前线/产出）
- **前线：✅ 已完成（2026-08-18）**。对照接口1.ecode L1395-1480，`MapService.ensureHouseMaps` 持久化院子、屋内、前线三张动态地图并维护入口；对照 _主程序.ecode L2228-2254，`FamiliarSystemService.handleHomeFrontline` 首次查看调用 `generateFrontline` 并保存召唤物/载具；对照 _主程序.ecode L2077-2163，`GameService.handleStartBattle` 按前线等级分支生成地精 `GameMonster`、置掉落、开启活动。真实数据库专项 `test/integration-home-frontline.spec.ts` 6/6 通过。
- **产出：✅ 核心闭环完成（2026-08-19）**。`HomeService.collectHomeOutput` 已按 `地图操作.ecode L1-600` 接通地图 `items/markers` 观测持久化、普通宠物/具现装置、作物/建筑优先级生产、电力/燃料/人力/超载、世界模拟器 AI、工业牵引、朱雀/腐化南方巨兽龙/白兔子/小雨下/小恶魔/肉食植物/螳螂/兔子窝/心之守望等特殊产出。特殊多产出共享消耗时间，世界模拟器核心保留 `data=a`；`test/home-output.spec.ts` 覆盖地图仓储隔离、具现装置、AI 核心和消耗约束。剩余差异仅为原版显示文本和少数运行时属性初始化的边缘分支，不阻塞产出玩法闭环。

### §11.4 占位 handler 内部实现
- `炮击/福音书/安乐天使/呼叫/设置跟随` 等 handler 仍有占位或简化实现，需逐条从原版 ecode 复刻；捕捉已移出本清单并完成。

### 11.5 本轮家园前线逐行对照与自检（2026-08-18）

【原文 _主程序.ecode L2077-2163】
```
a = 取地图列表编号 (玩家.房子名称 + “前线”)
.判断 (取数组成员数 (地图列表[a].怪物2) != 0)
...
.判断开始 (b < 15) ... 地精×2
.判断 (b < 40) ... 地精×2 + 地精十夫长
.判断 (b < 60) ... 再加入地精百夫长
.默认 ... 再加入地精千夫长，b >= 80 时加入地精将军
生成前线 (地图列表[a], 玩家.QQ, 原始时间戳, b)
```

【复刻】`game.service.ts` `handleStartBattle`：先检查家园进度/前线存活怪物，按相同阈值调用 `MapService.spawnMonsterByName` 写入 `GameMonster`，逐只调用 `setDrop`，再调用 `generateFrontline` 保存 `summons/vehicles` 和“活动”标记。

【原文 接口1.ecode L1395-1480】
```
d.名称 = 玩家列表[a].房子名称
... d2.名称 = 玩家列表[a].房子名称 + “屋内”
... d2.名称 = 玩家列表[a].房子名称 + “前线”
加入成员 (地图列表, d2)
```

【复刻】`map.service.ts` `ensureHouseMaps`：动态 `GameMap` 按名称幂等创建，院子与世界地图、屋内/前线与院子互相追加连接；`getAllMaps/getMapByName` 会返回数据库中的动态地图；`renameHouseMaps` 同步改名入口，搬迁移除旧世界入口。

【自检结论】专项真实数据库测试 6/6，通过 `npm test` 全量 20 suites/244 tests，`npm run build` 通过。已知偏差仅为静态战斗建筑数据及家园产出剩余特殊分支，未将其伪报为完成。

---

## 使用说明
1. 复刻时**先**在 ecode 中 `search_content` 定位目标子程序行号。
2. 在对应表格单元补充「原文 Lxxx + 复刻代码 + 自检结论」，并把状态改为 ✅/🔶。
3. 遇到原版疑似 bug/死分支 → 仍按原版实现，备注写 `// 原版逻辑 Lxxx 疑似笔误，按原版保留`，并在本表"备注"列标注。
4. 每完成一个文件级单元，运行 `npm test` 确保回归护栏通过。
