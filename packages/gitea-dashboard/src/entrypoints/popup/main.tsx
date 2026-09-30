import { createRoot } from 'react-dom/client';
import '../../styles/popup.css';
import { applySystemTheme } from '../../lib/theme';
import { App } from './App';

applySystemTheme();
createRoot(document.getElementById('app')!).render(<App />);
