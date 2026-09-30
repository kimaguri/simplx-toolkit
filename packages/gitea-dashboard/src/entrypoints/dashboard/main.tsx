import { createRoot } from 'react-dom/client';
import '../../styles/globals.css';
import { applySystemTheme } from '../../lib/theme';
import { App } from './App';
import { RepoColorsProvider } from '../../features/repos/RepoColorsProvider';

applySystemTheme();
createRoot(document.getElementById('app')!).render(
  <RepoColorsProvider>
    <App />
  </RepoColorsProvider>
);
