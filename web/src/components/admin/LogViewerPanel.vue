<template>
  <div class="log-viewer">
    <div class="toolbar">
      <div class="toolbar-left">
        <label class="field">
          <span>文件</span>
          <select v-model="file" @change="reload">
            <option v-for="f in files" :key="f.name" :value="f.name">
              {{ f.name }}（{{ formatSize(f.size) }}）
            </option>
          </select>
        </label>
        <label class="field">
          <span>行数</span>
          <select v-model.number="limit" @change="reload">
            <option :value="100">100</option>
            <option :value="200">200</option>
            <option :value="500">500</option>
            <option :value="1000">1000</option>
          </select>
        </label>
        <label class="field">
          <span>级别</span>
          <select v-model="level" @change="reload">
            <option value="">全部</option>
            <option value="ERROR">ERROR</option>
            <option value="WARN">WARN</option>
            <option value="LOG">LOG</option>
            <option value="DEBUG">DEBUG</option>
          </select>
        </label>
        <label class="field grow">
          <span>关键字</span>
          <div class="search-wrap">
            <input
              v-model="keywordInput"
              placeholder="过滤关键字（回车生效）"
              @keyup.enter="applyKeyword"
            />
            <button v-if="keywordInput" class="clear-btn" title="清空" @click="clearKeyword">✕</button>
          </div>
        </label>
      </div>
      <div class="toolbar-right">
        <label class="field checkbox">
          <input v-model="colorize" type="checkbox" title="解析 ANSI 颜色码并高亮显示" />
          <span>彩色</span>
        </label>
        <label class="field checkbox">
          <input v-model="autoFollow" type="checkbox" title="每 3 秒拉取新增日志" />
          <span>自动跟随</span>
        </label>
        <button class="btn primary" @click="reload">刷新</button>
        <button class="btn" :disabled="lines.length === 0" @click="copyAll">复制</button>
      </div>
    </div>

    <div class="meta" v-if="meta.file">
      <span class="meta-file">{{ meta.file }}</span>
      <span>{{ formatSize(meta.size) }}</span>
      <span>
        命中 {{ meta.matched }} 行
        <template v-if="meta.truncated">（仅显示末尾 {{ limit }} 行）</template>
      </span>
      <span v-if="colorize" class="meta-tag">ANSI 已着色</span>
      <span v-if="error" class="err">{{ error }}</span>
    </div>

    <div class="log-box" ref="box">
      <div v-if="lines.length === 0" class="empty">
        <div class="empty-icon">📜</div>
        <div>暂无日志内容</div>
      </div>
      <div
        v-for="(line, i) in lines"
        :key="i"
        class="log-line"
        :class="lineClass(line)"
      >
        <span v-for="(seg, j) in renderSegs(line)" :key="j" :style="segStyle(seg)">{{ seg.text }}</span>
      </div>
    </div>
  </div>
</template>

<script>
/**
 * 后台日志查看面板（只读）
 * 数据源：GET /admin/logs/files + /admin/logs/tail（服务端目录白名单 + 路径穿越防护）。
 * - 手动模式：每次读取文件尾部 N 行；
 * - 跟随模式：以服务端返回的 offset 作为 since 增量轮询，只拉取新增内容。
 * - 彩色：解析 pm2/NestJS 落盘的 ANSI SGR 序列（含 16/256/真彩），映射为行内样式。
 */
import { adminApi } from '../../api';

/** Windows Terminal / cmd 默认 16 色（与 NestJS 在控制台里的观感一致） */
const ANSI16 = [
  '#0c0c0c', '#c50f1f', '#13a10e', '#c19c00',
  '#0037da', '#881798', '#3a96dd', '#cccccc',
  '#767676', '#e74856', '#16c60c', '#f9f1a5',
  '#3b78ff', '#b4009e', '#61d6d6', '#f2f2f2',
];

/** NestJS 结构着色（无 ANSI 时）：对齐 chalk 在 Windows 控制台的输出 */
const NEST = {
  green: '#16c60c',
  yellow: '#c19c00',
  red: '#e74856',
  dim: '#767676',
  text: '#cccccc',
};

/** 简易缓存：原行 → 分段结果（同一行重复渲染时避免重复解析） */
const parseCache = new Map();
const PARSE_CACHE_MAX = 2000;

function cacheParse(line, fn) {
  if (parseCache.size >= PARSE_CACHE_MAX) {
    const keys = parseCache.keys();
    for (let k = 0; k < PARSE_CACHE_MAX / 2; k++) parseCache.delete(keys.next().value);
  }
  if (parseCache.has(line)) return parseCache.get(line);
  const val = fn(line);
  parseCache.set(line, val);
  return val;
}

/** 256 色：0-15 系统色；16-231 立方；232-255 灰阶 */
function ansi256(n) {
  if (n < 16) return ANSI16[n];
  if (n >= 232) {
    const g = 8 + (n - 232) * 10;
    return '#' + g.toString(16).padStart(2, '0').repeat(3);
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const to = (c) => (c === 0 ? 0 : 55 + c * 40);
  return (
    '#' +
    [to(r), to(g), to(b)].map((v) => v.toString(16).padStart(2, '0')).join('')
  );
}

/**
 * 匹配 ANSI CSI SGR：
 * - 真实 ESC：\x1b[32m
 * - 护字符面量：^[[32m
 * - 损坏写法（ESC 被渲染成 @）：@[32m
 * 注意前缀只吃「引导符」，真正的 [ 留给后面的统一子模式。
 */
const ANSI_ANY = /(?:\x1b|\^\[|@)\[[0-9;:]*m/;

function parseAnsiLine(line) {
  const segs = [];
  let color = '';
  let bg = '';
  let bold = false;
  let underline = false;
  let dim = false;

  const push = (text) => {
    if (!text) return;
    segs.push({ text, color, bg, bold, underline, dim });
  };

  const applySgr = (params) => {
    const codes = params.split(';').map((p) => (p === '' ? 0 : Number(p)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = '';
        bg = '';
        bold = false;
        underline = false;
        dim = false;
      // 亮色变体：bold 时把暗色抬到亮色，接近 Windows Terminal 观感
      } else if (c === 1) {
        bold = true;
        if (color) {
          const di = ANSI16.indexOf(color);
          if (di >= 0 && di < 8) color = ANSI16[di + 8];
        }
      }
      else if (c === 2) dim = true;
      else if (c === 4) underline = true;
      else if (c === 22) {
        bold = false;
        dim = false;
      } else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) color = ANSI16[c - 30];
      else if (c === 39) color = '';
      else if (c >= 40 && c <= 47) bg = ANSI16[c - 40];
      else if (c === 49) bg = '';
      else if (c >= 90 && c <= 97) color = ANSI16[c - 90 + 8];
      else if (c >= 100 && c <= 107) bg = ANSI16[c - 100 + 8];
      else if (c === 38 || c === 48) {
        const isFg = c === 38;
        if (codes[i + 1] === 5 && i + 2 < codes.length) {
          const n = codes[i + 2];
          if (n >= 0 && n <= 255) {
            const hex = ansi256(n);
            if (isFg) color = hex;
            else bg = hex;
          }
          i += 2;
        } else if (codes[i + 1] === 2 && i + 4 < codes.length) {
          const r = codes[i + 2];
          const g = codes[i + 3];
          const b = codes[i + 4];
          const hex =
            '#' +
            [r, g, b]
              .map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0'))
              .join('');
          if (isFg) color = hex;
          else bg = hex;
          i += 4;
        }
      }
    }
  };

  // 引导符（ESC / ^[ / @）+ [ + 参数 + m
  const re = /(?:\x1b|\^\[|@)\[([0-9;:]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    push(line.slice(last, m.index));
    applySgr(m[1]);
    last = m.index + m[0].length;
  }
  push(line.slice(last));
  return segs;
}

/** 去掉 ANSI 序列后的纯文本（过滤/复制/结构识别用） */
function stripAnsi(line) {
  return String(line)
    .replace(/(?:\x1b|\^\[|@)\[[0-9;:]*m/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export default {
  name: 'LogViewerPanel',
  data() {
    return {
      files: [],
      file: 'out.log',
      limit: 200,
      level: '',
      keywordInput: '',
      keyword: '',
      autoFollow: false,
      colorize: true,
      lines: [],
      meta: { file: '', size: 0, matched: 0, truncated: false },
      offset: 0,
      error: '',
      timer: null,
      loading: false,
    };
  },
  async mounted() {
    await this.loadFiles();
    await this.reload();
  },
  beforeUnmount() {
    this.stopTimer();
  },
  watch: {
    autoFollow(on) {
      if (on) this.startTimer();
      else this.stopTimer();
    },
  },
  methods: {
    startTimer() {
      this.stopTimer();
      this.timer = setInterval(() => this.fetchTail(true), 3000);
    },
    stopTimer() {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    },
    async loadFiles() {
      try {
        const res = await adminApi.logFiles();
        this.files = res.data?.files || [];
        if (this.files.length && !this.files.some((f) => f.name === this.file)) {
          this.file = this.files[0].name;
        }
      } catch (e) {
        this.error = '日志文件列表获取失败：' + (e.response?.data?.message || e.message);
      }
    },
    applyKeyword() {
      this.keyword = this.keywordInput.trim();
      this.reload();
    },
    clearKeyword() {
      this.keywordInput = '';
      this.keyword = '';
      this.reload();
    },
    async reload() {
      this.offset = 0;
      this.lines = [];
      await this.fetchTail(false);
    },
    async fetchTail(follow) {
      if (this.loading) return;
      this.loading = true;
      try {
        const params = {
          file: this.file,
          lines: this.limit,
          keyword: this.keyword,
          level: this.level,
        };
        if (follow && this.offset > 0) params.since = this.offset;
        const res = await adminApi.logTail(params);
        const d = res.data || {};
        this.meta = {
          file: d.file,
          size: d.size,
          matched: d.matched,
          truncated: d.truncated,
        };
        this.offset = d.offset || 0;
        this.error = '';
        if (follow && this.offset > 0 && this.lines.length > 0 && d.lines?.length) {
          this.lines = this.lines.concat(d.lines).slice(-2000);
          this.scrollToBottom();
        } else {
          this.lines = d.lines || [];
          this.scrollToBottom();
        }
      } catch (e) {
        this.error = '日志读取失败：' + (e.response?.data?.message || e.message);
      } finally {
        this.loading = false;
      }
    },
    lineClass(line) {
      const u = stripAnsi(line).toUpperCase();
      if (u.includes('ERROR') || u.includes('FATAL')) return 'lv-error';
      if (u.includes('WARN') || u.includes('WARNING')) return 'lv-warn';
      if (u.includes('DEBUG') || u.includes('VERBOSE')) return 'lv-debug';
      return '';
    },
    renderSegs(line) {
      const raw = String(line);
      if (this.colorize && ANSI_ANY.test(raw)) {
        return cacheParse(raw, (l) => parseAnsiLine(l));
      }
      return cacheParse('plain:' + raw, () => this.structuralSegs(stripAnsi(raw)));
    },
    structuralSegs(rest) {
      const segs = [];
      const push = (text, style) => {
        if (text) segs.push({ text, ...style });
      };

      let m = rest.match(
        /^\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?Z?)\s*/,
      );
      if (m) {
        push(m[1], { color: NEST.green });
        rest = rest.slice(m[0].length);
      }

      m = rest.match(/^(\[Nest\]\s*\d+\s*-\s*)/i);
      if (m) {
        push(m[1], { color: NEST.green });
        rest = rest.slice(m[0].length);
      }

      m = rest.match(/^\s*(ERROR|FATAL|WARN(?:ING)?|DEBUG|VERBOSE|INFO|LOG)\b\s*/);
      if (m) {
        const lv = m[1] === 'WARNING' ? 'WARN' : m[1].toUpperCase();
        const colors = {
          LOG: NEST.green,
          INFO: NEST.green,
          ERROR: NEST.red,
          FATAL: NEST.red,
          WARN: NEST.yellow,
          DEBUG: NEST.yellow,
          VERBOSE: NEST.dim,
        };
        push(m[1], { color: colors[lv] || NEST.text, bold: true });
        rest = rest.slice(m[0].length);
      }

      m = rest.match(/^(\[[^\]]+\])\s*/);
      if (m) {
        push(m[1], { color: NEST.yellow });
        rest = rest.slice(m[0].length);
      }

      // LOG 行消息体用绿色；ERROR 用红色；其余默认灰白
      const lvNow = segs.find((s) => /^(ERROR|FATAL|WARN|DEBUG|LOG|INFO|VERBOSE)$/i.test(s.text.trim()));
      const lvKey = lvNow ? lvNow.text.trim().toUpperCase() : '';
      const body =
        lvKey === 'ERROR' || lvKey === 'FATAL'
          ? { color: NEST.red }
          : lvKey === 'WARN' || lvKey === 'WARNING'
            ? { color: NEST.yellow }
            : lvKey === 'LOG' || lvKey === 'INFO'
              ? { color: NEST.green }
              : { color: NEST.text };

      m = rest.match(/^(.*?)(\s*\+\d+m?s\s*)$/);
      if (m) {
        push(m[1], body);
        push(m[2], { color: NEST.dim });
      } else {
        push(rest, body);
      }
      return segs;
    },
    segStyle(seg) {
      const s = {};
      if (seg.color) s.color = seg.color;
      if (seg.bg) s.backgroundColor = seg.bg;
      if (seg.bold) s.fontWeight = '700';
      if (seg.underline) s.textDecoration = 'underline';
      if (seg.dim) s.opacity = '0.65';
      return s;
    },
    formatSize(n) {
      const v = Number(n) || 0;
      if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
      if (v >= 1024) return (v / 1024).toFixed(1) + ' KB';
      return v + ' B';
    },
    scrollToBottom() {
      this.$nextTick(() => {
        const box = this.$refs.box;
        if (box) box.scrollTop = box.scrollHeight;
      });
    },
    async copyAll() {
      try {
        await navigator.clipboard.writeText(this.lines.map(stripAnsi).join('\n'));
      } catch {
        // 剪贴板不可用时静默
      }
    },
  },
};
</script>

<style scoped>
.log-viewer {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}
.toolbar-left,
.toolbar-right {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted, #9aa4b2);
}
.field.grow {
  flex: 1;
  min-width: 180px;
}
.field input[type='text'],
.field input:not([type]),
.field select {
  background: rgba(10, 8, 26, 0.75);
  color: var(--text, #dbe2ea);
  border: 1px solid var(--border, #2c3644);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.field input:focus,
.field select:focus {
  border-color: var(--accent, #8b5cf6);
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.15);
}
.field.grow input {
  width: 100%;
}
.search-wrap {
  position: relative;
  flex: 1;
  min-width: 140px;
  display: flex;
  align-items: center;
}
.search-wrap input {
  width: 100%;
  padding-right: 26px !important;
}
.clear-btn {
  position: absolute;
  right: 6px;
  border: none;
  background: transparent;
  color: var(--muted-dark, #6b6b8a);
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  padding: 2px;
}
.clear-btn:hover {
  color: #f87171;
}
.checkbox {
  gap: 6px;
  cursor: pointer;
  user-select: none;
}
.checkbox input {
  accent-color: var(--accent, #8b5cf6);
  cursor: pointer;
}
.btn {
  background: rgba(10, 8, 26, 0.75);
  color: var(--text, #dbe2ea);
  border: 1px solid var(--border, #2c3644);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, color 0.15s;
  white-space: nowrap;
}
.btn:hover:not(:disabled) {
  border-color: var(--accent, #8b5cf6);
  color: #d4c4ff;
  background: rgba(139, 92, 246, 0.12);
}
.btn.primary {
  background: rgba(139, 92, 246, 0.22);
  border-color: rgba(139, 92, 246, 0.55);
  color: #e4d4ff;
}
.btn.primary:hover:not(:disabled) {
  background: rgba(139, 92, 246, 0.32);
}
.btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--muted, #9aa4b2);
  align-items: center;
}
.meta-file {
  color: var(--text, #dbe2ea);
  font-family: Consolas, 'Courier New', monospace;
  font-weight: 600;
}
.meta-tag {
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: rgba(34, 197, 94, 0.12);
  color: #4ade80;
  border: 1px solid rgba(34, 197, 94, 0.3);
}
.meta .err {
  color: #f87171;
  background: rgba(239, 68, 68, 0.1);
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid rgba(239, 68, 68, 0.35);
}
.log-box {
  flex: 1;
  min-height: 420px;
  max-height: 62vh;
  overflow: auto;
  /* 贴近 cmd / Windows Terminal 的纯黑底 */
  background: #0c0c0c;
  border: 1px solid var(--glass-border, rgba(139, 92, 246, 0.18));
  border-radius: 10px;
  padding: 12px 14px;
  font-family: Consolas, 'Cascadia Mono', 'Cascadia Code', 'Courier New', monospace;
  font-size: 14px;
  line-height: 1.55;
  color: #cccccc;
  white-space: pre-wrap;
  word-break: break-all;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
  scrollbar-width: thin;
  scrollbar-color: #2a2a2a transparent;
}
.log-line {
  padding: 0 4px;
  border-radius: 3px;
  border-left: 2px solid transparent;
}
.log-line:hover {
  background: rgba(255, 255, 255, 0.04);
}
.log-line.lv-error {
  background: rgba(197, 15, 31, 0.12);
  border-left-color: #c50f1f;
}
.log-line.lv-warn {
  background: rgba(193, 156, 0, 0.1);
  border-left-color: #c19c00;
}
.log-line.lv-debug {
  opacity: 0.9;
  border-left-color: #767676;
}
.empty {
  color: var(--muted-dark, #7f8b99);
  text-align: center;
  padding: 48px 0;
  font-size: 13px;
}
.empty-icon {
  font-size: 28px;
  margin-bottom: 8px;
  opacity: 0.7;
}
</style>
