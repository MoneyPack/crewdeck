import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { paneText } from './xterm';

// Launch the built app against a throwaway profile + project, spawn a shell, echo round-trip.
test('launch, spawn shell, echo round-trip', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-e2e-'));
  const userData = path.join(root, 'userData');
  const project = path.join(root, 'project');
  fs.mkdirSync(userData);
  fs.mkdirSync(project);

  // CREWDECK_E2E_EXE=release/win-unpacked/crewdeck.exe runs the same test against the packaged app.
  const exe = process.env.CREWDECK_E2E_EXE;
  const app = await electron.launch({
    ...(exe ? { executablePath: path.resolve(exe), args: [] } : { args: [path.resolve('dist-electron/main.cjs')] }),
    env: { ...process.env, CREWDECK_USER_DATA: userData, CREWDECK_TEST_PROJECT: project } as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.toolbar .title')).toHaveText('crewdeck');

    // Open the project via the test hook (bypasses the native folder dialog).
    await page.locator('button.project').click();
    await expect(page.locator('button.project')).toContainText('project');

    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    const pane = page.locator('.pane').last();
    await expect(pane.locator('.pane-body[data-renderer]')).toBeVisible();

    // Marker is concatenated at runtime so the echoed command line alone cannot match.
    await pane.locator('.pane-body').click();
    await page.keyboard.type("Write-Output ('CREW' + 'DECK_E2E')");
    await page.keyboard.press('Enter');
    await expect.poll(() => paneText(pane), { timeout: 15_000 }).toContain('CREWDECK_E2E');
  } finally {
    await app.close();
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows may still hold handles briefly; temp dir is disposable.
    }
  }
});
