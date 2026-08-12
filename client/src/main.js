import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { createAppRouter } from './router.js';
import './style.css';

const app = createApp(App);
app.use(createPinia());
app.use(createAppRouter());
app.mount('#app');
