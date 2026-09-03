<template>
  <div class="gd-panel">
    <!-- 分类侧栏 + 数据列表 -->
    <div class="gd-body">
      <!-- ===== 左侧：分类侧栏（按分组聚合） ===== -->
      <aside class="gd-side">
        <div v-for="grp in categoryGroups" :key="grp.name" class="gd-group">
          <div class="gd-group-title">{{ grp.name }}</div>
          <button
            v-for="cat in grp.items"
            :key="cat.key"
            :class="['gd-cat', activeKey === cat.key && 'active']"
            :title="`${cat.label}（${cat.file}，共 ${cat.count} 条）`"
            @click="switchCategory(cat)"
          >
            <span class="gd-cat-label">{{ cat.label }}</span>
            <span class="gd-cat-count">{{ cat.count }}</span>
          </button>
        </div>
      </aside>

      <!-- ===== 右侧：工具栏 + 列表 ===== -->
      <div class="gd-main">
        <div class="gd-toolbar">
          <div class="gd-search">
            <input
              v-model="search"
              :placeholder="`搜索${activeMeta?.label || '条目'}（名称/描述/全文）`"
              @keyup.esc="search = ''"
            />
            <button v-if="search" class="gd-btn ghost" @click="search = ''">清空</button>
          </div>
          <span class="gd-count">
            {{ activeMeta ? `共 ${activeMeta.count} 条` : '' }}
            <template v-if="search"> · 匹配 <strong>{{ filteredEntries.length }}</strong> 条</template>
          </span>
          <div class="gd-toolbar-actions">
            <button class="gd-btn" title="重新从服务器加载" @click="loadEntries(true)">🔄 刷新</button>
            <button v-if="activeMeta && !activeMeta.single" class="gd-btn primary" @click="openCreate">➕ 新增</button>
          </div>
        </div>

        <p v-if="activeMeta?.single" class="gd-single-hint">
          该分类为整体配置文件（{{ activeMeta.file }}），仅支持编辑，不支持新增/删除。
        </p>

        <div class="gd-table-wrap">
          <table v-if="filteredEntries.length" class="gd-table">
            <thead>
              <tr>
                <th class="gd-col-idx">#</th>
                <th v-for="col in activeMeta?.columns || []" :key="col.field" :class="col.wide && 'gd-col-wide'">
                  {{ col.label }}
                </th>
                <th class="gd-col-actions">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredEntries" :key="row.__index" @click="openEdit(row.__index)">
                <td class="gd-col-idx mono">{{ row.__index }}</td>
                <td v-for="col in activeMeta?.columns || []" :key="col.field" :class="col.wide && 'gd-col-wide'">
                  <template v-if="typeof row.entry[col.field] === 'boolean'">
                    <span :class="row.entry[col.field] ? 'gd-bool yes' : 'gd-bool'">{{ row.entry[col.field] ? '是' : '否' }}</span>
                  </template>
                  <span v-else class="gd-cell" :title="cellText(row.entry[col.field])">{{ cellText(row.entry[col.field]) }}</span>
                </td>
                <td class="gd-col-actions" @click.stop>
                  <button class="gd-act edit" title="编辑" @click="openEdit(row.__index)">编辑</button>
                  <button v-if="activeMeta && !activeMeta.single" class="gd-act copy" title="复制为新条目" @click="openDuplicate(row.__index)">复制</button>
                  <button v-if="activeMeta && !activeMeta.single" class="gd-act danger" title="删除" @click="removeEntry(row.__index)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-else class="gd-empty">
            <template v-if="loading">加载中…</template>
            <template v-else-if="!activeMeta">请选择左侧分类</template>
            <template v-else-if="search">没有匹配「{{ search }}」的条目</template>
            <template v-else>该分类暂无数据，可点击右上角「新增」创建</template>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 编辑/新增弹窗 ===== -->
    <div v-if="editor.open" class="gd-modal-mask" @click.self="closeEditor">
      <div class="gd-modal">
        <div class="gd-modal-head">
          <h3>
            {{ editor.isCreate ? '新增' : '编辑' }} · {{ activeMeta?.label }}
            <small v-if="!editor.isCreate" class="mono">#{{ editor.index }}</small>
          </h3>
          <div class="gd-modal-head-right">
            <div class="gd-mode-switch">
              <button :class="editor.mode === 'form' && 'on'" @click="switchMode('form')">表单模式</button>
              <button :class="editor.mode === 'json' && 'on'" @click="switchMode('json')">JSON 模式</button>
            </div>
            <button class="gd-modal-close" @click="closeEditor">×</button>
          </div>
        </div>

        <!-- 表单模式：按值类型自动生成控件，复杂结构以 JSON 文本编辑 -->
        <div v-if="editor.mode === 'form'" class="gd-form">
          <div v-for="key in formKeys" :key="key" class="gd-field">
            <label>
              <span class="gd-field-name mono">{{ key }}</span>
              <span v-if="fieldCn(key)" class="gd-field-cn">({{ fieldCn(key) }})</span>
              <span class="gd-field-type">{{ fieldTypeLabel(editData[key], key) }}</span>
              <button
                v-if="key !== 'name'"
                class="gd-field-del"
                title="删除该字段"
                @click="deleteFormField(key)"
              >✕</button>
            </label>

            <!-- 布尔 -->
            <label v-if="fieldKind(editData[key]) === 'boolean'" class="gd-check">
              <input v-model="editData[key]" type="checkbox" />
              <span>{{ editData[key] ? '是' : '否' }}</span>
            </label>
            <!-- 数字 -->
            <input
              v-else-if="fieldKind(editData[key]) === 'number'"
              v-model.number="editData[key]"
              type="number"
              step="any"
            />
            <!-- 长文本 -->
            <textarea
              v-else-if="fieldKind(editData[key]) === 'longtext'"
              v-model="editData[key]"
              rows="3"
            ></textarea>
            <!-- 对象/数组：JSON 文本 -->
            <template v-else-if="fieldKind(editData[key]) === 'json'">
              <textarea
                v-model="jsonTexts[key]"
                :rows="jsonRows(jsonTexts[key])"
                :class="jsonErrors[key] && 'invalid'"
                spellcheck="false"
              ></textarea>
              <div class="gd-json-actions">
                <span v-if="jsonErrors[key]" class="gd-json-error">{{ jsonErrors[key] }}</span>
                <span v-else class="gd-json-ok">✓ JSON 合法</span>
                <button class="gd-btn tiny" @click="formatJson(key)">格式化</button>
              </div>
            </template>
            <!-- 普通文本 -->
            <input v-else v-model="editData[key]" type="text" />
          </div>

          <button class="gd-btn ghost add-field" @click="addField">＋ 添加字段</button>
        </div>

        <!-- JSON 模式：整条目源码编辑 -->
        <div v-else class="gd-form">
          <textarea
            v-model="wholeJsonText"
            class="gd-whole-json"
            :class="wholeJsonError && 'invalid'"
            rows="18"
            spellcheck="false"
          ></textarea>
          <div class="gd-json-actions">
            <span v-if="wholeJsonError" class="gd-json-error">{{ wholeJsonError }}</span>
            <span v-else class="gd-json-ok">✓ JSON 合法</span>
            <button class="gd-btn tiny" @click="formatWholeJson">格式化</button>
          </div>
        </div>

        <div class="gd-modal-foot">
          <button class="gd-btn primary" :disabled="saving" @click="saveEditor">
            {{ saving ? '保存中…' : '💾 保存' }}
          </button>
          <button class="gd-btn ghost" :disabled="saving" @click="closeEditor">取消</button>
          <span v-if="editorResult" :class="['gd-result', editorError && 'err']">{{ editorResult }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * 数据管理面板（模块化后台管理工具）
 * ------------------------------------------------------------------
 * 面向 server/prisma/data/*.json 静态游戏数据的查看/新增/编辑/删除界面。
 * 组件完全由后端 GET /admin/gamedata 返回的分类元数据驱动（分类/分组/展示列/
 * 新增模板），后端注册表新增分类时前端零改动，天然模块化。
 *
 * 交互设计：
 * - 左侧分类侧栏按分组聚合，右侧表格展示条目，支持全文即时搜索（本地过滤）。
 * - 编辑弹窗提供「表单模式」（按值类型自动生成控件）与「JSON 模式」（整条源码），
 *   覆盖从改数值到写复杂结构的不同场景。
 * - 更新/删除携带 expectName 乐观校验，后端写入前自动备份并热重载缓存。
 */
import { ref, computed, onMounted } from 'vue';
import { adminApi } from '../../api';

/**
 * 字段中文对照表：编辑表单里英文字段名后以 (中文) 展示。
 * 覆盖 prisma/data/*.json 中实际出现的英文键；未收录的字段只显示类型提示，
 * 中文名沿用原版易语言配置的叫法，便于与原版资料对照。
 */
const FIELD_LABELS = {
  name: '名称',
  type: '类型',
  type2: '类型2',
  id: 'ID',
  value: '价值',
  count: '数量',
  quantity: '数量',
  price: '价格',
  cost: '消耗',
  level: '等级',
  exp: '经验',
  expGain: '经验收益',
  description: '描述',
  description2: '描述2',
  content: '内容',
  chance: '概率',
  duration: '持续时长',
  stackTime: '叠加时长',
  cooldown: '冷却',
  lockTime: '锁定时间',
  distance: '距离',
  aoe: '溅射范围',
  // 战斗属性
  hp: '生命',
  maxHp: '生命上限',
  currentHp: '当前生命',
  shield: '护盾',
  maxShield: '护盾上限',
  armor: '装甲',
  maxArmor: '装甲上限',
  attack: '攻击',
  defense: '防御',
  maxDefense: '防御上限',
  speed: '速度',
  dodge: '闪避',
  hit: '命中',
  weapon: '武器加成',
  walk: '行走加成',
  function: '功能加成',
  // 装备/武器
  equipType: '装备部位',
  specialSeq: '特殊序号',
  specialEffect: '特殊特效',
  forcedEffect: '强制特效',
  negativeType: '负面类型',
  damageType: '伤害类型',
  damage: '伤害',
  vehicleForceDmg: '对载具强制伤害',
  affixes: '随机词条',
  properties: '属性详情',
  attrs: '属性列表',
  durability: '耐久',
  attackText: '攻击文本',
  attackTexts: '攻击文本',
  shieldBreak: '破盾文本',
  armorBreak: '破甲文本',
  killTexts: '击杀文本',
  missTexts: '闪避文本',
  lockTexts: '锁定文本',
  // 装备/怪物容器
  bonus: '加成属性',
  baseBonus: '基础加成',
  buffs: '增益',
  markers: '标记',
  markers2: '限时标记',
  marker: '标记',
  weapons: '武器',
  equipments: '装备',
  equipmentList: '装备列表',
  weaponSlots: '武器槽位',
  defenseSlots: '防御槽位',
  moveSlots: '行走槽位',
  functionSlots: '功能槽位',
  maxWeapon: '武器槽上限',
  maxMove: '行走槽上限',
  maxFunction: '功能槽上限',
  slotStatus: '槽位状态',
  builtinParts: '内置零件',
  parts: '零件',
  materials: '材料',
  coating: '涂层',
  reverseField: '逆转力场',
  backpack: '背包',
  // 怪物/使魔
  affinityDesc: '好感度描述',
  uniqueSkill: '专属技能',
  skillDesc: '技能描述',
  noSummon: '禁止召唤',
  hairDrop: '掉落毛发',
  // 地图
  mapIndex: '地图编号',
  isFrontier: '是否开拓地',
  isInstance: '是否关卡地图',
  noTeleport: '禁止传送',
  noMove: '禁止搬迁',
  requiredTravel: '前往需求',
  respawnPoint: '重生点',
  monsters: '固定怪物',
  spawnMonsters: '刷出怪物',
  tempMonsters: '临时怪物',
  summons: '召唤物',
  resources: '资源',
  resources2: '可采集资源',
  connections: '可前往地图',
  npcs: 'NPC列表',
  items: '物品列表',
  buildings: '建筑',
  vehicles: '载具',
  mapBuffs: '地图增益',
  requireMarkers: '进入要求标记',
  failHint: '未满足提示',
  clearMarkers: '进入清除标记',
  music: '背景音乐',
  bgm: '背景音乐',
  monsterCount: '刷怪数量',
  noSpecial: '不刷特殊事件',
  // 任务
  publisher: '发布人',
  requirements: '需求条件',
  rewards: '奖励',
  nextTasks: '后续任务',
  restrictMarkers: '限制标记',
  taskId: '任务ID',
  unlockReq: '解锁条件',
  unlockRequirements: '解锁需求',
  // 配方/制造
  outputs: '产出',
  outputs2: '产出2',
  inputs: '消耗材料',
  productivity: '生产力',
  production: '生产配置',
  craftTime: '制造耗时',
  noCraft: '禁止制造',
  deconstructMul: '分解倍率',
  gainMarkers: '获得标记',
  recipes: '配方',
  // 资源/采集
  times: '可采集次数',
  timeScale: '时间倍率',
  renewable: '可再生',
  gatherCmd: '采集指令',
  gatherText: '采集文本',
  useGet: '可获得',
  proxySpeak: '代说话',
  drops: '掉落',
  // NPC 对话
  hostileChat: '敌对台词',
  friendlyChat: '友好台词',
  followText: '跟随台词',
  stopText: '停下台词',
  pickupText: '拾取台词',
  milkText: '挤奶台词',
  killText: '击杀台词',
  boostStart: '补魔开始台词',
  boostEnd: '补魔结束台词',
  strengthenText: '强化台词',
  captureText: '被捕捉台词',
  lieDownText: '躺下台词',
  wakeUpText: '起床台词',
  // 载具
  vehicleId: '载具ID',
  owner: '归属者',
  driver: '驾驶员',
  moveType: '行走方式',
  // 特效/增益
  limit: '限制',
  limit2: '限制2',
  effectText: '效果文本',
  triggerText: '触发文本',
  sourceFile: '来源文件',
  // 商店/行商
  shopActivity: '活跃度商店',
  shopDiamond: '钻石商店',
  shopData: '数据核心商店',
  dungeons: '副本',
  dungeons2: '副本2',
  robotQQ: '机器人QQ',
  familiarImg: '使魔图片',
  characterImg: '人物图片',
  monsterImg: '怪物图片',
  mapImg: '地图图片',
  travelingEquip: '行商装备池',
  travelingItem: '行商物品池',
  equipmentText: '行商装备池',
  itemText: '行商物品池',
  // 其他
  useEffects: '使用效果',
  useMarkers: '使用标记',
  forMonster: '适用怪物',
  storage: '仓储',
};

/** 字段中文翻译：字典命中直接返回；material_N 这类序号字段按模式生成 */
function fieldCn(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  const m = /^material_(\d+)$/.exec(key);
  if (m) return `材料${m[1]}`;
  return '';
}

// ---- 分类元数据与当前分类 ----
const categories = ref([]);
const activeKey = ref('');
const activeMeta = computed(() => categories.value.find((c) => c.key === activeKey.value) || null);

/** 分类按 group 分组，保持注册表顺序 */
const categoryGroups = computed(() => {
  const groups = [];
  const index = {};
  for (const cat of categories.value) {
    const g = cat.group || '其他';
    if (!(g in index)) {
      index[g] = { name: g, items: [] };
      groups.push(index[g]);
    }
    index[g].items.push(cat);
  }
  return groups;
});

// ---- 条目数据与搜索 ----
const entries = ref([]);        // 当前分类全部条目（原数组顺序）
const loading = ref(false);
const search = ref('');

/** 表格行包装：保留原数组下标（API 按 index 寻址） */
const filteredEntries = computed(() => {
  const kw = search.value.trim().toLowerCase();
  const rows = entries.value.map((entry, __index) => ({ entry, __index }));
  if (!kw) return rows;
  return rows.filter(({ entry }) => haystackOf(entry).includes(kw));
});

/** 搜索文本：优先 名称/类型/描述，否则整条 JSON（适配单配置文件） */
function haystackOf(entry) {
  const parts = [entry?.name, entry?.type, entry?.description].filter((v) => typeof v === 'string' && v);
  const text = parts.length ? parts.join(' ') : JSON.stringify(entry ?? {});
  return text.toLowerCase();
}

/** 单元格文本：复杂结构折叠为摘要，避免表格爆版 */
function cellText(v) {
  if (v === null || v === undefined || v === '') return '-';
  if (Array.isArray(v)) return v.length ? `[${v.length} 项]` : '[]';
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{${keys.slice(0, 3).join('、')}${keys.length > 3 ? '…' : ''}}` : '{}';
  }
  return String(v);
}

// ---- 数据加载 ----
async function loadCategories() {
  const res = await adminApi.gameDataCategories();
  categories.value = res.data || [];
  // 恢复上次使用的分类，否则选第一个
  const last = localStorage.getItem('admin.gamedata.category');
  const initial = categories.value.find((c) => c.key === last) || categories.value[0];
  if (initial) await switchCategory(initial);
}

async function switchCategory(cat) {
  activeKey.value = cat.key;
  localStorage.setItem('admin.gamedata.category', cat.key);
  await loadEntries();
}

async function loadEntries(notifyError = false) {
  if (!activeKey.value) return;
  loading.value = true;
  try {
    const res = await adminApi.gameDataEntries(activeKey.value);
    entries.value = res.data?.entries || [];
    // 同步侧栏计数
    const meta = activeMeta.value;
    if (meta) meta.count = entries.value.length;
  } catch (e) {
    if (notifyError) alert('加载数据失败：' + (e.response?.data?.message || e.message));
    else console.warn('[数据管理] 加载失败', e);
  } finally {
    loading.value = false;
  }
}

// ---- 编辑器状态 ----
const editor = ref({
  open: false,
  isCreate: false,   // true 新增/复制，false 编辑
  index: -1,         // 编辑时的原数组下标
  expectName: '',    // 编辑时乐观校验用原名
  mode: 'form',      // 'form' | 'json'
});
const editData = ref({});        // 表单数据（基础类型直接绑定）
const jsonTexts = ref({});       // 对象/数组字段的 JSON 文本
const jsonErrors = ref({});      // 各 JSON 字段的解析错误
const wholeJsonText = ref('');   // JSON 模式整条文本
const wholeJsonError = ref('');
const saving = ref(false);
const editorResult = ref('');
const editorError = ref(false);

/** 值类型 → 控件类别 */
function fieldKind(v) {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return v.length > 60 || v.includes('\n') ? 'longtext' : 'text';
  return 'json'; // object / array / null / undefined
}

function fieldTypeLabel(v, key) {
  const kind = fieldKind(v);
  if (key === 'name') return '必填，同分类唯一';
  return { boolean: '布尔', number: '数字', longtext: '长文本', text: '文本', json: 'JSON 结构' }[kind];
}

/** 表单字段排序：name 优先，基础类型在前，复杂结构在后 */
const formKeys = computed(() => {
  const keys = Object.keys(editData.value);
  const score = (k) => {
    if (k === 'name') return 0;
    const kind = fieldKind(editData.value[k]);
    if (kind === 'number' || kind === 'boolean') return 1;
    if (kind === 'text') return 2;
    if (kind === 'longtext') return 3;
    return 4;
  };
  return keys.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
});

/** JSON 文本框行数：内容多时给更多空间 */
function jsonRows(text) {
  const lines = (text || '').split('\n').length;
  return Math.min(Math.max(lines, 3), 14);
}

function validateJsonTexts() {
  const errors = {};
  for (const [key, text] of Object.entries(jsonTexts.value)) {
    try {
      JSON.parse(text);
      errors[key] = '';
    } catch (e) {
      errors[key] = `JSON 语法错误：${e.message}`;
    }
  }
  jsonErrors.value = errors;
  return Object.values(errors).every((v) => !v);
}

/** 表单状态 → 条目对象（JSON 文本字段解析回结构） */
function collectEntry() {
  const obj = {};
  for (const key of Object.keys(editData.value)) {
    if (key in jsonTexts.value) {
      obj[key] = JSON.parse(jsonTexts.value[key]);
    } else {
      let v = editData.value[key];
      if (v === '') v = 0; // 数字输入框清空后按 0 提交（游戏数值字段的主流默认）
      obj[key] = v;
    }
  }
  return obj;
}

/** 条目对象 → 表单状态 */
function hydrateEditor(entry) {
  const data = JSON.parse(JSON.stringify(entry ?? {}));
  const texts = {};
  const errors = {};
  for (const key of Object.keys(data)) {
    const v = data[key];
    if (v !== null && typeof v === 'object') {
      texts[key] = JSON.stringify(v, null, 2);
      errors[key] = '';
    }
  }
  editData.value = data;
  jsonTexts.value = texts;
  jsonErrors.value = errors;
  wholeJsonText.value = JSON.stringify(data, null, 2);
  wholeJsonError.value = '';
}

function openEditor(index, entry, isCreate) {
  editor.value = {
    open: true,
    isCreate,
    index: isCreate ? -1 : index,
    expectName: isCreate ? '' : String(entry?.name ?? ''),
    mode: 'form',
  };
  editorResult.value = '';
  editorError.value = false;
  hydrateEditor(entry);
}

function openEdit(index) {
  const entry = entries.value[index];
  if (!entry) return;
  openEditor(index, entry, false);
}

/** 新增：字段骨架 = 分类模板 ∪ 该分类现有条目出现过的全部字段，保证新增条目字段不缺漏 */
function openCreate() {
  const template = JSON.parse(JSON.stringify(activeMeta.value?.template || { name: '' }));
  const skeleton = buildCreateSkeleton(entries.value, template);
  openEditor(-1, skeleton, true);
}

/**
 * 构造新增表单骨架：先保留模板字段（默认值取模板），再并入现有条目中出现过的
 * 其余字段（默认值按值类型推导：字符串→''、数字→0、布尔→false、对象/数组→空）。
 * 个别用不上的字段可在表单里用 ✕ 手动移除。
 */
function buildCreateSkeleton(existingEntries, template) {
  const skeleton = {};
  const addKey = (key, sampleValue) => {
    if (key in skeleton) return;
    let dv;
    if (key in template) dv = template[key];
    else if (typeof sampleValue === 'string') dv = '';
    else if (typeof sampleValue === 'number') dv = 0;
    else if (typeof sampleValue === 'boolean') dv = false;
    else if (Array.isArray(sampleValue)) dv = [];
    else if (sampleValue && typeof sampleValue === 'object') dv = {};
    else dv = null;
    skeleton[key] = JSON.parse(JSON.stringify(dv === undefined ? null : dv));
  };
  for (const [k, v] of Object.entries(template || {})) addKey(k, v);
  for (const entry of existingEntries || []) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      for (const [k, v] of Object.entries(entry)) addKey(k, v);
    }
  }
  return skeleton;
}

/** 复制：以原条目为模板，自动起不重名的名称 */
function openDuplicate(index) {
  const entry = JSON.parse(JSON.stringify(entries.value[index]));
  if (entry && typeof entry === 'object') {
    const base = `${entry.name ?? ''}副本`;
    let name = base;
    let n = 2;
    const names = new Set(entries.value.map((e) => e?.name));
    while (names.has(name)) name = `${base}${n++}`;
    entry.name = name;
  }
  openEditor(-1, entry, true);
}

function closeEditor() {
  if (saving.value) return;
  editor.value.open = false;
  editorResult.value = '';
}

/** 模式切换时双向同步表单状态与整条 JSON 文本 */
function switchMode(mode) {
  if (editor.value.mode === mode) return;
  if (mode === 'json') {
    // 表单 → JSON：先校验各字段 JSON 文本，合法才允许进入
    if (!validateJsonTexts()) {
      editorError.value = true;
      editorResult.value = '存在 JSON 语法错误的字段，修正后再切换模式';
      return;
    }
    wholeJsonText.value = JSON.stringify(collectEntry(), null, 2);
    wholeJsonError.value = '';
  } else {
    // JSON → 表单：解析整条文本
    try {
      const parsed = JSON.parse(wholeJsonText.value);
      hydrateEditor(parsed);
    } catch (e) {
      wholeJsonError.value = `JSON 语法错误：${e.message}`;
      return;
    }
  }
  editor.value.mode = mode;
  editorResult.value = '';
  editorError.value = false;
}

function formatJson(key) {
  try {
    jsonTexts.value[key] = JSON.stringify(JSON.parse(jsonTexts.value[key]), null, 2);
    jsonErrors.value[key] = '';
  } catch (e) {
    jsonErrors.value[key] = `JSON 语法错误：${e.message}`;
  }
}

function formatWholeJson() {
  try {
    wholeJsonText.value = JSON.stringify(JSON.parse(wholeJsonText.value), null, 2);
    wholeJsonError.value = '';
  } catch (e) {
    wholeJsonError.value = `JSON 语法错误：${e.message}`;
  }
}

/** 新增字段：输入字段名，初值为空文本 */
function addField() {
  const key = prompt('新字段名（英文标识，如 newValue）：');
  if (!key || !key.trim()) return;
  const k = key.trim();
  if (k in editData.value) {
    alert(`字段「${k}」已存在`);
    return;
  }
  editData.value[k] = '';
  jsonErrors.value[k] = '';
}

function deleteFormField(key) {
  if (!confirm(`确定删除字段「${key}」吗？（保存后生效）`)) return;
  delete editData.value[key];
  delete jsonTexts.value[key];
  delete jsonErrors.value[key];
}

/** 保存：新增走 create，编辑走 update（携带 expectName 乐观校验） */
async function saveEditor() {
  let entry;
  if (editor.value.mode === 'json') {
    try {
      entry = JSON.parse(wholeJsonText.value);
    } catch (e) {
      wholeJsonError.value = `JSON 语法错误：${e.message}`;
      return;
    }
  } else {
    if (!validateJsonTexts()) {
      editorError.value = true;
      editorResult.value = '存在 JSON 语法错误的字段，请修正后保存';
      return;
    }
    entry = collectEntry();
  }

  saving.value = true;
  editorError.value = false;
  editorResult.value = '';
  try {
    if (editor.value.isCreate) {
      await adminApi.createGameData(activeKey.value, entry);
      editorResult.value = `已新增「${entry.name ?? '配置'}」`;
    } else {
      await adminApi.updateGameData(activeKey.value, editor.value.index, entry, editor.value.expectName);
      editorResult.value = '已保存并生效';
    }
    await loadEntries();
    // 保存成功后关闭（留出提示时间无必要，列表刷新即为反馈）
    setTimeout(() => {
      editor.value.open = false;
      editorResult.value = '';
    }, 600);
  } catch (e) {
    editorError.value = true;
    editorResult.value = '保存失败：' + (e.response?.data?.message || e.message);
  } finally {
    saving.value = false;
  }
}

/** 删除条目（带乐观校验与二次确认） */
async function removeEntry(index) {
  const entry = entries.value[index];
  if (!entry) return;
  if (!confirm(`确定删除「${entry.name ?? index}」吗？\n原文件会自动备份，但删除对游戏立即生效。`)) return;
  try {
    await adminApi.deleteGameData(activeKey.value, index, String(entry.name ?? ''));
    await loadEntries();
  } catch (e) {
    alert('删除失败：' + (e.response?.data?.message || e.message));
  }
}

onMounted(loadCategories);
</script>

<style scoped>
/* ===== 整体布局 ===== */
.gd-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 420px;
}
.gd-body {
  display: flex;
  gap: 12px;
  align-items: stretch;
  min-height: 480px;
}

/* ===== 左侧分类侧栏 ===== */
.gd-side {
  width: 178px;
  flex-shrink: 0;
  max-height: calc(100vh - 240px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 2px;
}
.gd-group-title {
  font-size: 11px;
  color: var(--muted, #9ca3af);
  letter-spacing: 1px;
  padding: 0 6px 4px;
  border-bottom: 1px dashed var(--border, rgba(255, 255, 255, 0.12));
}
.gd-group + .gd-group .gd-group-title {
  margin-top: 2px;
}
.gd-cat {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  margin-top: 4px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text, #e5e7eb);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s;
}
.gd-cat:hover {
  background: rgba(139, 92, 246, 0.12);
}
.gd-cat.active {
  background: rgba(139, 92, 246, 0.22);
  border-color: rgba(139, 92, 246, 0.5);
  color: #c4b5fd;
  font-weight: 600;
}
.gd-cat-count {
  font-size: 11px;
  color: var(--muted, #9ca3af);
  background: rgba(255, 255, 255, 0.06);
  border-radius: 9px;
  padding: 0 7px;
  line-height: 17px;
}
.gd-cat.active .gd-cat-count {
  color: #c4b5fd;
}

/* ===== 右侧主体 ===== */
.gd-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.gd-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.gd-search {
  display: flex;
  gap: 6px;
  flex: 1;
  min-width: 200px;
  max-width: 420px;
}
.gd-search input {
  flex: 1;
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 8px;
  color: var(--text, #e5e7eb);
  padding: 6px 10px;
  font-size: 13px;
}
.gd-search input:focus {
  outline: none;
  border-color: var(--accent, #7aa2ff);
}
.gd-count {
  font-size: 12px;
  color: var(--muted, #9ca3af);
  white-space: nowrap;
}
.gd-count strong {
  color: var(--accent2, #fbbf24);
}
.gd-toolbar-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
.gd-single-hint {
  margin: 0;
  font-size: 12px;
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.1);
  border: 1px dashed rgba(245, 158, 11, 0.4);
  border-radius: 8px;
  padding: 6px 10px;
}

/* ===== 按钮 ===== */
.gd-btn {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: 13px;
  cursor: pointer;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  background: rgba(255, 255, 255, 0.06);
  color: var(--text, #e5e7eb);
  white-space: nowrap;
  transition: filter 0.15s;
}
.gd-btn:hover:not(:disabled) {
  filter: brightness(1.2);
}
.gd-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.gd-btn.primary {
  background: rgba(139, 92, 246, 0.35);
  border-color: rgba(139, 92, 246, 0.6);
  color: #ddd6fe;
  font-weight: 600;
}
.gd-btn.ghost {
  background: transparent;
  color: var(--muted, #9ca3af);
}
.gd-btn.tiny {
  padding: 2px 8px;
  font-size: 11px;
}

/* ===== 表格 ===== */
.gd-table-wrap {
  flex: 1;
  overflow: auto;
  max-height: calc(100vh - 300px);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
}
.gd-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.gd-table th,
.gd-table td {
  text-align: left;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  white-space: nowrap;
}
.gd-table thead th {
  position: sticky;
  top: 0;
  background: rgba(16, 16, 32, 0.98);
  color: var(--muted, #9ca3af);
  font-size: 12px;
  z-index: 2;
}
.gd-table tbody tr {
  cursor: pointer;
}
.gd-table tbody tr:hover {
  background: rgba(139, 92, 246, 0.1);
}
.gd-col-idx {
  width: 46px;
  color: var(--muted, #9ca3af);
}
.gd-col-wide {
  max-width: 300px;
}
.gd-col-wide .gd-cell {
  display: inline-block;
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}
.gd-col-actions {
  width: 150px;
  white-space: nowrap;
}
.mono {
  font-family: monospace;
}
.gd-bool.yes {
  color: #4ade80;
}
.gd-bool {
  color: var(--muted, #9ca3af);
}
.gd-act {
  border: none;
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.gd-act.edit {
  color: #7aa2ff;
}
.gd-act.edit:hover {
  background: rgba(59, 130, 246, 0.18);
}
.gd-act.copy {
  color: #fbbf24;
}
.gd-act.copy:hover {
  background: rgba(245, 158, 11, 0.18);
}
.gd-act.danger {
  color: #f87171;
}
.gd-act.danger:hover {
  background: rgba(239, 68, 68, 0.18);
}
.gd-empty {
  padding: 60px 0;
  text-align: center;
  color: var(--muted, #9ca3af);
  font-size: 13px;
}

/* ===== 编辑弹窗 ===== */
.gd-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
  animation: gdFadeIn 0.18s ease-out;
}
@keyframes gdFadeIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
.gd-modal {
  width: min(860px, calc(100vw - 40px));
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--card, rgba(16, 16, 32, 0.98));
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}
.gd-modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.gd-modal-head h3 {
  margin: 0;
  font-size: 15px;
  color: var(--text, #e5e7eb);
}
.gd-modal-head small {
  font-weight: 400;
  color: var(--muted, #9ca3af);
  margin-left: 6px;
}
.gd-modal-head-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.gd-mode-switch {
  display: flex;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 8px;
  overflow: hidden;
}
.gd-mode-switch button {
  border: none;
  background: transparent;
  color: var(--muted, #9ca3af);
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
}
.gd-mode-switch button.on {
  background: rgba(139, 92, 246, 0.3);
  color: #ddd6fe;
}
.gd-modal-close {
  background: none;
  border: none;
  color: var(--muted, #9ca3af);
  font-size: 22px;
  cursor: pointer;
  line-height: 1;
}
.gd-modal-close:hover {
  color: var(--text, #e5e7eb);
}

/* ===== 表单 ===== */
.gd-form {
  flex: 1;
  overflow-y: auto;
  padding: 12px 18px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 10px 14px;
  align-content: start;
}
.gd-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.gd-field > label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  color: var(--muted, #9ca3af);
}
.gd-field-name {
  color: var(--accent2, #fbbf24);
  font-size: 12px;
}
.gd-field-del {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--muted, #9ca3af);
  cursor: pointer;
  font-size: 11px;
}
.gd-field-del:hover {
  color: #f87171;
}
.gd-field input[type='text'],
.gd-field input[type='number'],
.gd-field textarea {
  width: 100%;
  box-sizing: border-box;
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 8px;
  color: var(--text, #e5e7eb);
  padding: 6px 9px;
  font-size: 13px;
  font-family: inherit;
}
.gd-field textarea {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
}
.gd-field input:focus,
.gd-field textarea:focus {
  outline: none;
  border-color: var(--accent, #7aa2ff);
}
.gd-field textarea.invalid {
  border-color: #f87171;
}
.gd-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text, #e5e7eb);
  cursor: pointer;
}
.gd-check input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent, #8b5cf6);
}
.gd-json-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
}
.gd-json-error {
  color: #f87171;
}
.gd-json-ok {
  color: #4ade80;
}
.gd-whole-json {
  grid-column: 1 / -1;
  width: 100%;
  box-sizing: border-box;
  background: rgba(10, 10, 26, 0.7);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.15));
  border-radius: 8px;
  color: var(--text, #e5e7eb);
  padding: 10px;
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  line-height: 1.6;
  resize: vertical;
}
.gd-whole-json.invalid {
  border-color: #f87171;
}
.add-field {
  grid-column: 1 / -1;
  justify-self: start;
}

/* ===== 弹窗底部 ===== */
.gd-modal-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.1));
}
.gd-result {
  font-size: 13px;
  color: #4ade80;
}
.gd-result.err {
  color: #f87171;
  word-break: break-all;
}

/* ===== 移动端 ===== */
@media (max-width: 768px) {
  .gd-body {
    flex-direction: column;
  }
  .gd-side {
    width: 100%;
    max-height: 180px;
    flex-direction: row;
    flex-wrap: wrap;
  }
  .gd-group {
    min-width: 100%;
  }
  .gd-form {
    grid-template-columns: 1fr;
  }
}
</style>
