import 'babel-polyfill';
import precinct from 'precinct';
import path from 'path';
import fs from 'fs';
import resolve from 'resolve';
import { transformFile } from 'babel-core';
import less from 'less';
import minimist from 'minimist'
import combineSourceMap from 'combine-source-map';
import convertSourceMap from 'convert-source-map';
import vlq from 'vlq';
import sourceMapConcatinator, { modes as sourceMapModes } from './sourceMapConcatinator';

const argv = minimist(process.argv.slice(2));
//Source root is the absolute root folder from which files can be required.
argv['source-root'] = argv['source-root'] || process.cwd();
//Bundle root is the folder that will be used as the basedir for __dirname
argv['bundle-root'] = argv['bundle-root'] || argv['source-root'];
const sourceMapMode = argv['source-map-compat'] ? sourceMapModes.COMPAT : sourceMapModes.FAST;

//TODO: in order to really speed things up we should do less in batches. I.e. currently we first
//get all the deps, then resolve the deps, and then compile them. However, during waiting on
//the files to load we can perfectly fine already compile some others

function now() {
	return new Date().getTime();
}

const start = now();

function promisify(f) {
	return new Promise((resolve, reject) => {
		f((err, res) => {
			if (err) {
				reject(err);
			} else {
				resolve(res);
			}
		});
	});
}

const options = {
	sourceRoot : argv['source-root'],
	bundleRoot : argv['bundle-root'],
	entries : argv._
};


function cachedFactory(factory, keyFunc = x => x) {
	const cache = new Map();
	return (...params) => {
		const key = keyFunc(...params);
		if (!cache.has(key)) {
			cache.set(key, factory(...params));
		}
		return cache.get(key);
	}
}

function getFileContent(file) {
	//TODO: CACHE ALL THE THINGS!!!
	return promisify(cb => fs.readFile(file, 'utf8', cb));
}


const getDeps = cachedFactory(async(file) => {
	//We currently can't get dependencies other than .js files
	if (path.extname(file) !== '.js') {
		return [];
	}
	const content = await getFileContent(file);
	const relativeDeps = precinct(content);
	const absoluteDeps = await Promise.all(
		relativeDeps
			.map(dep => promisify(cb => resolve(dep, { basedir: path.dirname(file) }, cb)))
	);


	return relativeDeps.map((relative, idx) => {
		return {
			relative,
			absolute : absoluteDeps[idx]
		}
	});
});

//TODO: also keep track of dependants, such that we can remove files that are no longer needed
//Quick thought: maybe it's a better idea to keep an entire tree/graph of dependencies instead of just a list
//


async function gatherFiles(entry, seen = []) {
	if (seen.includes(entry)) {
		return;
	}
	seen.push(entry);
	const deps = (await getDeps(entry));
	await Promise.all(deps
		.map(dep => gatherFiles(dep.absolute, seen))
	);
	return seen;
}

let compileCount = 0;
let mapShown  = false;

const compile = cachedFactory(async (file) => {
	compileCount++;
	const ext = path.extname(file);
	switch (ext) {
		case '.js': {
			const { code, map, ast } = await promisify(cb => transformFile(file, { sourceRoot : options.sourceRoot, sourceMaps : true, sourceFileName: path.relative(options.sourceRoot, file), comments: false }, cb));
			if (!mapShown) {
				//console.log(map);
				mapShown = true;
			}

			return { file, code, map };
		}
		case '.json': {
			const code = await getFileContent(file);
			return { file, code : `module.exports = ${code};`, map : null };
		}
		case '.less': {
			const content = await getFileContent(file);
			try {
				const { css, map, imports } = await less.render(content);
			} catch(e) {
				//TODO: don't ignore errors
			}
			return { file, code : `console.log("can't load less yet");`, map : null };
		}
		default:
			return { file, code : '', map : null };
	}
});


async function build(file, out) {
	console.log(`Building bundle for ${file}`);
	const absEntryPath = path.resolve(options.sourceRoot, file);
	const files = await gatherFiles(absEntryPath);
	console.log(`About to compile ${files.length} files`);
	//NOTE: we need the arrow function here because otherwise we'll miss the cache
	const fileIds = new Map();
	files.forEach((file, id) => fileIds.set(file, id));

	const compiled = await Promise.all(files.map(file => compile(file)));


	const bundleStart = now();

	const concatinator = sourceMapConcatinator(out, { mode : sourceMapMode });
	concatinator.skipLines(6); //TODO: dynamically calculate this

	//TODO: move to somewhere else
	const modules = await compiled.reduce(async (resultPromise, { code, file, map }) => {
		const result = await resultPromise;
		const deps = await getDeps(file);
		//This is the map of dependencies as `import`ed/`require`d -> fileId
		const depMap = {};
		deps.forEach(({ absolute, relative }) => {
			if (!fileIds.has(absolute)) {
				throw new Error("File imported that was not resolved. File: ${absolute}");
			}
			depMap[relative] = fileIds.get(absolute);
		});
		const depMapJson = JSON.stringify(depMap);
		if (!fileIds.has(file)) {
			throw new Error("File compiled that has no id. That's not supposed to happen. File: ${file}");
		}
		const fileId = fileIds.get(file);
		const dirname = path.relative(options.bundleRoot, path.dirname(file));

		const modulePrefix = `${fileId} : [function(require, module, exports) {
		  //TODO: don't automatically include this
		  var __dirname = '${dirname}';\n`

		const moduleSuffix = `
		}, ${depMapJson}],
		`;

		//Prefix
		concatinator.addSource(modulePrefix, null);
		concatinator.addSource(code, map);
		concatinator.addSource(moduleSuffix, null);

		return `${result}${modulePrefix}${code}${moduleSuffix}`;
	}, Promise.resolve(''));

	const entryId = fileIds.get(absEntryPath);

	const sourceMapComment = convertSourceMap.fromObject(concatinator.getMap()).toComment();

	const bundle = `(function() {
		//TODO: don't automatically include these
		var global = window;
		var DEV_MODE = true;

		var modules = {
			${modules}
		};

		var cache = {};

		function requireWith(mapping) {
			return function(module) {
			  var id = mapping[module];
				return loadModule(id);
			}
		}

		function loadModule(id) {
			if (cache[id]) {
				return cache[id].exports;
			}
			var module = modules[id];
			var moduleVar = { exports : {} };
			//We need to wrap the exports in an object such that we can properly deal with null/undefined
			//Additionally we need to make sure to assign to exports[id] *before* calling the module,
			//such that we can deal with circular dependencies
			cache[id] = moduleVar;
			module[0].call(moduleVar.exports, requireWith(module[1]), moduleVar, moduleVar.exports);
			return cache[id].exports;
		}
		loadModule(${entryId});
	}());\n${sourceMapComment}`;

	const bundleEnd = now();

	console.log(`Bundling took ${bundleEnd - bundleStart} ms`);


	await promisify(cb => fs.writeFile(out, bundle, 'utf8', cb));
}

Promise.all(options.entries.map(entry => build(entry, 'out/' + path.basename(entry)))) //TODO: make output configurable
	.then(() => {
		const dt = now() - start;
		console.log(`done in ${dt} ms`);
		console.log(`Actually compiled ${compileCount} files`);
	}, err => console.error("Failed: ", err));

