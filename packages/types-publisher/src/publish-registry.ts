import assert = require("assert");
import { emptyDir } from "fs-extra";
import * as yargs from "yargs";

import { Options } from "./lib/common";
import NpmClient, { fetchNpmInfo } from "./lib/npm-client";
import { AllPackages, NotNeededPackage, readNotNeededPackages, TypingsData } from "./lib/packages";
import { outputPath, validateOutputPath } from "./lib/settings";
import { fetchAndProcessNpmInfo } from "./lib/versions";
import { assertDirectoriesEqual, Fetcher, npmInstallFlags, readJson, sleep, writeFile, writeJson } from "./util/io";
import { logger, writeLog } from "./util/logging";
import { computeHash, done, execAndThrowErrors, joinPaths, nAtATime } from "./util/util";

const packageName = "types-registry";
const registryOutputPath = joinPaths(outputPath, packageName);
const readme =
	`This package contains a listing of all packages published to the @types scope on NPM.
Generated by [types-publisher](https://github.com/Microsoft/types-publisher).`;

if (!module.parent) {
	const dry = !!yargs.argv.dry;
	done(main(Options.defaults, dry, new Fetcher()));
}

export default async function main(options: Options, dry: boolean, fetcher: Fetcher): Promise<void> {
	const [log, logResult] = logger();
	log("=== Publishing types-registry ===");

	const { version: oldVersion, highestSemverVersion, contentHash: oldContentHash, lastModified } = await fetchAndProcessNpmInfo(packageName, fetcher);

	if (!isAWeekAfter(lastModified)) {
		log("Was modified less than a week ago, so do nothing.");
		return;
	}

	const client = await NpmClient.create({ defaultTag: "next" });

	// Don't include not-needed packages in the registry.
	const typings = await AllPackages.readTypings();
	const registry = JSON.stringify(await generateRegistry(typings, fetcher, options));
	const newContentHash = computeHash(registry);

	assert.equal(oldVersion.major, 0);
	assert.equal(oldVersion.minor, 1);
	const newVersion = `0.1.${oldVersion.patch + 1}`;
	const packageJson = generatePackageJson(newVersion, newContentHash);
	await generate(registry, packageJson);

	if (!highestSemverVersion.equals(oldVersion)) {
		// There was an error in the last publish and types-registry wasn't validated.
		// This may have just been due to a timeout, so test if types-registry@next is a subset of the one we're about to publish.
		// If so, we should just update it to "latest" now.
		log("Old version of types-registry was never tagged latest, so updating");
		await validateIsSubset(await readNotNeededPackages(options));
		await client.tag(packageName, highestSemverVersion.versionString, "latest");
	} else if (oldContentHash !== newContentHash) {
		log("New packages have been added, so publishing a new registry.");
		await publish(client, packageJson, newVersion, dry);
	} else {
		log("No new packages published, so no need to publish new registry.");
		// Just making sure...
		await validate();
	}

	await writeLog("publish-registry.md", logResult());
}

const millisecondsPerDay = 1000 * 60 * 60 * 24;
function isAWeekAfter(time: Date): boolean {
	const diff = Date.now() - time.getTime();
	const days = diff / millisecondsPerDay;
	return days > 7;
}

async function generate(registry: string, packageJson: {}): Promise<void> {
	await emptyDir(registryOutputPath);
	await writeOutputJson("package.json", packageJson);
	await writeOutputFile("index.json", registry);
	await writeOutputFile("README.md", readme);

	function writeOutputJson(filename: string, content: object): Promise<void> {
		return writeJson(outputPath(filename), content);
	}

	function writeOutputFile(filename: string, content: string): Promise<void> {
		return writeFile(outputPath(filename), content);
	}

	function outputPath(filename: string): string {
		return joinPaths(registryOutputPath, filename);
	}
}

async function publish(client: NpmClient, packageJson: {}, version: string, dry: boolean): Promise<void> {
	await client.publish(registryOutputPath, packageJson, dry);
	// Sleep for 20 seconds to let NPM update.
	await sleep(20);
	// Don't set it as "latest" until *after* it's been validated.
	await validate();
	await client.tag(packageName, version, "latest");
}

async function installForValidate(): Promise<void> {
	await emptyDir(validateOutputPath);
	await writeJson(joinPaths(validateOutputPath, "package.json"), {
		name: "validate",
		version: "0.0.0",
		description: "description",
		readme: "",
		license: "",
		repository: {},
	});

	const npmPath = joinPaths(__dirname, "..", "node_modules", "npm", "bin", "npm-cli.js");
	const err = (await execAndThrowErrors(`node ${npmPath} install types-registry@next ${npmInstallFlags}`, validateOutputPath)).trim();
	if (err) {
		console.error(err);
	}
}

const validateTypesRegistryPath = joinPaths(validateOutputPath, "node_modules", "types-registry");

async function validate(): Promise<void> {
	await installForValidate();
	await assertDirectoriesEqual(registryOutputPath, validateTypesRegistryPath, {
		ignore: f => f === "package.json"
	});
}

async function validateIsSubset(notNeeded: ReadonlyArray<NotNeededPackage>): Promise<void> {
	await installForValidate();
	const indexJson = "index.json";
	await assertDirectoriesEqual(registryOutputPath, validateTypesRegistryPath, {
		ignore: f => f === "package.json" || f === indexJson,
	});
	const actual = await readJson(joinPaths(validateTypesRegistryPath, indexJson)) as Registry;
	const expected = await readJson(joinPaths(registryOutputPath, indexJson)) as Registry;
	for (const key in actual.entries) {
		if (!(key in expected.entries) && !notNeeded.some(p => p.name === key)) {
			throw new Error(`Actual types-registry has unexpected key ${key}`);
		}
	}
}

function generatePackageJson(version: string, typesPublisherContentHash: string): {} {
	return {
		name: packageName,
		version,
		description: "A registry of TypeScript declaration file packages published within the @types scope.",
		repository: {
			type: "git",
			url: "https://github.com/Microsoft/types-publisher.git"
		},
		keywords: [
			"TypeScript",
			"declaration",
			"files",
			"types",
			"packages"
		],
		author: "Microsoft Corp.",
		license: "MIT",
		typesPublisherContentHash,
	};
}

interface Registry { readonly entries: { readonly [packageName: string]: { readonly [distTags: string]: string } }; }
async function generateRegistry(typings: ReadonlyArray<TypingsData>, fetcher: Fetcher, options: Options): Promise<Registry> {
	const entries: { [packageName: string]: { [distTags: string]: string } } = {};
	await nAtATime(options.fetchParallelism, typings, async typing => {
		const info = await fetchNpmInfo(typing.fullEscapedNpmName, fetcher);
		const tags = info["dist-tags"];
		if (tags) {
			entries[typing.name] = filterTags(tags);
		}
	});
	return { entries };

	interface Tags { [tag: string]: string; }
	function filterTags(tags: Tags): Tags {
		const latestTag = "latest";
		const latestVersion = tags[latestTag];
		const out: Tags = {};
		for (const tag in tags) {
			if (tag === latestTag || tags[tag] !== latestVersion) {
				out[tag] = tags[tag];
			}
		}
		return out;
	}
}
