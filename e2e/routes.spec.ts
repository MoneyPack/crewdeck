import { expect, test } from '@playwright/test';
import { launch, openTerminal, routeViaComposer } from './launch';

test('routing log records composer messages', async () => {
  const { app, page } = await launch();
  try {
    await openTerminal(page);
    await routeViaComposer(page, 'echo ' + 'ROUTE' + '_OK');
    await page.locator('button[title^="Routing log"]').click();
    const log = page.locator('aside[aria-label="Routing log"]');
    await expect(log).toBeVisible();
    await expect(log.locator('li.route.composer .route-to').first()).toContainText('@', { timeout: 10000 });
  } finally {
    await app.close();
  }
});
