import { describe, expect, test } from 'bun:test';

import { htmlToText, decodeEntitiesOnce } from '../src/ats/html.ts';
import { classifyRemote, isBrazilEligible } from '../src/ats/remote.ts';
import { adapters, fetchAll, fetchAllWithReport } from '../src/ats/index.ts';
import { greenhouseAdapter } from '../src/ats/greenhouse.ts';
import type { AtsType, NormalizedJob } from '../src/ats/types.ts';

const SKIP_NETWORK = Bun.env['SKIP_NETWORK_TESTS'] === '1';

/** Build a NormalizedJob for eligibility tests without restating every field. */
function makeJob(overrides: Partial<NormalizedJob> = {}): NormalizedJob {
  return {
    id: 'job-1',
    atsType: 'greenhouse',
    companyToken: 'acme',
    title: 'Senior Engineer',
    url: 'https://example.com/jobs/1',
    locationRaw: '',
    remotePolicy: 'unknown',
    descriptionText: '',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('htmlToText', () => {
  test('strips tags and keeps the text', () => {
    expect(htmlToText('<p>Hello <strong>world</strong></p>')).toBe('Hello world');
  });

  test('returns empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });

  test('converts <br> to a newline', () => {
    expect(htmlToText('Line one<br>Line two')).toBe('Line one\nLine two');
  });

  test('separates paragraphs with a blank line', () => {
    expect(htmlToText('<p>First</p><p>Second</p>')).toBe('First\n\nSecond');
  });

  test('prefixes list items with "- "', () => {
    const text = htmlToText('<ul><li>Alpha</li><li>Beta</li></ul>');
    expect(text).toBe('- Alpha\n- Beta');
  });

  test('collapses three or more blank lines down to two', () => {
    const text = htmlToText('A<br><br><br><br><br>B');
    expect(text).toBe('A\n\nB');
    expect(text).not.toContain('\n\n\n');
  });

  test('decodes the named entities the spec requires', () => {
    expect(htmlToText('a &amp; b')).toBe('a & b');
    expect(htmlToText('&quot;quoted&quot;')).toBe('"quoted"');
    expect(htmlToText("it&#39;s")).toBe("it's");
    expect(htmlToText("it&apos;s")).toBe("it's");
    expect(htmlToText('a&nbsp;b')).toBe('a b');
  });

  test('decodes &lt; and &gt; into literal text when real markup is present', () => {
    // Alongside real tags, escaped angle brackets are content, not markup.
    expect(htmlToText('<p>Use &lt;div&gt; to wrap</p>')).toBe('Use <div> to wrap');
  });

  test('treats a wholly escaped document as markup, per the Greenhouse contract', () => {
    // With no real tags in sight, "&lt;tag&gt;" is escaped markup and is stripped.
    // This is the behaviour Greenhouse ingest depends on.
    expect(htmlToText('&lt;p&gt;kept&lt;/p&gt;')).toBe('kept');
  });

  test('preserves a literal code sample inside escaped Greenhouse content', () => {
    // Double-escaped angle brackets are the author showing code to the reader;
    // one decode pass leaves them as text instead of eating them as a tag.
    const greenhouse = '&lt;p&gt;Wrap it in &amp;lt;div&amp;gt; first&lt;/p&gt;';
    expect(htmlToText(greenhouse)).toBe('Wrap it in <div> first');
  });

  test('decodes numeric and hex entities', () => {
    expect(htmlToText('don&#8217;t')).toBe('don’t');
    expect(htmlToText('don&#x2019;t')).toBe('don’t');
  });

  test('leaves an unknown entity untouched rather than destroying it', () => {
    expect(decodeEntitiesOnce('&notarealentity;')).toBe('&notarealentity;');
  });

  test('handles Greenhouse escaping: decodes entities before stripping tags', () => {
    // Exactly the shape boards-api.greenhouse.io returns: markup escaped once,
    // ampersands escaped twice.
    const greenhouse = '&lt;p&gt;Research &amp;amp; Development&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Ship it&lt;/li&gt;&lt;/ul&gt;';
    expect(htmlToText(greenhouse)).toBe('Research & Development\n\n- Ship it');
  });

  test('resolves Greenhouse double-escaped nbsp to a space', () => {
    expect(htmlToText('&lt;p&gt;a&amp;nbsp;b&lt;/p&gt;')).toBe('a b');
  });

  test('drops script and style bodies instead of leaking their text', () => {
    const html = '<p>Keep</p><script>var leak = 1;</script><style>.x{color:red}</style>';
    const text = htmlToText(html);
    expect(text).toBe('Keep');
    expect(text).not.toContain('leak');
    expect(text).not.toContain('color:red');
  });

  test('does not emit a literal surrogate half for an invalid numeric entity', () => {
    expect(htmlToText('&#xD800;')).toBe('&#xD800;');
  });
});

describe('classifyRemote', () => {
  test('reads "Remote" out of the location string', () => {
    expect(classifyRemote('Remote - US', '')).toBe('remote');
  });

  test('reads "Hybrid" out of the location string', () => {
    expect(classifyRemote('Hybrid - Berlin', '')).toBe('hybrid');
  });

  test('treats a plain city as onsite', () => {
    expect(classifyRemote('Seattle, San Francisco, New York City', '')).toBe('onsite');
  });

  test('returns unknown when there is no signal at all', () => {
    expect(classifyRemote('', '')).toBe('unknown');
  });

  test('lets ATS workplaceType override a contradictory isRemote flag', () => {
    // Ashby's ramp board really does return isRemote:true with workplaceType:"Hybrid".
    expect(classifyRemote('New York, NY (HQ)', '', { isRemote: true, workplaceType: 'Hybrid' }))
      .toBe('hybrid');
  });

  test('uses the isRemote hint when the location says nothing', () => {
    expect(classifyRemote('', '', { isRemote: true })).toBe('remote');
  });

  test('uses the isHybrid hint when the location says nothing', () => {
    expect(classifyRemote('', '', { isHybrid: true })).toBe('hybrid');
  });

  test('falls back to the description when the location is silent', () => {
    expect(classifyRemote('', 'This is a fully remote role on a distributed team.')).toBe('remote');
  });

  test('does not read a negated mention as remote', () => {
    expect(classifyRemote('Austin, TX (not remote)', '')).toBe('onsite');
  });

  test('recognizes on-site wording', () => {
    expect(classifyRemote('On-site, Dublin', '')).toBe('onsite');
  });
});

describe('isBrazilEligible', () => {
  test('accepts an explicit Brazil location', () => {
    const result = isBrazilEligible(makeJob({ locationRaw: 'Remote - Brazil', remotePolicy: 'remote' }));
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain('Brazil');
  });

  test('accepts LATAM and names the deciding field in the reason', () => {
    const result = isBrazilEligible(makeJob({ locationRaw: 'Remote (LATAM)', remotePolicy: 'remote' }));
    expect(result.eligible).toBe(true);
    expect(result.reason).toStartWith('location:');
    expect(result.reason).toContain('LATAM');
  });

  test('accepts South America in the body when the location is bare Remote', () => {
    const result = isBrazilEligible(
      makeJob({ locationRaw: 'Remote', remotePolicy: 'remote', descriptionText: 'Open to South America.' }),
    );
    expect(result.eligible).toBe(true);
    expect(result.reason).toStartWith('description:');
  });

  test('accepts Americas in the location', () => {
    expect(
      isBrazilEligible(makeJob({ locationRaw: 'Remote - Americas', remotePolicy: 'remote' })).eligible,
    ).toBe(true);
  });

  test('accepts anywhere / worldwide when stated as the location', () => {
    expect(isBrazilEligible(makeJob({ locationRaw: 'Work from anywhere', remotePolicy: 'remote' })).eligible).toBe(true);
    expect(isBrazilEligible(makeJob({ locationRaw: 'Remote - Worldwide', remotePolicy: 'remote' })).eligible).toBe(true);
  });

  test('rejects "US only" and reports the phrase', () => {
    const result = isBrazilEligible(makeJob({ locationRaw: 'Remote (US only)', remotePolicy: 'remote' }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('US only');
  });

  test('rejects "must be located in the United States"', () => {
    const result = isBrazilEligible(
      makeJob({
        locationRaw: 'Remote',
        remotePolicy: 'remote',
        descriptionText: 'You must be located in the United States for this role.',
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason.toLowerCase()).toContain('must be located in the united states');
  });

  test('rejects a US work-authorization requirement', () => {
    const result = isBrazilEligible(
      makeJob({
        locationRaw: 'Remote',
        remotePolicy: 'remote',
        descriptionText: 'This position requires US work authorization.',
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason.toLowerCase()).toContain('work authorization');
  });

  test('rejects "EU only"', () => {
    expect(
      isBrazilEligible(makeJob({ locationRaw: 'Remote - EU only', remotePolicy: 'remote' })).eligible,
    ).toBe(false);
  });

  test('lets an exclusion beat a co-occurring inclusion', () => {
    const result = isBrazilEligible(
      makeJob({
        locationRaw: 'Remote - Americas',
        remotePolicy: 'remote',
        descriptionText: 'Candidates must be authorized to work in the United States.',
      }),
    );
    expect(result.eligible).toBe(false);
  });

  test('rejects "anywhere in the United States" despite the word anywhere', () => {
    const result = isBrazilEligible(
      makeJob({ locationRaw: 'Remote - anywhere in the United States', remotePolicy: 'remote' }),
    );
    expect(result.eligible).toBe(false);
  });

  test('rejects a US-scoped remote location', () => {
    expect(
      isBrazilEligible(makeJob({ locationRaw: 'Remote from the US', remotePolicy: 'remote' })).eligible,
    ).toBe(false);
  });

  test('still accepts an onsite role located in Brazil', () => {
    const result = isBrazilEligible(
      makeJob({ locationRaw: 'Sao Paulo, Brazil', remotePolicy: 'onsite' }),
    );
    expect(result.eligible).toBe(true);
    expect(result.reason).toContain('Brazil');
  });

  test('defaults to not eligible, with a reason, when nothing matches', () => {
    const result = isBrazilEligible(makeJob({ locationRaw: 'Tokyo, Japan', remotePolicy: 'onsite' }));
    expect(result.eligible).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

describe('isBrazilEligible: explicit location beats description boilerplate', () => {
  test('does NOT treat marketing "global" as an eligibility signal', () => {
    // Regression: a company's own copy calls it global, which made onsite
    // Seattle and Dublin roles read as eligible across a live 628-job fetch.
    const result = isBrazilEligible(
      makeJob({
        locationRaw: 'Seattle, San Francisco, New York City',
        remotePolicy: 'onsite',
        descriptionText: 'Northstar Labs is a global platform serving the global economy.',
      }),
    );
    expect(result.eligible).toBe(false);
  });

  test('rejects an onsite role whose body merely mentions a Brazil office', () => {
    const result = isBrazilEligible(
      makeJob({
        locationRaw: 'Dublin',
        remotePolicy: 'onsite',
        descriptionText: 'We also have an office in Brazil.',
      }),
    );
    expect(result.eligible).toBe(false);
  });

  test('live greenhouse/gitlab: enumerated countries beat "fully distributed team"', () => {
    const result = isBrazilEligible(
      makeJob({
        title: 'Engineering Manager, Tenant Scale:Git',
        locationRaw: 'Remote, Canada; Remote, United Kingdom; Remote, United States',
        remotePolicy: 'remote',
        descriptionText: 'GitLab is a fully distributed team working from everywhere.',
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toStartWith('location:');
  });

  test('live greenhouse/cloudflare: "Hybrid" beats "globally distributed"', () => {
    const result = isBrazilEligible(
      makeJob({
        title: 'Full Stack Engineer - Internal Audit',
        locationRaw: 'Hybrid',
        remotePolicy: 'hybrid',
        descriptionText: 'We are a globally distributed company.',
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('office presence');
  });

  test('live ashby/supabase: "Remote, EMEA" beats "work from anywhere"', () => {
    const result = isBrazilEligible(
      makeJob({
        title: 'Support Engineer (EMEA)',
        locationRaw: 'Remote, EMEA',
        remotePolicy: 'remote',
        descriptionText: 'Supabase is remote-first and you can work from anywhere.',
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('EMEA');
  });

  test('"Remote, AMER" is eligible but "Remote, EMEA" is not', () => {
    expect(isBrazilEligible(makeJob({ locationRaw: 'Remote, AMER', remotePolicy: 'remote' })).eligible).toBe(true);
    expect(isBrazilEligible(makeJob({ locationRaw: 'Remote, EMEA', remotePolicy: 'remote' })).eligible).toBe(false);
  });

  test('"North America" is not read as "Americas"', () => {
    expect(
      isBrazilEligible(makeJob({ locationRaw: 'Remote, North America', remotePolicy: 'remote' })).eligible,
    ).toBe(false);
  });

  test('a two-country enumeration is not eligible', () => {
    expect(
      isBrazilEligible(
        makeJob({ locationRaw: 'Remote, Canada; Remote, United Kingdom', remotePolicy: 'remote' }),
      ).eligible,
    ).toBe(false);
  });

  test('"Remote, Global" is eligible', () => {
    expect(
      isBrazilEligible(makeJob({ locationRaw: 'Remote, Global', remotePolicy: 'remote' })).eligible,
    ).toBe(true);
  });

  test('bare "Remote" defers to an explicit hiring-scope phrase in the body', () => {
    const result = isBrazilEligible(
      makeJob({
        locationRaw: 'Remote',
        remotePolicy: 'remote',
        descriptionText: 'We hire anywhere in the world.',
      }),
    );
    expect(result.eligible).toBe(true);
    expect(result.reason).toStartWith('description:');
  });

  test('an empty location with no scope phrase stays ineligible', () => {
    expect(
      isBrazilEligible(
        makeJob({ locationRaw: '', remotePolicy: 'remote', descriptionText: 'We are a global company.' }),
      ).eligible,
    ).toBe(false);
  });
});

describe('registry', () => {
  test('exposes every adapter, each tagged with its own type', () => {
    // Gupy (search-based) is the sixth: discovery only, submitted by hand.
    const expected: AtsType[] = ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'gupy'];
    expect(Object.keys(adapters).sort()).toEqual([...expected].sort());
    for (const key of expected) {
      expect(adapters[key]?.atsType).toBe(key);
    }
  });
});

describe('fetchAll failure isolation', () => {
  test('records an unknown atsType as a failure instead of throwing', async () => {
    const report = await fetchAllWithReport([
      { token: 'whoever', atsType: 'not-a-real-ats' as never },
    ]);
    expect(report.jobs).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.message).toContain('unknown atsType');
  });

  test('keeps a good target when another one throws', async () => {
    const failures: string[] = [];
    const original = adapters['greenhouse'];
    expect(original).toBeDefined();

    adapters['exploding'] = {
      atsType: 'greenhouse',
      fetchJobs: () => Promise.reject(new Error('boom')),
      probe: () => Promise.resolve(false),
    };
    adapters['fine'] = {
      atsType: 'greenhouse',
      fetchJobs: () => Promise.resolve([makeJob({ id: 'kept' })]),
      probe: () => Promise.resolve(true),
    };

    try {
      const jobs = await fetchAll(
        [
          { token: 'bad', atsType: 'exploding' as never },
          { token: 'good', atsType: 'fine' as never },
        ],
        { onFailure: (failure) => failures.push(failure.message) },
      );

      expect(jobs.map((job) => job.id)).toEqual(['kept']);
      expect(failures).toEqual(['boom']);
    } finally {
      delete adapters['exploding'];
      delete adapters['fine'];
    }
  });

  test('returns an empty result for an empty target list', async () => {
    expect(await fetchAll([])).toEqual([]);
  });
});

describe('greenhouse live integration', () => {
  test.skipIf(SKIP_NETWORK)(
    'fetches more than 100 normalized jobs from the stripe board',
    async () => {
      const jobs = await greenhouseAdapter.fetchJobs('stripe');

      expect(jobs.length).toBeGreaterThan(100);

      const first = jobs[0];
      expect(first).toBeDefined();
      if (first === undefined) return;

      expect(first.atsType).toBe('greenhouse');
      expect(first.companyToken).toBe('stripe');
      expect(first.title.length).toBeGreaterThan(0);
      expect(first.url).toStartWith('http');
      expect(first.descriptionText.length).toBeGreaterThan(100);
      // Proves the entity decoding actually ran: no escaped markup survives.
      expect(first.descriptionText).not.toContain('&lt;');
      expect(first.descriptionText).not.toContain('&amp;');
      expect(first.descriptionText).not.toContain('<p>');
      expect(new Date(first.fetchedAt).getTime()).toBeGreaterThan(0);
    },
    60_000,
  );

  test.skipIf(SKIP_NETWORK)(
    'returns an empty array for a token that does not exist',
    async () => {
      expect(await greenhouseAdapter.fetchJobs('zzz-nope-xyz-123')).toEqual([]);
      expect(await greenhouseAdapter.probe('zzz-nope-xyz-123')).toBe(false);
    },
    60_000,
  );
});
