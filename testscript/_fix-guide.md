# 测试夹具口径统一修复指南（临时工作文档）

> 背景：项目刚完成「字段口径统一」重构——`server/src/modules/game/field-contract.util.ts` 是唯一真相来源（SSOT），
> 运行时/DB 边界会把历史别名键收敛为英文规范键，业务代码已改为**只读规范键**。
> 测试夹具与断言仍绑定旧别名/已删除的镜像字段，导致大量 spec 失败。本指南规定如何修复。

## 一、规范键映射（权威来源：field-contract.util.ts，务必先读该文件）

物品域（背包/装备/武器/安全箱/掉落物/零件/商品条目）：
`名称→name`、`类型→type`、`数量→quantity`、`数据→data`、`耐久→durability`、`制造者→maker`、`耐久等级→durabilityLevel`；
同义英文合并：**`count → quantity`**（顶层数量的旧写法）

增益域（markers2 / buffs 数组元素）：
`名称→name`、`强度→strength`、`有效期至→expireAt`、`是否叠加时间→stackTime`；同义英文合并：`value → strength`

载具域：`名称→name`、`编号→vehicleId`、`归属→owner`、`驾驶员→driver`、`行走方式→moveType`、`当前生命→currentHp`、
`生命→maxHp`、`武器→weaponSlots`、`零件→parts`、`内置零件→builtinParts`、`配方→recipes`、`加成→bonus`、`数值→value`、
`标记→markers`、`标记2→markers2`、`封印中→sealed`、`封印等级→sealLevel`、`需求等级→requireLevel` 等（其余见契约文件）

召唤物域：`归属→ownerQQ`、`特殊序号→specialSeq`、`当前生命→hp`、`当前护盾→shield`、`当前装甲→armor`、
`生命→maxHp`、`护盾→maxShield`、`装甲→maxArmor`、`技能等级→skillLevel`、`好感→affinity`、`活力→vitality`、
`经验→exp`、`基础加成→baseBonus`、`额外加成→extraBonus`、`增益→buffs`、`装备→equipments`、`武器→weapons`、
`当前武器→currentWeapon`、`装备预设→equipmentPresets`、`成就→achievements`、`背包→backpack` 等

地图资源/建筑域：`名称→name`、`类型→type`、`数量→quantity`、`产出→outputs`、`产出2→outputs2`、`消耗→inputs`、
`采集指令→gatherCmd`、`采集文本→gatherText`、`代发言→proxySpeak`、`几率→chance`、`次数→times`、`说明→description`、
`加成→bonus`、`耐久→durability`；同义英文合并：**`count → quantity`**（顶层）

标记/成就域（**仅数组形态** `[{名称,数值}]`→`[{name,value}]`）：`名称→name`、`数值→value`。
⚠️ `markers` 若为**字典** `{ 标记名: 数值 }`，字典键是标记名（内容语义），**绝不能改**。

## 二、判别要点：`count` 是两义的，不能一刀切

| 位置 | 语义 | 处理 |
|---|---|---|
| 条目**顶层** `{name:'木头', count:5}` | 数量（旧写法） | 夹具改 `quantity: 5` |
| `outputs[]` 里 `{name:'木头3', count:100}`（无 chance） | **概率**（早期导出格式，名称末尾数字才是数量） | **保留 `count`**，这是被测的兼容分支，改了反而错 |
| 玩家/怪物 `markers` 字典里的键 | 标记名 | 不动 |

用例名含「兼容旧」「旧 JSON」「旧存档」字样的，优先怀疑它是**故意**用旧格式测兼容，不要改夹具。

## 三、修复判定流程（逐用例）

1. 先跑 `npx jest test/<file>` 看失败详情，读断言 + 夹具构造代码。
2. 归类：
   - **A 夹具过时**（最常见）：夹具把持久化实体数据写成旧别名键，生产代码只读规范键 → 改夹具为规范键，并同步断言里的字段名。
   - **B 断言绑定已删除镜像**：断言读 `.count`（物品数量镜像）等已不再写的字段 → 改为断言规范键 `quantity`。
   - **C 生产代码真 bug（兼容分支被误删）**：用例本身在验证「读旧格式仍能用」，而生产代码里该兼容读取被删/写错 → 允许**最小改动**修 src，并加中文注释说明；**不要**改测试。
   - **D 拿不准**：跳过该用例，在报告中列出（用例名 + 现象 + 你的怀疑），**不要**弱化断言蒙混。
3. 严禁：`.skip` / `xit`、改 jest 配置排除、删断言、放宽精度（如 `toBeCloseTo` 位数变小）、把 `toEqual` 降级为 `toMatchObject` 来掩盖字段差异。

## 四、允许改动的范围

- 允许：`server/test/**`（夹具、断言、辅助 stub）
- 允许（谨慎、最小）：`server/src/**` —— 仅限「类型 C」的真 bug 修复；每处都要在报告里列出 `文件:行 + 理由`
- 禁止：改 `field-contract.util.ts` 的映射表；改 jest 配置；改 `prisma/data/*.json` 静态数据
- 若发现某业务模块仍保留旧别名兜底读取（如 `x.amount ?? x.quantity`、`x.count ?? x.quantity`），**先报告**，不要自行批量清理（另有专门任务处理）

## 五、报告格式（保持简短）

```
spec 文件: 已修/未修
  - 修复类型统计：A=x 处，B=y 处，C=z 处，D=w 处
  - src 改动（若有）：文件:行 —— 一句话理由
  - 未修项（D）：用例名 —— 现象 —— 怀疑
```
最后附一行：`npx jest test/<你负责的每个文件>` 的最终结果（通过数/总数）。