import { expect, test } from '@playwright/test';
import { launch, openTerminal, routeViaComposer } from './launch';
import { paneText } from './xterm';

test('composer routes @mention to terminal', async () => {
  const { app, page } = await launch();
  try {
    const pane = await openTerminal(page);
    const marker = 'COMP' + '_OK_' + Date.now();
    await routeViaComposer(page, `echo ${marker}`);
    await expect(page.locator('textarea.composer-input')).toHaveValue('');
    await expect.poll(() => paneText(pane), { timeout: 20000 }).toContain(marker);
  } finally {
    await app.close();
  }
});
