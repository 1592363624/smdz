<template>
  <div class="log-viewer">
    <div class="toolbar">
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
        <input
          v-model="keywordInput"
          placeholder="过滤关键字（回车生效）"
          @keyup.enter="applyKeyword"
        />
      </label>
      <label class="field checkbox">
        <input v-model="autoFollow" type="checkbox" />
        <span>自动刷新（3s 跟随新增）</span>
      </label>
      <button class="btn" @click="reload">刷新</button>
      <button class="btn" @click="copyAll" :disabled="lines.length === 0">复制</button>
    </div>

    <div class="meta" v-if="meta.file">
      <span>{{ meta.file }}</span>
      <span>文件大小 {{ formatSize(meta.size) }}</span>
      <span>命中 {{ meta.matched }} 行<template v-if="meta.truncated">（仅显示末尾 {{ limit }} 行）</template></span>
      <span v-if="error" class="err">{{ error }}</span>
    </div>

    <div class="log-box" ref="box">
      <div v-if="lines.length === 0" class="empty">暂无日志内容</div>
      <div v-for="(line, i) in lines" :key="i" class="log-line" :class="lineClass(line)">
        <!-- 按终端风格分段着色：时间戳 / 级别 / 上下文 / 消息 -->
        <span v-for="(seg, j) in parseSegments(line)" :key="j" :class="seg.cls">{{ seg.text }}</span>
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
 */
import { adminApi } from '../../api';

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
        this.meta = { file: d.file, size: d.size, matched: d.matched, truncated: d.truncated };
        this.offset = d.offset || 0;
        this.error = '';
        if (follow && this.offset > 0 && this.lines.length > 0 && d.lines?.length) {
          // 跟随模式：追加新增行，保留窗口上限
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
      // 整行只做底色提示（错误红 / 警告黄），文字颜色由分段着色控制
      const u = String(line).toUpperCase();
      if (u.includes('ERROR') || u.includes('FATAL')) return 'lv-error';
      if (u.includes('WARN')) return 'lv-warn';
      if (u.includes('DEBUG')) return 'lv-debug';
      return '';
    },
    /**
     * 把一行日志拆解为带样式类的分段，模拟终端（NestJS/pm2）的彩色输出。
     * 识别顺序：时间戳 → [Nest] pid 前缀 → 级别 → [上下文] → 消息（尾部的 +xxms 弱化）。
     * 未匹配到的部分按普通文本输出，保证任意格式日志都不会丢失内容。
     * @param {string} line 原始日志行
     * @returns {Array<{text: string, cls: string}>} 分段数组
     */
    parseSegments(line) {
      const segs = [];
      let rest = String(line);
      const push = (text, cls) => {
        if (text) segs.push({ text, cls });
      };

      // 1. 时间戳：2026/09/13 13:58:45 或 2026-09-13T13:58:45.123Z 等
      let m = rest.match(/^\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?Z?)\s*/);
      if (m) {
        push(m[1], 'seg-time');
        rest = rest.slice(m[0].length);
      }

      // 2. pm2/Nest 管道前缀：[Nest] 22080  -
      m = rest.match(/^(\[Nest\]\s*\d+\s*-\s*)/i);
      if (m) {
        push(m[1], 'seg-dim');
        rest = rest.slice(m[0].length);
      }

      // 3. 级别标记：LOG/ERROR/WARN/DEBUG/FATAL/VERBOSE/INFO
      m = rest.match(/^\s*(ERROR|FATAL|WARN(?:ING)?|DEBUG|VERBOSE|INFO|LOG)\b\s*/);
      if (m) {
        const lv = m[1] === 'WARNING' ? 'WARN' : m[1];
        push(m[1], 'seg-lv seg-lv-' + lv.toLowerCase());
        rest = rest.slice(m[0].length);
      }

      // 4. 上下文：紧随级别后的 [XxxService] / [RouterExplorer] 等
      m = rest.match(/^(\[[^\]]+\])\s*/);
      if (m) {
        push(m[1], 'seg-context');
        rest = rest.slice(m[0].length);
      }

      // 5. 剩余消息；末尾的 NestJS 耗时标记（+6ms / +2s）弱化显示
      m = rest.match(/^(.*?)(\s*\+\d+m?s\s*)$/);
      if (m) {
        push(m[1], '');
        push(m[2], 'seg-dim');
      } else {
        push(rest, '');
      }
      return segs;
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
        await navigator.clipboard.writeText(this.lines.join('\n'));
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
  gap: 8px;
  min-height: 0;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.field {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim, #9aa4b2);
}
.field.grow { flex: 1; min-width: 160px; }
.field input[type='text'], .field input:not([type]), .field select {
  background: var(--bg-input, #1d2430);
  color: var(--text-main, #dbe2ea);
  border: 1px solid var(--border, #2c3644);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
}
.field.grow input { width: 100%; }
.checkbox { gap: 6px; cursor: pointer; }
.btn {
  background: var(--bg-input, #1d2430);
  color: var(--text-main, #dbe2ea);
  border: 1px solid var(--border, #2c3644);
  border-radius: 4px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
}
.btn:hover { border-color: var(--accent, #4a9eff); }
.btn:disabled { opacity: 0.5; cursor: default; }
.meta {
  display: flex;
  gap: 14px;
  font-size: 12px;
  color: var(--text-dim, #9aa4b2);
}
.meta .err { color: var(--danger, #ff6b6b); }
.log-box {
  flex: 1;
  min-height: 420px;
  max-height: 62vh;
  overflow: auto;
  background: var(--bg-input, #141a24);
  border: 1px solid var(--border, #2c3644);
  border-radius: 6px;
  padding: 8px 10px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.55;
  color: var(--text-main, #c8d2dc);
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line.lv-error { background: rgba(255, 90, 90, 0.08); }
.log-line.lv-warn { background: rgba(255, 200, 90, 0.06); }
.log-line.lv-debug { opacity: 0.85; }

/* —— 终端风格分段着色 —— */
.seg-time { color: #6f8fa8; }
.seg-dim { color: #5c6b7a; }
.seg-context { color: #e0c070; } /* 上下文（如 [ScheduleService]）用黄色，与 Nest 终端一致 */
.seg-lv { font-weight: 700; }
.seg-lv-log { color: #6ee07a; }    /* LOG 绿色 */
.seg-lv-info { color: #6ee07a; }
.seg-lv-error { color: #ff6b6b; }  /* ERROR 红色 */
.seg-lv-fatal { color: #ff4d4d; }  /* FATAL 加亮红 */
.seg-lv-warn { color: #ffcf70; }   /* WARN 黄色 */
.seg-lv-debug { color: #6bc1ff; }  /* DEBUG 蓝色 */
.seg-lv-verbose { color: #c792ea; }/* VERBOSE 紫色 */
.empty {
  color: var(--text-dim, #7f8b99);
  text-align: center;
  padding: 40px 0;
}
</style>
