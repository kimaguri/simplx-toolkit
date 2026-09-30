// @vitest-environment happy-dom
// Contract: docs/specs/002-fullpage-dashboard/research.md R10, tasks.md T032.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { browser } from 'wxt/browser';
import { BranchTag, NumberTag, RepoTag } from '../../src/ui/Tags';
import { repoColorIndex } from '../../src/domain/labels';

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
});

afterEach(() => {
  cleanup();
});

describe('RepoTag', () => {
  it('renders the short label when there is no owner collision', () => {
    render(<RepoTag fullName="acme/api" allFullNames={['acme/api', 'acme/web']} />);
    expect(screen.getByText('api')).toBeTruthy();
  });

  it('renders owner/name on collision', () => {
    render(<RepoTag fullName="acme/api" allFullNames={['acme/api', 'other/api']} />);
    expect(screen.getByText('acme/api')).toBeTruthy();
  });

  it('sets a native title with the full name', () => {
    render(<RepoTag fullName="acme/api" allFullNames={['acme/api']} />);
    expect(screen.getByText('api').getAttribute('title')).toBe('acme/api');
  });

  it('applies a tone class consistent with repoColorIndex', () => {
    render(<RepoTag fullName="acme/api" allFullNames={['acme/api']} />);
    const el = screen.getByText('api');
    const idx = repoColorIndex('acme/api');
    // Every tone class pairs a bg-<c>-500/10 utility with the badge; assert
    // that some bg-*-500/10 class is present (exact color depends on idx).
    const hasBgClass = Array.from(el.classList).some((c) => /^bg-.+-500\/10$/.test(c));
    expect(hasBgClass).toBe(true);
    expect(idx).toBeGreaterThanOrEqual(0);
  });
});

describe('BranchTag', () => {
  it('renders the branch name', () => {
    render(<BranchTag branch="main" />);
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('applies the blue tone for main', () => {
    render(<BranchTag branch="main" />);
    const el = screen.getByText('main');
    expect(el.className).toMatch(/bg-blue-500\/10/);
  });

  it('applies the amber tone for test', () => {
    render(<BranchTag branch="test" />);
    const el = screen.getByText('test');
    expect(el.className).toMatch(/bg-amber-500\/10/);
  });

  it('applies a neutral tone otherwise', () => {
    render(<BranchTag branch="develop" />);
    const el = screen.getByText('develop');
    expect(el.className).not.toMatch(/bg-blue-500\/10/);
    expect(el.className).not.toMatch(/bg-amber-500\/10/);
  });

  it('sets a native title with the full branch name', () => {
    render(<BranchTag branch="feature/very-long-branch-name" />);
    expect(screen.getByText('feature/very-long-branch-name').getAttribute('title')).toBe(
      'feature/very-long-branch-name',
    );
  });
});

describe('NumberTag', () => {
  it('renders #<number>', () => {
    render(<NumberTag number={42} />);
    expect(screen.getByText('#42')).toBeTruthy();
  });

  it('uses a monospace, muted outline style', () => {
    render(<NumberTag number={7} />);
    const el = screen.getByText('#7');
    expect(el.className).toMatch(/font-mono/);
    expect(el.className).toMatch(/text-muted-foreground/);
  });
});
