/**
 * Invariant: opening a file Orca can't highlight suggests the catalog plugin whose release lists
 * its extension; View plugin opens the plugin's page and never installs.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  createGleamCatalogFixture,
  GLEAM_PLUGIN_KEY as PLUGIN_KEY
} from './helpers/plugin-gleam-catalog-fixture'
import { openRepoFile } from './helpers/plugin-smoke'

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('suggests a catalog plugin for an unknown file and never installs it', async ({}, testInfo) => {
  // Why: one Electron launch plus a Git catalog fetch and a plugin page; slower than the 30s default on CI.
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-file-type-suggestion-e2e-'))
  const fixture = await createGleamCatalogFixture(root)
  const session = createRestartSession(testInfo as TestInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const page = launched.page
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
      await window.api.plugins.refreshMarketplaces?.({})
    })
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await window.api.plugins.listMarketplacePlugins()).map((entry) => entry.pluginKey)
          ),
        { timeout: 60_000 }
      )
      .toContain(PLUGIN_KEY)

    await attachRepoAndOpenTerminal(page, fixture.workspace)
    await openRepoFile(page, fixture.workspace, 'main.gleam')
    const banner = page.getByText('A plugin can open .gleam files: Gleam')
    await expect(banner).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'View plugin' }).click()
    // Why the page: a suggestion leads to the same one-action install as the catalog, no dialog.
    const pluginPage = page.getByRole('article')
    await expect(pluginPage.locator('#plugin-detail-heading')).toContainText('Gleam', {
      timeout: 30_000
    })
    await expect(pluginPage.getByRole('img', { name: 'Official' })).toBeVisible()
    await expect(pluginPage).toContainText('Syntax')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await pluginPage.getByRole('button', { name: 'Plugins', exact: true }).click()
    expect(
      await page.evaluate(async () =>
        (await window.api.plugins.list()).map((entry) => entry.pluginKey)
      )
    ).not.toContain(PLUGIN_KEY)

    await page.evaluate(() => window.__store?.getState().closeSettingsPage())
    await page.getByRole('button', { name: "Don't suggest for .gleam" }).click()
    await expect(banner).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() => window.__store?.getState().settings?.pluginDismissedFileTypes)
      )
      .toEqual(['gleam'])
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
