/**
 * 前端路由配置
 * 定义各页面路径、组件与访问权限（需要登录/需要管理员）。
 */
import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../views/LoginView.vue';
import OnboardView from '../views/OnboardView.vue';
import ChatView from '../views/ChatView.vue';
import HomeView from '../views/HomeView.vue';
import AdminView from '../views/AdminView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/login', name: 'login', component: LoginView },
    { path: '/onboard', name: 'onboard', component: OnboardView, meta: { requiresAuth: true } },
    { path: '/chat', name: 'chat', component: ChatView, meta: { requiresAuth: true } },
    // 家园院子：QQ 农场式格子视图独立页面（侧栏空间不足，单独开一屏）
    { path: '/home', name: 'home', component: HomeView, meta: { requiresAuth: true } },
    { path: '/admin', name: 'admin', component: AdminView, meta: { requiresAuth: true, requiresAdmin: true } },
  ],
});

router.beforeEach((to) => {
  const token = localStorage.getItem('token');
  if (to.meta.requiresAuth && !token) return { name: 'login' };
  if (to.name === 'login' && token) return { name: 'chat' };
  return true;
});
export default router;
