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

const argv = minimist(process.argv.slice(2));
//Source root is the absolute root folder from which files can be required.
argv['source-root'] = argv['source-root'] || process.cwd();
//Bundle root is the folder that will be used as the basedir for __dirname
argv['bundle-root'] = argv['bundle-root'] || argv['source-root'];

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
			const { code, map, ast } = await promisify(cb => transformFile(file, { sourceRoot : options.sourceRoot, sourceMaps : true }, cb));
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


	//Prefix
	const offset = 5; //TODO: dynamically calculate this

	const sourceMap = {
		version: 3,
		file: out,
		sources : [],
		names : [],
		//TODO since I'm tired now. Source maps are pretty simple things: the mappings string is a list
		//of line mappings, seperated by `;` (e.g. <mappingsLine1>;<mappingsLine2>;;<mappingsLine4>)
		//The mappings themselves are tuples containing the offsets and the sources, encoded with vlq
		//(https://github.com/Rich-Harris/vlq/tree/master/sourcemaps)
		//If we have sourceMapA for file A and sourceMapB for file B and we want to create sourceMapAB
		//then we can construct that one from sourceMapA by:
		//- Add the sources and sourcesContent from sourceMapB to sourceMapA
		//- Update the file indices in the mappings of sourceMapB such that they point to the correct source.
		//  I.e. in sourceMapB the source of file B would be at index 0, but in sourceMapAB it will be at 1.
		//  This needs to be updated in the mapping
		//- Append the updated mapping to the mapping of SourceMapA
		mappings : new Array(offset+1).join(';'),
		sourcesContent : []
	};
	let sourceMapCol = 0;
	let sourceMapRow = 0;
	let sourcesIndex = 0;
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

		sourceMap.mappings += ';;;' //3 lines module prefix
		if (map) {
			const sourcesOffset = sourceMap.sources.length - sourcesIndex;
			sourceMap.sources = [...sourceMap.sources, ...map.sources];
			sourceMap.sourcesContent = [...sourceMap.sourcesContent, ...map.sourcesContent];
			if (sourceMap.sources.length !== sourceMap.sourcesContent.length) {
				throw new Error("Sources and sourcesContent have different lengths");
			}
			const vlqs = map.mappings.split(';').map(line => line.split(','));
			let isFirst = true;
			const mapped = vlqs.map(line => {
				if (line.length === 0) {
					return line;
				}
				return line.map(token => {
					const parts = vlq.decode(token);
					if (parts.length > 1) {
						if (isFirst) {
							parts[1] += sourcesOffset;
							parts[2] -= sourceMapRow;
							parts[3] -= sourceMapCol;
							isFirst = false;
						}
						sourceMapRow += parts[2];
						sourceMapCol += parts[3];
					}
					if (parts[4] !== undefined) {
						throw new Error("We do not support names yet");
					}
					return vlq.encode(parts);
				}).join(',');
			}).join(';');
			sourceMap.mappings += mapped;
		} else {
			const newLines = code.split('\n').length;
			sourceMap.mappings += new Array(newLines + 1).join(';');
		}
		sourceMap.mappings += ';;'; //1 lines module postfix

		return `${result}${fileId} : [function(require, module, exports) {
		  //TODO: don't automatically include this
		  var __dirname = '${dirname}';` + //The linebreak here is to ensure code start at column 0, which makes source maps easier
		  `\n${code}
		}, ${depMapJson}],
		`;
	}, Promise.resolve(''));

	const entryId = fileIds.get(absEntryPath);

	console.log(sourceMap);

	const sourceMapComment = convertSourceMap.fromObject(sourceMap).toComment();

	const bundle = `(function() {
		//TODO: don't automatically include these
		var global = window;
		var DEV_MODE = true;

		var modules = {${modules}};

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
	${sourceMapComment}
	`;
	await promisify(cb => fs.writeFile(out, bundle, 'utf8', cb));
}

Promise.all(options.entries.map(entry => build(entry, 'out/' + path.basename(entry)))) //TODO: make output configurable
	.then(() => {
		const dt = now() - start;
		console.log(`done in ${dt} ms`);
		console.log(`Actually compiled ${compileCount} files`);
	}, err => console.error("Failed: ", err));

