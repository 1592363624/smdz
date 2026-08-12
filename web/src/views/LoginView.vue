<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="game-title">使魔大战3 · 网页版</h1>
      <p class="subtitle">公屏群聊文字游戏 · 支持AstrBot机器人</p>

      <!-- 登录/注册切换 -->
      <div class="tabs">
        <button :class="['tab', mode === 'login' && 'active']" @click="switchMode('login')">登录</button>
        <button :class="['tab', mode === 'register' && 'active']" @click="switchMode('register')">注册</button>
      </div>

      <form class="form" @submit.prevent="handleSubmit">
        <label class="field">
          <span>用户名</span>
          <input v-model="username" placeholder="请输入用户名" required minlength="3" maxlength="20" />
        </label>
        <label class="field">
          <span>密码</span>
          <input v-model="password" type="password" placeholder="请输入密码" required minlength="6" />
        </label>
        <!-- 注册时显示确认密码字段 -->
        <label v-if="mode === 'register'" class="field">
          <span>确认密码</span>
          <input v-model="confirmPassword" type="password" placeholder="再次输入密码" required minlength="6" />
        </label>
        <label v-if="mode === 'register'" class="field">
          <span>昵称(可选)</span>
          <input v-model="nickname" placeholder="游戏内显示的名字" maxlength="20" />
        </label>

        <!-- 错误提示 -->
        <transition name="fade">
          <p v-if="error" class="error">{{ error }}</p>
        </transition>

        <button class="submit-btn" type="submit" :disabled="loading">
          {{ loading ? '处理中...' : mode === 'login' ? '登录' : '注册并进入' }}
        </button>
      </form>

      <!-- QQ 登录分隔线 -->
      <div class="divider">
        <span class="divider-line"></span>
        <span class="divider-text">或</span>
        <span class="divider-line"></span>
      </div>

      <!-- QQ 登录按钮 -->
      <button
        class="qq-login-btn"
        :disabled="qqLoading"
        @click="qqLogin"
        :title="qqConfigured ? '使用QQ账号登录' : 'QQ登录未配置（需设置 QQ_APP_ID）'"
      >
        <svg class="qq-icon" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
        </svg>
        <span>{{ qqLoading ? '跳转中...' : 'QQ 登录' }}</span>
      </button>

      <p class="tip">提示：指令以 / 或 ！ 开头，如「/info」查看信息</p>
    </div>
  </div>
</template>

<script setup>
/**
 * 登录/注册页面（增强版）
 * - 支持登录和注册模式切换
 * - 注册时需确认密码，防止输错
 * - 登录后自动获取用户信息并跳转至聊天页
 * - 支持 QQ OAuth2 登录，回调后自动完成登录
 */
import { ref, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { authApi, userApi } from '../api';
import { API_BASE } from '../config';

const router = useRouter();
const route = useRoute();
const mode = ref('login');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');
const nickname = ref('');
const loading = ref(false);
const error = ref('');
const qqLoading = ref(false);
const qqConfigured = ref(false);

// 组件挂载时：检查 QQ 登录是否已配置，并处理 QQ 回调参数
onMounted(async () => {
  // 检查 QQ 登录是否已配置
  try {
    const res = await fetch(`${API_BASE}/auth/qq/status`);
    const data = await res.json();
    qqConfigured.value = data.data?.configured === true;
  } catch {
    qqConfigured.value = false;
  }

  // 处理 QQ 登录回调（从 URL 参数中获取 token 和用户信息）
  const qqToken = route.query.qq_token;
  const qqUserStr = route.query.qq_user;
  if (qqToken && qqUserStr) {
    try {
      // 保存 token 和用户信息
      localStorage.setItem('token', qqToken);
      const qqUser = JSON.parse(decodeURIComponent(qqUserStr));
      localStorage.setItem('user', JSON.stringify(qqUser));
      // 自动跳转到聊天页
      router.push('/chat');
    } catch (e) {
      error.value = 'QQ 登录处理失败，请重试';
    }
  }

  // 处理 QQ 登录错误
  if (route.query.error === 'qq_auth_failed') {
    error.value = 'QQ 登录失败，请重试';
  }
});

// 切换模式时清空错误和输入
function switchMode(newMode) {
  mode.value = newMode;
  error.value = '';
  confirmPassword.value = '';
}

async function handleSubmit() {
  // 清除之前的错误
  error.value = '';
  loading.value = true;

  try {
    // 注册模式下校验密码一致性
    if (mode.value === 'register') {
      if (password.value !== confirmPassword.value) {
        error.value = '两次输入的密码不一致';
        loading.value = false;
        return;
      }
      await authApi.register({
        username: username.value,
        password: password.value,
        nickname: nickname.value || undefined,
      });
    }

    // 登录获取 token
    const res = await authApi.login({
      username: username.value,
      password: password.value,
    });
    localStorage.setItem('token', res.data.access_token);

    // 通过 /users/me 获取包含角色等完整信息
    const me = await userApi.me();
    localStorage.setItem('user', JSON.stringify(me.data));
    router.push('/chat');
  } catch (e) {
    error.value = e.response?.data?.message || e.message || '操作失败';
  } finally {
    loading.value = false;
  }
}

/**
 * QQ 登录：跳转到 QQ 授权页面
 */
function qqLogin() {
  if (!qqConfigured.value) {
    error.value = 'QQ 登录尚未配置，请联系管理员设置 QQ_APP_ID 和 QQ_APP_KEY';
    return;
  }
  qqLoading.value = true;
  // 跳转到后端 QQ 授权入口
  window.location.href = `${API_BASE}/auth/qq/login`;
}
</script>

<style scoped>
/* 分隔线 */
.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 16px;
}
.divider-line {
  flex: 1;
  height: 1px;
  background: var(--glass-border);
}
.divider-text {
  color: var(--muted);
  font-size: 13px;
}

/* QQ 登录按钮 - 逆流次元风格 */
.qq-login-btn {
  width: 100%;
  padding: 10px 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(10, 10, 26, 0.6);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.25s ease;
  position: relative;
  overflow: hidden;
}
.qq-login-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, rgba(18, 183, 245, 0.05), transparent);
  pointer-events: none;
}
.qq-login-btn:hover:not(:disabled) {
  border-color: rgba(18, 183, 245, 0.4);
  background: rgba(18, 183, 245, 0.08);
  box-shadow: 0 0 16px rgba(18, 183, 245, 0.15);
  transform: translateY(-1px);
}
.qq-login-btn:active:not(:disabled) {
  transform: translateY(0);
}
.qq-login-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.qq-icon {
  width: 20px;
  height: 20px;
  color: #12b7f5;
  filter: drop-shadow(0 0 4px rgba(18, 183, 245, 0.3));
}

/* 错误提示淡入淡出动画 */
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s ease;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}
</style>