import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  alias: {
    '@': path.resolve(__dirname, 'src'),
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  hooks: {
    // T081: a local tooling plugin (claude-mem) writes stray `CLAUDE.md`
    // files into public/** directories; never let them ship in the build.
    'build:publicAssets': (_wxt, files) => {
      const kept = files.filter((file) => {
        const src = 'absoluteSrc' in file ? file.absoluteSrc : file.relativeDest;
        return (
          path.basename(src) !== 'CLAUDE.md' &&
          path.basename(file.relativeDest) !== 'CLAUDE.md'
        );
      });
      files.splice(0, files.length, ...kept);
    },
  },
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'ru',
    permissions: ['storage', 'alarms', 'notifications'],
    host_permissions: [],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    action: {
      default_title: '__MSG_actionTitle__',
    },
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Alt+G',
          mac: 'Alt+G',
        },
      },
    },
    omnibox: {
      keyword: 'gt',
    },
    options_ui: {
      open_in_tab: true,
    },
  },
});
