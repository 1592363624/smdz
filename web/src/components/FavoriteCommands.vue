<template>
  <!-- 我的常用指令：用户自定义，可编辑、可拖拽排序，点击直接发送。
       根元素必须保持 class="fav-cmds"：样式全部在 src/styles.css 里全局定义，
       且 startFavEdit 依赖 closest('.fav-cmds') 定位本面板自己的输入框。 -->
  <div class="fav-cmds">
    <div class="fav-head">
      <span class="fav-title">{{ title }}</span>
      <div class="fav-actions">
        <!-- 分享：把当前常用列表生成分享码并复制到剪贴板，可在其他账号导入 -->
        <button class="fav-mini-btn" title="复制分享码，可在其他账号导入" @click="exportFavorites">分享</button>
        <!-- 导入：粘贴其他账号的分享码，合并进当前列表 -->
        <button class="fav-mini-btn" title="粘贴分享码导入常用指令" @click="openFavImport">导入</button>
        <button class="fav-edit-btn" @click="toggleFavEdit">{{ favEditing ? '完成' : '编辑' }}</button>
      </div>
    </div>
    <div v-if="favoriteCommands.length || favEditing" class="fav-list">
      <!-- 非编辑态也允许拖拽排序：HTML5 拖拽自带触发阈值，未实际拖动时 click 仍正常触发发送 -->
      <span
        v-for="(f, fi) in favoriteCommands"
        :key="'fav-' + f.cmd"
        class="fav-chip"
        :class="{ editing: favEditing, dragging: dragIndex === fi, dragover: dragOverIndex === fi, 'edit-target': favEditTarget === f.cmd }"
        :draggable="true"
        @dragstart="onFavDragStart(fi)"
        @dragover.prevent="onFavDragOver(fi)"
        @drop="onFavDrop(fi)"
        @click="onFavoriteClick(f, $event)"
      >
        <span v-if="favEditing" class="fav-grip" title="拖拽排序" @click.stop>⋮⋮</span>
        <span class="fav-label" :title="favEditing ? '点击载入下方重新编辑' : f.label">{{ f.label }}</span>
        <span v-if="favEditing" class="fav-del" title="删除" @click.stop="removeFavorite(f.cmd)">✕</span>
      </span>
      <span v-if="!favoriteCommands.length && favEditing" class="fav-empty">暂无常用，在下方添加任意内容</span>
    </div>
    <div v-if="favEditing" class="fav-add">
      <div v-if="favEditTarget" class="fav-edit-tip">正在编辑「{{ favEditTip }}」，保存后覆盖原项</div>
      <textarea
        class="fav-add-input fav-add-textarea"
        v-model="favAddInput"
        rows="3"
        placeholder="发送内容（每行一条，可组成指令集，点击后从上到下顺序执行；Ctrl+Enter 保存）"
        @click.stop
        @keydown.enter.ctrl.prevent="favAddInput.trim() ? addFavorite() : null"
      ></textarea>
      <input
        class="fav-add-label"
        v-model="favAddLabel"
        placeholder="显示名（可选，留空用发送内容）"
        @click.stop
        @keyup.enter="favAddInput.trim() ? addFavorite() : null"
      />
      <div class="fav-add-actions">
        <button class="fav-add-btn" :disabled="favBusy || !favAddInput.trim()" @click="addFavorite()">{{ favEditTarget ? '保存修改' : '+ 添加' }}</button>
        <button v-if="favEditTarget" class="fav-cancel-btn" @click="resetFavForm()">取消编辑</button>
      </div>
      <div v-if="favAddCandidates.length" class="fav-candidates">
        <span
          v-for="c in favAddCandidates"
          :key="'favc-' + c.name"
          class="fav-cand"
          @click="addFavorite(c.name)"
        >{{ c.name }}</span>
      </div>
    </div>
    <!-- 导入面板：粘贴其他账号的分享码，实时预览解析结果，确认后再合并进当前列表 -->
    <div v-if="favImporting" class="fav-add fav-import">
      <textarea
        class="fav-add-input fav-add-textarea"
        v-model="favImportText"
        rows="4"
        placeholder="粘贴分享码（在其他账号点「分享」复制的内容）"
        @click.stop
      ></textarea>
      <!-- 预览区：解析失败提示原因，成功则列出「将新增」与「将跳过」的条目 -->
      <div v-if="favImportPreview.error" class="fav-import-tip err">{{ favImportPreview.error }}</div>
      <div v-else-if="favImportPreview.incoming.length" class="fav-import-preview">
        <div class="fav-import-sum">
          共解析 {{ favImportPreview.incoming.length }} 条：
          <b class="ok">新增 {{ favImportPreview.added.length }} 条</b>
          <span v-if="favImportPreview.dup.length">，<span class="skip">跳过 {{ favImportPreview.dup.length }} 条重复</span></span>
        </div>
        <div v-if="favImportPreview.added.length" class="fav-list">
          <span
            v-for="p in favImportPreview.added"
            :key="'favp-' + p.cmd"
            class="fav-chip"
            :title="p.cmd"
          >{{ p.label }}</span>
        </div>
        <div v-else class="fav-import-sum">与当前列表完全相同，无需重复导入</div>
        <details v-if="favImportPreview.dup.length" class="fav-import-dup">
          <summary>已存在、将跳过 {{ favImportPreview.dup.length }} 条</summary>
          <div class="fav-list">
            <span
              v-for="p in favImportPreview.dup"
              :key="'favd-' + p.cmd"
              class="fav-chip muted"
              :title="p.cmd"
            >{{ p.label }}</span>
          </div>
        </details>
      </div>
      <div class="fav-add-actions">
        <button class="fav-add-btn" :disabled="favBusy || !favImportPreview.added.length" @click="confirmFavImport()">确认导入{{ favImportPreview.added.length ? `（${favImportPreview.added.length} 条）` : '' }}</button>
        <button class="fav-cancel-btn" @click="cancelFavImport()">取消</button>
      </div>
    </div>
    <div v-if="!favEditing && !favoriteCommands.length" class="fav-hint">点「编辑」可添加常用指令</div>
    <div v-if="favMsg" class="fav-msg">{{ favMsg }}</div>
  </div>
</template>

<script setup>
/**
 * 「我的常用指令」面板：从 ChatView 抽出，桌面侧栏 / 手机抽屉 / 全局「我的」底部抽屉复用同一份实现。
 *
 * 职责边界：
 *  - 本组件拥有全部常用指令状态与后端读写（loadFavorites / saveFavorites / 分享 / 导入 / 拖拽排序 / favMsg）；
 *  - 「点了常用项之后做什么」属于父级：组件只 emit('send', cmd)，由父级决定走 socket 还是填入输入框、
 *    以及是否收起抽屉等副作用；
 *  - 样式全部在 src/styles.css（全局），本组件不写也不 @import 任何样式，根元素保持 class="fav-cmds"。
 */
import { ref, computed, nextTick, onMounted } from 'vue';
import { userApi } from '../api';
import { COMMAND_SEARCH_CONFIG } from '../config';
import { searchCommands } from '../utils/commandSearch';
import { useCommandStore } from '../stores/command';

defineProps({
  // 面板标题，默认与 ChatView 原文案一致
  title: { type: String, default: '⭐ 我的常用' },
});

const emit = defineEmits(['send']);

// 候选指令来源：与 ChatView 一样直接读 Pinia store（loadCommands 由父级在挂载流程里触发）
const commandStore = useCommandStore();
const commands = computed(() => commandStore.commands);

// ---------- 我的常用指令（用户自定义，置顶展示、可编辑、可拖拽排序） ----------
// 常用指令数组：每项 { cmd, label }。cmd 为实际发送内容（任意文本，模拟从输入框发送）；label 为按钮展示文字
const favoriteCommands = ref([]);
// 常用指令编辑态（true=进入编辑模式，显示删除按钮/添加框/拖拽手柄）
const favEditing = ref(false);
// 正在编辑的已有项原始 cmd（空字符串=新增模式）：点击常用项文字会把它「放下来」载入下方表单重新编辑，保存时原地覆盖
const favEditTarget = ref('');
// 编辑态表单顶部提示：取列表里的显示名（多行指令集的 cmd 会很长，不适合直接展示）
const favEditTip = computed(() => {
  if (!favEditTarget.value) return '';
  const it = favoriteCommands.value.find((f) => f.cmd === favEditTarget.value);
  return it ? it.label : favEditTarget.value;
});
// 添加常用指令：cmd 为发送内容（任意文本），label 为可选显示名
const favAddInput = ref('');
const favAddLabel = ref('');
// 添加时的候选指令（基于 cmd 文本从全量指令过滤，仅作快速选择辅助；也可直接输入任意文本）
const favAddCandidates = computed(() => {
  // 多行输入时仅用第一行做候选匹配（候选只是快速选择辅助）
  const q = (favAddInput.value.split(/\r?\n/)[0] || '').trim();
  if (!q) return [];
  // 已在常用列表里的指令不再重复作为候选
  const rest = commands.value.filter((c) => !favoriteCommands.value.some((f) => f.cmd === c.name));
  // 候选支持拼音检索：输入 "bb" 也能找到「背包」
  return searchCommands(rest, q, { limit: COMMAND_SEARCH_CONFIG.limits.favoriteCandidate });
});
// 保存中/提示
const favBusy = ref(false);
const favMsg = ref('');
let favMsgTimer = null;
// 拖拽排序状态：当前拖拽项索引、拖拽经过项索引
const dragIndex = ref(-1);
const dragOverIndex = ref(-1);

async function loadFavorites() {
  try {
    const res = await userApi.getFavorites();
    // 兼容后端可能返回的字符串数组格式，统一归一化成 { cmd, label }
    const list = Array.isArray(res.data) ? res.data : [];
    favoriteCommands.value = list.map((it) =>
      typeof it === 'string' ? { cmd: it, label: it } : { cmd: it.cmd, label: it.label || it.cmd }
    );
  } catch {
    favoriteCommands.value = [];
  }
}

function showFavMsg(text) {
  favMsg.value = text;
  if (favMsgTimer) clearTimeout(favMsgTimer);
  favMsgTimer = setTimeout(() => (favMsg.value = ''), 1800);
}

// 提交整体列表到后端（全量覆盖，保留当前顺序）
async function saveFavorites(next) {
  favBusy.value = true;
  try {
    const res = await userApi.setFavorites(next);
    favoriteCommands.value = Array.isArray(res.data) ? res.data : next;
    return true;
  } catch (e) {
    showFavMsg(e?.response?.data?.message || '保存失败');
    return false;
  } finally {
    favBusy.value = false;
  }
}

// 由「发送内容 + 可选显示名」构造一条常用项；内容为空返回 null
// 归一化：按行拆分、去首尾空白、过滤空行后重新拼接（单行文本行为不变）
function buildFavorite(raw, labelInput) {
  const lines = String(raw ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const cmd = lines.join('\n');
  if (!cmd) return null;
  // 多行指令集默认显示名：首行 + 条数，避免按钮上挤进整段多行文本
  const label = (labelInput || '').trim() || (lines.length > 1 ? `${lines[0]}（${lines.length}条）` : cmd);
  return { cmd, label };
}

// 提交常用指令表单：新增或覆盖保存修改（去重按 cmd，无数量上限）
// - favEditTarget 为空 → 追加新项
// - favEditTarget 有值 → 原地替换该项（保持原顺序），即「点击文字载入重新编辑」后的保存
// 支持多行指令集：每行一条指令，点击按钮时由后端按行拆分、从上到下顺序执行（与发送窗口多行行为一致）
async function addFavorite(cmdText) {
  const raw = cmdText != null ? cmdText : favAddInput.value;
  const built = buildFavorite(raw, favAddLabel.value);
  if (!built) return;
  const { cmd, label } = built;
  const editing = favEditTarget.value;
  // 去重校验：编辑态必须排除自身，否则原样保存会被误判为「已在常用列表中」
  if (favoriteCommands.value.some((f) => f.cmd === cmd && f.cmd !== editing)) {
    showFavMsg('已在常用列表中');
    return;
  }
  const next = editing
    ? favoriteCommands.value.map((f) => (f.cmd === editing ? { cmd, label } : f))
    : [...favoriteCommands.value, { cmd, label }];
  const ok = await saveFavorites(next);
  if (ok) {
    showFavMsg(editing ? '修改已保存' : '已添加');
    resetFavForm();
  }
}

// 退出「编辑已有项」状态并清空下方表单（取消编辑 / 保存成功后 / 退出编辑模式时调用）
function resetFavForm() {
  favAddInput.value = '';
  favAddLabel.value = '';
  favEditTarget.value = '';
}

// 点击常用项文字：把该项「放下来」载入下方表单重新编辑（此时列表不变，点「保存修改」才覆盖原项）
function startFavEdit(item, evt) {
  favEditTarget.value = item.cmd;
  favAddInput.value = item.cmd;
  // 仅当显示名是自定义的才回填；自动生成的显示名（多行指令集「首行（N条）」）留空以便按新内容重新生成
  const autoLabel = buildFavorite(item.cmd, '')?.label || item.cmd;
  favAddLabel.value = item.label && item.label !== autoLabel ? item.label : '';
  favMsg.value = '';
  // 载入后把光标落到同一个「我的常用」面板的输入框里，省去用户再点一次
  nextTick(() => {
    const scope = evt?.currentTarget?.closest?.('.fav-cmds');
    const ta = scope?.querySelector?.('.fav-add-textarea');
    if (ta) {
      ta.focus();
      ta.setSelectionRange?.(ta.value.length, ta.value.length);
    }
  });
}

// 删除一条常用指令（按 cmd 匹配，仅由 ✕ 按钮触发）
async function removeFavorite(cmd) {
  const next = favoriteCommands.value.filter((f) => f.cmd !== cmd);
  const ok = await saveFavorites(next);
  if (ok) {
    // 若正在编辑的就是被删掉的那条，同步清空表单，避免保存时写回一条已删除的项
    if (favEditTarget.value === cmd) resetFavForm();
    showFavMsg('已删除');
  }
}

function onFavDragStart(idx) {
  dragIndex.value = idx;
}
function onFavDragOver(idx) {
  dragOverIndex.value = idx;
}
async function onFavDrop(idx) {
  const from = dragIndex.value;
  dragIndex.value = -1;
  dragOverIndex.value = -1;
  if (from < 0 || from === idx) return;
  const next = [...favoriteCommands.value];
  const [moved] = next.splice(from, 1);
  next.splice(idx, 0, moved);
  await saveFavorites(next);
  showFavMsg('顺序已保存');
}

// 进入/退出编辑模式：退出时清空表单与「正在编辑」状态，避免残留状态误保存
function toggleFavEdit() {
  favEditing.value = !favEditing.value;
  resetFavForm();
  // 切换编辑态时收起导入面板，避免两个面板同时展开互相干扰
  favImporting.value = false;
  dragIndex.value = -1;
  dragOverIndex.value = -1;
  if (!favEditing.value) favMsg.value = '';
}

// ---------- 常用指令 分享 / 导入（跨账号复用，纯前端实现） ----------
// 分享码格式：{ v: 1, items: [{ cmd, label }] }，经 UTF-8 安全的 Base64 编码后输出
// 导入面板开关与分享码输入内容
const favImporting = ref(false);
const favImportText = ref('');

// 分享码编码：JSON → UTF-8 字节 → Base64（unescape/escape 兼容中文等多字节字符）
function encodeFavCode(payload) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}
// 分享码解码：先按 Base64 + UTF-8 还原 JSON；失败时兼容直接粘贴原始 JSON 的情况
function decodeFavCode(code) {
  try {
    return JSON.parse(decodeURIComponent(escape(atob(code))));
  } catch {
    try {
      return JSON.parse(code);
    } catch {
      return null;
    }
  }
}

// 分享：把当前常用列表编码成分享码并复制到剪贴板
async function exportFavorites() {
  if (!favoriteCommands.value.length) {
    showFavMsg('暂无常用指令可分享');
    return;
  }
  const code = encodeFavCode({ v: 1, items: favoriteCommands.value });
  try {
    // 优先用异步剪贴板 API（需 HTTPS 或 localhost 环境）
    await navigator.clipboard.writeText(code);
    showFavMsg('分享码已复制，去其他账号点「导入」粘贴即可');
  } catch {
    // 降级：老浏览器或非安全上下文用隐藏 textarea + execCommand 复制
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    document.body.removeChild(ta);
    showFavMsg(ok ? '分享码已复制，去其他账号点「导入」粘贴即可' : '复制失败，请手动复制');
  }
}

// 打开导入面板
function openFavImport() {
  favImporting.value = true;
  favImportText.value = '';
  favMsg.value = '';
}

// 取消导入：收起面板并清空输入
function cancelFavImport() {
  favImporting.value = false;
  favImportText.value = '';
}

// 解析分享码（预览与正式导入共用，保证「看到的」和「导入的」完全一致）
// 返回 { error, incoming, added, dup }：
// - incoming：分享码中归一化后的全部条目
// - added：与当前列表不重复、真正会新增的条目
// - dup：当前列表已存在、会被跳过的条目
function parseFavImport(raw) {
  const empty = { error: '', incoming: [], added: [], dup: [] };
  if (!raw) return empty;
  const parsed = decodeFavCode(raw);
  // 兼容裸数组或 { items: [...] } 两种结构
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items)) return { ...empty, error: '分享码无效，请检查是否复制完整' };
  // 归一化：只收有非空 cmd 的项，label 缺省用 cmd（与后端存储格式保持一致）
  const incoming = items
    .filter((it) => it && typeof it.cmd === 'string' && it.cmd.trim())
    .map((it) => ({ cmd: it.cmd, label: (typeof it.label === 'string' && it.label.trim()) || it.cmd }));
  if (!incoming.length) return { ...empty, error: '分享码中没有可导入的内容' };
  // 按 cmd 与当前列表比对：重复的放进 dup 跳过，其余按序放入 added
  const existing = new Set(favoriteCommands.value.map((f) => f.cmd));
  const added = [];
  const dup = [];
  for (const it of incoming) {
    if (existing.has(it.cmd)) {
      dup.push(it);
      continue;
    }
    existing.add(it.cmd);
    added.push(it);
  }
  return { error: '', incoming, added, dup };
}

// 导入预览：随输入框内容实时刷新，粘贴后即可看到将新增/将跳过的条目
const favImportPreview = computed(() => parseFavImport(favImportText.value.trim()));

// 确认导入：直接复用预览的解析结果，追加新增条目并整体保存
async function confirmFavImport() {
  const { incoming, added, dup } = parseFavImport(favImportText.value.trim());
  if (!incoming.length) {
    showFavMsg('分享码无效或没有可导入的内容');
    return;
  }
  if (!added.length) {
    showFavMsg('分享内容已全部存在，无需导入');
    return;
  }
  // 当前列表保持原顺序在前，新增项按分享码顺序追加在后
  const ok = await saveFavorites([...favoriteCommands.value, ...added]);
  if (ok) {
    favImporting.value = false;
    favImportText.value = '';
    showFavMsg(`已导入 ${added.length} 条${dup.length ? `（跳过 ${dup.length} 条重复）` : ''}`);
  }
}

// 点击常用指令：编辑态→把该项载入下方表单重新编辑；非编辑态→emit 交给父级发送（任意文本、未必是指令）
function onFavoriteClick(item, evt) {
  if (favEditing.value) {
    startFavEdit(item, evt);
  } else {
    // 原实现是直接走 socket 发送（与输入框发送完全一致，含本地回显）；
    // 「有没有连接、发不出去时退回填输入框」属于父级状态，这里只把内容交出去。
    emit('send', item.cmd);
  }
}

// 每个实例自带列表数据：挂载即拉一次，宿主（ChatView 侧栏 / 手机抽屉 / 全局「我的」抽屉）
// 无需各自记得调用，多个实例并存时也各有一份可用列表。ChatView 仍可在指令列表就绪后再刷新一次。
onMounted(loadFavorites);

// 供父级主动触发拉取（ChatView 里 `favRef.value?.loadFavorites()`）
defineExpose({ loadFavorites });
</script>
