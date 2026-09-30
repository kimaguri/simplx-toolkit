import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  toConnectionKind,
  toSnapshotErrorKind,
  type ApiErrorKind,
} from '../../src/domain/types';

describe('DEFAULT_SETTINGS', () => {
  it('matches data-model.md defaults', () => {
    expect(DEFAULT_SETTINGS.pollIntervalSec).toBe(60);
    expect(DEFAULT_SETTINGS.badgeMode).toBe('reviews');
    expect(DEFAULT_SETTINGS.recentWindowHours).toBe(24);
    expect(DEFAULT_SETTINGS.redBadgeWindowMin).toBe(30);
    expect(DEFAULT_SETTINGS.showOtherPrs).toBe(true);
    expect(DEFAULT_SETTINGS.repoModeLimit).toBe(30);
    expect(DEFAULT_SETTINGS.notify.buildFailed).toBe('mine');
    expect(DEFAULT_SETTINGS.notify.buildSucceededMyPr).toBe(false);
    expect(DEFAULT_SETTINGS.notify.reviewRequested).toBe(true);
    expect(DEFAULT_SETTINGS.notify.comments).toBe(false);
    expect(DEFAULT_SETTINGS.scope.excludeRepos).toEqual([]);
    expect(DEFAULT_SETTINGS.scope.excludeOrgs).toEqual([]);
    expect(DEFAULT_SETTINGS.scope.includeRepos).toEqual([]);
  });
});

describe('toSnapshotErrorKind', () => {
  it('maps unreachable to network', () => {
    expect(toSnapshotErrorKind('unreachable')).toBe('network');
  });
  it('maps not-json to server', () => {
    expect(toSnapshotErrorKind('not-json')).toBe('server');
  });
  it('maps not-found to server', () => {
    expect(toSnapshotErrorKind('not-found')).toBe('server');
  });
  it('maps auth to auth', () => {
    expect(toSnapshotErrorKind('auth')).toBe('auth');
  });
  it('maps forbidden to forbidden', () => {
    expect(toSnapshotErrorKind('forbidden')).toBe('forbidden');
  });
  it('maps server to server', () => {
    expect(toSnapshotErrorKind('server')).toBe('server');
  });

  it('covers every ApiErrorKind without throwing', () => {
    const kinds: ApiErrorKind[] = [
      'unreachable',
      'auth',
      'forbidden',
      'not-found',
      'server',
      'not-json',
    ];
    for (const kind of kinds) {
      expect(() => toSnapshotErrorKind(kind)).not.toThrow();
    }
  });
});

describe('toConnectionKind', () => {
  it('maps forbidden to scope', () => {
    expect(toConnectionKind('forbidden')).toBe('scope');
  });
  it('maps not-json to not-gitea', () => {
    expect(toConnectionKind('not-json')).toBe('not-gitea');
  });
  it('maps unreachable to unreachable', () => {
    expect(toConnectionKind('unreachable')).toBe('unreachable');
  });
  it('maps auth to auth', () => {
    expect(toConnectionKind('auth')).toBe('auth');
  });
  it('maps not-found to not-gitea', () => {
    expect(toConnectionKind('not-found')).toBe('not-gitea');
  });
  it('maps server to unreachable', () => {
    expect(toConnectionKind('server')).toBe('unreachable');
  });
});
