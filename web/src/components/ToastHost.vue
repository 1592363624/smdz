<template>
  <!-- 全局轻提示容器：固定在右上角，移动端贴顶居中；aria-live 让读屏软件播报 -->
  <div class="toast-host" role="status" aria-live="polite">
    <transition-group name="toast">
      <div
        v-for="t in ui.toasts"
        :key="t.id"
        class="toast"
        :class="'toast-' + t.type"
        @click="ui.removeToast(t.id)"
        role="alert"
      >
        <span class="toast-icon" aria-hidden="true">{{ iconOf(t.type) }}</span>
        <div class="toast-body">
          <div v-if="t.title" class="toast-title">{{ t.title }}</div>
          <div class="toast-msg">{{ t.message }}</div>
        </div>
        <button class="toast-close" aria-label="关闭" @click.stop="ui.removeToast(t.id)">✕</button>
      </div>
    </transition-group>
  </div>
</template>

<script setup>
import { useUiStore } from '../stores/ui';

const ui = useUiStore();

function iconOf(type) {
  return { success: '✅', error: '⛔', warning: '⚠️', info: 'ℹ️' }[type] || 'ℹ️';
}
</script>

<style scoped>
.toast-host {
  position: fixed;
  top: calc(14px + var(--safe-top, 0px));
  right: 14px;
  z-index: 9998;
  display: flex;
  flex-direction: column;
  gap: 10px;
  pointer-events: none; /* 容器不拦截，仅 toast 自身可点 */
  max-width: min(360px, calc(100vw - 28px));
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 12px;
  border-radius: 12px;
  background: rgba(20, 16, 42, 0.92);
  border: 1px solid var(--glass-border, rgba(139, 92, 246, 0.25));
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text, #f1f1f9);
}
.toast-icon {
  font-size: 15px;
  line-height: 1.4;
  flex-shrink: 0;
}
.toast-body {
  flex: 1;
  min-width: 0;
}
.toast-title {
  font-weight: 700;
  margin-bottom: 2px;
}
.toast-msg {
  color: var(--text-secondary, #c8c8e0);
  word-break: break-word;
}
.toast-close {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--muted, #a0a0c0);
  cursor: pointer;
  font-size: 12px;
  line-height: 1.4;
  padding: 0 2px;
}
.toast-close:hover {
  color: var(--text);
}
/* 语义色左边框 */
.toast-success { border-left: 3px solid var(--success, #22c55e); }
.toast-error { border-left: 3px solid var(--danger, #ef4444); }
.toast-warning { border-left: 3px solid var(--warning, #eab308); }
.toast-info { border-left: 3px solid var(--info, #3b82f6); }

/* 进出场动画 */
.toast-enter-active,
.toast-leave-active {
  transition: all 0.28s cubic-bezier(0.4, 0, 0.2, 1);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
.toast-leave-active {
  position: absolute;
}

/* 移动端：贴顶居中，避免与右侧按钮重叠 */
@media (max-width: 480px) {
  .toast-host {
    top: calc(8px + var(--safe-top, 0px));
    left: 8px;
    right: 8px;
    max-width: none;
    align-items: stretch;
  }
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>
