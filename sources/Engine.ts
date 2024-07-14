import {UsageError}                                                from 'clipanion';
import fs                                                          from 'fs';
import path                                                        from 'path';
import process                                                     from 'process';
import semverRcompare                                              from 'semver/functions/rcompare.js';
import semverValid                                                 from 'semver/functions/valid.js';
import semverValidRange                                            from 'semver/ranges/valid.js';

import defaultConfig                                               from '../config.json' with { type: 'json' };

import * as corepackUtils                                          from './corepackUtils.ts';
import * as debugUtils                                             from './debugUtils.ts';
import * as folderUtils                                            from './folderUtils.ts';
import type {NodeError}                                            from './nodeUtils.ts';
import * as semverUtils                                            from './semverUtils.ts';
import * as specUtils                                              from './specUtils.ts';
import {SupportedPackageManagerSet, isSupportedPackageManager}     from './types.ts';
import type {Config, Descriptor, Locator, PackageManagerSpec}      from './types.ts';
import type {SupportedPackageManagers}                             from './types.ts';
import type {SupportedPackageManagersWithoutNpm}                   from './types.ts';

export type PreparedPackageManagerInfo = Awaited<ReturnType<Engine[`ensurePackageManager`]>>;

export type PackageManagerRequest = {
  packageManager: SupportedPackageManagers;
  binaryName: string;
  binaryVersion: string | null;
};

function getLastKnownGoodFilePath() {
  return path.join(folderUtils.getCorepackHomeFolder(), `lastKnownGood.json`);
}

export async function getLastKnownGood(): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(getLastKnownGoodFilePath(), `utf8`);
  } catch (err) {
    if ((err as NodeError)?.code === `ENOENT`) return {};
    throw err;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed) return {};
    if (typeof parsed !== `object`) return {};
    Object.entries(parsed).forEach(([key, value]) => {
      if (typeof value !== `string`) {
        // Ensure that all entries are strings.
        delete parsed[key];
      }
    });
    return parsed;
  } catch {
    // Ignore errors; too bad
    return {};
  }
}

async function createLastKnownGoodFile(lastKnownGood: Record<string, string>) {
  const content = `${JSON.stringify(lastKnownGood, null, 2)}\n`;
  await fs.promises.mkdir(folderUtils.getCorepackHomeFolder(), {recursive: true});
  await fs.promises.writeFile(getLastKnownGoodFilePath(), content, `utf8`);
}

export function getLastKnownGoodFromFileContent(lastKnownGood: Record<string, string>, packageManager: string) {
  if (Object.hasOwn(lastKnownGood, packageManager))
    return lastKnownGood[packageManager];
  return undefined;
}

export async function activatePackageManager(lastKnownGood: Record<string, string>, locator: Locator) {
  if (lastKnownGood[locator.name] === locator.reference) {
    debugUtils.log(`${locator.name}@${locator.reference} is already Last Known Good version`);
    return;
  }

  lastKnownGood[locator.name] = locator.reference;

  debugUtils.log(`Setting ${locator.name}@${locator.reference} as Last Known Good version`);
  await createLastKnownGoodFile(lastKnownGood);
}

export class Engine {
  config: Config;

  constructor(config: Config = defaultConfig as Config) {
    this.config = config;
  }

  getPackageManagerFor(binaryName: string): SupportedPackageManagers | null {
    for (const packageManager of SupportedPackageManagerSet) {
      for (const rangeDefinition of Object.values(this.config.definitions[packageManager]!.ranges)) {
        const bins = Array.isArray(rangeDefinition.bin)
          ? rangeDefinition.bin
          : Object.keys(rangeDefinition.bin);

        if (bins.includes(binaryName)) {
          return packageManager;
        }
      }
    }

    return null;
  }

  getPackageManagerSpecFor(locator: Locator): PackageManagerSpec {
    if (!corepackUtils.isSupportedPackageManagerLocator(locator)) {
      const url = `${locator.reference}`;
      return {
        url,
        bin: undefined as any, // bin will be set later
        registry: {
          type: `url`,
          url,
          fields: {
            tags: ``,
            versions: ``,
          },
        },
      };
    }

    const definition = this.config.definitions[locator.name as SupportedPackageManagers];
    if (typeof definition === `undefined`)
      throw new UsageError(`This package manager (${locator.name}) isn't supported by this corepack build`);

    const ranges = Object.keys(definition.ranges).reverse();
    const range = ranges.find(range => semverUtils.satisfiesWithPrereleases(locator.reference, range));
    if (typeof range === `undefined`)
      throw new Error(`Assertion failed: Specified resolution (${locator.reference}) isn't supported by any of ${ranges.join(`, `)}`);

    return definition.ranges[range];
  }

  getBinariesFor(name: SupportedPackageManagers) {
    const binNames = new Set<string>();

    for (const rangeDefinition of Object.values(this.config.definitions[name]!.ranges)) {
      const bins = Array.isArray(rangeDefinition.bin)
        ? rangeDefinition.bin
        : Object.keys(rangeDefinition.bin);

      for (const name of bins) {
        binNames.add(name);
      }
    }

    return binNames;
  }

  async getDefaultDescriptors() {
    const locators: Array<Descriptor> = [];

    for (const name of SupportedPackageManagerSet as Set<SupportedPackageManagers>)
      locators.push({name, range: await this.getDefaultVersion(name)});

    return locators;
  }

  async getDefaultVersion(packageManager: SupportedPackageManagers) {
    const definition = this.config.definitions[packageManager];
    if (typeof definition === `undefined`)
      throw new UsageError(`This package manager (${packageManager}) isn't supported by this corepack build`);

    const lastKnownGood = await getLastKnownGood();
    const lastKnownGoodForThisPackageManager = getLastKnownGoodFromFileContent(lastKnownGood, packageManager);
    if (lastKnownGoodForThisPackageManager)
      return lastKnownGoodForThisPackageManager;

    if (process.env.COREPACK_DEFAULT_TO_LATEST === `0`)
      return definition.default;

    const reference = await corepackUtils.fetchLatestStableVersion(definition.fetchLatestFrom);

    try {
      await activatePackageManager(lastKnownGood, {
        name: packageManager,
        reference,
      });
    } catch {
      // If for some reason, we cannot update the last known good file, we
      // ignore the error.
    }

    return reference;
  }

  async activatePackageManager(locator: Locator) {
    const lastKnownGood = await getLastKnownGood();
    await activatePackageManager(lastKnownGood, locator);
  }

  async ensurePackageManager(locator: Locator) {
    const spec = this.getPackageManagerSpecFor(locator);

    const packageManagerInfo = await corepackUtils.installVersion(folderUtils.getInstallFolder(), locator, {
      spec,
    });

    const noHashReference = locator.reference.replace(/\+.*/, ``);
    const fixedHashReference = `${noHashReference}+${packageManagerInfo.hash}`;

    const fixedHashLocator = {
      name: locator.name,
      reference: fixedHashReference,
    };

    return {
      ...packageManagerInfo,
      locator: fixedHashLocator,
      spec,
    };
  }

  /**
   * Locates the active project's package manager specification.
   *
   * If the specification exists but doesn't match the active package manager,
   * an error is thrown to prevent users from using the wrong package manager,
   * which would lead to inconsistent project layouts.
   *
   * If the project doesn't include a specification file, we just assume that
   * whatever the user uses is exactly what they want to use. Since the version
   * isn't explicited, we fallback on known good versions.
   *
   * Finally, if the project doesn't exist at all, we ask the user whether they
   * want to create one in the current project. If they do, we initialize a new
   * project using the default package managers, and configure it so that we
   * don't need to ask again in the future.
   */
  async findProjectSpec(initialCwd: string, locator: Locator, {transparent = false}: {transparent?: boolean} = {}): Promise<Descriptor> {
    // A locator is a valid descriptor (but not the other way around)
    const fallbackDescriptor = {name: locator.name, range: `${locator.reference}`};

    if (process.env.COREPACK_ENABLE_PROJECT_SPEC === `0`)
      return fallbackDescriptor;

    if (process.env.COREPACK_ENABLE_STRICT === `0`)
      transparent = true;

    while (true) {
      const result = await specUtils.loadSpec(initialCwd);

      switch (result.type) {
        case `NoProject`:
          return fallbackDescriptor;

        case `NoSpec`: {
          if (process.env.COREPACK_ENABLE_AUTO_PIN !== `0`) {
            const resolved = await this.resolveDescriptor(fallbackDescriptor, {allowTags: true});
            if (resolved === null)
              throw new UsageError(`Failed to successfully resolve '${fallbackDescriptor.range}' to a valid ${fallbackDescriptor.name} release`);

            const installSpec = await this.ensurePackageManager(resolved);

            console.error(`! The local project doesn't define a 'packageManager' field. Corepack will now add one referencing ${installSpec.locator.name}@${installSpec.locator.reference}.`);
            console.error(`! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager`);
            console.error();

            await specUtils.setLocalPackageManager(path.dirname(result.target), installSpec);
          }

          return fallbackDescriptor;
        }

        case `Found`: {
          if (result.spec.name !== locator.name) {
            if (transparent) {
              return fallbackDescriptor;
            } else {
              throw new UsageError(`This project is configured to use ${result.spec.name} because ${result.target} has a "packageManager" field`);
            }
          } else {
            return result.spec;
          }
        }
      }
    }
  }

  async executePackageManagerRequest({packageManager, binaryName, binaryVersion}: PackageManagerRequest, {cwd, args}: {cwd: string, args: Array<string>}): Promise<void> {
    let fallbackLocator: Locator = {
      name: binaryName as SupportedPackageManagers,
      reference: undefined as any,
    };

    let isTransparentCommand = false;
    if (packageManager != null) {
      const defaultVersion = binaryVersion || await this.getDefaultVersion(packageManager);
      const definition = this.config.definitions[packageManager]!;

      // If all leading segments match one of the patterns defined in the `transparent`
      // key, we tolerate calling this binary even if the local project isn't explicitly
      // configured for it, and we use the special default version if requested.
      for (const transparentPath of definition.transparent.commands) {
        if (transparentPath[0] === binaryName && transparentPath.slice(1).every((segment, index) => segment === args[index])) {
          isTransparentCommand = true;
          break;
        }
      }

      const fallbackReference = isTransparentCommand
        ? definition.transparent.default ?? defaultVersion
        : defaultVersion;

      fallbackLocator = {
        name: packageManager,
        reference: fallbackReference,
      };
    }

    const descriptor = await this.findProjectSpec(cwd, fallbackLocator, {transparent: isTransparentCommand});

    if (binaryVersion)
      descriptor.range = binaryVersion;

    const resolved = await this.resolveDescriptor(descriptor, {allowTags: true});
    if (resolved === null)
      throw new UsageError(`Failed to successfully resolve '${descriptor.range}' to a valid ${descriptor.name} release`);

    const installSpec = await this.ensurePackageManager(resolved);

    return await corepackUtils.runVersion(resolved, installSpec, binaryName, args);
  }

  async resolveDescriptor(descriptor: Descriptor, {allowTags = false, useCache = true}: {allowTags?: boolean, useCache?: boolean} = {}): Promise<Locator | null> {
    if (!corepackUtils.isSupportedPackageManagerDescriptor(descriptor)) {
      if (process.env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS !== `1` && isSupportedPackageManager(descriptor.name))
        throw new UsageError(`Illegal use of URL for known package manager. Instead, select a specific version, or set COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (${descriptor.name}@${descriptor.range})`);

      return {
        name: descriptor.name,
        reference: descriptor.range,
      };
    }

    const definition = this.config.definitions[descriptor.name as SupportedPackageManagers];
    if (typeof definition === `undefined`)
      throw new UsageError(`This package manager (${descriptor.name}) isn't supported by this corepack build`);

    let finalDescriptor = descriptor;
    if (!semverValid(descriptor.range) && !semverValidRange(descriptor.range)) {
      if (!allowTags)
        throw new UsageError(`Packages managers can't be referenced via tags in this context`);

      // We only resolve tags from the latest registry entry
      const ranges = Object.keys(definition.ranges);
      const tagRange = ranges[ranges.length - 1];

      const packageManagerSpec = definition.ranges[tagRange];
      const registry = corepackUtils.getRegistryFromPackageManagerSpec(packageManagerSpec);

      const tags = await corepackUtils.fetchAvailableTags(registry);
      if (!Object.hasOwn(tags, descriptor.range))
        throw new UsageError(`Tag not found (${descriptor.range})`);

      finalDescriptor = {
        name: descriptor.name,
        range: tags[descriptor.range],
      };
    }

    // If a compatible version is already installed, no need to query one
    // from the remote listings
    const cachedVersion = await corepackUtils.findInstalledVersion(folderUtils.getInstallFolder(), finalDescriptor);
    if (cachedVersion !== null && useCache)
      return {name: finalDescriptor.name, reference: cachedVersion};

    // If the user asked for a specific version, no need to request the list of
    // available versions from the registry.
    if (semverValid(finalDescriptor.range))
      return {name: finalDescriptor.name, reference: finalDescriptor.range};

    const versions = await Promise.all(Object.keys(definition.ranges).map(async range => {
      const packageManagerSpec = definition.ranges[range];
      const registry = corepackUtils.getRegistryFromPackageManagerSpec(packageManagerSpec);

      const versions = await corepackUtils.fetchAvailableVersions(registry);
      return versions.filter(version => semverUtils.satisfiesWithPrereleases(version, finalDescriptor.range));
    }));

    const highestVersion = [...new Set(versions.flat())].sort(semverRcompare);
    if (highestVersion.length === 0)
      return null;

    return {name: finalDescriptor.name, reference: highestVersion[0]};
  }
}
