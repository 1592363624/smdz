/**
 * 数据库种子脚本
 * 初始化默认频道、基础指令表、系统配置、默认管理员账号。
 * 固定游戏数据（地图/怪物/物品/装备/使魔/配方/任务等）已 JSON 化，
 * 由 seed-data.ts（动态数据）与 StaticDataService（固定配置）负责。
 * 运行：npm run prisma:seed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 开始写入种子数据...');

  // 1. 默认世界频道
  const channel = await prisma.channel.upsert({
    where: { name: '世界频道' },
    update: {},
    create: { name: '世界频道', description: '所有玩家公屏频道' },
  });
  console.log(`✅ 频道: ${channel.name} (id=${channel.id})`);

  // 2. 基础指令表（中文指令名作为主名，英文作为别名）
  // 基础指令（help, info, inventory, move, map）保留独立 handlerKey
  // 其余游戏指令统一使用 handlerKey: 'game'，由 GameCommandHandler 统一分发
  const commands = [
    // 基础指令（独立处理器）
    { name: '帮助', alias: 'help,指令,命令', description: '查看所有可用指令', handlerKey: 'help', minRole: 'USER', sortOrder: 1 },
    { name: '信息', alias: 'info,资料,查看,状态', description: '查看自己的玩家信息', handlerKey: 'info', minRole: 'USER', sortOrder: 2 },
    { name: '背包', alias: 'inventory', description: '查看背包物品', handlerKey: 'inventory', minRole: 'USER', sortOrder: 3 },
    { name: '移动', alias: 'move,前往,去,飞到,go', description: '移动到指定地图', handlerKey: 'move', minRole: 'USER', sortOrder: 4 },
    { name: '地图', alias: 'map,查看地图', description: '查看当前地图信息', handlerKey: 'map', minRole: 'USER', sortOrder: 5 },
    // 战斗（统一 game 处理器）
    { name: '攻击', alias: 'attack,打,揍', description: '攻击当前地图的怪物', handlerKey: 'game', minRole: 'USER', sortOrder: 10 },
    { name: '炮击', alias: 'cannon', description: '使用载具炮台攻击', handlerKey: 'game', minRole: 'USER', sortOrder: 11 },
    { name: '技能', alias: 'skill,使魔技能', description: '查看使魔技能信息', handlerKey: 'game', minRole: 'USER', sortOrder: 12 },
    // 物品/装备（统一 game 处理器）
    { name: '装备', alias: 'equip,穿上', description: '装备物品到对应部位', handlerKey: 'game', minRole: 'USER', sortOrder: 20 },
    { name: '卸下', alias: 'unequip,脱下', description: '卸下指定部位的装备', handlerKey: 'game', minRole: 'USER', sortOrder: 21 },
    { name: '使用', alias: 'use', description: '使用背包中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 22 },
    { name: '制造', alias: 'craft,制作', description: '制造物品或装备', handlerKey: 'game', minRole: 'USER', sortOrder: 23 },
    { name: '分解', alias: 'deconstruct', description: '分解装备为材料', handlerKey: 'game', minRole: 'USER', sortOrder: 24 },
    { name: '丢弃', alias: 'discard,扔掉', description: '丢弃背包中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 25 },
    { name: '移除', alias: 'remove', description: '移除装备', handlerKey: 'game', minRole: 'USER', sortOrder: 26 },
    { name: '保护', alias: 'protect', description: '保护物品不被分解', handlerKey: 'game', minRole: 'USER', sortOrder: 27 },
    { name: '强化', alias: 'enhance,升级', description: '强化装备或法宝', handlerKey: 'game', minRole: 'USER', sortOrder: 28 },
    { name: '解析', alias: 'analyze', description: '解析装备属性', handlerKey: 'game', minRole: 'USER', sortOrder: 29 },
    { name: '锁定装备', alias: 'lock', description: '锁定装备防止误操作', handlerKey: 'game', minRole: 'USER', sortOrder: 30 },
    { name: '解锁', alias: 'unlock', description: '解锁被锁定的装备', handlerKey: 'game', minRole: 'USER', sortOrder: 31 },
    // 使魔系统（统一 game 处理器）
    { name: '选择使魔', alias: 'select,familiar,更换使魔', description: '选择或更换使魔', handlerKey: 'game', minRole: 'USER', sortOrder: 40 },
    { name: '召唤使魔', alias: 'summon', description: '召唤使魔到当前地图', handlerKey: 'game', minRole: 'USER', sortOrder: 41 },
    { name: '命名使魔', alias: 'name-familiar', description: '为你的使魔命名', handlerKey: 'game', minRole: 'USER', sortOrder: 42 },
    { name: '使魔数据', alias: 'familiar-data', description: '查看使魔详细数据', handlerKey: 'game', minRole: 'USER', sortOrder: 43 },
    { name: '使魔商店', alias: 'familiar-shop', description: '使魔商店', handlerKey: 'game', minRole: 'USER', sortOrder: 44 },
    { name: '兑换', alias: 'exchange', description: '兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 45 },
    // 家园系统（统一 game 处理器）
    { name: '家园', alias: 'home', description: '家园操作入口', handlerKey: 'game', minRole: 'USER', sortOrder: 50 },
    { name: '圈地', alias: 'claim-land', description: '在当前地图开始建造家园', handlerKey: 'game', minRole: 'USER', sortOrder: 51 },
    { name: '开挖地基', alias: 'dig-foundation', description: '开挖地基（家园建造阶段）', handlerKey: 'game', minRole: 'USER', sortOrder: 52 },
    { name: '建造地基', alias: 'build-foundation', description: '建造地基（家园建造阶段）', handlerKey: 'game', minRole: 'USER', sortOrder: 53 },
    { name: '建造房子', alias: 'build-house', description: '建造房子（家园建造完成）', handlerKey: 'game', minRole: 'USER', sortOrder: 54 },
    // 宠物系统（统一 game 处理器）
    { name: '宠物', alias: 'pet', description: '宠物操作入口', handlerKey: 'game', minRole: 'USER', sortOrder: 60 },
    { name: '捕捉', alias: 'capture', description: '开始捕捉宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 61 },
    // 地图/探索（统一 game 处理器）
    { name: '传送', alias: 'teleport,跃迁', description: '传送到指定地图', handlerKey: 'game', minRole: 'USER', sortOrder: 70 },
    { name: '探测', alias: 'probe,scout', description: '探测当前地图', handlerKey: 'game', minRole: 'USER', sortOrder: 71 },
    { name: '拾取', alias: 'pickup', description: '拾取地上的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 72 },
    { name: '开采', alias: 'mine', description: '开采当前地图的资源', handlerKey: 'game', minRole: 'USER', sortOrder: 73 },
    // 副本系统（统一 game 处理器）
    { name: '开启副本', alias: 'start-dungeon', description: '开启副本挑战', handlerKey: 'game', minRole: 'USER', sortOrder: 80 },
    { name: '刷新副本', alias: 'refresh-dungeon', description: '刷新当前副本', handlerKey: 'game', minRole: 'USER', sortOrder: 81 },
    // 载具系统（统一 game 处理器）
    { name: '安装', alias: 'install', description: '安装载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 90 },
    { name: '拆卸', alias: 'uninstall', description: '拆卸载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 91 },
    // 任务系统（统一 game 处理器）
    { name: '领取任务', alias: 'accept-quest', description: '领取任务', handlerKey: 'game', minRole: 'USER', sortOrder: 100 },
    { name: '查看任务', alias: 'quests,我的任务', description: '查看当前任务列表', handlerKey: 'game', minRole: 'USER', sortOrder: 101 },
    { name: '提交任务', alias: 'complete-quest', description: '提交任务完成', handlerKey: 'game', minRole: 'USER', sortOrder: 102 },
    { name: '放弃任务', alias: 'abandon-quest', description: '放弃当前任务', handlerKey: 'game', minRole: 'USER', sortOrder: 103 },
    // 社交系统（统一 game 处理器）
    { name: '对话', alias: 'talk,交谈', description: '与NPC对话', handlerKey: 'game', minRole: 'USER', sortOrder: 110 },
    { name: '对话露娜未知', alias: 'dialogue-luna', description: '与露娜对话，用未知物品兑换奖励', handlerKey: 'game', minRole: 'USER', sortOrder: 110 },
    { name: '来倒目的', alias: 'arrive', description: '延时移动到指定地图（系统内部命令）', handlerKey: 'game', minRole: 'USER', sortOrder: 110 },
    { name: '救助', alias: 'rescue', description: '救助倒地的玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 111 },
    { name: '赠予', alias: 'give,gift', description: '赠予物品给其他玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 112 },
    { name: '设置跟随', alias: 'follow', description: '设置跟随目标', handlerKey: 'game', minRole: 'USER', sortOrder: 113 },
    // 私聊 / 反馈（统一 game 处理器）
    { name: '私聊', alias: 'whisper,pm', description: '私聊其他玩家，格式：私聊 用户名 内容', handlerKey: 'game', minRole: 'USER', sortOrder: 114 },
    { name: '反馈', alias: 'feedback', description: '提交游戏反馈建议，格式：反馈 内容', handlerKey: 'game', minRole: 'USER', sortOrder: 115 },
    // 状态系统（统一 game 处理器）
    { name: '躺下', alias: 'lie-down', description: '躺下休息', handlerKey: 'game', minRole: 'USER', sortOrder: 120 },
    { name: '起床', alias: 'get-up', description: '起床', handlerKey: 'game', minRole: 'USER', sortOrder: 121 },
    // 设置（统一 game 处理器）
    { name: '设置', alias: 'settings', description: '个人设置', handlerKey: 'game', minRole: 'USER', sortOrder: 130 },
    // 战斗相关（统一 game 处理器）
    { name: '开始战斗', alias: 'start-battle', description: '手动进入战斗循环模式', handlerKey: 'game', minRole: 'USER', sortOrder: 140 },
    { name: '扫荡', alias: 'sweep', description: '快速战斗/扫荡模式', handlerKey: 'game', minRole: 'USER', sortOrder: 141 },
    { name: '闪避', alias: 'dodge', description: '释放闪避技能', handlerKey: 'game', minRole: 'USER', sortOrder: 142 },
    // 玩家信息/背包（统一 game 处理器）
    { name: '资源背包', alias: 'resource-bag', description: '查看资源类背包物品', handlerKey: 'game', minRole: 'USER', sortOrder: 150 },
    { name: '背包搜索', alias: 'search-bag', description: '搜索背包中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 151 },
    { name: '保险柜搜索', alias: 'search-safe', description: '搜索保险柜中的物品', handlerKey: 'game', minRole: 'USER', sortOrder: 152 },
    { name: '比较装备', alias: 'compare-equip', description: '比较两件装备的属性', handlerKey: 'game', minRole: 'USER', sortOrder: 153 },
    { name: '被动效果', alias: 'passive-effects', description: '查看当前被动效果', handlerKey: 'game', minRole: 'USER', sortOrder: 154 },
    { name: '图鉴', alias: 'handbook', description: '查看游戏图鉴', handlerKey: 'game', minRole: 'USER', sortOrder: 155 },
    // 物品操作（统一 game 处理器）
    { name: '切换武器', alias: 'switch-weapon', description: '切换当前武器', handlerKey: 'game', minRole: 'USER', sortOrder: 160 },
    { name: '强化植入体', alias: 'enhance-implant', description: '强化植入体', handlerKey: 'game', minRole: 'USER', sortOrder: 161 },
    { name: '查看植入体', alias: 'view-implant', description: '查看植入体信息', handlerKey: 'game', minRole: 'USER', sortOrder: 162 },
    { name: '切换植入体', alias: 'switch-implant', description: '切换植入体类型', handlerKey: 'game', minRole: 'USER', sortOrder: 163 },
    { name: '还原植入体', alias: 'reset-implant', description: '还原植入体', handlerKey: 'game', minRole: 'USER', sortOrder: 164 },
    { name: '查看增幅器', alias: 'view-amplifier', description: '查看增幅器信息', handlerKey: 'game', minRole: 'USER', sortOrder: 165 },
    { name: '切换增幅器', alias: 'switch-amplifier', description: '切换增幅器', handlerKey: 'game', minRole: 'USER', sortOrder: 166 },
    { name: '强化增幅器', alias: 'enhance-amplifier', description: '强化增幅器', handlerKey: 'game', minRole: 'USER', sortOrder: 167 },
    { name: '还原增幅器', alias: 'reset-amplifier', description: '还原增幅器', handlerKey: 'game', minRole: 'USER', sortOrder: 168 },
    { name: '增幅器说明', alias: 'amplifier-help', description: '查看增幅器系统说明', handlerKey: 'game', minRole: 'USER', sortOrder: 169 },
    { name: '炼丹', alias: 'alchemy', description: '炼丹操作', handlerKey: 'game', minRole: 'USER', sortOrder: 170 },
    { name: '融合', alias: 'merge', description: '融合物品', handlerKey: 'game', minRole: 'USER', sortOrder: 171 },
    { name: '锻造', alias: 'forge', description: '锻造装备', handlerKey: 'game', minRole: 'USER', sortOrder: 172 },
    { name: '育种', alias: 'breed', description: '育种操作', handlerKey: 'game', minRole: 'USER', sortOrder: 173 },
    { name: '修理', alias: 'repair-item', description: '修理装备或物品', handlerKey: 'game', minRole: 'USER', sortOrder: 174 },
    { name: '装填', alias: 'reload', description: '装填弹药或能量', handlerKey: 'game', minRole: 'USER', sortOrder: 175 },
    { name: '回充', alias: 'recharge', description: '回充能量', handlerKey: 'game', minRole: 'USER', sortOrder: 176 },
    // 使魔系统扩展（统一 game 处理器）
    { name: '使魔技能', alias: 'familiar-skills', description: '查看使魔技能详情', handlerKey: 'game', minRole: 'USER', sortOrder: 180 },
    { name: '使魔家园', alias: 'familiar-home', description: '进入使魔家园', handlerKey: 'game', minRole: 'USER', sortOrder: 181 },
    { name: '通用技能', alias: 'common-skills', description: '查看通用技能', handlerKey: 'game', minRole: 'USER', sortOrder: 182 },
    { name: '使魔称号', alias: 'familiar-titles', description: '查看使魔称号', handlerKey: 'game', minRole: 'USER', sortOrder: 183 },
    { name: '领取称号', alias: 'claim-title', description: '领取已获得的称号', handlerKey: 'game', minRole: 'USER', sortOrder: 184 },
    { name: '佩戴称号', alias: 'equip-title', description: '佩戴称号', handlerKey: 'game', minRole: 'USER', sortOrder: 185 },
    { name: '使魔排行', alias: 'familiar-rank', description: '查看使魔排行榜', handlerKey: 'game', minRole: 'USER', sortOrder: 186 },
    { name: '大召唤术', alias: 'mass-summon', description: '大规模召唤使魔', handlerKey: 'game', minRole: 'USER', sortOrder: 187 },
    { name: '复活使魔', alias: 'revive-familiar', description: '复活已阵亡的使魔', handlerKey: 'game', minRole: 'USER', sortOrder: 188 },
    { name: '使魔挑战', alias: 'familiar-challenge', description: '查看使魔挑战', handlerKey: 'game', minRole: 'USER', sortOrder: 189 },
    { name: '开始挑战', alias: 'start-challenge', description: '开始使魔挑战', handlerKey: 'game', minRole: 'USER', sortOrder: 190 },
    // 使魔技能（统一 game 处理器）
    { name: '安乐天使', alias: 'ease-angel', description: '使魔技能 - 安乐天使', handlerKey: 'game', minRole: 'USER', sortOrder: 200 },
    { name: '福音书', alias: 'gospel', description: '使魔技能 - 福音书', handlerKey: 'game', minRole: 'USER', sortOrder: 201 },
    { name: '启示录', alias: 'apocalypse', description: '使魔技能 - 启示录', handlerKey: 'game', minRole: 'USER', sortOrder: 202 },
    { name: '切换模式', alias: 'switch-mode', description: '切换使魔模式', handlerKey: 'game', minRole: 'USER', sortOrder: 203 },
    { name: '纳米生化装', alias: 'nano-suit', description: '纳米生化装', handlerKey: 'game', minRole: 'USER', sortOrder: 204 },
    { name: '铠甲合体', alias: 'armor-combine', description: '铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 205 },
    // 生产/建造（统一 game 处理器）
    { name: '生产', alias: 'produce', description: '家园生产操作', handlerKey: 'game', minRole: 'USER', sortOrder: 210 },
    { name: '建造', alias: 'build', description: '家园建造操作', handlerKey: 'game', minRole: 'USER', sortOrder: 211 },
    { name: '拆除', alias: 'demolish', description: '拆除家园建筑', handlerKey: 'game', minRole: 'USER', sortOrder: 212 },
    { name: '种植', alias: 'plant', description: '在家园种植作物', handlerKey: 'game', minRole: 'USER', sortOrder: 213 },
    { name: '收获', alias: 'harvest', description: '收获家园作物', handlerKey: 'game', minRole: 'USER', sortOrder: 214 },
    // 载具系统扩展（统一 game 处理器）
    { name: '载具', alias: 'vehicle', description: '查看载具状态', handlerKey: 'game', minRole: 'USER', sortOrder: 220 },
    { name: '组装', alias: 'assemble', description: '组装载具', handlerKey: 'game', minRole: 'USER', sortOrder: 221 },
    { name: '驾驶', alias: 'drive', description: '驾驶载具', handlerKey: 'game', minRole: 'USER', sortOrder: 222 },
    { name: '载具命名', alias: 'name-vehicle', description: '为载具命名', handlerKey: 'game', minRole: 'USER', sortOrder: 223 },
    { name: '载具模拟', alias: 'simulate-vehicle', description: '模拟载具操作', handlerKey: 'game', minRole: 'USER', sortOrder: 224 },
    { name: '维修', alias: 'repair', description: '维修载具', handlerKey: 'game', minRole: 'USER', sortOrder: 225 },
    { name: '脱出', alias: 'exit', description: '从载具中脱出', handlerKey: 'game', minRole: 'USER', sortOrder: 226 },
    { name: '接管', alias: 'takeover', description: '接管载具控制权', handlerKey: 'game', minRole: 'USER', sortOrder: 227 },
    { name: '架炮', alias: 'deploy-cannon', description: '架设载具炮台', handlerKey: 'game', minRole: 'USER', sortOrder: 228 },
    { name: '模式转换', alias: 'mode-change', description: '载具模式转换', handlerKey: 'game', minRole: 'USER', sortOrder: 229 },
    { name: '转换', alias: 'transform', description: '载具形态转换', handlerKey: 'game', minRole: 'USER', sortOrder: 230 },
    { name: '牵引', alias: 'tractor', description: '牵引载具', handlerKey: 'game', minRole: 'USER', sortOrder: 231 },
    { name: '控制终端', alias: 'control-terminal', description: '载具控制终端', handlerKey: 'game', minRole: 'USER', sortOrder: 232 },
    { name: '载具操作', alias: 'vehicle-ops', description: '载具操作菜单', handlerKey: 'game', minRole: 'USER', sortOrder: 233 },
    // 地图/探索扩展（统一 game 处理器）
    { name: '观察附近', alias: 'look-around', description: '观察附近环境', handlerKey: 'game', minRole: 'USER', sortOrder: 240 },
    { name: '召唤货舱', alias: 'summon-cargo', description: '召唤货舱', handlerKey: 'game', minRole: 'USER', sortOrder: 241 },
    { name: '发射信号枪', alias: 'signal-gun', description: '发射信号枪', handlerKey: 'game', minRole: 'USER', sortOrder: 242 },
    { name: '副本清空', alias: 'clear-dungeon', description: '清空副本', handlerKey: 'game', minRole: 'USER', sortOrder: 243 },
    // 宠物系统扩展（统一 game 处理器）
    { name: '开始捕捉', alias: 'start-capture', description: '开始捕捉宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 250 },
    { name: '停止捕捉', alias: 'stop-capture', description: '停止捕捉宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 251 },
    { name: '全部跟随', alias: 'follow-all,all-follow', description: '所有宠物跟随', handlerKey: 'game', minRole: 'USER', sortOrder: 252 },
    { name: '补魔', alias: 'refill', description: '补充魔力', handlerKey: 'game', minRole: 'USER', sortOrder: 253 },
    { name: '挤奶', alias: 'milk', description: '挤奶', handlerKey: 'game', minRole: 'USER', sortOrder: 254 },
    { name: '剪毛', alias: 'shear', description: '剪毛', handlerKey: 'game', minRole: 'USER', sortOrder: 255 },
    // 快捷输入（统一 game 处理器）
    { name: '快捷', alias: 'sc,shortcut', description: '快捷输入设置', handlerKey: 'game', minRole: 'USER', sortOrder: 260 },
    // 新手教程（统一 game 处理器）
    { name: '新手教程', alias: 'tutorial', description: '新手指引设置', handlerKey: 'game', minRole: 'USER', sortOrder: 270 },
    { name: '查看指定玩家', alias: 'view-player', description: '查看指定玩家信息', handlerKey: 'game', minRole: 'USER', sortOrder: 271 },
    // 其他扩展（统一 game 处理器）
    { name: '使魔大战', alias: 'game-intro', description: '游戏介绍', handlerKey: 'game', minRole: 'USER', sortOrder: 280 },
    { name: '游戏解释', alias: 'game-terms,名词解释', description: '游戏名词解释', handlerKey: 'game', minRole: 'USER', sortOrder: 281 },
    { name: '更多', alias: 'more', description: '更多帮助信息', handlerKey: 'game', minRole: 'USER', sortOrder: 282 },
    { name: '更新历史', alias: 'changelog', description: '查看更新历史', handlerKey: 'game', minRole: 'USER', sortOrder: 283 },
    { name: '贸易', alias: 'trade', description: '玩家间贸易', handlerKey: 'game', minRole: 'USER', sortOrder: 284 },
    { name: '购物', alias: 'shop', description: '商店购物', handlerKey: 'game', minRole: 'USER', sortOrder: 285 },
    // 基础社交类
    { name: '扶', alias: 'help-up', description: '扶起倒地的玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 286 },
    { name: '呼叫', alias: 'call', description: '呼叫载具到当前位置', handlerKey: 'game', minRole: 'USER', sortOrder: 287 },
    // 安装全部/拆卸全部
    { name: '安装全部', alias: 'install-all', description: '安装所有可用的载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 288 },
    { name: '拆卸全部', alias: 'uninstall-all', description: '拆卸所有载具部件', handlerKey: 'game', minRole: 'USER', sortOrder: 289 },
    // 背包操作
    { name: '背包操作', alias: 'bag-ops', description: '背包操作说明', handlerKey: 'game', minRole: 'USER', sortOrder: 290 },
    // 装备强化/加成
    { name: '装备强化', alias: 'equip-enhance', description: '强化已装备的装备', handlerKey: 'game', minRole: 'USER', sortOrder: 291 },
    { name: '装备加成', alias: 'equip-bonus', description: '查看装备加成信息', handlerKey: 'game', minRole: 'USER', sortOrder: 292 },
    { name: '装备预设', alias: 'equip-preset', description: '装备预设管理', handlerKey: 'game', minRole: 'USER', sortOrder: 293 },
    // 商店类
    { name: '活跃度商店', alias: 'activity-shop', description: '使用活跃度兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 294 },
    { name: '钻石商店', alias: 'diamond-shop', description: '使用钻石兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 295 },
    { name: '数据商店', alias: 'data-shop', description: '使用数据兑换物品', handlerKey: 'game', minRole: 'USER', sortOrder: 296 },
    // 探测扩展
    { name: '探测雷达', alias: 'probe-radar', description: '使用雷达探测当前地图', handlerKey: 'game', minRole: 'USER', sortOrder: 297 },
    { name: '探测资源', alias: 'probe-resource', description: '探测当前地图资源', handlerKey: 'game', minRole: 'USER', sortOrder: 298 },
    { name: '探测拾取', alias: 'probe-pickup', description: '探测并拾取物品', handlerKey: 'game', minRole: 'USER', sortOrder: 299 },
    { name: '探测作物', alias: 'probe-crop', description: '探测当前地图的作物', handlerKey: 'game', minRole: 'USER', sortOrder: 300 },
    // 宠物扩展
    { name: '宠物操作', alias: 'pet-ops', description: '宠物操作菜单', handlerKey: 'game', minRole: 'USER', sortOrder: 301 },
    { name: '宠物改名', alias: 'pet-rename', description: '为宠物改名', handlerKey: 'game', minRole: 'USER', sortOrder: 302 },
    { name: '宠物转让', alias: 'pet-transfer', description: '转让宠物给其他玩家', handlerKey: 'game', minRole: 'USER', sortOrder: 303 },
    { name: '宠物驾驶', alias: 'pet-drive', description: '骑乘宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 304 },
    { name: '宠物喂食', alias: 'pet-feed', description: '喂食宠物', handlerKey: 'game', minRole: 'USER', sortOrder: 305 },
    { name: '宠物嗅探', alias: 'pet-sniff', description: '宠物嗅探搜索', handlerKey: 'game', minRole: 'USER', sortOrder: 306 },
    { name: '宠物觉醒', alias: 'pet-awaken', description: '宠物觉醒操作', handlerKey: 'game', minRole: 'USER', sortOrder: 307 },
    { name: '宠物攻击', alias: 'pet-attack', description: '宠物攻击指令', handlerKey: 'game', minRole: 'USER', sortOrder: 308 },
    { name: '宠物前往', alias: 'pet-goto', description: '宠物前往指定位置', handlerKey: 'game', minRole: 'USER', sortOrder: 309 },
    { name: '宠物装备', alias: 'pet-equip', description: '宠物装备管理', handlerKey: 'game', minRole: 'USER', sortOrder: 310 },
    // 全部指令（全部跟随已存在 sortOrder 252，此处跳过）
    { name: '全部停下', alias: 'all-stop', description: '所有宠物停下', handlerKey: 'game', minRole: 'USER', sortOrder: 311 },
    { name: '全部主动', alias: 'all-active', description: '所有宠物设为主动', handlerKey: 'game', minRole: 'USER', sortOrder: 312 },
    { name: '全部被动', alias: 'all-passive', description: '所有宠物设为被动', handlerKey: 'game', minRole: 'USER', sortOrder: 313 },
    { name: '全部挤奶', alias: 'all-milk', description: '给所有可挤奶的宠物挤奶', handlerKey: 'game', minRole: 'USER', sortOrder: 314 },
    { name: '全部指令', alias: 'all-commands', description: '查看所有宠物指令', handlerKey: 'game', minRole: 'USER', sortOrder: 315 },
    // 家园扩展
    { name: '家园操作', alias: 'home-ops', description: '家园操作菜单', handlerKey: 'game', minRole: 'USER', sortOrder: 316 },
    { name: '家园前线', alias: 'home-front', description: '家园前线防御', handlerKey: 'game', minRole: 'USER', sortOrder: 317 },
    { name: '家园产出', alias: 'home-output', description: '查看家园产出', handlerKey: 'game', minRole: 'USER', sortOrder: 318 },
    { name: '家园音乐', alias: 'home-music', description: '家园音乐设置', handlerKey: 'game', minRole: 'USER', sortOrder: 319 },
    { name: '家园搬迁', alias: 'home-relocate', description: '搬迁家园', handlerKey: 'game', minRole: 'USER', sortOrder: 320 },
    { name: '家园命名', alias: 'home-rename', description: '为家园命名', handlerKey: 'game', minRole: 'USER', sortOrder: 321 },
    // 开采扩展
    { name: '开采自动', alias: 'auto-mine', description: '开启自动开采模式', handlerKey: 'game', minRole: 'USER', sortOrder: 322 },
    { name: '开采停止', alias: 'stop-mine', description: '停止开采', handlerKey: 'game', minRole: 'USER', sortOrder: 323 },
    // 配方
    { name: '配方解锁', alias: 'recipe-unlock', description: '解锁新的制造配方', handlerKey: 'game', minRole: 'USER', sortOrder: 324 },
    // 求助/购物扩展
    { name: '求助确认', alias: 'confirm-help', description: '确认求助请求', handlerKey: 'game', minRole: 'USER', sortOrder: 325 },
    { name: '购物自动', alias: 'auto-shop', description: '自动购物模式', handlerKey: 'game', minRole: 'USER', sortOrder: 326 },
    // 管理扩展
    { name: '刷新怪物', alias: 'refresh-monster', description: '刷新当前地图怪物(管理员)', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 327 },
    { name: '删除怪物', alias: 'delete-monster', description: '删除当前地图怪物(管理员)', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 328 },
    { name: '生成人物', alias: 'spawn-npc', description: '生成NPC(管理员)', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 329 },
    // 生产模式
    { name: '生产0', alias: 'prod-mode-0', description: '切换生产模式为正常', handlerKey: 'game', minRole: 'USER', sortOrder: 330 },
    { name: '生产1', alias: 'prod-mode-1', description: '切换生产模式为超载', handlerKey: 'game', minRole: 'USER', sortOrder: 331 },
    // 铠甲合体
    { name: '炎龙', alias: 'yanlong', description: '炎龙铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 332 },
    { name: '黑犀', alias: 'heixi', description: '黑犀铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 333 },
    { name: '飞影', alias: 'feiying', description: '飞影铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 334 },
    { name: '地虎', alias: 'dihu', description: '地虎铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 335 },
    { name: '雪獒', alias: 'xueao', description: '雪獒铠甲合体', handlerKey: 'game', minRole: 'USER', sortOrder: 336 },
    // 其他
    { name: '转换文本', alias: 'transform-text', description: '文本转换操作', handlerKey: 'game', minRole: 'USER', sortOrder: 337 },
    { name: '保存图片', alias: 'save-image', description: '保存图片到本地', handlerKey: 'game', minRole: 'USER', sortOrder: 338 },
    { name: '保存图片开始', alias: 'start-save-image', description: '开始自动保存图片', handlerKey: 'game', minRole: 'USER', sortOrder: 339 },
    { name: '保存图片停止', alias: 'stop-save-image', description: '停止自动保存图片', handlerKey: 'game', minRole: 'USER', sortOrder: 340 },
    // 接管停止
    { name: '接管停止', alias: 'stop-takeover', description: '停止接管载具', handlerKey: 'game', minRole: 'USER', sortOrder: 341 },
    // 确认还原
    { name: '确认还原植入体等级', alias: 'confirm-reset-implant', description: '确认还原植入体等级', handlerKey: 'game', minRole: 'USER', sortOrder: 342 },
    { name: '确认还原增幅器等级', alias: 'confirm-reset-amplifier', description: '确认还原增幅器等级', handlerKey: 'game', minRole: 'USER', sortOrder: 343 },
    // 被挤出排序的旧指令（从原 286-291 移至此处）
    { name: '求助', alias: 'help-me', description: '获取帮助', handlerKey: 'game', minRole: 'USER', sortOrder: 344 },
    { name: '配方', alias: 'recipe', description: '查看制造配方', handlerKey: 'game', minRole: 'USER', sortOrder: 345 },
    { name: '逆向', alias: 'reverse', description: '逆向操作', handlerKey: 'game', minRole: 'USER', sortOrder: 346 },
    { name: '预设切换', alias: 'preset,切换预设', description: '切换装备预设', handlerKey: 'game', minRole: 'USER', sortOrder: 347 },
    { name: '签到', alias: 'daily-checkin', description: '每日签到', handlerKey: 'game', minRole: 'USER', sortOrder: 348 },
    { name: '文本发送', alias: 'text-send', description: '文本发送', handlerKey: 'game', minRole: 'USER', sortOrder: 349 },
    // 设置子指令（统一 game 处理器）
    { name: '设置指引', alias: 'setting-guide', description: '设置新手指引开关', handlerKey: 'game', minRole: 'USER', sortOrder: 350 },
    { name: '设置随机', alias: 'setting-random', description: '设置随机移动模式', handlerKey: 'game', minRole: 'USER', sortOrder: 351 },
    { name: '设置采集', alias: 'setting-gather', description: '设置自动采集模式', handlerKey: 'game', minRole: 'USER', sortOrder: 352 },
    { name: '设置活力', alias: 'setting-vitality', description: '设置活力管理', handlerKey: 'game', minRole: 'USER', sortOrder: 353 },
    { name: '设置不扶', alias: 'setting-no-help', description: '设置是否自动扶起', handlerKey: 'game', minRole: 'USER', sortOrder: 354 },
    { name: '设置音乐', alias: 'setting-music', description: '设置音乐播放', handlerKey: 'game', minRole: 'USER', sortOrder: 355 },
    { name: '设置倍率', alias: 'setting-multiplier', description: '设置显示倍率', handlerKey: 'game', minRole: 'USER', sortOrder: 356 },
    { name: '设置购物', alias: 'setting-shop', description: '设置自动购物', handlerKey: 'game', minRole: 'USER', sortOrder: 357 },
    { name: '设置位置', alias: 'setting-location', description: '设置位置显示', handlerKey: 'game', minRole: 'USER', sortOrder: 358 },
    { name: '设置标记', alias: 'setting-marker', description: '设置自定义标记', handlerKey: 'game', minRole: 'USER', sortOrder: 359 },
    // 管理（统一 game 处理器）
    { name: '管理', alias: 'admin,管理员', description: '管理员操作入口', handlerKey: 'game', minRole: 'ADMIN', sortOrder: 999 },
  ];

  // 使魔技能/通用技能指令批量注册：使 /技能名 可直接施放（指令分发先查 Command 表，
  // 必须在此注册，否则会报"未找到指令"而无法进入 game-command.handler 的技能 case）。
  // name 为原版中文技能名，alias 为英文别名；handlerKey 统一 game，由 GameCommandHandler 按名路由到 executeSkill。
  const familiarSkillCommands: { name: string; alias: string; description: string }[] = [
    { name: '六道轮回', alias: 'six-paths', description: '使魔技能 - 六道轮回' },
    { name: '怒吼', alias: 'roar', description: '使魔技能 - 怒吼' },
    { name: '万象', alias: 'myriad-visions', description: '使魔技能 - 万象' },
    { name: '誓约胜利之剑', alias: 'excalibur', description: '使魔技能 - 誓约胜利之剑' },
    { name: '鹰眼', alias: 'hawk-eye', description: '使魔技能 - 鹰眼' },
    { name: '歼灭', alias: 'annihilate', description: '使魔技能 - 歼灭' },
    { name: '歼灭模式', alias: 'annihilation-mode', description: '使魔技能 - 歼灭模式' },
    { name: '绝对守护', alias: 'absolute-guard', description: '使魔技能 - 绝对守护' },
    { name: '斗转星移', alias: 'stellar-shift', description: '使魔技能 - 斗转星移' },
    { name: '火力全开', alias: 'full-firepower', description: '使魔技能 - 火力全开' },
    { name: '啾啾猫猫', alias: 'meow-attack', description: '使魔技能 - 啾啾猫猫' },
    { name: '银龙附体', alias: 'silver-dragon', description: '使魔技能 - 银龙附体' },
    { name: '斩', alias: 'slash', description: '使魔技能 - 斩' },
    { name: '会心一击', alias: 'critical-hit', description: '使魔技能 - 会心一击' },
    { name: '全弹发射', alias: 'full-salvo', description: '使魔技能 - 全弹发射' },
    { name: '光翼', alias: 'light-wings', description: '使魔技能 - 光翼' },
    { name: '炮冠', alias: 'cannon-crown', description: '使魔技能 - 炮冠' },
    { name: '日轮', alias: 'solar-wheel', description: '使魔技能 - 日轮' },
    { name: '安宝加油', alias: 'anchor-boost', description: '使魔技能 - 安宝加油' },
    { name: '灼烂歼鬼', alias: 'scorched-finger', description: '使魔技能 - 灼烂歼鬼' },
    { name: '冻结傀儡', alias: 'freeze-puppet', description: '使魔技能 - 冻结傀儡' },
    { name: '封印解除', alias: 'seal-release', description: '使魔技能 - 封印解除' },
    { name: '召唤银龙', alias: 'summon-dragon', description: '使魔技能 - 召唤银龙' },
    { name: '形神合一', alias: 'spirit-unity', description: '使魔技能 - 形神合一' },
    { name: '风月入墨', alias: 'wind-moon', description: '使魔技能 - 风月入墨' },
    { name: '心无所扰', alias: 'heart-unperturbed', description: '使魔技能 - 心无所扰' },
    { name: '梦倾天下', alias: 'dream-world', description: '使魔技能 - 梦倾天下' },
    { name: '反转童话', alias: 'reverse-fairytale', description: '使魔技能 - 反转童话' },
    { name: '月落寸光', alias: 'moonlight-inch', description: '使魔技能 - 月落寸光' },
    { name: '洗脑', alias: 'brainwash', description: '通用技能 - 洗脑' },
    { name: '砸瓦鲁多', alias: 'za-warudo', description: '通用技能 - 砸瓦鲁多' },
    { name: '训练', alias: 'train', description: '通用技能 - 训练' },
    { name: '掌控时间', alias: 'time-control', description: '通用技能 - 掌控时间' },
    { name: '召唤', alias: 'summon-thing', description: '通用技能 - 召唤' },
    { name: '力量模式', alias: 'power-mode', description: '纳米生化装 - 力量模式' },
    { name: '速度模式', alias: 'speed-mode', description: '纳米生化装 - 速度模式' },
    { name: '装甲模式', alias: 'armor-mode', description: '纳米生化装 - 装甲模式' },
    { name: '隐匿模式', alias: 'stealth-mode', description: '纳米生化装 - 隐匿模式' },
    { name: '安乐天使', alias: 'ease-angel', description: '使魔技能 - 安乐天使' },
    { name: '福音书', alias: 'gospel', description: '使魔技能 - 福音书' },
    { name: '启示录', alias: 'apocalypse', description: '使魔技能 - 启示录' },
    { name: '铠甲合体', alias: 'armor-combine', description: '使魔技能 - 铠甲合体' },
    { name: '切换模式', alias: 'switch-mode', description: '使魔技能 - 切换模式' },
    { name: '使魔挑战', alias: 'familiar-challenge', description: '使魔技能 - 使魔挑战' },
    { name: '开始挑战', alias: 'start-challenge', description: '使魔技能 - 开始挑战' },
    { name: '复活使魔', alias: 'revive-familiar', description: '使魔技能 - 复活使魔' },
    { name: '大召唤术', alias: 'mass-summon', description: '使魔技能 - 大召唤术' },
  ];
  for (const s of familiarSkillCommands) {
    commands.push({
      name: s.name,
      alias: s.alias,
      description: s.description,
      handlerKey: 'game',
      minRole: 'USER',
      sortOrder: 400 + commands.length,
    } as any);
  }

  for (const cmd of commands) {
    await prisma.command.upsert({
      where: { name: cmd.name },
      // 以代码为准：已存在也更新为 seed 中的最新值（便于改描述/别名/权限等）
      update: cmd as any,
      create: cmd as any,
    });
  }
  console.log(`✅ 指令表: ${commands.length} 条指令`);

  // 3. 系统配置中心初始项
  const systemConfigs = [
    { key: 'command.prefixes', value: JSON.stringify(['/', '！', '!']), label: '指令前缀', description: '以这些字符开头的输入会作为指令处理', type: 'string-array', group: 'command' },
    { key: 'command.requirePrefix', value: 'false', label: '必须带前缀才算指令', description: 'true=必须带前缀；false=无前缀时若命中指令名/别名也作为指令', type: 'boolean', group: 'command' },
    { key: 'game.playerBaseHp', value: '100', label: '玩家基础生命', description: '新玩家初始生命值', type: 'number', group: 'game' },
    { key: 'game.playerBaseAttack', value: '10', label: '玩家基础攻击', description: '新玩家初始攻击力', type: 'number', group: 'game' },
    { key: 'game.expMultiplier', value: '1.0', label: '经验倍率', description: '全局经验获取倍率', type: 'number', group: 'game' },
    { key: 'game.dropMultiplier', value: '1.0', label: '掉落倍率', description: '全局物品掉落倍率', type: 'number', group: 'game' },
    { key: 'game.maxPlayers', value: '1000', label: '最大玩家数', description: '服务器最大玩家数量', type: 'number', group: 'game' },
    { key: 'game.autoSaveInterval', value: '300', label: '自动保存间隔(秒)', description: '后台自动保存玩家数据的间隔', type: 'number', group: 'game' },
    { key: 'game.respawnTime', value: '30', label: '怪物重生时间(秒)', description: '怪物被击杀后重生时间', type: 'number', group: 'game' },
    { key: 'game.spawnMonsterCooldown', value: '60', label: '怪物刷新时间(秒)', description: '地图怪物被清空后刷新时间', type: 'number', group: 'game' },
    { key: 'game.worldLevel', value: '1', label: '世界等级', description: '当前世界等级，影响怪物强度和掉落', type: 'number', group: 'game' },
    { key: 'game.moveTimeEnabled', value: 'true', label: '移动真实耗时', description: '移动是否真实消耗时间(延时到达)。true=移动需等待耗时秒数后才到达，false=即时到达', type: 'boolean', group: 'game' },
    { key: 'game.adminQQ', value: '', label: '管理员QQ', description: '拥有管理员权限的QQ号（逗号分隔）', type: 'string', group: 'game' },
  ] as const;

  for (const cfg of systemConfigs) {
    await prisma.systemConfig.upsert({
      where: { key: cfg.key },
      update: {},
      create: cfg as any,
    });
  }
  console.log(`✅ 系统配置: ${systemConfigs.length} 项`);

  // 4-10. 固定游戏数据（地图/物品/装备/使魔/怪物/增益/配方）已迁移为 JSON 存储，
  //       由 seed-data.ts + StaticDataService 处理，此处不再内联示例占位数据。
  //       地图/载具动态数据由 seed-data.ts 从 prisma/data/*.json 导入。

  // 11. 默认管理员账号
  const existingAdmin = await prisma.user.findUnique({ where: { username: 'admin' } });
  if (!existingAdmin) {
    const bcrypt = await import('bcrypt');
    const hashed = await bcrypt.hash('admin123', 10);
    await prisma.user.create({
      data: {
        username: 'admin',
        password: hashed,
        nickname: '管理员',
        role: 'SUPER_ADMIN',
      },
    });
    console.log('✅ 默认管理员已创建: admin / admin123');
  } else {
    console.log('ℹ️ 管理员账号已存在，跳过');
  }

  // 12. 同步删除：以代码为准，删除 seed 中已不存在的记录(处理"删除/重命名"场景)
  // 仅对 seed.ts 自身为权威数据源的表(指令/系统配置)做同步删除。
  // 地图/载具等动态数据由 seed-data.ts 从 JSON 导入，不在本脚本做同步删除，
  // 以免误删 JSON 已更新但 DB 尚未同步的记录。
  const syncDeleted = async (label: string, seedNames: string[], findMany: any, deleteMany: any) => {
    const seedSet = new Set(seedNames);
    const existing = await findMany({ select: { name: true } });
    const toDelete = existing
      .map((r: any) => r.name)
      .filter((n: string) => n && !seedSet.has(n));
    if (toDelete.length > 0) {
      await deleteMany({ where: { name: { in: toDelete } } });
      console.log(`🗑️ ${label}: 已删除 ${toDelete.length} 条(代码中已移除): ${toDelete.join(', ')}`);
    }
  };
  // 仅同步 seed.ts 权威的指令表与系统配置；保留管理员在线修改不被覆盖(update:{})
  await syncDeleted('指令', commands.map((c) => c.name), (q: any) => prisma.command.findMany(q), (q: any) => prisma.command.deleteMany(q));
  // 系统配置以 key 为主键(非 name)，单独同步删除
  {
    const seedKeys = new Set(systemConfigs.map((c: any) => c.key));
    const existing = await prisma.systemConfig.findMany({ select: { key: true } });
    const toDelete = existing.map((r: any) => r.key).filter((k: string) => k && !seedKeys.has(k));
    if (toDelete.length > 0) {
      await prisma.systemConfig.deleteMany({ where: { key: { in: toDelete } } });
      console.log(`🗑️ 系统配置: 已删除 ${toDelete.length} 条(代码中已移除): ${toDelete.join(', ')}`);
    }
  }

  console.log('🎉 种子数据写入完成');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });