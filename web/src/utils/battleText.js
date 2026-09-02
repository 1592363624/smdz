/**
 * 战斗文本结构化解析器（Battle Text Parser）
 *
 * 作用：把服务端下发的「战斗结算纯文本」（攻击/炮击/地图战斗回合的结果）在网页端
 *       解析成结构化段落，交给 BattleCard.vue 渲染成带动画的战斗卡片。
 *
 * 设计约束与兼容性（与 RichSystemCard 相同的展示层原则）：
 * - 本解析器仅服务于网页端「展示层」增强——只读原文做结构化展示，绝不改写原文内容。
 * - 后端与 AstrBot（QQ 等）仍走标准纯文本消息；解析失败时回退为原始文本直出。
 * - 文本特征全部来自服务端实际输出（combat-system.service.ts 的 resultLines 拼接规则），
 *   正则与服务端文案一一对应，改动服务端战斗文案时需同步维护本文件。
 */

/**
 * 战斗消息检测：命中任一「强战斗特征」即认为是战斗结算文本。
 * 特征均来自 combat-system.service.ts 的实际输出：
 *   - 主命中行：`…，造成 护盾-12 装甲-34 生命-56…` / `…，造成 40`
 *   - 击杀行：`怪物名 已被击杀`
 *   - 闪避行：`怪物名 向你发起攻击，但被你闪避了`
 *   - 光荣弹：`…引爆【光荣弹】，对 …造成 …`
 * 其余装饰性行（掉落/经验/统计）单独出现不足以判定为战斗（避免误伤系统消息）。
 */
const BATTLE_DETECT_RE = new RegExp(
  [
    /，造成(?:伤害)?\s*(?:[\d.]+|护盾-|装甲-|生命-)/.source,
    /已被击杀/.source,
    /发起攻击，但被.+?闪避了/.source,
    /引爆【光荣弹】，对.+?造成/.source,
  ].join('|'),
);

export function isBattleContent(text) {
  if (typeof text !== 'string' || !text || text.length > 6000) return false;
  return BATTLE_DETECT_RE.test(text);
}

/** 伤害评级 → 展示等级（决定配色） */
const RATING_LEVELS = { 绝杀: 'epic', 完美: 'great', 致命: 'good', 强力: 'fair', 正中: 'normal' };

/** 带倍率前缀的主命中行：`攻击文本(倍率N%) 目标名，造成 伤害文本…` */
const HIT_LINE_RE = /^\s*(.*?)[（(]倍率[-+.\d]+%[）)]\s*(\S+)\s*，造成(?:伤害)?\s*(.+)$/;
/** 光荣弹行：`名 引爆【光荣弹】，对 名 造成 伤害文本（倍率N%）` */
const GLORY_RE = /^(.+?)\s*引爆【光荣弹】，对\s*(\S+?)\s*造成(?:伤害)?\s*(.+)$/;
/** 怪物反击行（带武器）：`怪物名 使用武器攻击目标名，造成 …`（目标名与「攻击」间无空格） */
const COUNTER_WEP_RE = /^(.{1,20}?)使用(.{1,20}?)攻击(你|\S+?)，造成(?:伤害)?\s*(.+)$/;
/** 怪物反击行（不带武器）：`怪物名攻击目标名，造成 …` */
const COUNTER_RE = /^(.{1,20}?)(?<![的了中着开])攻击(你|\S+?)，造成(?:伤害)?\s*(.+)$/;
/** 通用命中行：`任意文本 目标名，造成 …`（目标名 = `，造成` 前最后一个空格分词） */
const HIT_LINE_PLAIN_RE = /^\s*(.+?)\s*，造成(?:伤害)?\s*(.+)$/;

const POOL_SHIELD_RE = /护盾-([\d.]+)/;
const POOL_ARMOR_RE = /装甲-([\d.]+)/;
const POOL_HP_RE = /(?:^|\s)生命-([\d.]+)(?!\()/;
const POOL_HP_CAPTURE_RE = /生命-([\d.]+)\(([\d.]+)\)\(捕捉中\)/;
const CRIT_RE = /【暴击】/;
const RATING_RE = /【(绝杀|完美|致命|强力|正中)】([\d.]+)%/;

/** 独立特效标记行：`【名字】说明`（名字 ≤ 10 字，排除暴击/评级等内联标记） */
const EFFECT_TAG_RE = /^【([^】]{1,10})】\s*(.*)$/;
/** 击杀行：`怪物名 已被击杀` */
const KILL_RE = /^(.+?)\s*已被击杀\s*$/;
/** 掉落行：`掉落：名字×数量、名字2`（分隔符与服务端 distributeLoot 的 join('、') 对齐） */
const DROP_RE = /^掉落：\s*(.+)$/;
/** 经验行：`获得 N 点经验`（活力消耗文案内也带经验数值，一并按经验行处理） */
const EXP_RE = /^(?:获得|得到了)\s*([\d.]+)\s*点?经验/;
/** 生命偷取行：`生命偷取 N 点` */
const LEECH_RE = /^生命偷取\s*([\d.]+)/;
/** 战斗统计：`攻击N次，命中N次，被闪避N次，命中零伤N次，有效伤N次` */
const STATS_RE = /攻击(\d+)次，命中(\d+)次，被闪避(\d+)次，命中零伤(\d+)次，有效伤(\d+)次/;
/** 受益/触发类状态行：目标名 触发【X】/ 受到【X】效果 / 免死 / 灼烧 等 */
const STATUS_RE = /触发【|受到【|被圣剑之光灼烧|护盾抵消了本次攻击|免死/;

/**
 * 数值展示格式化：整数直出，小数最多两位且去尾零（与服务端 formatDisplayNumber 口径一致）。
 * @param {number} n
 * @returns {string}
 */
export function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 100) / 100);
}

/** 解析 `，造成` 之后的伤害文本 → { pools, total, captured, captureHp, crit, rating, extra } */
function parseDamagePart(part) {
  let rest = part;
  const pools = { shield: 0, armor: 0, hp: 0 };
  let captured = false;
  let captureHp = null;

  // 捕捉模式：`生命-0(剩余血量)(捕捉中)`，先于普通三池解析
  const cap = rest.match(POOL_HP_CAPTURE_RE);
  if (cap) {
    pools.hp = parseFloat(cap[1]) || 0;
    captureHp = parseFloat(cap[2]) || 0;
    captured = true;
    rest = rest.replace(cap[0], ' ');
  }
  const sh = rest.match(POOL_SHIELD_RE);
  if (sh) {
    pools.shield = parseFloat(sh[1]) || 0;
    rest = rest.replace(sh[0], ' ');
  }
  const ar = rest.match(POOL_ARMOR_RE);
  if (ar) {
    pools.armor = parseFloat(ar[1]) || 0;
    rest = rest.replace(ar[0], ' ');
  }
  const hp = rest.match(POOL_HP_RE);
  if (hp) {
    pools.hp = parseFloat(hp[1]) || 0;
    rest = rest.replace(hp[0], ' ');
  }

  let total = pools.shield + pools.armor + pools.hp;
  let plain = null;
  if (total <= 0) {
    // 无三池分项（特殊武器/简写）→ 取剩余文本开头的纯数字
    const pm = rest.match(/^\s*([\d.]+)/);
    if (pm) {
      plain = parseFloat(pm[1]) || 0;
      total = plain;
      rest = rest.replace(pm[0], ' ');
    }
  }

  let crit = false;
  if (CRIT_RE.test(rest)) {
    crit = true;
    rest = rest.replace(CRIT_RE, ' ');
  }
  let rating = null;
  const rm = rest.match(RATING_RE);
  if (rm) {
    rating = { name: rm[1], pct: parseFloat(rm[2]) || 0, level: RATING_LEVELS[rm[1]] || 'normal' };
    rest = rest.replace(rm[0], ' ');
  }

  // 清理尾巴（光荣弹的（倍率N%）缀在伤害文本之后）与开头的连接标点（反击行 `，你倒下了！`）
  let extra = rest
    .replace(/[（(]倍率[-+.\d]+%[）)]\s*$/, '')
    .replace(/^[\s，,、]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { pools, total, plain, captured, captureHp, crit, rating, extra };
}

/**
 * 命中行拆解：按「带倍率 → 光荣弹 → 反击（仅限打给视角玩家的行）→ 通用」顺序尝试。
 * 返回 { attacker, target, weapon?, rest, counter?, glory? } 或 null。
 */
function matchHitLine(line, viewerName) {
  let m = line.match(HIT_LINE_RE);
  if (m) return { attacker: m[1].trim(), target: m[2], rest: m[3] };
  m = line.match(GLORY_RE);
  if (m) return { attacker: m[1].trim(), target: m[2], rest: m[3], glory: true };
  // 反击行型只在「目标 = 你 / 视角玩家名」时采信：
  // 玩家命中行模板也可能含「攻击」字样（如"俯冲攻击李四"），误判会污染出手方展示
  m = line.match(COUNTER_WEP_RE);
  if (m && (m[3] === '你' || m[3] === viewerName)) {
    return { attacker: m[1].trim(), weapon: m[2].trim(), target: m[3], rest: m[4], counter: true };
  }
  m = line.match(COUNTER_RE);
  if (m && (m[2] === '你' || m[2] === viewerName)) {
    return { attacker: m[1].trim(), target: m[2], rest: m[3], counter: true };
  }
  m = line.match(HIT_LINE_PLAIN_RE);
  if (m) {
    const left = m[1];
    const sp = left.lastIndexOf(' ');
    const target = sp >= 0 ? left.slice(sp + 1) : left;
    const flavor = sp >= 0 ? left.slice(0, sp).trim() : '';
    return { target, flavor, rest: m[2] };
  }
  return null;
}

/** 单行分类 → 段落对象；未识别返回 null（调用方落回 raw） */
function classifyLine(line, viewerName) {
  let m;

  m = line.match(KILL_RE);
  if (m) return { kind: 'kill', name: m[1].trim() };

  m = line.match(DROP_RE);
  if (m) {
    return { kind: 'drop', items: m[1].split('、').map((s) => s.trim()).filter(Boolean) };
  }

  m = line.match(EXP_RE);
  if (m) return { kind: 'exp', amount: parseFloat(m[1]) || 0 };

  m = line.match(LEECH_RE);
  if (m) return { kind: 'leech', amount: parseFloat(m[1]) || 0 };

  // 战斗统计（原版简略模式）：`攻击N次，命中N次，…`
  m = line.match(STATS_RE);
  if (m) {
    return { kind: 'stats', total: +m[1], hit: +m[2], dodged: +m[3], nullDmg: +m[4], effective: +m[5] };
  }

  // 分隔线（可能带标题，如 `━━━ 召唤物攻击 ━━━`）
  if (/^━+$/.test(line)) return { kind: 'divider', title: '' };
  m = line.match(/^━+\s*(.+?)\s*━+$/);
  if (m) return { kind: 'divider', title: m[1] };

  // 闪避/格挡类（先于通用状态判断，二者都含【】标记）
  if (/闪避了攻击|闪开了攻击|躲开了|处于闪避状态/.test(line) || /发起攻击，但被.+?闪避了/.test(line)) {
    return { kind: 'dodge', text: line };
  }
  if (/格挡了本次攻击|挡住了本次攻击|格挡】本次伤害降低|格挡率\+/.test(line)) {
    return { kind: 'block', text: line };
  }

  // 独立特效标记行：`【名字】说明`
  m = line.match(EFFECT_TAG_RE);
  if (m && !STATUS_RE.test(line)) {
    return { kind: 'effect', name: m[1], desc: m[2].trim() };
  }

  // 死亡 / 卷土重来（正面翻盘）
  if (/^你已死亡/.test(line)) return { kind: 'death', text: line };
  if (/卷土重来/.test(line) && line.length <= 20) return { kind: 'rally', text: line };

  // 受益/触发类状态行（免死、灼烧、护盾抵消等）
  if (STATUS_RE.test(line)) return { kind: 'status', text: line };

  // 命中行（最后判断：正则最重，且行型最宽）
  const hit = matchHitLine(line, viewerName);
  if (hit) {
    const dmg = parseDamagePart(hit.rest);
    const seg = {
      kind: 'hit',
      attacker: hit.attacker || '',
      flavor: hit.flavor || '',
      target: hit.target,
      weapon: hit.weapon || '',
      counter: !!hit.counter,
      glory: !!hit.glory,
      ...dmg,
    };
    // 视角归类：打到我（"你"/我的名字）→ 受击；我打出 → 出手；其余 → 中立
    const isMe = hit.target === '你' || (viewerName && hit.target === viewerName);
    const mine = viewerName && (seg.attacker === viewerName || (hit.flavor || '').startsWith(viewerName));
    seg.side = isMe ? 'in' : mine ? 'out' : 'neutral';
    // 反击附带尾部状态（`，你倒下了！` / `，你进入了卷土重来状态(N秒)`）落在 extra 中
    if (/倒下了/.test(seg.extra)) seg.downed = true;
    if (/卷土重来状态/.test(seg.extra)) seg.rallied = true;
    return seg;
  }

  return null;
}

/**
 * 解析战斗结算文本 → 结构化段落列表 + 汇总数据
 *
 * @param {string} text 战斗结算纯文本（含换行）
 * @param {{ viewerName?: string }} [opts] viewerName：当前浏览器端玩家名，
 *        用于把命中行归入「我打出的」/「打到我身上的」/「其他」三种视角样式
 * @returns {{ segments: Array<object>, summary: object }}
 */
export function parseBattle(text, opts = {}) {
  const viewerName = (opts.viewerName || '').trim();
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l !== '');

  const segments = [];
  // 连续的独立特效标记行合并为一个 chip 组（【棒棒糖】【火力】…天然连排）
  let effectGroup = null;
  const flushEffects = () => {
    if (effectGroup && effectGroup.tags.length) segments.push(effectGroup);
    effectGroup = null;
  };

  for (const line of lines) {
    const seg = classifyLine(line, viewerName);
    if (seg && seg.kind === 'effect') {
      if (!effectGroup) effectGroup = { kind: 'effects', tags: [] };
      effectGroup.tags.push({ name: seg.name, desc: seg.desc });
      continue;
    }
    flushEffects();
    segments.push(seg || { kind: 'raw', text: line });
  }
  flushEffects();

  // —— 汇总：给卡片头部徽章用 ——
  const summary = { damage: 0, hits: 0, crits: 0, kills: 0, exp: 0, incoming: 0, drops: [] };
  for (const seg of segments) {
    if (seg.kind === 'hit') {
      // 打到我身上的单列承伤，其余计入战斗规模；头部徽章只展示「我打出」的伤害
      if (seg.side === 'in') summary.incoming += seg.total;
      else summary.damage += seg.total;
      summary.hits += 1;
      if (seg.crit) summary.crits += 1;
    } else if (seg.kind === 'kill') {
      summary.kills += 1;
    } else if (seg.kind === 'exp') {
      summary.exp += seg.amount;
    } else if (seg.kind === 'drop') {
      summary.drops.push(...seg.items);
    }
  }
  summary.damage = Math.round(summary.damage * 100) / 100;
  summary.incoming = Math.round(summary.incoming * 100) / 100;

  return { segments, summary };
}
