// Contract: docs/specs/002-fullpage-dashboard/data-model.md PageRoute/PrTableFilter/
// RunHistoryFilter, research.md R2 ("свой маленький парсер/сериализатор на
// URLSearchParams, без роутер-библиотеки"),
// docs/specs/002-fullpage-dashboard/tasks.md T003.
import { describe, expect, it } from 'vitest';
import {
  parseRoute,
  prTableFilterFromParams,
  prTableFilterToParams,
  runHistoryFilterFromParams,
  runHistoryFilterToParams,
  serializeRoute,
  type PageRoute,
} from '../../src/domain/route';

describe('parseRoute', () => {
  it('parses a bare section with no query', () => {
    const route = parseRoute('#/repos', 'prs');
    expect(route.section).toBe('repos');
    expect(route.view).toBeUndefined();
    expect(route.params.toString()).toBe('');
  });

  it('parses #/prs?view=table&... (repeated repo/ci, draft, sort, q)', () => {
    const route = parseRoute(
      '#/prs?view=table&repo=a/b&repo=c/d&ci=failure&draft=only&sort=updated:desc&q=x',
      'repos',
    );
    expect(route.section).toBe('prs');
    expect(route.view).toBe('table');
    expect(route.params.getAll('repo')).toEqual(['a/b', 'c/d']);
    expect(route.params.getAll('ci')).toEqual(['failure']);
    expect(route.params.get('draft')).toBe('only');
    expect(route.params.get('sort')).toBe('updated:desc');
    expect(route.params.get('q')).toBe('x');
  });

  it('parses #/builds?view=history&period=30d&wf=ci.yml&mine=1', () => {
    const route = parseRoute('#/builds?view=history&period=30d&wf=ci.yml&mine=1', 'prs');
    expect(route.section).toBe('builds');
    expect(route.view).toBe('history');
    expect(route.params.get('period')).toBe('30d');
    expect(route.params.get('wf')).toBe('ci.yml');
    expect(route.params.get('mine')).toBe('1');
  });

  it('falls back to prs for an unknown section, ignoring the fallback argument', () => {
    expect(parseRoute('#/nonsense', 'repos').section).toBe('prs');
    expect(parseRoute('#/nonsense?x=1', 'builds').section).toBe('prs');
  });

  it('uses the fallback argument for an empty hash', () => {
    expect(parseRoute('', 'builds').section).toBe('builds');
    expect(parseRoute('#', 'repos').section).toBe('repos');
    expect(parseRoute('#/', 'prs').section).toBe('prs');
  });

  it('drops an unknown view value', () => {
    const route = parseRoute('#/prs?view=nonsense', 'prs');
    expect(route.view).toBeUndefined();
  });

  it('T050: ignores the legacy view=groups (view undefined, no throw)', () => {
    const r = parseRoute('#/prs?view=groups', 'repos');
    expect(r.section).toBe('prs');
    expect(r.view).toBeUndefined();
  });

  it('preserves the order of repeated params', () => {
    const route = parseRoute('#/prs?repo=z/z&repo=a/a&repo=m/m', 'prs');
    expect(route.params.getAll('repo')).toEqual(['z/z', 'a/a', 'm/m']);
  });
});

describe('serializeRoute', () => {
  it('produces a hash starting with #/<section>', () => {
    const route: PageRoute = { section: 'repos', params: new URLSearchParams() };
    expect(serializeRoute(route)).toBe('#/repos');
  });

  it('includes the query string when params are present', () => {
    const route: PageRoute = {
      section: 'prs',
      view: 'table',
      params: new URLSearchParams('view=table&q=x'),
    };
    const serialized = serializeRoute(route);
    expect(serialized.startsWith('#/prs?')).toBe(true);
    expect(serialized).toContain('q=x');
  });

  it('round-trips: parse(serialize(parse(hash))) === parse(hash)', () => {
    const original =
      '#/prs?view=table&repo=a/b&repo=c/d&ci=failure&draft=only&sort=updated:desc&q=x';
    const first = parseRoute(original, 'repos');
    const again = parseRoute(serializeRoute(first), 'repos');
    expect(again.section).toBe(first.section);
    expect(again.view).toBe(first.view);
    expect(again.params.toString()).toBe(first.params.toString());
  });

  it('round-trips a repo value containing a slash', () => {
    const first = parseRoute('#/prs?repo=owner/name', 'prs');
    const again = parseRoute(serializeRoute(first), 'prs');
    expect(again.params.getAll('repo')).toEqual(['owner/name']);
  });
});

describe('prTableFilterFromParams / toParams', () => {
  it('reads repeated repo/author/ci, draft, conflict, q, sort', () => {
    const params = new URLSearchParams(
      'repo=a/b&repo=c/d&author=alice&ci=failure&ci=pending&draft=only&conflict=only&q=hi&sort=title:asc',
    );
    const filter = prTableFilterFromParams(params);
    expect(filter.repo).toEqual(['a/b', 'c/d']);
    expect(filter.author).toEqual(['alice']);
    expect(filter.ci).toEqual(['failure', 'pending']);
    expect(filter.draft).toBe('only');
    expect(filter.conflict).toBe('only');
    expect(filter.q).toBe('hi');
    expect(filter.sort).toEqual({ column: 'title', direction: 'asc' });
  });

  it('defaults to sort updated:desc when sort is absent', () => {
    const filter = prTableFilterFromParams(new URLSearchParams());
    expect(filter.sort).toEqual({ column: 'updated', direction: 'desc' });
    expect(filter.repo).toEqual([]);
    expect(filter.draft).toBeUndefined();
    expect(filter.conflict).toBeUndefined();
    expect(filter.q).toBe('');
  });

  it('drops invalid ci/draft/conflict/sort values instead of throwing', () => {
    const params = new URLSearchParams(
      'ci=bogus&ci=failure&draft=maybe&conflict=maybe&sort=bogus',
    );
    const filter = prTableFilterFromParams(params);
    expect(filter.ci).toEqual(['failure']);
    expect(filter.draft).toBeUndefined();
    expect(filter.conflict).toBeUndefined();
    expect(filter.sort).toEqual({ column: 'updated', direction: 'desc' });
  });

  it('silently ignores a legacy group= param (no group key, not re-serialized)', () => {
    const filter = prTableFilterFromParams(new URLSearchParams('group=mine&group=review&repo=a/b'));
    expect('group' in filter).toBe(false);
    expect(filter.repo).toEqual(['a/b']);
    expect(prTableFilterToParams(filter).has('group')).toBe(false);
  });

  it('drops a sort with an invalid direction', () => {
    const filter = prTableFilterFromParams(new URLSearchParams('sort=title:sideways'));
    expect(filter.sort).toEqual({ column: 'updated', direction: 'desc' });
  });

  it('round-trips through toParams', () => {
    const params = new URLSearchParams(
      'repo=a/b&repo=c/d&author=alice&ci=failure&draft=only&q=hi&sort=title:asc',
    );
    const filter = prTableFilterFromParams(params);
    const again = prTableFilterFromParams(prTableFilterToParams(filter));
    expect(again).toEqual(filter);
  });

  it('round-trips a repo value containing a slash through toParams', () => {
    const filter = prTableFilterFromParams(new URLSearchParams('repo=owner/name'));
    const roundTripped = prTableFilterFromParams(prTableFilterToParams(filter));
    expect(roundTripped.repo).toEqual(['owner/name']);
  });
});

describe('runHistoryFilterFromParams / toParams', () => {
  it('reads period, repeated repo/wf/branch/event/result, mine, sort', () => {
    const params = new URLSearchParams(
      'period=30d&repo=a/b&wf=ci.yml&branch=main&event=push&result=failure&result=success&mine=1&sort=duration:asc',
    );
    const filter = runHistoryFilterFromParams(params);
    expect(filter.period).toBe('30d');
    expect(filter.repo).toEqual(['a/b']);
    expect(filter.wf).toEqual(['ci.yml']);
    expect(filter.branch).toEqual(['main']);
    expect(filter.event).toEqual(['push']);
    expect(filter.result).toEqual(['failure', 'success']);
    expect(filter.mine).toBe(true);
    expect(filter.sort).toEqual({ column: 'duration', direction: 'asc' });
  });

  it('defaults to period today, sort started:desc, mine false', () => {
    const filter = runHistoryFilterFromParams(new URLSearchParams());
    expect(filter.period).toBe('today');
    expect(filter.sort).toEqual({ column: 'started', direction: 'desc' });
    expect(filter.mine).toBe(false);
    expect(filter.result).toEqual([]);
  });

  it('kind defaults to builds; kind=all selects all runs; junk falls back to builds', () => {
    expect(runHistoryFilterFromParams(new URLSearchParams()).kind).toBe('builds');
    expect(runHistoryFilterFromParams(new URLSearchParams('kind=all')).kind).toBe('all');
    expect(runHistoryFilterFromParams(new URLSearchParams('kind=zzz')).kind).toBe('builds');
  });

  it('serializes kind only when it is all', () => {
    const all = runHistoryFilterToParams(runHistoryFilterFromParams(new URLSearchParams('kind=all')));
    expect(all.get('kind')).toBe('all');
    const builds = runHistoryFilterToParams(runHistoryFilterFromParams(new URLSearchParams()));
    expect(builds.has('kind')).toBe(false);
  });

  it('accepts period=today', () => {
    expect(runHistoryFilterFromParams(new URLSearchParams('period=today')).period).toBe('today');
  });

  it('drops an invalid period, result value and sort instead of throwing', () => {
    const params = new URLSearchParams('period=1y&result=bogus&result=success&sort=nonsense');
    const filter = runHistoryFilterFromParams(params);
    expect(filter.period).toBe('today');
    expect(filter.result).toEqual(['success']);
    expect(filter.sort).toEqual({ column: 'started', direction: 'desc' });
  });

  it('treats mine values other than "1" as false', () => {
    expect(runHistoryFilterFromParams(new URLSearchParams('mine=true')).mine).toBe(false);
    expect(runHistoryFilterFromParams(new URLSearchParams('mine=0')).mine).toBe(false);
  });

  it('round-trips through toParams', () => {
    const params = new URLSearchParams(
      'period=30d&repo=a/b&wf=ci.yml&branch=main&event=push&result=failure&mine=1&sort=duration:asc',
    );
    const filter = runHistoryFilterFromParams(params);
    const again = runHistoryFilterFromParams(runHistoryFilterToParams(filter));
    expect(again).toEqual(filter);
  });
});
