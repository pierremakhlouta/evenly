import './styles/main.css';
import { configureRpc, rpcConfigFromEnv } from './api/rpc';
import { startApp } from './ui/app';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Missing #app element');

configureRpc(rpcConfigFromEnv());
startApp(root);
