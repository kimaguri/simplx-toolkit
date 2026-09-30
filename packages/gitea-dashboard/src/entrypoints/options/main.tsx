import { createRoot } from 'react-dom/client';
import '../../styles/globals.css';
import { applySystemTheme } from '../../lib/theme';
import { Options } from './Options';

applySystemTheme();
createRoot(document.getElementById('app')!).render(<Options />);
