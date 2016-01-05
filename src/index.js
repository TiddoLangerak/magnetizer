import 'babel-polyfill';
import precinct from 'precinct';
import path from 'path';
import fs from 'fs';
import resolve from 'resolve';
import { transformFile } from 'babel-core';
import less from 'less';

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
	basePath : process.cwd() + '/src/main/webapp',
	entries : process.argv.slice(2)
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

const compile = cachedFactory(async (file) => {
	compileCount++;
	const ext = path.extname(file);
	switch (ext) {
		case '.js': {
			const { code, map, ast } = await promisify(cb => transformFile(file, { sourceRoot : options.basePath }, cb));
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
	const absEntryPath = path.resolve(options.basePath, file);
	const files = await gatherFiles(absEntryPath);
	console.log(`About to compile ${files.length} files`);
	//NOTE: we need the arrow function here because otherwise we'll miss the cache
	const fileIds = new Map();
	files.forEach((file, id) => fileIds.set(file, id));

	const compiled = await Promise.all(files.map(file => compile(file)));

	//TODO: move to somewhere else

	const modules = await Promise.all(compiled.map(async ({ code, file }) => {
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
		const dirname = path.relative(options.basePath, path.dirname(file));
		return `${fileId} : [function(require, module, exports) {
		  //TODO: don't automatically include this
		  var __dirname = '${dirname}';
		  ${code}
		}, ${depMapJson}]`;
	}));

	const entryId = fileIds.get(absEntryPath);

	const bundle = `
	(function() {
		//TODO: don't automatically include these
		var global = window;
		var DEV_MODE = true;

		var modules = {${modules.join(',\n')}};

		var exports = {};

		function requireWith(mapping) {
			return function(module) {
			  var id = mapping[module];
				return loadModule(id);
			}
		}

		function loadModule(id) {
			if (exports[id]) {
				return exports[id];
			}
			var module = modules[id];
			var moduleVar = { exports : {} };
			module[0](requireWith(module[1]), moduleVar, moduleVar.exports);
			exports[id] = moduleVar.exports;
			return exports[id];
		}
		loadModule(${entryId});
	}());
	`;
	await promisify(cb => fs.writeFile(out, bundle, 'utf8', cb));
}

Promise.all(options.entries.map(entry => build(entry, 'out/' + path.basename(entry)))) //TODO: make output configurable
	.then(() => {
		const dt = now() - start;
		console.log(`done in ${dt} ms`);
		console.log(`Actually compiled ${compileCount} files`);
	}, err => console.error("Failed: ", err));

