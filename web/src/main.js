/**
 * 前端入口
 * 创建 Vue 应用，挂载路由。
 */
import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './styles.css';

const app = createApp(App);
app.use(router);
app.mount('#app');
