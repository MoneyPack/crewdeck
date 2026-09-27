import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';

export async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crewdeck-e2e-'));
  const userData = path.join(root, 'userData');
  const project = path.join(root, 'project');
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const exe = process.env.CREWDECK_E2E_EXE;
  const app = await electron.launch({
    ...(exe ? { executablePath: path.resolve(exe), args: [] } : { args: [path.resolve('dist-electron/main.cjs')] }),
    env: { ...process.env, CREWDECK_USER_DATA: userData, CREWDECK_TEST_PROJECT: project } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.keyboard.press('Escape').catch(() => {});
  await page.locator('[data-testid="splash"]').waitFor({ state: 'detached' });
  await expect(page.locator('.toolbar .title')).toHaveText('crewdeck');
  return { app, page };
}

export async function openTerminal(page: Page) {
  const projectBtn = page.locator('button.project');
  await projectBtn.click();
  await expect(projectBtn).toContainText('project');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const pane = page.locator('.pane').last();
  await expect(pane.locator('.pane-body[data-renderer]')).toBeVisible();
  return pane;
}

export async function routeViaComposer(page: Page, text: string) {
  const input = page.locator('textarea.composer-input');
  await input.click();
  await input.type('@');
  await expect(page.locator('ul.composer-suggest li[role=option]').first()).toBeVisible();
  await input.press('Tab');
  await input.type(` ${text}`);
  await input.press('Enter');
  await expect(page.locator('div.composer-error')).toHaveCount(0);
}
