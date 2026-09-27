import { expect, test } from '@playwright/test';
import { launch, openTerminal } from './launch';
import { paneText } from './xterm';

test('terminal echoes typed command', async () => {
  const { app, page } = await launch();
  try {
    const pane = await openTerminal(page);
    const marker = 'TERM' + '_OK_' + Date.now();
    await pane.locator('.pane-body').click();
    await page.keyboard.type(`echo ${marker}`);
    await page.keyboard.press('Enter');
    await expect.poll(() => paneText(pane), { timeout: 20000 }).toContain(marker);
  } finally {
    await app.close();
  }
});
