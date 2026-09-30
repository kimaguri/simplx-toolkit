// Typed messages between popup/options and the background service worker.
// Contract: docs/specs/001-gitea-dashboard/contracts/extension-surface.md
// "Сообщения окно/настройки → фон".

import type { ConnectionReport } from '../domain/types';

export type RefreshReason = 'popup-open' | 'manual';

export interface RefreshMessage {
  type: 'refresh';
  reason: RefreshReason;
}

export interface PopupHeartbeatMessage {
  type: 'popup-heartbeat';
  /**
   * T043: set only by the dashboard PAGE (visible tab). With active builds of
   * mine the background then also runs a light 5s `page-fast` cycle. The popup
   * never sets it, so its behaviour is unchanged.
   */
  page?: boolean;
}

export interface CheckConnectionMessage {
  type: 'check-connection';
  baseUrl: string;
  token: string;
  /**
   * Additive field (M5 review fix). Defaults to `true` when omitted, which
   * preserves the old "always persist as active" behavior. The Save flow's
   * auto-check sends `true`; the manual "Проверить подключение" button sends
   * `false` so probing an unsaved/different URL never hijacks
   * `activeInstanceId` away from the instance that actually has a token.
   */
  persist?: boolean;
}

export interface SettingsChangedMessage {
  type: 'settings-changed';
}

export type BackgroundMessage =
  | RefreshMessage
  | PopupHeartbeatMessage
  | CheckConnectionMessage
  | SettingsChangedMessage;

export interface RefreshResponse {
  ok: true;
}

export interface PopupHeartbeatResponse {
  /** How often (seconds, 15..20) the popup should send `popup-heartbeat`. */
  fastSec: number;
}

export interface SettingsChangedResponse {
  ok: true;
}

/** `check-connection` never echoes the token back (contract note). */
export type CheckConnectionResponse = ConnectionReport;

export type BackgroundResponse =
  | RefreshResponse
  | PopupHeartbeatResponse
  | SettingsChangedResponse
  | CheckConnectionResponse;

/** Narrows an unknown `runtime.onMessage` payload to a `BackgroundMessage`. */
export function isBackgroundMessage(value: unknown): value is BackgroundMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) {
    return false;
  }
  const type = (value as { type: unknown }).type;
  return (
    type === 'refresh' ||
    type === 'popup-heartbeat' ||
    type === 'check-connection' ||
    type === 'settings-changed'
  );
}
