import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { paneText } from './xterm';

// Terminal stress harness: 4 visible panes, 3 flooding output while pane 0 stays interactive.
// Measures renderer FPS, keystroke echo latency under load, per-pane throughput and memory.
// Opt-in only (slow, machine-dependent): `npm run test:stress` sets CREWDECK_STRESS=1.
test.skip(!process.env.CREWDECK_STRESS, 'set CREWDECK_STRESS=1 (npm run test:stress)');

const FLOOD_SECONDS = Number(process.env.CREWDECK_STRESS_SECONDS ?? 15);
const PANES = 4;
const ECHO_SAMPLES = 12;

const memoryMb = (app: ElectronApplication) =>
  app.evaluate(({ app: a }) => a.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
};

/** Sample rAF frames in the renderer for `ms`; returns fps and the worst frame gap. */
const sampleFrames = (page: Page, ms: number) =>
  page.evaluate(
    (duration) =>
      new Promise<{ fps: number; worstGapMs: number; p95GapMs: number }>((resolve) => {
        // e2e compiles against node libs (no DOM), so reach rAF through a typed globalThis view.
        const raf = (globalThis as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number })
          .requestAnimationFrame;
        const gaps: number[] = [];
        const start = performance.now();
        let last = start;
        const tick = (now: number) => {
          gaps.push(now - last);
          last = now;
          if (now - start < duration) raf(tick);
          else {
            const sorted = [...gaps].sort((a, b) => a - b);
            resolve({
              fps: (gaps.length * 1000) / (now - start),
              worstGapMs: sorted[sorted.length - 1] ?? 0,
              p95GapMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
            });
          }
        };
        raf(tick);
      }),
    ms,
  );

test('stress: 4 panes, 3 flooding, interactive echo latency', async () => {
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-stress-'));
  const userData = path.join(root, 'userData');
  const project = path.join(root, 'project');
  fs.mkdirSync(userData);
  fs.mkdirSync(project);

  const exe = process.env.CREWDECK_E2E_EXE;
  const app = await electron.launch({
    ...(exe ? { executablePath: path.resolve(exe), args: [] } : { args: [path.resolve('dist-electron/main.cjs')] }),
    env: { ...process.env, CREWDECK_USER_DATA: userData, CREWDECK_TEST_PROJECT: project } as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForSelector('[data-testid=splash]', { state: 'detached' });
    await page.setViewportSize({ width: 1600, height: 1000 }).catch(() => undefined);
    // CREWDECK_STRESS_RENDERER=dom forces the DOM renderer for A/B comparison (read at pane mount).
    const renderer = process.env.CREWDECK_STRESS_RENDERER === 'dom' ? 'dom' : 'webgl';
    await page.evaluate((r) => {
      const ls = (
        globalThis as unknown as { localStorage: { setItem(k: string, v: string): void; removeItem(k: string): void } }
      ).localStorage;
      if (r === 'dom') ls.setItem('crewdeck.renderer', 'dom');
      else ls.removeItem('crewdeck.renderer');
    }, renderer);
    await page.locator('button.project').click();
    await expect(page.locator('button.project')).toContainText('project');
    await page.locator('.layout-picker button[title^="4-pane layout"]').click();

    for (let i = 0; i < PANES; i++) {
      await page.getByRole('button', { name: 'Terminal', exact: true }).click();
      await expect(page.locator('.pane:not(.empty-slot)')).toHaveCount(i + 1);
    }
    const panes = page.locator('.pane:not(.empty-slot)');
    // Wait for every shell prompt before driving input.
    for (let i = 0; i < PANES; i++)
      await expect.poll(() => paneText(panes.nth(i)), { timeout: 30_000 }).toContain('PS ');

    const memBefore = await memoryMb(app);

    // Flood panes 1..3 with fixed-duration output; the loop counter reveals achieved throughput
    // (ConPTY backpressures when the renderer falls behind).
    const flood =
      `$e=(Get-Date).AddSeconds(${FLOOD_SECONDS});$l='#'*100;$i=0;` +
      `while((Get-Date) -lt $e){$i++;[Console]::WriteLine("L$i $l")};` +
      `Write-Output ('FLOOD'+'_DONE '+$i)`;
    const t0 = Date.now();
    for (let i = 1; i < PANES; i++) {
      await panes.nth(i).locator('.pane-body').click();
      await page.keyboard.type(flood);
      await page.keyboard.press('Enter');
    }

    // While the floods run: sample frame pacing and keystroke echo latency in pane 0 concurrently.
    const framesP = sampleFrames(page, Math.min(8_000, (FLOOD_SECONDS - 2) * 1000));
    await panes.nth(0).locator('.pane-body').click();
    const echo: number[] = [];
    for (let n = 0; n < ECHO_SAMPLES; n++) {
      const token = `z${n}q${Math.random().toString(36).slice(2, 7)}`;
      const start = Date.now();
      await page.keyboard.type(`#${token}`);
      await expect.poll(() => paneText(panes.nth(0), 50), { timeout: 10_000, intervals: [5] }).toContain(token);
      echo.push(Date.now() - start);
      await page.keyboard.press('Escape'); // PSReadLine: clear the line
      await page.waitForTimeout(100);
    }
    const frames = await framesP;
    const memPeak = await memoryMb(app);

    const lines: number[] = [];
    for (let i = 1; i < PANES; i++) {
      const pane = panes.nth(i);
      await expect
        .poll(() => paneText(pane, 20), { timeout: FLOOD_SECONDS * 1000 + 60_000, intervals: [250] })
        .toMatch(/FLOOD_DONE \d+/);
      const m = /FLOOD_DONE (\d+)/.exec(await paneText(pane, 20));
      lines.push(m ? Number(m[1]) : 0);
    }
    const drainSec = (Date.now() - t0) / 1000;
    const memAfter = await memoryMb(app);

    const report = {
      renderer: await panes.nth(0).locator('.pane-body').getAttribute('data-renderer'),
      floodSeconds: FLOOD_SECONDS,
      drainSeconds: +drainSec.toFixed(1),
      linesPerPane: lines,
      linesPerSecTotal: Math.round(lines.reduce((a, b) => a + b, 0) / FLOOD_SECONDS),
      fps: +frames.fps.toFixed(1),
      frameGapP95Ms: +frames.p95GapMs.toFixed(1),
      frameGapWorstMs: +frames.worstGapMs.toFixed(1),
      echoMs: { p50: pct(echo, 50), p95: pct(echo, 95), max: Math.max(...echo) },
      memoryMb: { before: Math.round(memBefore), peak: Math.round(memPeak), after: Math.round(memAfter) },
    };
    fs.mkdirSync('test-results', { recursive: true });
    fs.writeFileSync(path.join('test-results', 'stress.json'), JSON.stringify(report, null, 2));
    console.log('STRESS', JSON.stringify(report));
    test.info().annotations.push({ type: 'stress', description: JSON.stringify(report) });

    // Budgets: generous floors that catch regressions without flaking on slower machines.
    expect(report.echoMs.p95, 'echo latency p95 under load').toBeLessThan(750);
    expect(report.fps, 'renderer fps under load').toBeGreaterThan(15);
    expect(report.memoryMb.peak, 'app working set').toBeLessThan(1500);
  } finally {
    await app.close();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows may still hold handles briefly.
    }
  }
});
