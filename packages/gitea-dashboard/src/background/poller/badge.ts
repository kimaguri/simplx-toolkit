// Applies the toolbar badge (browser.action) from the current
// settings/snapshot. Not a poll `Section` (it has no Snapshot fields of its
// own to contribute) — called directly by src/entrypoints/background.ts
// after every poll cycle and on `settings-changed` (FR-050/FR-051).
// Design: docs/specs/001-gitea-dashboard/data-model.md "Бейдж".

import { browser } from 'wxt/browser';
import { badgeFor } from '../../domain/badge';
import type { Settings, Snapshot } from '../../domain/types';

export async function applyBadge(
  settings: Settings,
  snapshot: Snapshot | null,
  now: Date
): Promise<void> {
  const badge = badgeFor(settings, snapshot, now);
  await Promise.all([
    browser.action.setBadgeText({ text: badge.text }),
    browser.action.setBadgeBackgroundColor({ color: badge.color }),
  ]);
}
