import { TypesDataFile, TypingsData, NotNeededPackage, fullPackageName, notNeededReadme, settings, getOutputPath } from "./common";
import { parseJson } from "./util";
import Versions from "./versions";
import * as fsp from "fs-promise";
import * as path from "path";

/** Generates the package to disk */
export async function generatePackage(typing: TypingsData, availableTypes: TypesDataFile, versions: Versions): Promise<{ log: string[] }> {
	const log: string[] = [];

	const outputPath = getOutputPath(typing);
	await clearOutputPath(outputPath, log);

	log.push("Generate package.json, metadata.json, and README.md");
	const packageJson = await createPackageJSON(typing, versions.getVersion(typing), availableTypes);
	const metadataJson = createMetadataJSON(typing);
	const readme = createReadme(typing);

	log.push("Write metadata files to disk");
	const outputs = [
		writeOutputFile("package.json", packageJson),
		writeOutputFile("types-metadata.json", metadataJson),
		writeOutputFile("README.md", readme)
	];
	outputs.push(...typing.files.map(async file => {
		log.push(`Copy and patch ${file}`);
		let content = await fsp.readFile(filePath(typing, file), { encoding: "utf8" });
		content = patchDefinitionFile(content);
		return writeOutputFile(file, content);
	}));

	await Promise.all(outputs);
	return { log };

	async function writeOutputFile(filename: string, content: string): Promise<void> {
		const full = path.join(outputPath, filename);
		const dir = path.dirname(full);
		if (dir !== outputPath) {
			await fsp.mkdirp(dir);
		}
		return await fsp.writeFile(full, content, { encoding: "utf8" });
	}
}

export async function generateNotNeededPackage(pkg: NotNeededPackage): Promise<{ log: string[] }> {
	const log: string[] = [];
	const outputPath = getOutputPath(pkg);
	await clearOutputPath(outputPath, log);

	log.push("Generate package.json and README.md");
	const packageJson = createNotNeededPackageJSON(pkg);
	const readme = notNeededReadme(pkg);

	log.push("Write metadata files to disk");
	await writeOutputFile("package.json", packageJson);
	await writeOutputFile("README.md", readme);

	// Not-needed packages never change version

	return { log };

	function writeOutputFile(filename: string, content: string): Promise<void> {
		return fsp.writeFile(path.join(outputPath, filename), content, { encoding: "utf8" });
	}
}

async function clearOutputPath(outputPath: string, log: string[]): Promise<void> {
	log.push(`Create output path ${outputPath}`);
	await fsp.mkdirp(outputPath);

	log.push(`Clear out old files`);
	await removeAllFiles(outputPath);
}

async function removeAllFiles(dirPath: string): Promise<void> {
	const files = await fsp.readdir(dirPath);
	await Promise.all(files.map(file => fsp.unlink(path.join(dirPath, file))));
}

function patchDefinitionFile(input: string): string {
	const pathToLibrary = /\/\/\/ <reference path="..\/(\w.+)\/.+"/gm;
	let output = input.replace(pathToLibrary, '/// <reference types="$1"');
	return output;
}

function createMetadataJSON(typing: TypingsData): string {
	const replacer = (key: string, value: any) => key === "root" ? undefined : value;
	return JSON.stringify(typing, replacer, 4);
}

function filePath(typing: TypingsData, fileName: string): string {
	return path.join(typing.root, fileName);
}

async function createPackageJSON(typing: TypingsData, version: number, availableTypes: { [name: string]: TypingsData }): Promise<string> {
	// typing may provide a partial `package.json` for us to complete
	const pkgPath = filePath(typing, "package.json");
	interface PartialPackageJson {
		dependencies?: { [name: string]: string };
		description: string;
	}
	let pkg: PartialPackageJson = typing.hasPackageJson ?
		parseJson(await fsp.readFile(pkgPath, { encoding: "utf8" })) :
		{};

	const ignoredField = Object.keys(pkg).find(field => !["dependencies", "description"].includes(field));
	if (ignoredField) {
		throw new Error(`Ignored field in ${pkgPath}: ${ignoredField}`);
	}

	const dependencies = pkg.dependencies || {};
	addInferredDependencies(dependencies, typing, availableTypes, version);

	const description = pkg.description || `TypeScript definitions for ${typing.libraryName}`;

	// Use the ordering of fields from https://docs.npmjs.com/files/package.json
	const out = {
		name: fullPackageName(typing.typingsPackageName),
		version: versionString(typing, version),
		description,
		// keywords,
		// homepage,
		// bugs,
		license: "MIT",
		author: typing.authors,
		// contributors
		main: "",
		repository: {
			type: "git",
			url: `${typing.sourceRepoURL}.git`
		},
		scripts: {},
		dependencies,
		typings: typing.definitionFilename
	};

	return JSON.stringify(out, undefined, 4);
}

function addInferredDependencies(dependencies: { [name: string]: string }, typing: TypingsData, availableTypes: { [name: string]: TypingsData }, version: number): void {
	function addDependency(d: string): void {
		if (dependencies.hasOwnProperty(d) || !availableTypes.hasOwnProperty(d)) {
			// 1st case: don't add a dependency if it was specified in the package.json or if it has already been added.
			// 2nd case: If it's not a package we know of, just ignore it.
			// For example, we may have an import of "http", where the package is depending on "node" to provide that.
			return;
		}

		const type = availableTypes[d];
		// In normal releases, we want to allow patch updates, so we use `foo.bar.*`.
		// In a prerelease, we can only reference *exact* packages.
		// See https://github.com/npm/node-semver#prerelease-tags
		const patch = settings.prereleaseTag ?
			`${version}-${settings.prereleaseTag}` :
			"*";
		const semver = `${type.libraryMajorVersion}.${type.libraryMinorVersion}.${patch}`;
		dependencies[fullPackageName(d)] = semver;
	}
	typing.moduleDependencies.forEach(addDependency);
	typing.libraryDependencies.forEach(addDependency);
}

function versionString(typing: TypingsData, version: number): string {
	let versionString = `${typing.libraryMajorVersion}.${typing.libraryMinorVersion}.${version}`;
	if (settings.prereleaseTag) {
		versionString = `${version}-${settings.prereleaseTag}`;
	}
	return versionString;
}

function createNotNeededPackageJSON({libraryName, typingsPackageName, sourceRepoURL}: NotNeededPackage): string {
	return JSON.stringify({
		name: fullPackageName(typingsPackageName),
		version: "0.0.0",
		description: `Stub TypeScript definitions entry for ${libraryName}, which provides its own types definitions`,
		main: "",
		scripts: {},
		author: "",
		repository: sourceRepoURL,
		license: "MIT",
		// No `typings`, that's provided by the dependency.
		dependencies: {
			[typingsPackageName]: "*"
		}
	}, undefined, 4);
}

function createReadme(typing: TypingsData) {
	const lines: string[] = [];
	lines.push("# Installation");
	lines.push("> `npm install --save " + fullPackageName(typing.typingsPackageName) + "`");
	lines.push("");

	lines.push("# Summary");
	if (typing.projectName) {
		lines.push(`This package contains type definitions for ${typing.libraryName} (${typing.projectName}).`);
	} else {
		lines.push(`This package contains type definitions for ${typing.libraryName}.`);
	}
	lines.push("");

	lines.push("# Details");
	lines.push(`Files were exported from ${typing.sourceRepoURL}/tree/${typing.sourceBranch}/${typing.typingsPackageName}`);

	lines.push("");
	lines.push(`Additional Details`);
	lines.push(` * Last updated: ${(new Date()).toUTCString()}`);
	lines.push(` * File structure: ${typing.kind}`);
	lines.push(` * Library Dependencies: ${typing.libraryDependencies.length ? typing.libraryDependencies.join(", ") : "none"}`);
	lines.push(` * Module Dependencies: ${typing.moduleDependencies.length ? typing.moduleDependencies.join(", ") : "none"}`);
	lines.push(` * Global values: ${typing.globals.length ? typing.globals.join(", ") : "none"}`);
	lines.push("");

	if (typing.authors) {
		lines.push("# Credits");
		lines.push(`These definitions were written by ${typing.authors}.`);
		lines.push("");
	}

	return lines.join("\r\n");
}