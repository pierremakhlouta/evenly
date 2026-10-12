import './styles/main.css';
import { APP_NAME } from './config';

const app = document.querySelector<HTMLElement>('#app');
if (!app) throw new Error('Missing #app element');

app.innerHTML = `
  <section class="card">
    <h1>${APP_NAME}</h1>
    <p class="muted">Shared bills, kept even. Coming soon.</p>
  </section>
`;
