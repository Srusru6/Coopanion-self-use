/**
 * Panel bundles the app serves to the WebUI. The World packages' bundles are assembled as
 * definitions, so the extension loader never reads their `cortico.webUiClient`; the study World's
 * bundle is built from this repository's own sources. These entries join the extension asset
 * table, which is where the WebUI server serves page bundles from.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionPackageFile } from 'cortico/extensions.ts';
import { parseExtensionManifest, type ExtensionWebUiAsset, type ExtensionPackageJson } from 'cortico/extensions/manifest.ts';
import { pageIdFor } from 'cortico/web/shared/webui-protocol.ts';

const NODE_MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));

export function bundledWebUiAssets(worlds: ReadonlyArray<{ id: string; packageName: string }>): ExtensionWebUiAsset[] {
  const out: ExtensionWebUiAsset[] = [];
  for (const { id, packageName } of worlds) {
    const dir = join(NODE_MODULES, packageName);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ExtensionPackageJson & { version: string };
    const parsed = parseExtensionManifest(pkg);
    if (!parsed.ok || parsed.manifest.webUiClient === undefined) continue;
    // a missing file leaves the page without a bundle; the WebUI manifest names the page and the fix
    const jsFile = extensionPackageFile(dir, parsed.manifest.webUiClient);
    if (!jsFile) continue;
    const cssFile = parsed.manifest.webUiStyle === undefined ? null : extensionPackageFile(dir, parsed.manifest.webUiStyle);
    // the WebUI server lets browsers cache a bundle by its URL for a year; a rebuild changes the hash in it
    const hash = createHash('sha256').update(readFileSync(jsFile));
    if (cssFile) hash.update(readFileSync(cssFile));
    const version = `${pkg.version}-${hash.digest('hex').slice(0, 10)}`;
    out.push({ pageId: pageIdFor('world', id), packageName, version, jsFile, ...(cssFile ? { cssFile } : {}) });
  }
  return out;
}

/**
 * The study World's panel bundle, built by `scripts/stage.ts` from `console/features/study/panel.ts`.
 * It belongs to no npm package, so the entry carries the app's own version; the content hash keeps a
 * rebuilt bundle from being served out of the browser's year-long cache. Null before a build.
 */
export function studyWebUiAsset(): ExtensionWebUiAsset | null {
  const jsFile = fileURLToPath(new URL('../build/console/study-panel.js', import.meta.url));
  let bytes: Buffer;
  try {
    bytes = readFileSync(jsFile);
  } catch {
    return null;
  }
  const { version } = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
  return { pageId: pageIdFor('world', 'study'), packageName: 'coopanion', version: `${version}-${hash}`, jsFile };
}
